import { Phone, PhoneOff } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceLine, TraceTitle } from "@/components/ui/trace";
import { won } from "../orders";

const WS_URL = import.meta.env.VITE_VOICE_WS_URL as string;
const HTTP_URL = WS_URL.replace(/^ws/, "http").replace(/\/sim\/stream$/, "");
const UNREGISTERED = "+821099999999";
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
const INPUT_RATE = 16000;
const FRAME_BYTES = 640;
const FRAME_MS = 20;

const STATUS_TEXT = { idle: "대기", connecting: "연결 중", in_call: "통화 중", transferred: "상담원 연결", ended: "통화 종료" };

const STATE_TEXT: Record<string, string> = {
  GREETING: "인사",
  INTENT: "주문 파악",
  BUILD_CART: "메뉴 담기",
  CONFIRM: "복창, 확인 대기",
  PLACE_ORDER: "주문 접수",
  DONE: "완료",
  ONBOARD_NEW: "미등록 번호",
};

const TOOL_LABEL: Record<string, string> = {
  identify_customer: "고객 확인",
  get_recent_orders: "최근 주문 조회",
  search_stores: "가게 검색",
  search_menu: "메뉴 검색",
  cart_add: "장바구니 담기",
  cart_remove: "장바구니 빼기",
  cart_get: "장바구니 확인",
  get_quote: "금액 계산",
  request_confirmation: "복창 문구 생성",
  place_order: "주문 실행",
};

type Status = keyof typeof STATUS_TEXT;

type TimelineEntry =
  | { kind: "line"; who: "caller" | "agent"; text: string; at: number }
  | { kind: "order"; storeName: string; total: number; eta: number; at: number }
  | { kind: "note"; text: string; at: number };

interface Sms { to: string; text: string; at: number }
interface ActivityEntry { id: number; label: string; ok: boolean; detail?: unknown }

function formatPhone(e164: string): string {
  const local = e164.replace(/^\+82/, "0");
  return local.length === 11 ? `${local.slice(0, 3)}-${local.slice(3, 7)}-${local.slice(7)}` : local;
}

function useElapsed(running: boolean): string {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    setSeconds(0);
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

const ms = (value: number | undefined) => (value === undefined ? "없음" : `${value.toLocaleString("ko-KR")}ms`);

export function SimulatorPage() {
  const [code, setCode] = useState(() => localStorage.getItem("sim-code") ?? "");
  const [verified, setVerified] = useState(false);
  const [checking, setChecking] = useState(false);
  const [callers, setCallers] = useState<{ name: string; phone_e164: string }[]>([]);
  const [callerId, setCallerId] = useState(UNREGISTERED);
  const [developer, setDeveloper] = useState(false);
  const [phoneQuality, setPhoneQuality] = useState(true);
  const [noise, setNoise] = useState(0);
  const [delayMs, setDelayMs] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [partial, setPartial] = useState("");
  const [state, setState] = useState("");
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [latency, setLatency] = useState<Record<string, number>>({});
  const [cost, setCost] = useState<number | null>(null);
  const [sms, setSms] = useState<Sms[]>([]);
  const [typed, setTyped] = useState("");
  const [replayFile, setReplayFile] = useState<File | null>(null);
  const [silentMode, setSilentMode] = useState(false);

  const socket = useRef<WebSocket | null>(null);
  const capture = useRef<AudioWorkletNode | null>(null);
  const playback = useRef<AudioWorkletNode | null>(null);
  const cleanup = useRef<() => void>(() => {});
  const meter = useRef<HTMLDivElement | null>(null);
  const activityId = useRef(0);
  const delayRef = useRef(0);
  delayRef.current = delayMs;

  const elapsed = useElapsed(status === "in_call");
  const inCall = status === "in_call" || status === "connecting";

  const verifyCode = async (value: string) => {
    setChecking(true);
    try {
      const response = await fetch(`${HTTP_URL}/sim/callers`, { headers: { "x-access-code": value } });
      if (!response.ok) throw new Error(response.status === 401 ? "접속 코드가 맞지 않습니다. 다시 입력해 주세요." : "서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
      const list = await response.json();
      localStorage.setItem("sim-code", value);
      setCallers(list);
      setCallerId((current) => (current === UNREGISTERED && list[0] ? list[0].phone_e164 : current));
      setVerified(true);
      setError("");
    } catch (failure) {
      setError(failure instanceof TypeError ? "서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요." : (failure as Error).message);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (code) void verifyCode(code);
  }, []);

  useEffect(() => { capture.current?.port.postMessage({ phoneQuality }); }, [phoneQuality]);
  useEffect(() => { capture.current?.port.postMessage({ noise }); }, [noise]);
  useEffect(() => () => cleanup.current(), []);

  const send = (data: string | ArrayBuffer) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    if (delayRef.current) setTimeout(() => socket.current?.readyState === WebSocket.OPEN && socket.current.send(data), delayRef.current);
    else socket.current.send(data);
  };

  const logActivity = (label: string, ok = true, detail?: unknown) => {
    setActivity((all) => [{ id: activityId.current++, label, ok, detail }, ...all].slice(0, 40));
  };

  const onAgentEvent = (message: Record<string, any>) => {
    switch (message.name) {
      case "state":
        setState(message.state);
        break;
      case "latency":
        setLatency(message);
        break;
      case "call_cost":
        setCost(message.cost_usd);
        break;
      case "tool_call":
        logActivity(TOOL_LABEL[message.tool] ?? message.tool, !message.result?.error, message.result);
        break;
      case "confirmation":
        logActivity(message.outcome === "confirmed" ? "고객이 네라고 확인" : "고객이 복창 내용을 거절", message.outcome === "confirmed");
        break;
      case "barge_in":
        logActivity("고객이 끼어들어 재생 중단");
        break;
      case "dtmf":
        logActivity(`키패드 ${message.digit}번`);
        break;
      case "fail_safe":
        logActivity("장애로 상담원 연결 전환", false, message.reason);
        break;
    }
  };

  const onServerMessage = (data: string | ArrayBuffer) => {
    if (typeof data !== "string") {
      const pcm = new Int16Array(data);
      playback.current?.port.postMessage(Float32Array.from(pcm, (sample) => sample / 0x8000));
      return;
    }
    const message = JSON.parse(data);
    switch (message.type) {
      case "start_ack":
        setStatus("in_call");
        setState(message.registered ? "GREETING" : "ONBOARD_NEW");
        setSilentMode(message.tts === "none");
        break;
      case "clear":
        playback.current?.port.postMessage("clear");
        break;
      case "transcript":
        if (message.final) {
          setPartial("");
          setTimeline((all) => [...all, { kind: "line", who: "caller", text: message.text, at: Date.now() }]);
        } else {
          setPartial(message.text);
        }
        break;
      case "assistant_text":
        setTimeline((all) => [...all, { kind: "line", who: "agent", text: message.text, at: Date.now() }]);
        break;
      case "guardian_sms":
        setSms((all) => [...all, { to: message.to, text: message.text, at: Date.now() }]);
        break;
      case "order_placed":
        setTimeline((all) => [...all, { kind: "order", storeName: message.storeName, total: message.order.total, eta: message.order.eta_minutes, at: Date.now() }]);
        break;
      case "fail_safe":
        // Stand-in for the pre-recorded notice: TTS may be the very thing that failed.
        speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(message.text), { lang: "ko-KR", rate: 0.9 }));
        setTimeline((all) => [...all, { kind: "line", who: "agent", text: message.text, at: Date.now() }]);
        break;
      case "transfer":
        setStatus("transferred");
        setTimeline((all) => [...all, { kind: "note", text: "상담원에게 연결했습니다", at: Date.now() }]);
        break;
      case "hangup":
        if (message.reason) setError(message.reason);
        setStatus((current) => (current === "transferred" ? current : "ended"));
        break;
      case "agent_event":
        onAgentEvent(message);
        break;
    }
  };

  const startCall = async () => {
    setError("");
    setTimeline([]);
    setActivity([]);
    setLatency({});
    setCost(null);
    setSms([]);
    setPartial("");
    setState("");
    setStatus("connecting");

    try {
      const context = new AudioContext({ sampleRate: INPUT_RATE });
      await context.audioWorklet.addModule("/pcm-worklet.js");
      // The agent's 24 kHz voice needs its own context, since an AudioContext has one rate.
      const output = new AudioContext({ sampleRate: 24000 });
      await output.audioWorklet.addModule("/pcm-worklet.js");
      const player = new AudioWorkletNode(output, "playback");
      player.connect(output.destination);
      playback.current = player;

      const node = new AudioWorkletNode(context, "capture");
      capture.current = node;
      node.port.postMessage({ phoneQuality, noise });

      let stream: MediaStream | null = null;
      let stopReplay = () => {};
      if (replayFile) {
        stopReplay = await replayWav(replayFile, context, send);
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        context.createMediaStreamSource(stream).connect(node);
        node.port.onmessage = ({ data }) => {
          send(data);
          let peak = 0;
          for (const sample of new Int16Array(data)) peak = Math.max(peak, Math.abs(sample));
          meter.current?.style.setProperty("--level", String(Math.min(1, (peak / 0x7fff) * 1.6)));
        };
      }

      const callId = crypto.randomUUID();
      const ws = new WebSocket(`${WS_URL}?callId=${callId}&code=${encodeURIComponent(code)}`);
      ws.binaryType = "arraybuffer";
      socket.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: "start", callerId, phoneQuality }));
      ws.onmessage = ({ data }) => onServerMessage(data);
      ws.onerror = () => setError("서버에 연결하지 못했습니다. 잠시 뒤 다시 걸어 주세요.");
      ws.onclose = () => {
        setStatus((current) => (current === "transferred" ? current : "ended"));
        meter.current?.style.setProperty("--level", "0");
        cleanup.current();
      };

      cleanup.current = () => {
        stopReplay();
        stream?.getTracks().forEach((track) => track.stop());
        void context.close();
        void output.close();
        capture.current = null;
        playback.current = null;
        cleanup.current = () => {};
      };
    } catch (failure) {
      cleanup.current();
      setStatus("idle");
      const name = failure instanceof Error ? failure.name : "";
      setError(name === "NotAllowedError" ? "마이크를 쓸 수 있어야 전화를 걸 수 있습니다. 브라우저 주소창에서 마이크를 허용해 주세요." : "전화를 걸지 못했습니다. 다시 걸어 주세요.");
    }
  };

  const hangUp = () => {
    send(JSON.stringify({ type: "hangup" }));
    socket.current?.close();
  };

  const submitTyped = (event: FormEvent) => {
    event.preventDefault();
    if (!typed.trim()) return;
    send(JSON.stringify({ type: "utterance", text: typed }));
    setTyped("");
  };

  if (!verified) {
    return (
      <div className="flex flex-1 items-center justify-center bg-muted p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-xl">전화 걸기</CardTitle>
            <CardDescription>받으신 접속 코드를 입력하세요.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(event) => { event.preventDefault(); void verifyCode(code); }}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="sim-code">접속 코드</FieldLabel>
                  <Input id="sim-code" type="password" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} required />
                </Field>
                {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
                <Button type="submit" disabled={checking || !code}>확인</Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  const callerName = callers.find((caller) => caller.phone_e164 === callerId)?.name;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Field className="w-72">
          <FieldLabel htmlFor="caller">어느 번호로 걸까요?</FieldLabel>
          <Select value={callerId} onValueChange={setCallerId} disabled={inCall}>
            <SelectTrigger id="caller" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {callers.map((caller) => <SelectItem key={caller.phone_e164} value={caller.phone_e164}>{caller.name} ({formatPhone(caller.phone_e164)})</SelectItem>)}
                <SelectItem value={UNREGISTERED}>등록 안 된 번호 ({formatPhone(UNREGISTERED)})</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <div className="flex items-center gap-2 text-sm">
          <Switch id="developer" checked={developer} onCheckedChange={setDeveloper} />
          <label htmlFor="developer">개발자 보기</label>
        </div>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      <div className={developer ? "grid flex-1 items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)_340px]" : "grid flex-1 items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)]"}>
        <section aria-label="전화기" className="mx-auto flex w-full max-w-[300px] flex-col gap-3">
          <div className="deskphone flex flex-col gap-4">
            <div className="lcd" data-lit={inCall || status === "transferred"} role="status">
              <div className="flex justify-between text-sm font-bold"><span>{STATUS_TEXT[status]}</span><span>{status === "in_call" ? elapsed : "--:--"}</span></div>
              <div className="text-xl font-extrabold leading-relaxed whitespace-nowrap">{formatPhone(callerId)}</div>
              <div className="flex items-center justify-between text-sm font-bold">
                <span>{callerName ?? "미등록"}</span>
                <div className="meter" ref={meter} aria-hidden="true"><i /><i /><i /><i /><i /></div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {KEYS.map((key) => (
                <button key={key} type="button" className="keycap" disabled={status !== "in_call"} aria-label={`${key}번`} onClick={() => send(JSON.stringify({ type: "dtmf", digit: key }))}>{key}</button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button type="button" className="callkey" data-kind="call" disabled={inCall} onClick={startCall} aria-label="전화 걸기"><Phone /></button>
              <button type="button" className="callkey" data-kind="end" disabled={!inCall && status !== "transferred"} onClick={hangUp} aria-label="전화 끊기"><PhoneOff /></button>
            </div>
          </div>
          <p className="text-center text-sm text-muted-foreground">헤드셋을 쓰면 더 잘 들립니다. 확인할 때 1번은 네, 2번은 아니요, 0번은 상담원입니다.</p>
        </section>

        <section aria-label="통화 내용" className="flex h-[min(72svh,720px)] min-h-[440px] flex-col rounded-xl border">
          {silentMode && inCall && <Alert className="m-3 w-auto"><AlertDescription>음성 안내가 아직 꺼져 있어 답변은 글자로만 나옵니다.</AlertDescription></Alert>}
          {timeline.length === 0 && !partial ? (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyTitle>{status === "connecting" ? "연결하고 있습니다" : "초록 버튼을 눌러 전화를 거세요"}</EmptyTitle>
                <EmptyDescription>나눈 말이 여기에 글자로 표시됩니다.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <MessageScrollerProvider autoScroll>
              <MessageScroller className="min-h-0 flex-1">
                <MessageScrollerViewport>
                  <MessageScrollerContent className="gap-4 p-4">
                    {timeline.map((entry, index) => (
                      <MessageScrollerItem key={index} messageId={String(index)} className="overflow-visible px-px">
                        {entry.kind === "note" && <Marker><MarkerContent>{entry.text}</MarkerContent></Marker>}
                        {entry.kind === "order" && (
                          <Card size="sm" className="mx-auto my-1 w-full max-w-xs">
                            <CardHeader>
                              <CardTitle>주문이 접수됐습니다</CardTitle>
                              <CardDescription>{entry.storeName}, {won(entry.total)}, 약 {entry.eta}분 뒤 도착</CardDescription>
                            </CardHeader>
                          </Card>
                        )}
                        {entry.kind === "line" && (
                          <Message align={entry.who === "caller" ? "end" : "start"}>
                            <MessageContent>
                              {(timeline[index - 1] as { who?: string } | undefined)?.who !== entry.who && <MessageHeader>{entry.who === "caller" ? callerName ?? "고객" : "콜오더"}</MessageHeader>}
                              <Bubble variant={entry.who === "caller" ? "default" : "muted"} align={entry.who === "caller" ? "end" : "start"}>
                                <BubbleContent className="text-lg">{entry.text}</BubbleContent>
                              </Bubble>
                            </MessageContent>
                          </Message>
                        )}
                      </MessageScrollerItem>
                    ))}
                    {partial && (
                      <MessageScrollerItem messageId="partial">
                        <Message align="end">
                          <MessageContent>
                            <Bubble variant="outline" align="end"><BubbleContent className="text-lg text-muted-foreground">{partial}</BubbleContent></Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    )}
                    {sms.map((message, index) => (
                      <MessageScrollerItem key={`sms-${index}`} messageId={`sms-${index}`}>
                        <Marker><MarkerContent>{formatPhone(message.to)} 보호자에게 문자를 보냈습니다: {message.text}</MarkerContent></Marker>
                      </MessageScrollerItem>
                    ))}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>
            </MessageScrollerProvider>
          )}
        </section>

        {developer && (
          <aside aria-label="개발자 보기" className="flex flex-col gap-5 rounded-xl border p-4 text-sm">
            <dl className="flex flex-col gap-1">
              {[
                ["단계", STATE_TEXT[state] ?? "없음"],
                ["음성 인식 확정", ms(latency.final_ms)],
                ["LLM 첫 토큰", ms(latency.llm_first_token_ms)],
                ["첫 음성 (목표 1,500ms)", ms(latency.tts_first_chunk_ms)],
                ["통화 비용", cost === null ? "끊은 뒤 계산" : `$${cost.toFixed(4)}`],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3"><dt className="text-muted-foreground">{label}</dt><dd className="font-medium tabular-nums">{value}</dd></div>
              ))}
            </dl>
            <Separator />
            <form className="flex gap-2" onSubmit={submitTyped}>
              <Input aria-label="말 대신 글자로 입력" placeholder="말 대신 글자로 입력" value={typed} disabled={status !== "in_call"} onChange={(event) => setTyped(event.target.value)} />
              <Button type="submit" variant="secondary" disabled={status !== "in_call" || !typed.trim()}>보내기</Button>
            </form>
            <Separator />
            <FieldGroup className="gap-4">
              <Field orientation="horizontal">
                <Switch id="quality" checked={phoneQuality} onCheckedChange={setPhoneQuality} />
                <FieldLabel htmlFor="quality">통화음질 (8kHz)</FieldLabel>
              </Field>
              <Field>
                <FieldLabel>배경 소음 {Math.round((noise / 0.1) * 100)}%</FieldLabel>
                <Slider aria-label="배경 소음" min={0} max={0.1} step={0.005} value={[noise]} onValueChange={([value]) => setNoise(value ?? 0)} />
              </Field>
              <Field>
                <FieldLabel>네트워크 지연 {delayMs}ms</FieldLabel>
                <Slider aria-label="네트워크 지연" min={0} max={1000} step={50} value={[delayMs]} onValueChange={([value]) => setDelayMs(value ?? 0)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="replay">녹음 파일로 말하기 (WAV)</FieldLabel>
                <Input id="replay" type="file" accept=".wav,audio/wav" disabled={inCall} onChange={(event) => setReplayFile(event.target.files?.[0] ?? null)} />
              </Field>
            </FieldGroup>
            <Separator />
            <div className="flex flex-col gap-2">
              <h2 className="font-semibold">에이전트 활동 <Badge variant="secondary">{activity.length}</Badge></h2>
              <Trace className="max-h-64 overflow-y-auto">
                {activity.map((entry) => entry.detail === undefined ? (
                  <TraceLine key={entry.id} status={entry.ok ? undefined : "error"}><TraceTitle>{entry.label}</TraceTitle></TraceLine>
                ) : (
                  <TraceCollapsible key={entry.id}>
                    <TraceCollapsibleTrigger><TraceLine status={entry.ok ? undefined : "error"}><TraceTitle>{entry.label}</TraceTitle></TraceLine></TraceCollapsibleTrigger>
                    <TraceCollapsibleContent><code className="block text-xs break-all whitespace-pre-wrap">{typeof entry.detail === "string" ? entry.detail : JSON.stringify(entry.detail, null, 1)}</code></TraceCollapsibleContent>
                  </TraceCollapsible>
                ))}
              </Trace>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

// Streams a recording in real-time 20 ms frames, standing in for the microphone.
async function replayWav(file: File, context: AudioContext, send: (data: ArrayBuffer) => void): Promise<() => void> {
  const decoded = await context.decodeAudioData(await file.arrayBuffer());
  const samples = decoded.getChannelData(0);
  const pcm = Int16Array.from(samples, (sample) => Math.max(-1, Math.min(1, sample)) * 0x7fff);
  let offset = 0;
  const silence = new ArrayBuffer(FRAME_BYTES);
  const timer = setInterval(() => {
    if (offset >= pcm.length) return send(silence.slice(0));
    send(pcm.slice(offset, offset + FRAME_BYTES / 2).buffer);
    offset += FRAME_BYTES / 2;
  }, FRAME_MS);
  return () => clearInterval(timer);
}
