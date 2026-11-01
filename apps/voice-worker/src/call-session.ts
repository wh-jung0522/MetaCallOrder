import enGreeting from "./greetings/en-greeting.pcm";
import enOther from "./greetings/en-other.pcm";
import koGreeting from "./greetings/ko-greeting.pcm";
import koOther from "./greetings/ko-other.pcm";
import { CallRepository, CustomerRepository, FIRST_TIME_CALLER_NAME, SupabaseMerchantAdapter, type Customer, type OrderResult } from "@callorder/adapters";
import { isBargeIn, isHandoffRequest, isRepeatRequest, nextLanguage, OrderSession, runConversationTurn, type Language, type OrderToolContext, type TurnAction } from "@callorder/agents";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DurableObject } from "cloudflare:workers";
import OpenAI from "openai";
import { createDb, missingSecrets, type Env } from "./env";
import { MuseStt } from "./stt";
import { AUDIO_BUCKET, CallRecorder, RECORD_RATE } from "./recording";
import { PhoneTransport, SimulatorTransport, type TelephonyTransport } from "./transport";
import { SilentTts, SonioxTts, TTS_SAMPLE_RATE, TypecastTts, type Tts } from "./tts";

// Recorded by eval/make-greetings.mjs in the TTS_VOICE voice, so the call opens instantly.
const RECORDED: Record<string, ArrayBuffer> = {
  "ko-greeting": koGreeting, "ko-other": koOther, "en-greeting": enGreeting, "en-other": enOther,
};

const PHRASES: Record<Language, { greeting: string; otherLanguage: string; whatToOrder: string; reorder(item: string): string; silence: string; failSafe: string; handoff: string; noOperator: string; ordered(minutes: number): string }> = {
  ko: {
    greeting: "안녕하세요, 콜오더 주문 전화입니다. AI가 주문을 도와드립니다. 통화 내용은 주문 처리를 위해 기록됩니다.",
    otherLanguage: "한국어로 말씀하셔도 됩니다.",
    whatToOrder: "무엇을 주문해 드릴까요?",
    reorder: (item) => `지난번에 ${item} 드셨어요. 같은 걸로 하실까요?`,
    silence: "천천히 말씀하셔도 됩니다.",
    failSafe: "죄송합니다. 지금 연결이 원활하지 않아 상담원에게 연결해 드릴게요.",
    handoff: "상담원에게 연결해 드릴게요.",
    noOperator: "죄송합니다. 지금은 상담원 연결이 되지 않습니다. 잠시 후 다시 전화해 주세요.",
    ordered: (minutes) => `주문이 완료되었습니다. 약 ${minutes}분 뒤 도착합니다. 감사합니다.`,
  },
  en: {
    greeting: "Hello, this is CallOrder. An AI will help with your order, and this call is recorded to process it.",
    otherLanguage: "You can also speak English.",
    whatToOrder: "What would you like to order?",
    reorder: (item) => `Last time you had ${item}. Would you like the same?`,
    silence: "Please take your time.",
    failSafe: "I'm sorry, the connection is having trouble. Let me connect you to an agent.",
    handoff: "Let me connect you to an agent.",
    noOperator: "I'm sorry, no agent is available right now. Please call again a little later.",
    ordered: (minutes) => `Your order is placed. It should arrive in about ${minutes} minutes. Thank you.`,
  },
};
const HANDOFF_TARGET = "상담원";
const SILENCE_MS = 12000;
const MAX_SILENCE_PROMPTS = 2;
const MAX_CALL_MS = 15 * 60_000;
const SLOW_DOWN = 0.1;
const TTS_DRAIN_TIMEOUT_MS = 15_000;
const CALLER_RATE = 16000;
// Hangup has already happened by then, so this only limits how long the object stays busy with a 30 MB file.
const UPLOAD_TIMEOUT_MS = 60_000;
// Worst case 2000 rows x 4000 UTF-16 characters = 16 MB, on top of the audio ceiling in recording.ts. A real call is well under 1 MB.
const MAX_LOG_ROWS = 2000;
const MAX_LOG_PAYLOAD_CHARS = 4000;

function clip(payload: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(payload);
  return text.length <= MAX_LOG_PAYLOAD_CHARS ? payload : { clipped: true, text: text.slice(0, MAX_LOG_PAYLOAD_CHARS) };
}

// USD. Meta: dev.meta.ai/docs/pricing-rate-limits. Soniox: soniox.com/pricing ($4/1M input tokens, ~0.3 token per char, ~$0.70/hour of audio).
const PRICE = { sttPerSecond: 0.18 / 3600, llmInput: 1.25 / 1e6, llmOutput: 4.25 / 1e6, ttsPerChar: (4 / 1e6) * 0.3, ttsPerSecond: 0.7 / 3600 };

interface TurnMetrics {
  speech_end_ms?: number;
  final_ms?: number;
  llm_first_token_ms?: number;
  tts_first_chunk_ms?: number;
}

export class CallSession extends DurableObject<Env> {
  private transport!: TelephonyTransport;
  private stt: MuseStt | null = null;
  private tts: Tts = new SilentTts();
  private db!: SupabaseClient;
  private calls!: CallRepository;
  private tools!: OrderToolContext;
  private llm!: OpenAI;

  private callId = "";
  private customer: Customer | null = null;
  private session = new OrderSession();
  private messages: OpenAI.ChatCompletionMessageParam[] = [];
  private transcript: { role: "caller" | "agent"; text: string; at: string }[] = [];
  private metrics: TurnMetrics[] = [];
  private current: TurnMetrics = {};
  private turnAbort: AbortController | null = null;
  private turnChain: Promise<void> = Promise.resolve();

  private lastSpoken = "";
  private spokenRate = 0.9;
  private playingUntil = 0;
  private speechEndedAt = 0;
  private bargedIn = false;
  private speechOverlappedPlayback = false;
  private silenceTimer = 0;
  private silencePrompts = 0;
  private callTimer = 0;
  private startedAt = 0;
  private usage = { input: 0, output: 0, ttsChars: 0, ttsSeconds: 0 };
  private outcome = "abandoned";
  private handoffReason: string | null = null;
  private ended = false;
  private dialedLanguage: Language | null = null;
  private recorder = new CallRecorder(0);
  private logs: { call_sid: string; seq: number; at: string; ms: number; kind: string; payload: Record<string, unknown> }[] = [];
  private partials = 0;
  // Sentences sent to TTS and not heard yet, so the first chunk of each can be matched to its place in the audio.
  private unheard: number[] = [];
  private voiceIsOff = false;

  override async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Recent compatibility dates default to Blob, which reads as zero-length audio here.
    server.binaryType = "arraybuffer";
    server.accept();
    const url = new URL(request.url);
    // A US number opens in English whoever is calling.
    const lang = url.searchParams.get("lang");
    this.dialedLanguage = lang === "en" || lang === "ko" ? lang : null;
    this.callId = url.searchParams.get("callId")!;
    server.addEventListener("message", (event) => {
      if (this.transport || typeof event.data !== "string") return;
      const start = JSON.parse(event.data) as { type?: string; event?: string; callerId?: string; lang?: string; start?: { streamSid?: string } };
      // The Worker signed this caller id before routing here, and it is empty when the number is blocked; the simulator states its own.
      const isPhone = url.pathname === "/phone/stream";
      if (isPhone ? start.event !== "start" : start.type !== "start" || !start.callerId) return;
      const callerId = isPhone ? (url.searchParams.get("caller") ?? "") : start.callerId!;
      // The simulator speaks the screen's language, English unless told otherwise.
      if (!isPhone) this.dialedLanguage = start.lang === "ko" ? "ko" : "en";
      this.begin(server, callerId, isPhone ? new PhoneTransport(server, callerId, start.start?.streamSid) : new SimulatorTransport(server, callerId)).catch((error) => {
        console.error("call start failed", error);
        server.send(JSON.stringify({ type: "hangup", reason: "통화를 시작하지 못했습니다." }));
        server.close(1011, "start failed");
      });
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private async begin(socket: WebSocket, callerId: string, transport: PhoneTransport | SimulatorTransport): Promise<void> {
    const missing = missingSecrets(this.env);
    if (missing.length) {
      socket.send(JSON.stringify({ type: "hangup", reason: `Worker 비밀값이 아직 없습니다: ${missing.join(", ")}` }));
      socket.close(1011, "missing secrets");
      return;
    }
    this.transport = transport;
    this.startedAt = Date.now();
    this.recorder = new CallRecorder(this.startedAt);
    this.session.language = this.dialedLanguage ?? (!callerId || callerId.startsWith("+82") ? "ko" : "en");
    // A stored greeting needs nothing below, so the caller is not left in silence while the call is set up.
    if (this.env.TTS_PROVIDER === "typecast") this.greet();

    this.db = createDb(this.env);
    this.calls = new CallRepository(this.db);
    const customers = new CustomerRepository(this.db);
    this.llm = new OpenAI({ apiKey: this.env.META_API_KEY, baseURL: this.env.META_BASE_URL, maxRetries: 1 });

    // Anyone with the simulator can pick any caller id, so real customers must stay out of reach there. A phone caller id comes from the carrier.
    let found = callerId ? await customers.findByPhone(callerId) : null;
    // Anyone can order: a number seen for the first time is registered on the spot. A simulator caller is demo data.
    if (callerId && !found) {
      await customers.ensureCaller(callerId, transport.kind === "simulator");
      found = await customers.findByPhone(callerId);
    }
    this.customer = transport.kind === "phone" || found?.is_demo ? found : null;
    this.spokenRate = this.customer?.preferred_speech_rate ?? 0.9;

    this.tools = {
      callSid: this.callId,
      callerE164: callerId,
      customer: this.customer,
      session: this.session,
      adapter: new SupabaseMerchantAdapter(this.db),
      customers,
      pendingRecap: null,
      storeName: null,
      placedOrder: null,
      onOrderPlaced: (order, storeName) => this.onOrderPlaced(customers, order, storeName),
    };

    this.log("call_start", { channel: transport.kind, language: this.session.language, tts: this.env.TTS_PROVIDER, registered: Boolean(this.customer) });
    transport.sendEvent({ type: "start_ack", callId: this.callId, sampleRate: TTS_SAMPLE_RATE, tts: this.env.TTS_PROVIDER, registered: Boolean(this.customer) });
    transport.onHangup(() => void this.finish());
    transport.onDtmf((digit) => this.onDtmf(digit));
    if (transport instanceof SimulatorTransport) {
      transport.onUtterance((text) => {
        this.speechEndedAt = Date.now();
        this.current = {};
        this.mark("speech_end_ms");
        this.onFinal(text);
      });
    }
    transport.onAudio((pcm) => {
      this.recorder.addCaller(pcm, CALLER_RATE);
      this.stt?.sendAudio(pcm);
    });
    this.callTimer = setTimeout(() => this.endWith("max_duration"), MAX_CALL_MS);

    await this.calls.start(this.callId, this.customer?.id ?? null, transport.kind);

    const ttsOptions = { url: this.env.TTS_URL, apiKey: this.env.TTS_API_KEY, model: this.env.TTS_MODEL, voice: this.env.TTS_VOICE };
    const ttsHandlers = {
      onAudio: (pcm: Int16Array) => this.onTtsAudio(pcm),
      onFirstChunk: () => {
        this.mark("tts_first_chunk_ms");
        const say = this.unheard.shift();
        if (say !== undefined) this.log("tts_start", { say, audio_ms: this.recorder.agentStartMs() });
      },
      // A simulator caller can still read the replies. A phone caller with no voice has nothing left.
      onFailure: (reason: string) => (transport.kind === "simulator" ? this.voiceOff(reason) : this.failSafe(reason)),
    };
    if (this.env.TTS_PROVIDER === "typecast") this.tts = new TypecastTts(ttsHandlers, ttsOptions);
    if (this.env.TTS_PROVIDER === "soniox") {
      const tts = new SonioxTts(ttsHandlers, ttsOptions);
      try {
        await tts.connect();
        this.tts = tts;
      } catch (error) {
        if (transport.kind !== "simulator") throw error;
        this.voiceOff(`tts connect: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.stt = new MuseStt({
      onSpeechStart: () => {
        clearTimeout(this.silenceTimer);
        this.speechOverlappedPlayback = this.isPlaying();
        this.emit("stt_speech_start");
      },
      onPartial: (text) => this.onPartial(text),
      onSpeechEnd: () => {
        this.speechEndedAt = Date.now();
        this.current = {};
        this.mark("speech_end_ms");
        this.log("speech_end");
      },
      onFinal: (text) => this.onFinal(text),
      onFailure: (reason) => this.failSafe(reason),
    });
    await this.stt.connect({
      url: this.env.META_STT_URL,
      apiKey: this.env.META_API_KEY,
      model: this.env.META_STT_MODEL,
      // Meta documents no cap on keywords. This only guards against a runaway catalog.
      keywords: await customers.sttKeywords(1000),
    });

    const language = this.session.language;
    if (this.env.TTS_PROVIDER !== "typecast") this.greet();
    if (!this.customer) {
      this.messages.push({ role: "user", content: "[시스템 상태] 전화가 연결됐습니다. 발신번호를 알 수 없습니다." });
      this.enqueueTurn();
      return;
    }
    // Asked by code, not the model: the first words reach the caller at once and cannot be a narrated plan.
    const recent = await customers.recentOrders(this.customer.id, 1).catch(() => []);
    const lastItem = recent[0]?.items[0];
    const lastName = language === "en" ? (lastItem?.label_en ?? lastItem?.name) : lastItem?.name;
    const opening = lastName ? PHRASES[language].reorder(lastName) : PHRASES[language].whatToOrder;
    this.messages.push({ role: "assistant", content: opening });
    this.say(opening);
    this.armSilenceTimer();
  }

  private greet(): void {
    const language = this.session.language;
    const other = language === "ko" ? "en" : "ko";
    this.say(PHRASES[language].greeting, language, `${language}-greeting`);
    this.say(PHRASES[other].otherLanguage, other, `${other}-other`);
  }

  private onPartial(text: string): void {
    clearTimeout(this.silenceTimer);
    this.partials++;
    this.transport.sendEvent({ type: "transcript", text, final: false });
    if (this.isPlaying() && isBargeIn(text)) this.bargeIn();
  }

  private bargeIn(): void {
    if (this.bargedIn) return;
    this.bargedIn = true;
    this.turnAbort?.abort();
    this.tts.cancel();
    this.unheard = [];
    this.recorder.stopAgent();
    this.transport.clearPlayback();
    this.playingUntil = 0;
    this.session.noteInterrupted();
    this.emit("barge_in");
  }

  private onFinal(text: string): void {
    const utterance = text.trim();
    if (!utterance || this.ended) return;
    this.session.language = nextLanguage(utterance, this.session.language);
    // "네" spoken over the recap is a backchannel, not agreement to an order they have not finished hearing.
    // Endpointing delay can deliver it after playback ended, hence the check from when the speech began.
    const overlapped = this.isPlaying() || this.speechOverlappedPlayback;
    this.speechOverlappedPlayback = false;
    const ignored = overlapped && !isBargeIn(utterance);
    this.log("stt_final", { text: utterance, partials: this.partials, ignored });
    this.partials = 0;
    if (ignored) return;
    if (this.isPlaying()) this.bargeIn();
    this.bargedIn = false;
    this.mark("final_ms");
    this.transport.sendEvent({ type: "transcript", text: utterance, final: true });
    this.record("caller", utterance);
    clearTimeout(this.silenceTimer);
    this.silencePrompts = 0;

    if (isHandoffRequest(utterance)) return this.handoff("고객 요청");
    if (isRepeatRequest(utterance) && this.lastSpoken) {
      this.spokenRate = Math.max(0.7, this.spokenRate - SLOW_DOWN);
      return this.say(this.lastSpoken);
    }

    this.applyConfirmation(this.session.noteCallerUtterance(utterance));
    this.messages.push({ role: "user", content: utterance });
    this.enqueueTurn();
  }

  private applyConfirmation(outcome: "confirmed" | "rejected" | "none"): void {
    if (outcome === "none") return;
    this.emit("confirmation", { outcome });
    this.emit("state", { state: this.derivedState() });
  }

  private onDtmf(digit: string): void {
    this.emit("dtmf", { digit });
    if (digit === "0") return this.handoff("키패드 0번");
    if (digit !== "1" && digit !== "2") return;
    const spoken = this.session.language === "en" ? (digit === "1" ? "yes" : "no") : digit === "1" ? "네" : "아니요";
    this.record("caller", `${spoken} (키패드 ${digit}번)`);
    // Pressing a key mid-recap means they did not wait to hear it, same as speaking over it.
    if (this.isPlaying()) this.bargeIn();
    this.bargedIn = false;
    this.applyConfirmation(this.session.noteCallerUtterance(spoken));
    this.messages.push({ role: "user", content: spoken });
    this.enqueueTurn();
  }

  // Turns run strictly in order, and a newer utterance supersedes whatever is still being worked out.
  private enqueueTurn(): void {
    this.turnAbort?.abort();
    this.turnChain = this.turnChain.then(() => this.runTurn());
  }

  private async runTurn(): Promise<void> {
    if (this.ended) return;
    const abort = new AbortController();
    this.turnAbort = abort;
    const historyLength = this.messages.length;
    let action: TurnAction = null;
    try {
      action = await runConversationTurn(
        this.messages,
        this.tools,
        { client: this.llm.chat.completions, model: this.env.META_LLM_MODEL },
        {
          speak: (text) => this.say(text),
          onToolCall: (tool, args, result) => this.emit("tool_call", { tool, args, result }),
          onConversationTool: (tool, args, result) => this.log("tool_call", { agent: "conversation", tool, args, result }),
          onLlmRequest: (request) => this.log("llm_request", request),
          onLlmResponse: (response) => this.log("llm_response", response),
          onFirstToken: () => this.mark("llm_first_token_ms"),
          onUsage: (usage) => {
            this.usage.input += usage.prompt_tokens;
            this.usage.output += usage.completion_tokens;
          },
        },
        abort.signal,
      );
    } catch (error) {
      if (abort.signal.aborted) {
        // A half-finished turn can leave tool_calls without results, which the API rejects with HTTP 400.
        // Cart and order effects survive in OrderSession and reach the model through the state note.
        this.messages.length = historyLength;
        this.log("turn_cancelled");
        return;
      }
      return this.failSafe(`llm: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.ctx.storage.put("snapshot", { messages: this.messages.length, cart: this.session.cart, confirmation: this.session.status });
    this.emit("state", { state: this.derivedState() });

    if (action?.type === "handoff") return this.handoff(action.reason);
    if (action?.type === "end_call") return this.endWith(this.outcome === "abandoned" ? "completed" : this.outcome);
    await this.ttsDrained();
    if (this.current.speech_end_ms !== undefined) {
      this.metrics.push(this.current);
      this.emit("latency", { ...this.current });
      this.current = {};
    }
    this.armSilenceTimer();
  }

  private derivedState(): string {
    if (this.tools.placedOrder) return "DONE";
    if (!this.customer) return "ONBOARD_NEW";
    const confirmation = this.session.status;
    if (confirmation) return confirmation.confirmed ? "PLACE_ORDER" : "CONFIRM";
    return this.session.cart?.items.length ? "BUILD_CART" : "INTENT";
  }

  private armSilenceTimer(): void {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (this.ended) return;
      if (this.silencePrompts >= MAX_SILENCE_PROMPTS) return void this.endWith("silence");
      this.silencePrompts++;
      const lastSpoken = this.lastSpoken;
      this.say(PHRASES[this.session.language].silence);
      // A courtesy line must not break the "last thing said was the recap" rule for a late 네.
      this.session.noteSpoken(lastSpoken);
      this.lastSpoken = lastSpoken;
      this.armSilenceTimer();
    }, Math.max(0, this.playingUntil - Date.now()) + SILENCE_MS);
  }

  private say(text: string, language: Language = this.session.language, recording?: string): void {
    if (this.ended) return;
    this.lastSpoken = text;
    this.session.noteSpoken(text);
    this.record("agent", text);
    const said = this.log("say", { text, language });
    this.transport.sendEvent({ type: "assistant_text", text });
    this.playingUntil = Math.max(this.playingUntil, Date.now());
    if (recording && this.env.TTS_PROVIDER === "typecast") {
      this.log("tts_start", { say: said, audio_ms: this.recorder.agentStartMs() });
      this.onTtsAudio(new Int16Array(RECORDED[recording]!));
      return;
    }
    this.unheard.push(said);
    this.usage.ttsChars += text.length;
    this.tts.speak(text, this.spokenRate, language);
  }

  private onTtsAudio(pcm: Int16Array): void {
    this.recorder.addAgent(pcm, TTS_SAMPLE_RATE);
    this.transport.playAudio(pcm, TTS_SAMPLE_RATE);
    const seconds = pcm.length / TTS_SAMPLE_RATE;
    this.usage.ttsSeconds += seconds;
    this.playingUntil = Math.max(this.playingUntil, Date.now()) + seconds * 1000;
  }

  private isPlaying(): boolean {
    return this.tts.busy || Date.now() < this.playingUntil;
  }

  private async onOrderPlaced(customers: CustomerRepository, order: OrderResult, storeName: string): Promise<void> {
    this.outcome = "ordered";
    this.transport.sendEvent({ type: "order_placed", order, storeName });
    this.say(PHRASES[this.session.language].ordered(order.eta_minutes));
    if (!this.customer) return;
    const guardians = await customers.guardians(this.customer.id);
    for (const guardian of guardians.filter((candidate) => candidate.notify_on_order)) {
      this.transport.sendEvent({
        type: "guardian_sms",
        to: guardian.phone_e164,
        text: `[콜오더] ${this.customer.name}님이 ${storeName}에 ${order.total.toLocaleString("ko-KR")}원을 주문했습니다. 약 ${order.eta_minutes}분 뒤 도착합니다.`,
      });
    }
  }

  private handoff(reason: string): void {
    if (this.ended) return;
    this.handoffReason = reason;
    this.turnAbort?.abort();
    const phrases = PHRASES[this.session.language];
    this.say(this.transport.kind === "phone" ? phrases.noOperator : phrases.handoff);
    void this.afterPlayback(async () => {
      await this.transport.transfer(HANDOFF_TARGET);
      await this.finish("handoff");
    });
  }

  // The screen already has the text of every reply, so the call carries on without sound.
  private voiceOff(reason: string): void {
    if (this.ended || this.voiceIsOff) return;
    this.voiceIsOff = true;
    console.error("tts off", this.callId, this.scrub(reason));
    this.log("tts_off", { reason });
    const broken = this.tts;
    this.tts = new SilentTts();
    this.unheard = [];
    broken.cancel();
    broken.close();
    this.transport.sendEvent({ type: "voice_off" });
  }

  private failSafe(rawReason: string): void {
    if (this.ended) return;
    const reason = this.scrub(rawReason);
    console.error("fail safe", this.callId, reason);
    this.emit("fail_safe", { reason });
    this.handoffReason = `fail_safe: ${reason}`;
    this.turnAbort?.abort();
    // The sim falls back to a local voice for this text when TTS itself is the broken piece.
    const phrases = PHRASES[this.session.language];
    const text = this.transport.kind === "phone" ? phrases.noOperator : phrases.failSafe;
    this.transport.sendEvent({ type: "fail_safe", text });
    this.record("agent", text);
    // A phone has no local voice to fall back on, so TTS says it unless TTS is what broke.
    if (this.transport.kind === "phone" && !reason.startsWith("tts")) {
      this.tts.speak(text, this.spokenRate, this.session.language);
      void this.afterPlayback(() => this.finish("fail_safe"));
      return;
    }
    void this.transport.transfer(HANDOFF_TARGET).then(() => this.finish("fail_safe"));
  }

  private endWith(outcome: string): void {
    void this.afterPlayback(() => this.finish(outcome));
  }

  // A TTS stream that never terminates must not freeze the call.
  private ttsDrained(): Promise<unknown> {
    return Promise.race([this.tts.drained(), new Promise((resolve) => setTimeout(resolve, TTS_DRAIN_TIMEOUT_MS))]);
  }

  private async afterPlayback(action: () => Promise<void>): Promise<void> {
    await this.ttsDrained();
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, this.playingUntil - Date.now())));
    await action();
  }

  private async finish(outcome = this.outcome): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.silenceTimer);
    clearTimeout(this.callTimer);
    this.turnAbort?.abort();
    this.stt?.close();
    this.tts.close();
    // Anything still queued was never heard, since the line is closing.
    this.recorder.stopAgent();
    const seconds = (Date.now() - this.startedAt) / 1000;
    const cost =
      seconds * PRICE.sttPerSecond +
      this.usage.input * PRICE.llmInput +
      this.usage.output * PRICE.llmOutput +
      this.usage.ttsChars * PRICE.ttsPerChar +
      this.usage.ttsSeconds * PRICE.ttsPerSecond;
    this.transport.sendEvent({ type: "agent_event", name: "call_cost", cost_usd: cost });
    // The caller is released first, so a slow database never keeps the line open.
    this.transport.hangup();
    if (this.current.speech_end_ms !== undefined) this.log("latency", { ...this.current });
    this.log("usage", { ...this.usage, cost_usd: cost });
    this.log("call_end", { outcome, seconds, handoff_reason: this.handoffReason });
    try {
      await this.calls.finish(this.callId, {
        outcome,
        transcript: this.transcript,
        latency_metrics: this.metrics,
        cost_usd: Number(cost.toFixed(5)),
        handoff_reason: this.handoffReason,
      });
    } catch (error) {
      console.error("call record failed", this.callId, error);
    }
    await this.saveLogsAndAudio();
    // Transcripts live in Supabase under the 30-day retention job, so the DO keeps nothing.
    await this.ctx.storage.deleteAll();
  }

  // Logs first and in one insert, so a slow or failed upload cannot cost them.
  private async saveLogsAndAudio(): Promise<void> {
    const hasAudio = this.recorder.seconds > 0;
    const path = `${this.callId}.wav`;
    this.log("audio", hasAudio ? { path, seconds: this.recorder.seconds, rate: RECORD_RATE, left: "caller", right: "agent" } : { path: null });
    const save = () => this.calls.saveLogs(JSON.parse(this.scrub(JSON.stringify(this.logs))));
    try {
      await save();
    } catch (error) {
      console.error("call logs failed", this.callId, error);
    }
    if (!hasAudio) return;
    try {
      const { error } = await createDb(this.env, UPLOAD_TIMEOUT_MS).storage.from(AUDIO_BUCKET).upload(path, this.recorder.toWav(), { contentType: "audio/wav" });
      if (error) throw error;
    } catch (error) {
      console.error("call audio failed", this.callId, error);
    }
  }

  // Provider errors can quote the credential they rejected.
  private scrub(text: string): string {
    const { META_API_KEY, TTS_API_KEY, SUPABASE_SERVICE_ROLE_KEY, SIM_ACCESS_CODE, PHONE_WEBHOOK_TOKEN } = this.env;
    return [META_API_KEY, TTS_API_KEY, SUPABASE_SERVICE_ROLE_KEY, SIM_ACCESS_CODE, PHONE_WEBHOOK_TOKEN].reduce((clean, secret) => (secret ? clean.replaceAll(secret, "[redacted]") : clean), text);
  }

  // The end of a call always gets through, so a runaway call still shows how it finished.
  private log(kind: string, payload: Record<string, unknown> = {}): number {
    const seq = this.logs.length;
    if (seq >= MAX_LOG_ROWS && !this.ended) return seq;
    const now = Date.now();
    this.logs.push({ call_sid: this.callId, seq, at: new Date(now).toISOString(), ms: now - this.startedAt, kind, payload: clip(payload) });
    return seq;
  }

  private record(role: "caller" | "agent", text: string): void {
    this.transcript.push({ role, text, at: new Date().toISOString() });
  }

  private mark(key: keyof TurnMetrics): void {
    this.current[key] ??= this.speechEndedAt ? Date.now() - this.speechEndedAt : 0;
  }

  private emit(name: string, data: Record<string, unknown> = {}): void {
    this.log(name, data);
    this.transport.sendEvent({ type: "agent_event", name, ...data });
  }
}
