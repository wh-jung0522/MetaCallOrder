import { mulawDecode, mulawEncode, resample } from "@callorder/audio";

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
  // Debug and demo events for the simulator screen. A phone call has no screen to show them on.
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
const PHONE_FRAME_BYTES = 160; // 20 ms of 8 kHz mulaw

// A ClawOps VoiceML <Connect><Stream> socket: JSON events carrying base64 mulaw at 8 kHz.
export class PhoneTransport implements TelephonyTransport {
  readonly kind = "phone";
  private audioCb: (pcm: Int16Array) => void = () => {};
  private dtmfCb: (digit: string) => void = () => {};
  private hangupCb: () => void = () => {};
  private held = new Int16Array(0);

  constructor(private socket: WebSocket, readonly callerId: string) {
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
    socket.addEventListener("close", () => this.hangupCb());
  }

  onAudio(cb: (pcm: Int16Array) => void) { this.audioCb = cb; }
  onDtmf(cb: (digit: string) => void) { this.dtmfCb = cb; }
  onHangup(cb: () => void) { this.hangupCb = cb; }

  playAudio(pcm16: Int16Array, sampleRate: number) {
    const samples = new Int16Array(this.held.length + pcm16.length);
    samples.set(this.held);
    samples.set(pcm16, this.held.length);
    // Whole groups only, so the rate change has no seam between chunks.
    const group = sampleRate / PHONE_RATE;
    const usable = samples.length - (samples.length % group);
    this.held = samples.slice(usable);
    const mulaw = mulawEncode(resample(samples.subarray(0, usable), sampleRate, PHONE_RATE));
    for (let at = 0; at < mulaw.length; at += PHONE_FRAME_BYTES) {
      const payload = btoa(String.fromCharCode(...mulaw.subarray(at, at + PHONE_FRAME_BYTES)));
      send(this.socket, JSON.stringify({ event: "media", media: { payload } }));
    }
  }
  mark() {}
  clearPlayback() {
    this.held = new Int16Array(0);
    send(this.socket, JSON.stringify({ event: "clear" }));
  }
  // ponytail: no operator line exists yet, so the caller is told and the call ends. Dial a real number here when one does.
  async transfer() {}
  hangup() {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, "call ended");
  }
  sendEvent() {}
}
