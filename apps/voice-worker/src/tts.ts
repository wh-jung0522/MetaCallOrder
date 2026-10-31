import { connectWebSocket } from "./upstream";

export const TTS_SAMPLE_RATE = 24000;
const KEEPALIVE_MS = 30_000;

export interface TtsHandlers {
  onAudio(pcm: Int16Array): void;
  onFirstChunk(): void;
  onFailure(reason: string): void;
}

export interface Tts {
  readonly busy: boolean;
  speak(text: string, speed: number): void;
  cancel(): void;
  drained(): Promise<void>;
  close(): void;
}

function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
}

// Soniox runs concurrent streams side by side, so sentences go one at a time to keep the audio in order.
export class SonioxTts implements Tts {
  private socket!: WebSocket;
  private queue: { text: string; speed: number }[] = [];
  private activeStream: string | null = null;
  private cancelled = false;
  private carry: number | null = null;
  private firstChunkSeen = false;
  private closing = false;
  private keepalive = 0;
  private drainWaiters: (() => void)[] = [];

  constructor(private handlers: TtsHandlers, private options: { url: string; apiKey: string; model: string; voice: string }) {}

  async connect(): Promise<void> {
    this.socket = await connectWebSocket(this.options.url, { Authorization: `Bearer ${this.options.apiKey}` });
    this.socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
    this.socket.addEventListener("close", (event) => {
      if (!this.closing) this.handlers.onFailure(`tts closed ${event.code} ${event.reason}`);
    });
    this.keepalive = setInterval(() => this.send({ keep_alive: true }), KEEPALIVE_MS);
  }

  get busy(): boolean {
    return this.activeStream !== null || this.queue.length > 0;
  }

  speak(text: string, speed: number): void {
    this.queue.push({ text, speed });
    this.pump();
  }

  cancel(): void {
    this.queue = [];
    this.carry = null;
    if (!this.activeStream) return;
    // Audio already in flight for this stream is dropped until the server confirms termination.
    this.cancelled = true;
    this.send({ stream_id: this.activeStream, cancel: true });
  }

  drained(): Promise<void> {
    if (!this.activeStream && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  close(): void {
    this.closing = true;
    clearInterval(this.keepalive);
    try {
      this.socket?.close(1000);
    } catch {
      // Already closed.
    }
  }

  private pump(): void {
    if (this.activeStream) return;
    const next = this.queue.shift();
    if (!next) {
      this.drainWaiters.splice(0).forEach((resolve) => resolve());
      return;
    }
    this.activeStream = crypto.randomUUID();
    this.firstChunkSeen = false;
    this.carry = null;
    this.send({
      stream_id: this.activeStream,
      model: this.options.model,
      language: "ko",
      voice: this.options.voice,
      audio_format: "pcm_s16le",
      sample_rate: TTS_SAMPLE_RATE,
      speed: Math.min(1.3, Math.max(0.7, next.speed)),
    });
    this.send({ stream_id: this.activeStream, text: next.text, text_end: true });
  }

  private send(message: object): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
    else if (!this.closing) this.handlers.onFailure("tts socket not open");
  }

  private onMessage(raw: string): void {
    const message = JSON.parse(raw) as { stream_id?: string; audio?: string; terminated?: boolean; error_message?: string };
    if (message.stream_id !== this.activeStream) return;
    if (message.error_message) this.handlers.onFailure(`tts error: ${message.error_message}`);
    if (message.audio && !this.cancelled) this.onAudioChunk(decodeBase64(message.audio));
    if (message.terminated) {
      this.activeStream = null;
      this.cancelled = false;
      this.pump();
    }
  }

  // Chunks can split a 16-bit sample in half, so an odd trailing byte waits for the next chunk.
  private onAudioChunk(chunk: Uint8Array): void {
    if (!this.firstChunkSeen) {
      this.firstChunkSeen = true;
      this.handlers.onFirstChunk();
    }
    const carried = this.carry === null ? 0 : 1;
    const usable = (chunk.length + carried) & ~1;
    if (usable === 0) {
      this.carry = chunk[0] ?? this.carry;
      return;
    }
    const bytes = new Uint8Array(usable);
    if (this.carry !== null) bytes[0] = this.carry;
    bytes.set(chunk.subarray(0, usable - carried), carried);
    this.carry = (chunk.length + carried) % 2 ? chunk[chunk.length - 1]! : null;
    this.handlers.onAudio(new Int16Array(bytes.buffer));
  }
}

// Transcript-only mode for running calls before a TTS key exists.
export class SilentTts implements Tts {
  readonly busy = false;
  speak(): void {}
  cancel(): void {}
  drained(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {}
}
