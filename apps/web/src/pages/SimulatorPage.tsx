import { BatteryFull, Delete, Grid3x3, Mic, MicOff, Phone, PhoneOff, SignalHigh, Wifi } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
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
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceLine, TraceTitle } from "@/components/ui/trace";
import { useT, type Pair, type T } from "../i18n";
import { won } from "../orders";

const WS_URL = import.meta.env.VITE_VOICE_WS_URL as string;
const HTTP_URL = WS_URL.replace(/^ws/, "http").replace(/\/sim\/stream$/, "");
const WATCH_URL = WS_URL.replace(/\/sim\/stream$/, "/sim/watch");
const UNREGISTERED = "+821099999999";
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
const KEY_LETTERS: Record<string, string> = { "2": "ABC", "3": "DEF", "4": "GHI", "5": "JKL", "6": "MNO", "7": "PQRS", "8": "TUV", "9": "WXYZ" };

// 010-1234-5678 and +1 415 555 0101 both become E.164. Null when it cannot be a phone number.
function toE164(typed: string): string | null {
  const digits = typed.replace(/[^\d+]/g, "");
  const e164 = digits.startsWith("0") ? `+82${digits.slice(1)}` : digits.startsWith("+") ? digits : `+${digits}`;
  return /^\+\d{8,15}$/.test(e164) ? e164 : null;
}
const INPUT_RATE = 16000;
const FRAME_BYTES = 640;
const FRAME_MS = 20;

const STATUS_TEXT = {
  idle: ["대기", "Ready"],
  connecting: ["연결 중", "Connecting"],
  in_call: ["통화 중", "In call"],
  transferred: ["상담원 연결", "With operator"],
  ended: ["통화 종료", "Call ended"],
} satisfies Record<string, Pair>;

const STATE_TEXT: Record<string, Pair> = {
  GREETING: ["인사", "Greeting"],
  INTENT: ["주문 파악", "Understanding the order"],
  BUILD_CART: ["메뉴 담기", "Adding items"],
  CONFIRM: ["복창, 확인 대기", "Reading back, waiting for yes"],
  PLACE_ORDER: ["주문 접수", "Placing the order"],
  DONE: ["완료", "Done"],
  ONBOARD_NEW: ["미등록 번호", "Unregistered number"],
};

const TOOL_LABEL: Record<string, Pair> = {
  identify_customer: ["고객 확인", "Check customer"],
  get_recent_orders: ["최근 주문 조회", "Look up recent orders"],
  search_stores: ["가게 검색", "Search stores"],
  search_menu: ["메뉴 검색", "Search menu"],
  cart_add: ["장바구니 담기", "Add to cart"],
  cart_remove: ["장바구니 빼기", "Remove from cart"],
  cart_get: ["장바구니 확인", "Check cart"],
  get_quote: ["금액 계산", "Work out the price"],
  request_confirmation: ["복창 문구 생성", "Write the read-back"],
  place_order: ["주문 실행", "Place order"],
};

const NONE: Pair = ["없음", "None"];
// Each number answers in its own language first and understands both. The caller's language comes first on screen.
const PHONE_LINES = [
  { lang: "ko", flag: "🇰🇷", number: "070-5276-7404", tel: "07052767404", name: ["한국 번호", "Korean number"] },
  { lang: "en", flag: "🇺🇸", number: "+1 515-349-6768", tel: "+15153496768", name: ["미국 번호", "US number"] },
] as const;
const BAD_CODE: Pair = ["접속 코드가 맞지 않습니다. 다시 입력해 주세요.", "That access code is not right. Please try again."];
const NO_SERVER: Pair = ["서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.", "Could not reach the server. Please try again in a moment."];

type Status = keyof typeof STATUS_TEXT;

type TimelineEntry =
  | { kind: "line"; who: "caller" | "agent"; text: string; at: number }
  | { kind: "order"; storeName: string; total: number; eta: number; at: number }
  | { kind: "note"; text: Pair; at: number };

interface Sms { to: string; text: string; at: number }
interface ActivityEntry { id: number; label: Pair; ok: boolean; detail?: unknown }

function formatPhone(e164: string): string {
  if (e164.startsWith("+1")) return e164.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "+1 $1-$2-$3");
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

const ms = (value: number | undefined, t: T) => (value === undefined ? t(...NONE) : `${value.toLocaleString("ko-KR")}ms`);

export function SimulatorPage() {
  const { t, lang } = useT();
  const [code, setCode] = useState(() => localStorage.getItem("sim-code") ?? "");
  const [mode, setMode] = useState<"web" | "phone">("phone");
  const [verified, setVerified] = useState(false);
  const [checking, setChecking] = useState(false);
  const [callers, setCallers] = useState<{ name: string; phone_e164: string }[]>([]);
  const [callerId, setCallerId] = useState(() => localStorage.getItem("sim-my-number") ?? UNREGISTERED);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [showKeypad, setShowKeypad] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 10_000);
    return () => clearInterval(timer);
  }, []);
  const [developer, setDeveloper] = useState(false);
  const [phoneQuality, setPhoneQuality] = useState(true);
  const [noise, setNoise] = useState(0);
  const [delayMs, setDelayMs] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<Pair | null>(null);
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
      if (!response.ok) return setError(response.status === 401 ? BAD_CODE : NO_SERVER);
      const list = await response.json();
      localStorage.setItem("sim-code", value);
      setCallers(list);
      // The first caller speaks the screen's language, so a Korean screen does not open on a US number.
      const first = list.find((caller: { phone_e164: string }) => caller.phone_e164.startsWith("+82") === (lang === "ko")) ?? list[0];
      setCallerId((current) => (current === UNREGISTERED && first ? first.phone_e164 : current));
      setVerified(true);
      setError(null);
    } catch (failure) {
      const { message } = failure as Error;
      setError(failure instanceof TypeError ? NO_SERVER : [message, message]);
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

  const logActivity = (label: Pair, ok = true, detail?: unknown) => {
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
        logActivity(TOOL_LABEL[message.tool] ?? [message.tool, message.tool], !message.result?.error, message.result);
        break;
      case "confirmation":
        logActivity(message.outcome === "confirmed" ? ["고객이 네라고 확인", "Customer said yes"] : ["고객이 복창 내용을 거절", "Customer said no to the read-back"], message.outcome === "confirmed");
        break;
      case "barge_in":
        logActivity(["고객이 끼어들어 재생 중단", "Customer interrupted, playback stopped"]);
        break;
      case "dtmf":
        logActivity([`키패드 ${message.digit}번`, `Keypad ${message.digit}`]);
        break;
      case "fail_safe":
        logActivity(["장애로 상담원 연결 전환", "Error, sent to operator"], false, message.reason);
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
      case "voice_off":
        setSilentMode(true);
        setTimeline((all) => [...all, { kind: "note", text: ["음성을 내보내지 못해 이 통화는 글자로만 이어 갑니다", "Voice is unavailable, so this call continues in text only"], at: Date.now() }]);
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
        speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(message.text), { lang: /[가-힣]/.test(message.text) ? "ko-KR" : "en-US", rate: 0.9 }));
        setTimeline((all) => [...all, { kind: "line", who: "agent", text: message.text, at: Date.now() }]);
        break;
      case "transfer":
        setStatus("transferred");
        setTimeline((all) => [...all, { kind: "note", text: ["상담원에게 연결했습니다", "Connected to an operator"], at: Date.now() }]);
        break;
      case "hangup":
        if (message.reason) setError([message.reason, message.reason]);
        setStatus((current) => (current === "transferred" ? current : "ended"));
        break;
      case "agent_event":
        onAgentEvent(message);
        break;
    }
  };

  const startCall = async () => {
    setError(null);
    const e164 = toE164(callerId);
    if (!e164) return setError(["전화번호를 확인해 주세요. 예: 010-1234-5678", "Please check the phone number. For example: +1 415 555 0101"]);
    if (!callers.some((caller) => caller.phone_e164 === e164)) localStorage.setItem("sim-my-number", e164);
    setCallerId(e164);
    mutedRef.current = false;
    setMuted(false);
    setShowKeypad(false);
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
          // Silence, not nothing: the speech service ends a session whose audio stops arriving.
          send(mutedRef.current ? new ArrayBuffer(data.byteLength) : data);
          let peak = 0;
          for (const sample of new Int16Array(data)) peak = Math.max(peak, Math.abs(sample));
          meter.current?.style.setProperty("--level", String(Math.min(1, (peak / 0x7fff) * 1.6)));
        };
      }

      const callId = crypto.randomUUID();
      const ws = new WebSocket(`${WS_URL}?callId=${callId}&code=${encodeURIComponent(code)}`);
      ws.binaryType = "arraybuffer";
      socket.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: "start", callerId: e164, phoneQuality, lang }));
      ws.onmessage = ({ data }) => onServerMessage(data);
      ws.onerror = () => setError(["서버에 연결하지 못했습니다. 잠시 뒤 다시 걸어 주세요.", "Could not reach the server. Please call again in a moment."]);
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
      setError(name === "NotAllowedError" ? ["마이크를 쓸 수 있어야 전화를 걸 수 있습니다. 브라우저 주소창에서 마이크를 허용해 주세요.", "You need a microphone to make a call. Please allow the microphone in your browser's address bar."] : ["전화를 걸지 못했습니다. 다시 걸어 주세요.", "Could not make the call. Please try again."]);
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
            <CardTitle className="text-xl">{t("전화 걸기", "Make a call")}</CardTitle>
            <CardDescription>{t("받으신 접속 코드를 입력하세요.", "Enter the access code you received.")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(event) => { event.preventDefault(); void verifyCode(code); }}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="sim-code">{t("접속 코드", "Access code")}</FieldLabel>
                  <Input id="sim-code" type="password" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} required />
                </Field>
                {error && <Alert variant="destructive"><AlertDescription>{t(...error)}</AlertDescription></Alert>}
                <Button type="submit" disabled={checking || !code}>{t("확인", "Continue")}</Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  const callerName = callers.find((caller) => caller.phone_e164 === callerId)?.name;
  const isPreset = Boolean(callerName) || callerId === UNREGISTERED;
  const dialDigit = (key: string) => setCallerId((current) => (isPreset ? "" : current) + (key === "*" ? "+" : key));
  const pressKey = (key: string) => send(JSON.stringify({ type: "dtmf", digit: key }));
  const onCall = inCall || status === "transferred";

  const modeSwitch = (
    <div role="group" aria-label={t("전화 방법", "How to call")} className="mx-auto flex w-full max-w-sm gap-1 rounded-lg bg-muted p-1">
      <Button variant={mode === "web" ? "default" : "ghost"} className="flex-1" aria-pressed={mode === "web"} disabled={inCall} onClick={() => setMode("web")}>{t("웹 시뮬레이터", "Web simulator")}</Button>
      <Button variant={mode === "phone" ? "default" : "ghost"} className="flex-1" aria-pressed={mode === "phone"} disabled={inCall} onClick={() => setMode("phone")}>{t("실제 전화번호", "Real phone number")}</Button>
    </div>
  );

  if (mode === "phone") {
    return (
      <div className="flex flex-1 flex-col gap-6 bg-muted p-6">
        {modeSwitch}
        <Card className="mx-auto w-full max-w-sm text-center">
          <CardHeader>
            <CardTitle className="text-xl">{t("이 번호로 전화하세요", "Call this number")}</CardTitle>
            <CardDescription>{t("휴대폰으로 걸면 AI가 받아 주문을 도와드립니다. 한국어와 영어 모두 됩니다.", "An AI answers and takes your order, in Korean or English.")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {[...PHONE_LINES].sort((a, b) => Number(b.lang === lang) - Number(a.lang === lang)).map((line) => (
              <a key={line.tel} href={`tel:${line.tel}`} aria-label={`${t(line.name[0], line.name[1])} ${line.number}`} className="text-2xl font-extrabold whitespace-nowrap text-primary underline-offset-4 hover:underline">
                <span aria-hidden="true">{line.flag} </span>{line.number}
              </a>
            ))}
            <p className="text-sm text-muted-foreground">{t("누구나 전화해서 주문할 수 있습니다. 배달지는 시연용 주소로 들어갑니다.", "Anyone can call and order. Orders go to a demo address.")}</p>
          </CardContent>
        </Card>
        <LiveCalls code={code} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4 md:p-6">
      {modeSwitch}
      <div className="flex items-center justify-end gap-2 text-sm">
        <Switch id="developer" checked={developer} onCheckedChange={setDeveloper} />
        <label htmlFor="developer">{t("개발자 보기", "Developer view")}</label>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{t(...error)}</AlertDescription></Alert>}

      <div className={developer ? "grid flex-1 items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)_340px]" : "grid flex-1 items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)]"}>
        <section aria-label={t("전화기", "Phone")} className="mx-auto flex w-full max-w-[300px] flex-col items-center gap-3">
          <div className="handset">
            <div className="handset-screen">
              <div className="flex h-6 items-center justify-between px-1 text-xs font-semibold" aria-hidden="true">
                <span>{clock.toLocaleTimeString(t("ko-KR", "en-US"), { hour: "numeric", minute: "2-digit", hour12: false })}</span>
                <span className="flex items-center gap-1"><SignalHigh className="size-3.5" /><Wifi className="size-3.5" /><BatteryFull className="size-4" /></span>
              </div>

              {onCall ? (
                <div className={`flex flex-1 flex-col items-center ${showKeypad ? "pt-5" : "pt-10"}`} role="status">
                  {!showKeypad && <div className="mb-3 flex size-20 items-center justify-center rounded-full bg-[#636366] text-3xl font-medium">{t("콜", "C")}</div>}
                  <div className="text-2xl font-medium">{t("콜오더", "CallOrder")}</div>
                  <div className="mt-1 text-sm text-[#aeaeb2]">{status === "in_call" ? elapsed : t(...STATUS_TEXT[status])}</div>
                  {!showKeypad && <div className="mt-1 text-xs whitespace-nowrap text-[#8e8e93]">{t("내 번호", "My number")} {callerName ? `${callerName}, ` : ""}{formatPhone(callerId)}</div>}
                  <div className={`meter ${showKeypad ? "mt-2" : "mt-4"}`} ref={meter} aria-hidden="true"><i /><i /><i /><i /><i /></div>

                  {showKeypad ? (
                    <div className="mt-auto grid w-full grid-cols-3 justify-items-center gap-y-2.5">
                      {KEYS.map((key) => (
                        <button key={key} type="button" className="dial-key" style={{ width: 58, height: 58 }} disabled={status !== "in_call"} aria-label={t(`${key}번`, `Key ${key}`)} onClick={() => pressKey(key)}><b>{key}</b></button>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-auto flex w-full justify-around pb-4">
                      <div className="flex flex-col items-center gap-1.5 text-xs">
                        <button type="button" className="round-key" aria-pressed={muted} disabled={status !== "in_call"} aria-label={t("음소거", "Mute")} onClick={() => { mutedRef.current = !muted; setMuted(!muted); }}>{muted ? <MicOff /> : <Mic />}</button>
                        {t("음소거", "Mute")}
                      </div>
                      <div className="flex flex-col items-center gap-1.5 text-xs">
                        <button type="button" className="round-key" disabled={status !== "in_call"} aria-label={t("키패드", "Keypad")} onClick={() => setShowKeypad(true)}><Grid3x3 /></button>
                        {t("키패드", "Keypad")}
                      </div>
                    </div>
                  )}

                  <div className="mt-4 grid w-full grid-cols-3 items-center justify-items-center">
                    {showKeypad && <button type="button" className="col-start-3 row-start-1 text-sm" onClick={() => setShowKeypad(false)}>{t("가리기", "Hide")}</button>}
                    <button type="button" className="round-key col-start-2 row-start-1" data-kind="end" onClick={hangUp} aria-label={t("전화 끊기", "Hang up")}><PhoneOff /></button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-1 flex-col pt-8">
                  <label htmlFor="my-number" className="text-center text-xs text-[#aeaeb2]">{t("내 번호를 누르고 전화를 거세요", "Enter your number, then call")}</label>
                  <input
                    id="my-number"
                    className="dial-number"
                    type="tel"
                    autoComplete="tel"
                    placeholder={t("010-0000-0000", "+1 000 000 0000")}
                    value={callerId === UNREGISTERED ? "" : formatPhone(callerId)}
                    onChange={(event) => setCallerId(event.target.value.replace(/[^\d+]/g, ""))}
                  />
                  <div className="h-5 text-center text-xs text-[#30b350]">{callerName ?? ""}</div>
                  <div className="mt-auto grid grid-cols-3 justify-items-center gap-y-3">
                    {KEYS.map((key) => (
                      <button key={key} type="button" className="dial-key" disabled={key === "#"} aria-label={key === "*" ? "+" : key} onClick={() => dialDigit(key)}>
                        <b>{key === "*" ? "+" : key}</b><small>{KEY_LETTERS[key] ?? ""}</small>
                      </button>
                    ))}
                    <button type="button" className="round-key col-start-2" data-kind="call" onClick={startCall} aria-label={t("콜오더에 전화 걸기", "Call CallOrder")}><Phone className="fill-current" /></button>
                    {callerId && !isPreset && (
                      <button type="button" className="dial-delete flex size-[66px] items-center justify-center rounded-full" aria-label={t("한 글자 지우기", "Delete one digit")} onClick={() => setCallerId((current) => current.slice(0, -1))}><Delete /></button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {!onCall && (
            <div className="flex flex-wrap justify-center gap-1.5">
              {callers.filter((caller) => caller.phone_e164 !== UNREGISTERED).map((caller) => (
                <Button key={caller.phone_e164} size="sm" className="rounded-full" variant={caller.phone_e164 === callerId ? "secondary" : "outline"} aria-pressed={caller.phone_e164 === callerId} onClick={() => setCallerId(caller.phone_e164)}>{caller.name}</Button>
              ))}
            </div>
          )}
          <p className="text-center text-sm text-muted-foreground">{t("처음 거는 번호는 바로 등록되어 시연용 주소로 주문됩니다. 위 이름을 누르면 시연 고객으로 걸립니다.", "A new number is registered at once and orders go to a demo address. Tap a name above to call as a demo customer.")}</p>
          <p className="text-center text-sm text-muted-foreground">{t("확인할 때 키패드 1번은 네, 2번은 아니요, 0번은 상담원입니다.", "When asked to confirm, press 1 for yes, 2 for no, 0 for an operator.")}</p>
        </section>

        <section aria-label={t("통화 내용", "Transcript")} className="flex h-[min(60svh,720px)] min-h-72 flex-col rounded-xl border lg:h-[min(72svh,720px)]">
          {silentMode && inCall && <Alert className="m-3 w-auto"><AlertDescription>{t("음성 안내가 꺼져 있어 답변은 글자로만 나옵니다.", "Voice replies are off, so answers appear as text only.")}</AlertDescription></Alert>}
          {timeline.length === 0 && !partial ? (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyTitle>{status === "connecting" ? t("연결하고 있습니다", "Connecting") : t("초록 버튼을 눌러 전화를 거세요", "Press the green button to call")}</EmptyTitle>
                <EmptyDescription>{t("나눈 말이 여기에 글자로 표시됩니다.", "What is said on the call will appear here as text.")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Transcript timeline={timeline} partial={partial} callerLabel={callerName ?? t("고객", "Customer")}>
              {sms.map((message, index) => (
                <MessageScrollerItem key={`sms-${index}`} messageId={`sms-${index}`}>
                  <Marker><MarkerContent>{t(`${formatPhone(message.to)} 보호자에게 문자를 보냈습니다: `, `Sent a text to the guardian at ${formatPhone(message.to)}: `)}{message.text}</MarkerContent></Marker>
                </MessageScrollerItem>
              ))}
            </Transcript>
          )}
        </section>

        {developer && (
          <aside aria-label={t("개발자 보기", "Developer view")} className="flex flex-col gap-5 rounded-xl border p-4 text-sm">
            <dl className="flex flex-col gap-1">
              {[
                [t("단계", "Stage"), t(...(STATE_TEXT[state] ?? NONE))],
                [t("음성 인식 확정", "Speech recognized"), ms(latency.final_ms, t)],
                [t("LLM 첫 토큰", "LLM first token"), ms(latency.llm_first_token_ms, t)],
                [t("첫 음성 (목표 1,500ms)", "First voice (goal 1,500ms)"), ms(latency.tts_first_chunk_ms, t)],
                [t("통화 비용", "Call cost"), cost === null ? t("끊은 뒤 계산", "Shown after hanging up") : `$${cost.toFixed(4)}`],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3"><dt className="text-muted-foreground">{label}</dt><dd className="font-medium tabular-nums">{value}</dd></div>
              ))}
            </dl>
            <Separator />
            <form className="flex gap-2" onSubmit={submitTyped}>
              <Input aria-label={t("말 대신 글자로 입력", "Type a message")} placeholder={t("말 대신 글자로 입력", "Type a message")} value={typed} disabled={status !== "in_call"} onChange={(event) => setTyped(event.target.value)} />
              <Button type="submit" variant="secondary" disabled={status !== "in_call" || !typed.trim()}>{t("보내기", "Send")}</Button>
            </form>
            <Separator />
            <FieldGroup className="gap-4">
              <Field orientation="horizontal">
                <Switch id="quality" checked={phoneQuality} onCheckedChange={setPhoneQuality} />
                <FieldLabel htmlFor="quality">{t("통화음질 (8kHz)", "Phone sound quality (8kHz)")}</FieldLabel>
              </Field>
              <Field>
                <FieldLabel>{t("배경 소음", "Background noise")} {Math.round((noise / 0.1) * 100)}%</FieldLabel>
                <Slider aria-label={t("배경 소음", "Background noise")} min={0} max={0.1} step={0.005} value={[noise]} onValueChange={([value]) => setNoise(value ?? 0)} />
              </Field>
              <Field>
                <FieldLabel>{t("네트워크 지연", "Network delay")} {delayMs}ms</FieldLabel>
                <Slider aria-label={t("네트워크 지연", "Network delay")} min={0} max={1000} step={50} value={[delayMs]} onValueChange={([value]) => setDelayMs(value ?? 0)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="replay">{t("녹음 파일로 말하기 (WAV)", "Speak from a recording (WAV)")}</FieldLabel>
                <Input id="replay" type="file" accept=".wav,audio/wav" disabled={inCall} onChange={(event) => setReplayFile(event.target.files?.[0] ?? null)} />
              </Field>
            </FieldGroup>
            <Separator />
            <div className="flex flex-col gap-2">
              <h2 className="font-semibold">{t("에이전트 활동", "Agent activity")} <Badge variant="secondary">{activity.length}</Badge></h2>
              <Trace className="max-h-64 overflow-y-auto">
                {activity.map((entry) => entry.detail === undefined ? (
                  <TraceLine key={entry.id} status={entry.ok ? undefined : "error"}><TraceTitle>{t(...entry.label)}</TraceTitle></TraceLine>
                ) : (
                  <TraceCollapsible key={entry.id}>
                    <TraceCollapsibleTrigger><TraceLine status={entry.ok ? undefined : "error"}><TraceTitle>{t(...entry.label)}</TraceTitle></TraceLine></TraceCollapsibleTrigger>
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

function Transcript({ timeline, partial, callerLabel, children }: { timeline: TimelineEntry[]; partial: string; callerLabel: string; children?: ReactNode }) {
  const { t } = useT();
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-4 p-4">
            {timeline.map((entry, index) => (
              <MessageScrollerItem key={index} messageId={String(index)} className="overflow-visible px-px">
                {entry.kind === "note" && <Marker><MarkerContent>{t(...entry.text)}</MarkerContent></Marker>}
                {entry.kind === "order" && (
                  <Card size="sm" className="mx-auto my-1 w-full max-w-xs">
                    <CardHeader>
                      <CardTitle>{t("주문이 접수됐습니다", "Your order is placed")}</CardTitle>
                      <CardDescription>{entry.storeName}, {won(entry.total, t)}, {t(`약 ${entry.eta}분 뒤 도착`, `arriving in about ${entry.eta} minutes`)}</CardDescription>
                    </CardHeader>
                  </Card>
                )}
                {entry.kind === "line" && (
                  <Message align={entry.who === "caller" ? "end" : "start"}>
                    <MessageContent>
                      {(timeline[index - 1] as { who?: string } | undefined)?.who !== entry.who && <MessageHeader>{entry.who === "caller" ? callerLabel : t("콜오더", "CallOrder")}</MessageHeader>}
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
            {children}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

interface LiveCall { callId: string; caller: string; timeline: TimelineEntry[]; partial: string; ended: boolean }

// The same events the simulator screen gets, for one real call.
function applyLiveEvent(call: LiveCall, message: Record<string, any>): LiveCall {
  const at = Date.now();
  switch (message.type) {
    case "transcript":
      return message.final ? { ...call, partial: "", timeline: [...call.timeline, { kind: "line", who: "caller", text: message.text, at }] } : { ...call, partial: message.text };
    case "assistant_text":
    case "fail_safe":
      return { ...call, timeline: [...call.timeline, { kind: "line", who: "agent", text: message.text, at }] };
    case "order_placed":
      return { ...call, timeline: [...call.timeline, { kind: "order", storeName: message.storeName, total: message.order.total, eta: message.order.eta_minutes, at }] };
    case "hangup":
      return { ...call, partial: "", ended: true };
    default:
      return call;
  }
}

const MAX_LIVE_CALLS = 6;

// Real calls from the numbers given, live. Each call gets its own panel, so calls at the same time sit side by side.
function LiveCalls({ code }: { code: string }) {
  const { t } = useT();
  const [typed, setTyped] = useState(() => localStorage.getItem("watch-numbers") ?? localStorage.getItem("sim-my-number") ?? "");
  const [watching, setWatching] = useState<string[]>([]);
  const [calls, setCalls] = useState<LiveCall[]>([]);

  useEffect(() => {
    let stopped = false;
    const sockets: WebSocket[] = [];
    const open = (phone: string) => {
      const ws = new WebSocket(`${WATCH_URL}?phone=${encodeURIComponent(phone)}&code=${encodeURIComponent(code)}`);
      sockets.push(ws);
      ws.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (!message.callId) return;
        setCalls((all) => {
          const found = all.find((call) => call.callId === message.callId);
          const next = applyLiveEvent(found ?? { callId: message.callId, caller: phone, timeline: [], partial: "", ended: false }, message);
          return found ? all.map((call) => (call === found ? next : call)) : [next, ...all].slice(0, MAX_LIVE_CALLS);
        });
      };
      // ponytail: fixed 3 s retry; back off if the Worker ever has to turn screens away
      ws.onclose = () => { if (!stopped) setTimeout(() => !stopped && open(phone), 3000); };
    };
    watching.forEach(open);
    return () => {
      stopped = true;
      sockets.forEach((ws) => ws.close());
    };
  }, [watching, code]);

  const watch = (event: FormEvent) => {
    event.preventDefault();
    const numbers = [...new Set(typed.split(/[,\n]/).map(toE164).filter((number): number is string => Boolean(number)))];
    localStorage.setItem("watch-numbers", typed);
    setWatching(numbers);
  };

  return (
    <section aria-label={t("실시간 통화", "Live calls")} className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <form className="mx-auto flex w-full max-w-sm flex-col gap-2" onSubmit={watch}>
        <label htmlFor="watch-numbers" className="text-sm font-medium">{t("거는 휴대폰 번호 (여러 개는 쉼표로)", "Phone numbers you call from (separate with commas)")}</label>
        <div className="flex gap-2">
          <Input id="watch-numbers" type="tel" autoComplete="tel" placeholder={t("010-0000-0000", "+1 000 000 0000")} value={typed} onChange={(event) => setTyped(event.target.value)} />
          <Button type="submit" variant="secondary">{t("통화 보기", "Show calls")}</Button>
        </div>
        {watching.length > 0 && <p className="text-sm text-muted-foreground">{t("이 번호로 걸면 대화가 아래에 실시간으로 나옵니다: ", "Calls from these numbers appear below as they happen: ")}{watching.map(formatPhone).join(", ")}</p>}
      </form>
      {calls.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {calls.map((call) => (
            <div key={call.callId} className="flex h-[min(60svh,640px)] min-h-72 flex-col rounded-xl border bg-background">
              <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
                <span className="font-medium">{formatPhone(call.caller)}</span>
                <Badge variant={call.ended ? "secondary" : "default"}>{call.ended ? t("통화 종료", "Ended") : t("통화 중", "On call")}</Badge>
              </div>
              <Transcript timeline={call.timeline} partial={call.partial} callerLabel={t("고객", "Customer")} />
            </div>
          ))}
        </div>
      )}
    </section>
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
