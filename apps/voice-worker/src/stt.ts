import { connectWebSocket } from "./upstream";

export interface SttHandlers {
  onSpeechStart(): void;
  onPartial(text: string): void;
  onSpeechEnd(): void;
  onFinal(text: string): void;
  onFailure(reason: string): void;
}

const MAX_BUFFERED_FRAMES = 100; // 2 seconds of 20 ms frames

// Muse Voice Transcribe realtime. Auth travels in the first frame and audio waits for the ack.
export class MuseStt {
  private socket: WebSocket | null = null;
  private ready = false;
  private closing = false;
  private pending: ArrayBuffer[] = [];

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
      languageBias: ["Korean"],
    }));
  }

  sendAudio(pcm: Int16Array): void {
    const frame = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
    if (!this.ready) {
      this.pending.push(frame);
      if (this.pending.length > MAX_BUFFERED_FRAMES) this.pending.shift();
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame);
  }

  close(): void {
    this.closing = true;
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
        for (const frame of this.pending) this.socket?.send(frame);
        this.pending = [];
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
