import { useEffect, useRef, useState } from "react";

const WS_URL = import.meta.env.VITE_VOICE_WS_URL as string;
const HTTP_URL = WS_URL.replace(/^ws/, "http").replace(/\/sim\/stream$/, "");
const UNREGISTERED = "+821099999999";
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
const INPUT_RATE = 16000;
const FRAME_BYTES = 640;
const FRAME_MS = 20;

type Status = "idle" | "connecting" | "in_call" | "transferred" | "ended";

interface Line { who: "caller" | "agent"; text: string }
interface Sms { to: string; text: string }

function DebugValue({ value }: { value: unknown }) {
  return <code>{typeof value === "string" ? value : JSON.stringify(value)}</code>;
}

export function SimulatorPage() {
  const [code, setCode] = useState(() => localStorage.getItem("sim-code") ?? "");
  const [callers, setCallers] = useState<{ name: string; phone_e164: string }[]>([]);
  const [callerId, setCallerId] = useState(UNREGISTERED);
  const [phoneQuality, setPhoneQuality] = useState(true);
  const [noise, setNoise] = useState(0);
  const [delayMs, setDelayMs] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [partial, setPartial] = useState("");
  const [state, setState] = useState("-");
  const [events, setEvents] = useState<Record<string, unknown>[]>([]);
  const [latency, setLatency] = useState<Record<string, number>>({});
  const [cost, setCost] = useState<number | null>(null);
  const [sms, setSms] = useState<Sms[]>([]);
  const [typed, setTyped] = useState("");
  const [replayFile, setReplayFile] = useState<File | null>(null);

  const socket = useRef<WebSocket | null>(null);
  const capture = useRef<AudioWorkletNode | null>(null);
  const playback = useRef<AudioWorkletNode | null>(null);
  const cleanup = useRef<() => void>(() => {});
  const delayRef = useRef(0);
  delayRef.current = delayMs;

  useEffect(() => {
    if (!code) return;
    fetch(`${HTTP_URL}/sim/callers`, { headers: { "x-access-code": code } })
      .then((response) => {
        if (!response.ok) throw new Error(response.status === 401 ? "접속 코드가 맞지 않습니다." : `서버 응답 ${response.status}`);
        return response.json();
      })
      .then((list) => {
        localStorage.setItem("sim-code", code);
        setCallers(list);
        setCallerId((current) => (current === UNREGISTERED && list[0] ? list[0].phone_e164 : current));
        setError("");
      })
      .catch((failure) => setError(failure.message));
  }, [code]);

  useEffect(() => { capture.current?.port.postMessage({ phoneQuality }); }, [phoneQuality]);
  useEffect(() => { capture.current?.port.postMessage({ noise }); }, [noise]);
  useEffect(() => () => cleanup.current(), []);

  const send = (data: string | ArrayBuffer) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    if (delayRef.current) setTimeout(() => socket.current?.readyState === WebSocket.OPEN && socket.current.send(data), delayRef.current);
    else socket.current.send(data);
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
        break;
      case "clear":
        playback.current?.port.postMessage("clear");
        break;
      case "transcript":
        if (message.final) {
          setPartial("");
          setLines((all) => [...all, { who: "caller", text: message.text }]);
        } else {
          setPartial(message.text);
        }
        break;
      case "assistant_text":
        setLines((all) => [...all, { who: "agent", text: message.text }]);
        break;
      case "guardian_sms":
        setSms((all) => [...all, { to: message.to, text: message.text }]);
        break;
      case "fail_safe":
        // Stand-in for the pre-recorded notice: TTS may be the very thing that failed.
        speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(message.text), { lang: "ko-KR", rate: 0.9 }));
        setLines((all) => [...all, { who: "agent", text: message.text }]);
        break;
      case "transfer":
        setStatus("transferred");
        break;
      case "hangup":
        setStatus((current) => (current === "transferred" ? current : "ended"));
        break;
      case "agent_event":
        if (message.name === "state") setState(message.state);
        else if (message.name === "latency") setLatency(message);
        else if (message.name === "call_cost") setCost(message.cost_usd);
        else setEvents((all) => [message, ...all].slice(0, 50));
        break;
      case "order_placed":
        setEvents((all) => [message, ...all].slice(0, 50));
        break;
    }
  };

  const startCall = async () => {
    setError("");
    setLines([]);
    setEvents([]);
    setLatency({});
    setCost(null);
    setSms([]);
    setState("-");
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
        node.port.onmessage = ({ data }) => send(data);
      }

      const callId = crypto.randomUUID();
      const ws = new WebSocket(`${WS_URL}?callId=${callId}&code=${encodeURIComponent(code)}`);
      ws.binaryType = "arraybuffer";
      socket.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: "start", callerId, phoneQuality }));
      ws.onmessage = ({ data }) => onServerMessage(data);
      ws.onerror = () => setError("서버에 연결하지 못했습니다.");
      ws.onclose = () => {
        setStatus((current) => (current === "transferred" ? current : "ended"));
        cleanup.current();
      };

      cleanup.current = () => {
        stopReplay();
        stream?.getTracks().forEach((track) => track.stop());
        void context.close();
        void output.close();
        capture.current = null;
        playback.current = null;
      };
    } catch (failure) {
      cleanup.current();
      setStatus("idle");
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const hangUp = () => {
    send(JSON.stringify({ type: "hangup" }));
    socket.current?.close();
  };

  const inCall = status === "in_call" || status === "connecting";

  return (
    <>
      <h1>전화 시뮬레이터</h1>
      <p className="muted">스피커 소리가 마이크로 들어가면 끼어들기가 오작동합니다. 헤드셋을 쓰세요.</p>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="sim">
        <section className="card phone" aria-label="전화기">
          <label>접속 코드 <input type="password" value={code} onChange={(event) => setCode(event.target.value)} disabled={inCall} /></label>
          <label>발신번호
            <select value={callerId} onChange={(event) => setCallerId(event.target.value)} disabled={inCall}>
              {callers.map((caller) => <option key={caller.phone_e164} value={caller.phone_e164}>{caller.name} {caller.phone_e164}</option>)}
              <option value={UNREGISTERED}>미등록 번호 {UNREGISTERED}</option>
            </select>
          </label>
          <div className="screen" role="status">
            {{ idle: "대기 중", connecting: "연결 중…", in_call: "통화 중", transferred: "상담원 연결됨", ended: "통화 종료" }[status]}
          </div>
          <div className="keypad">
            {KEYS.map((key) => <button key={key} disabled={status !== "in_call"} onClick={() => send(JSON.stringify({ type: "dtmf", digit: key }))}>{key}</button>)}
          </div>
          <div className="row">
            <button className="call" disabled={inCall || !code} onClick={startCall}>전화 걸기</button>
            <button className="end" disabled={!inCall && status !== "transferred"} onClick={hangUp}>끊기</button>
          </div>
          <label className="check"><input type="checkbox" checked={phoneQuality} onChange={(event) => setPhoneQuality(event.target.checked)} /> 통화음질 모드 (8kHz)</label>
          <label>배경 소음 <input type="range" min="0" max="0.1" step="0.005" value={noise} onChange={(event) => setNoise(Number(event.target.value))} /></label>
          <label>네트워크 지연 {delayMs}ms <input type="range" min="0" max="1000" step="50" value={delayMs} onChange={(event) => setDelayMs(Number(event.target.value))} /></label>
          <label>녹음 재생 (WAV, 선택) <input type="file" accept=".wav,audio/wav" disabled={inCall} onChange={(event) => setReplayFile(event.target.files?.[0] ?? null)} /></label>
          <form className="row" onSubmit={(event) => {
            event.preventDefault();
            if (!typed.trim()) return;
            send(JSON.stringify({ type: "utterance", text: typed }));
            setTyped("");
          }}>
            <input aria-label="글자로 말하기" placeholder="글자로 말하기" value={typed} disabled={status !== "in_call"} onChange={(event) => setTyped(event.target.value)} />
            <button disabled={status !== "in_call"}>보내기</button>
          </form>
        </section>

        <section className="card log" aria-label="통화 내용">
          <h2>전사</h2>
          <div className="stack">
            {lines.map((line, index) => <p key={index} className={line.who}><strong>{line.who === "caller" ? "고객" : "상담원"}</strong> {line.text}</p>)}
            {partial && <p className="caller partial">{partial}</p>}
          </div>
        </section>

        <section className="stack">
          <div className="card">
            <h2>상태</h2>
            <p>단계: <strong>{state}</strong></p>
            <p>STT 확정 {latency.final_ms ?? "-"}ms · LLM 첫 토큰 {latency.llm_first_token_ms ?? "-"}ms · 첫 음성 {latency.tts_first_chunk_ms ?? "-"}ms</p>
            <p>통화 원가: {cost === null ? "통화 종료 후 표시" : `$${cost.toFixed(4)}`}</p>
          </div>
          <div className="card guardian" aria-label="보호자 휴대폰">
            <h2>보호자 휴대폰</h2>
            {sms.length === 0 && <p className="muted">받은 문자 없음</p>}
            {sms.map((message, index) => <p key={index} className="sms"><small>{message.to}</small><br />{message.text}</p>)}
          </div>
          <div className="card">
            <h2>이벤트</h2>
            <div className="events">
              {events.map((event, index) => <p key={index}><DebugValue value={event} /></p>)}
            </div>
          </div>
        </section>
      </div>
    </>
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
