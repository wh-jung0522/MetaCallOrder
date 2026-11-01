import { connectWebSocket } from "./upstream";

export interface SttHandlers {
  onSpeechStart(): void;
  onPartial(text: string): void;
  onSpeechEnd(): void;
  onFinal(text: string): void;
  onFailure(reason: string): void;
}

const MAX_BUFFERED_FRAMES = 100; // 2 seconds of 20 ms frames
const BYTES_PER_MS = 32; // PCM16 at 16 kHz
const PACE_CHECK_MS = 200;
const MAX_LAG_MS = 300;

// Muse Voice Transcribe realtime. Auth travels in the first frame and audio waits for the ack.
export class MuseStt {
  private socket: WebSocket | null = null;
  private ready = false;
  private closing = false;
  private pending: ArrayBuffer[] = [];
  private streamStartedAt = 0;
  private sentMs = 0;
  private paceTimer = 0;

  constructor(private handlers: SttHandlers) {}

  async connect(options: { url: string; apiKey: string; model: string; keywords: string[] }): Promise<void> {
    const socket = await connectWebSocket(options.url);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
    socket.addEventListener("close", (event) => {
      if (!this.closing) this.handlers.onFailure(`stt closed ${event.code} ${event.reason}`);
    });
    socket.addEventListener("error", () => {
      if (!this.closing) this.handlers.onFailure("stt socket error");
    });
    socket.send(JSON.stringify({
      authorization: { accessToken: `Bearer ${options.apiKey}` },
      audioEncoding: "PCM_16KHZ",
      model: options.model,
      mode: "ENDPOINTING",
      partialMode: "CUMULATIVE",
      emitAudioProgress: false,
      keywords: options.keywords,
      languageBias: ["Korean", "English"],
    }));
  }

  sendAudio(pcm: Int16Array): void {
    const frame = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
    if (!this.ready) {
      this.pending.push(frame);
      if (this.pending.length > MAX_BUFFERED_FRAMES) this.pending.shift();
      return;
    }
    this.sendFrame(frame);
  }

  private sendFrame(frame: ArrayBuffer): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(frame);
    this.sentMs += frame.byteLength / BYTES_PER_MS;
  }

  // Meta ends the session (1008) when audio falls behind real time, so a network stall or a call with no mic is padded with silence.
  private keepPace(): void {
    const lag = Date.now() - this.streamStartedAt - this.sentMs;
    if (lag > MAX_LAG_MS) this.sendFrame(new ArrayBuffer(Math.floor(lag) * BYTES_PER_MS));
  }

  close(): void {
    this.closing = true;
    clearInterval(this.paceTimer);
    try {
      if (this.ready) this.socket?.send(JSON.stringify({ type: "endStream" }));
      this.socket?.close(1000);
    } catch {
      // Already closed.
    }
  }

  private onMessage(raw: string): void {
    const message = JSON.parse(raw) as { type?: string; sessionId?: string; transcript?: string; final?: boolean; message?: string };
    switch (message.type) {
      case undefined:
        if (!message.sessionId) return this.handlers.onFailure("stt handshake failed");
        this.ready = true;
        this.streamStartedAt = Date.now();
        for (const frame of this.pending) this.sendFrame(frame);
        this.pending = [];
        this.paceTimer = setInterval(() => this.keepPace(), PACE_CHECK_MS);
        return;
      case "speechStart":
        return this.handlers.onSpeechStart();
      case "transcript":
        return this.handlers.onPartial(message.transcript ?? "");
      case "speechEnd":
        return this.handlers.onSpeechEnd();
      case "speechComplete":
        return this.handlers.onFinal(message.transcript ?? "");
      case "error":
        return this.handlers.onFailure(`stt error: ${message.message}`);
    }
  }
}
