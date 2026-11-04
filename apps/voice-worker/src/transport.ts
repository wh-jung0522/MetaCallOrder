import { mulawDecode, mulawEncode, resample, ThirdRateDownsampler } from "@callorder/audio";

export interface TelephonyTransport {
  readonly kind: "simulator" | "phone";
  readonly callerId: string;
  onAudio(cb: (pcm16_16k: Int16Array) => void): void;
  onDtmf(cb: (digit: string) => void): void;
  onHangup(cb: () => void): void;
  playAudio(pcm16: Int16Array, sampleRate: number): void;
  mark(name: string): void;
  clearPlayback(): void;
  transfer(target: string): Promise<void>;
  hangup(): void;
  // Debug and demo events for the simulator screen. A phone call hands them to whoever watches its number.
  sendEvent(event: Record<string, unknown>): void;
}

const send = (socket: WebSocket, data: string | ArrayBufferLike) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(data as string);
};

// Speaks the §3.2 protocol. The `start` message was consumed by CallSession to learn the caller id.
export class SimulatorTransport implements TelephonyTransport {
  readonly kind = "simulator";
  private audioCb: (pcm: Int16Array) => void = () => {};
  private dtmfCb: (digit: string) => void = () => {};
  private hangupCb: () => void = () => {};
  private utteranceCb: (text: string) => void = () => {};

  constructor(private socket: WebSocket, readonly callerId: string) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        const bytes = event.data as ArrayBuffer;
        this.audioCb(new Int16Array(bytes, 0, Math.floor(bytes.byteLength / 2)));
        return;
      }
      const message = JSON.parse(event.data) as { type?: string; digit?: string; text?: string };
      if (message.type === "dtmf" && /^[0-9*#]$/.test(message.digit ?? "")) this.dtmfCb(message.digit!);
      if (message.type === "utterance" && message.text) this.utteranceCb(message.text.slice(0, 500));
      if (message.type === "hangup") this.hangupCb();
    });
    socket.addEventListener("close", () => this.hangupCb());
  }

  onAudio(cb: (pcm: Int16Array) => void) { this.audioCb = cb; }
  onDtmf(cb: (digit: string) => void) { this.dtmfCb = cb; }
  onHangup(cb: () => void) { this.hangupCb = cb; }
  // Typed test input from the simulator, handled like a final transcript.
  onUtterance(cb: (text: string) => void) { this.utteranceCb = cb; }

  playAudio(pcm16: Int16Array) {
    send(this.socket, pcm16.buffer.slice(pcm16.byteOffset, pcm16.byteOffset + pcm16.byteLength));
  }
  mark() {}
  clearPlayback() { this.sendEvent({ type: "clear" }); }
  async transfer(target: string) { this.sendEvent({ type: "transfer", target }); }
  hangup() {
    this.sendEvent({ type: "hangup" });
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, "call ended");
  }
  sendEvent(event: Record<string, unknown>) { send(this.socket, JSON.stringify(event)); }
}

const PHONE_RATE = 8000;
const PHONE_FRAME_MS = 20;
const PHONE_FRAME_BYTES = 160; // 20 ms of 8 kHz mulaw
const MULAW_SILENCE = 0xff;
const PHONE_LEAD_MS = 200;
const TAIL_FLUSH_MS = 120;
const CLOSE_FLUSH_LIMIT_MS = 3000;

// A ClawOps VoiceML <Connect><Stream> socket: JSON events carrying base64 mulaw at 8 kHz.
// The media server plays every frame as 20 ms, so only whole frames go out, at speaking pace.
export class PhoneTransport implements TelephonyTransport {
  readonly kind = "phone";
  private audioCb: (pcm: Int16Array) => void = () => {};
  private dtmfCb: (digit: string) => void = () => {};
  private hangupCb: () => void = () => {};
  private downsampler = new ThirdRateDownsampler();
  private outbox: Uint8Array = new Uint8Array(0);
  private nextFrameAt = 0;
  private lastAudioAt = 0;
  private pacer = 0;

  // Twilio requires the stream id on everything sent to it; ClawOps needs nothing extra.
  constructor(private socket: WebSocket, readonly callerId: string, private streamSid?: string, private onEvent: (event: Record<string, unknown>) => void = () => {}) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as { event?: string; media?: { payload?: string }; dtmf?: { digit?: string } };
      if (message.event === "media" && message.media?.payload) {
        const mulaw = Uint8Array.from(atob(message.media.payload), (char) => char.charCodeAt(0));
        this.audioCb(resample(mulawDecode(mulaw), PHONE_RATE, 16000));
      }
      if (message.event === "dtmf" && /^[0-9*#]$/.test(message.dtmf?.digit ?? "")) this.dtmfCb(message.dtmf!.digit!);
      if (message.event === "stop") this.hangupCb();
    });
    socket.addEventListener("close", () => {
      clearInterval(this.pacer);
      this.onEvent({ type: "hangup" });
      this.hangupCb();
    });
    this.pacer = setInterval(() => this.sendDueFrames(), PHONE_FRAME_MS);
  }

  onAudio(cb: (pcm: Int16Array) => void) { this.audioCb = cb; }
  onDtmf(cb: (digit: string) => void) { this.dtmfCb = cb; }
  onHangup(cb: () => void) { this.hangupCb = cb; }

  // Every TTS provider here delivers 24 kHz.
  playAudio(pcm16: Int16Array) {
    const mulaw = mulawEncode(this.downsampler.process(pcm16));
    const joined = new Uint8Array(this.outbox.length + mulaw.length);
    joined.set(this.outbox);
    joined.set(mulaw, this.outbox.length);
    this.outbox = joined;
    this.lastAudioAt = Date.now();
  }

  private sendDueFrames() {
    const now = Date.now();
    // The end of a sentence rarely fills a frame.
    if (this.outbox.length % PHONE_FRAME_BYTES && now - this.lastAudioAt > TAIL_FLUSH_MS) {
      const padded = new Uint8Array(this.outbox.length + PHONE_FRAME_BYTES - (this.outbox.length % PHONE_FRAME_BYTES)).fill(MULAW_SILENCE);
      padded.set(this.outbox);
      this.outbox = padded;
    }
    let sent = 0;
    this.nextFrameAt = Math.max(this.nextFrameAt, now);
    while (this.outbox.length - sent >= PHONE_FRAME_BYTES && this.nextFrameAt < now + PHONE_LEAD_MS) {
      const payload = btoa(String.fromCharCode(...this.outbox.subarray(sent, sent + PHONE_FRAME_BYTES)));
      send(this.socket, JSON.stringify({ event: "media", streamSid: this.streamSid, media: { payload } }));
      sent += PHONE_FRAME_BYTES;
      this.nextFrameAt += PHONE_FRAME_MS;
    }
    if (sent) this.outbox = this.outbox.slice(sent);
  }

  mark() {}
  clearPlayback() {
    this.outbox = new Uint8Array(0);
    this.nextFrameAt = 0;
    send(this.socket, JSON.stringify({ event: "clear", streamSid: this.streamSid }));
  }
  // ponytail: no operator line exists yet, so the caller is told and the call ends. Dial a real number here when one does.
  async transfer() {}
  hangup() {
    const giveUpAt = Date.now() + CLOSE_FLUSH_LIMIT_MS;
    const closeWhenPlayed = () => {
      if (this.outbox.length && Date.now() < giveUpAt) return void setTimeout(closeWhenPlayed, PHONE_FRAME_MS);
      clearInterval(this.pacer);
      if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, "call ended");
    };
    closeWhenPlayed();
  }
  sendEvent(event: Record<string, unknown>) { this.onEvent(event); }
}
