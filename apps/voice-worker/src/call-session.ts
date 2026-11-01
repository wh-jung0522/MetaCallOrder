import { CallRepository, CustomerRepository, SupabaseMerchantAdapter, type Customer, type OrderResult } from "@callorder/adapters";
import { isBargeIn, isHandoffRequest, isRepeatRequest, nextLanguage, OrderSession, runConversationTurn, type Language, type OrderToolContext, type TurnAction } from "@callorder/agents";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DurableObject } from "cloudflare:workers";
import OpenAI from "openai";
import { createDb, missingSecrets, type Env } from "./env";
import { MuseStt } from "./stt";
import { PhoneTransport, SimulatorTransport, type TelephonyTransport } from "./transport";
import { SilentTts, SonioxTts, TTS_SAMPLE_RATE, TypecastTts, type Tts } from "./tts";

const PHRASES: Record<Language, { greeting: string; otherLanguage: string; silence: string; failSafe: string; handoff: string; noOperator: string; ordered(minutes: number): string }> = {
  ko: {
    greeting: "안녕하세요, 콜오더 주문 전화입니다. AI가 주문을 도와드립니다. 통화 내용은 주문 처리를 위해 기록됩니다.",
    otherLanguage: "한국어로 말씀하셔도 됩니다.",
    silence: "천천히 말씀하셔도 됩니다.",
    failSafe: "죄송합니다. 지금 연결이 원활하지 않아 상담원에게 연결해 드릴게요.",
    handoff: "상담원에게 연결해 드릴게요.",
    noOperator: "죄송합니다. 지금은 상담원 연결이 되지 않습니다. 잠시 후 다시 전화해 주세요.",
    ordered: (minutes) => `주문이 완료되었습니다. 약 ${minutes}분 뒤 도착합니다. 감사합니다.`,
  },
  en: {
    greeting: "Hello, this is CallOrder. An AI will help with your order, and this call is recorded to process it.",
    otherLanguage: "You can also speak English.",
    silence: "Please take your time.",
    failSafe: "I'm sorry, the connection is having trouble. Let me connect you to an agent.",
    handoff: "Let me connect you to an agent.",
    noOperator: "I'm sorry, no agent is available right now. Please call again a little later.",
    ordered: (minutes) => `Your order is placed. It should arrive in about ${minutes} minutes. Thank you.`,
  },
};
const HANDOFF_TARGET = "상담원";
const SILENCE_MS = 7000;
const MAX_SILENCE_PROMPTS = 3;
const MAX_CALL_MS = 15 * 60_000;
const SLOW_DOWN = 0.1;
const TTS_DRAIN_TIMEOUT_MS = 15_000;

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

  override async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Recent compatibility dates default to Blob, which reads as zero-length audio here.
    server.binaryType = "arraybuffer";
    server.accept();
    const url = new URL(request.url);
    this.callId = url.searchParams.get("callId")!;
    server.addEventListener("message", (event) => {
      if (this.transport || typeof event.data !== "string") return;
      const start = JSON.parse(event.data) as { type?: string; event?: string; callerId?: string };
      // The Worker signed this caller id before routing here; the simulator states its own.
      const phoneCaller = url.pathname === "/phone/stream" ? url.searchParams.get("caller") : null;
      if (phoneCaller ? start.event !== "start" : start.type !== "start" || !start.callerId) return;
      const callerId = phoneCaller ?? start.callerId!;
      this.begin(server, callerId, phoneCaller ? new PhoneTransport(server, callerId) : new SimulatorTransport(server, callerId)).catch((error) => {
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

    this.db = createDb(this.env);
    this.calls = new CallRepository(this.db);
    const customers = new CustomerRepository(this.db);
    this.llm = new OpenAI({ apiKey: this.env.META_API_KEY, baseURL: this.env.META_BASE_URL, maxRetries: 1 });

    // Anyone with the simulator can pick any caller id, so real customers must stay out of reach there. A phone caller id comes from the carrier.
    const found = await customers.findByPhone(callerId);
    this.customer = transport.kind === "phone" || found?.is_demo ? found : null;
    this.spokenRate = this.customer?.preferred_speech_rate ?? 0.9;
    this.session.language = callerId.startsWith("+82") ? "ko" : "en";

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
    transport.onAudio((pcm) => this.stt?.sendAudio(pcm));
    this.callTimer = setTimeout(() => this.endWith("max_duration"), MAX_CALL_MS);

    await this.calls.start(this.callId, this.customer?.id ?? null);

    const ttsOptions = { url: this.env.TTS_URL, apiKey: this.env.TTS_API_KEY, model: this.env.TTS_MODEL, voice: this.env.TTS_VOICE };
    const ttsHandlers = {
      onAudio: (pcm: Int16Array) => this.onTtsAudio(pcm),
      onFirstChunk: () => this.mark("tts_first_chunk_ms"),
      onFailure: (reason: string) => this.failSafe(reason),
    };
    if (this.env.TTS_PROVIDER === "typecast") this.tts = new TypecastTts(ttsHandlers, ttsOptions);
    if (this.env.TTS_PROVIDER === "soniox") {
      const tts = new SonioxTts(ttsHandlers, ttsOptions);
      await tts.connect();
      this.tts = tts;
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
      },
      onFinal: (text) => this.onFinal(text),
      onFailure: (reason) => this.failSafe(reason),
    });
    await this.stt.connect({
      url: this.env.META_STT_URL,
      apiKey: this.env.META_API_KEY,
      model: this.env.META_STT_MODEL,
      keywords: await customers.sttKeywords(100),
    });

    const language = this.session.language;
    this.say(PHRASES[language].greeting);
    this.say(PHRASES[language === "ko" ? "en" : "ko"].otherLanguage, language === "ko" ? "en" : "ko");
    const opening = this.customer
      ? `전화가 연결됐습니다. ${this.customer.name} 고객님께 짧게 인사하고, 최근 주문이 있는지 order_agent로 확인한 뒤 제안하세요.`
      : "전화가 연결됐습니다. 미등록 번호입니다.";
    this.messages.push({ role: "user", content: `[시스템 상태] ${opening}` });
    this.enqueueTurn();
  }

  private onPartial(text: string): void {
    this.transport.sendEvent({ type: "transcript", text, final: false });
    if (this.isPlaying() && isBargeIn(text)) this.bargeIn();
  }

  private bargeIn(): void {
    if (this.bargedIn) return;
    this.bargedIn = true;
    this.turnAbort?.abort();
    this.tts.cancel();
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
    if (overlapped && !isBargeIn(utterance)) return;
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

  private say(text: string, language: Language = this.session.language): void {
    if (this.ended) return;
    this.lastSpoken = text;
    this.session.noteSpoken(text);
    this.record("agent", text);
    this.usage.ttsChars += text.length;
    this.transport.sendEvent({ type: "assistant_text", text });
    this.tts.speak(text, this.spokenRate, language);
    this.playingUntil = Math.max(this.playingUntil, Date.now());
  }

  private onTtsAudio(pcm: Int16Array): void {
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

  private failSafe(reason: string): void {
    if (this.ended) return;
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
    // Transcripts live in Supabase under the 30-day retention job, so the DO keeps nothing.
    await this.ctx.storage.deleteAll();
  }

  private record(role: "caller" | "agent", text: string): void {
    this.transcript.push({ role, text, at: new Date().toISOString() });
  }

  private mark(key: keyof TurnMetrics): void {
    this.current[key] ??= this.speechEndedAt ? Date.now() - this.speechEndedAt : 0;
  }

  private emit(name: string, data: Record<string, unknown> = {}): void {
    this.transport.sendEvent({ type: "agent_event", name, ...data });
  }
}
