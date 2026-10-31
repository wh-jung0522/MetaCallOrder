export interface TelephonyTransport {
  readonly kind: "simulator" | "twilio";
  readonly callerId: string;
  onAudio(cb: (pcm16_16k: Int16Array) => void): void;
  onDtmf(cb: (digit: string) => void): void;
  onHangup(cb: () => void): void;
  playAudio(pcm16: Int16Array, sampleRate: number): void;
  mark(name: string): void;
  clearPlayback(): void;
  transfer(target: string): Promise<void>;
  hangup(): void;
  // Debug and demo events. Twilio would forward these to the admin dashboard instead.
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
