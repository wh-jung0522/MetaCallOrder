import type { Language } from "@callorder/agents";
import { resample } from "@callorder/audio";
import { connectWebSocket } from "./upstream";

export const TTS_SAMPLE_RATE = 24000;
const KEEPALIVE_MS = 30_000;
const TYPECAST_SAMPLE_RATE = 32000;
const WAV_HEADER_BYTES = 44;
const TYPECAST_LANGUAGE: Record<Language, string> = { ko: "kor", en: "eng" };
const TTS_RESPONSE_TIMEOUT_MS = 10_000;
const TTS_RETRIES = 2;
const TTS_RETRY_MS = 400;

export interface TtsHandlers {
  onAudio(pcm: Int16Array): void;
  onFirstChunk(): void;
  onFailure(reason: string): void;
}

export interface Tts {
  readonly busy: boolean;
  speak(text: string, speed: number, language: Language): void;
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
  private queue: { text: string; speed: number; language: Language }[] = [];
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

  speak(text: string, speed: number, language: Language): void {
    this.queue.push({ text, speed, language });
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
      language: next.language,
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

// Typecast streams over plain HTTP, one request per sentence, so sentences stay in order by running one at a time.
export class TypecastTts implements Tts {
  private queue: { text: string; speed: number; language: Language }[] = [];
  private active: AbortController | null = null;
  private drainWaiters: (() => void)[] = [];

  constructor(private handlers: TtsHandlers, private options: { url: string; apiKey: string; model: string; voice: string }) {}

  get busy(): boolean {
    return this.active !== null || this.queue.length > 0;
  }

  speak(text: string, speed: number, language: Language): void {
    this.queue.push({ text, speed, language });
    if (!this.active) void this.pump();
  }

  cancel(): void {
    this.queue = [];
    this.active?.abort();
  }

  drained(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  close(): void {
    this.cancel();
  }

  private async pump(): Promise<void> {
    while (this.queue.length) {
      const next = this.queue.shift()!;
      const abort = new AbortController();
      this.active = abort;
      try {
        await this.synthesize(next, abort);
      } catch (error) {
        if (!abort.signal.aborted) this.handlers.onFailure(`tts: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.active = null;
    this.drainWaiters.splice(0).forEach((resolve) => resolve());
  }

  private async synthesize(next: { text: string; speed: number; language: Language }, abort: AbortController): Promise<void> {
    const timer = setTimeout(() => abort.abort(), TTS_RESPONSE_TIMEOUT_MS);
    const request = () => fetch(this.options.url, {
      method: "POST",
      headers: { "X-API-KEY": this.options.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_id: this.options.voice,
        text: next.text,
        model: this.options.model,
        language: TYPECAST_LANGUAGE[next.language],
        output: { audio_format: "wav", audio_tempo: Math.min(1.3, Math.max(0.7, next.speed)) },
      }),
      signal: abort.signal,
    });
    let response = await request();
    // Typecast refuses some requests for a moment (403 unusual activity, 429, 5xx), and one failure must not end a call.
    for (let retry = 1; retry <= TTS_RETRIES && (response.status === 403 || response.status === 429 || response.status >= 500); retry++) {
      console.warn("tts retry", response.status);
      await new Promise((resolve) => setTimeout(resolve, TTS_RETRY_MS * retry));
      response = await request();
    }
    clearTimeout(timer);
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${await response.text()}`);

    let skip = WAV_HEADER_BYTES;
    let held = new Uint8Array(0);
    let first = true;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (abort.signal.aborted) return;
      const body = chunk.subarray(Math.min(skip, chunk.length));
      skip -= chunk.length - body.length;
      const bytes = new Uint8Array(held.length + body.length);
      bytes.set(held);
      bytes.set(body, held.length);
      // 32 kHz to 24 kHz maps every 4 samples to 3, so only whole groups go out and chunk edges cannot click.
      const usable = bytes.length - (bytes.length % 8);
      held = bytes.slice(usable);
      if (!usable) continue;
      if (first) {
        first = false;
        this.handlers.onFirstChunk();
      }
      this.handlers.onAudio(resample(new Int16Array(bytes.buffer, 0, usable / 2), TYPECAST_SAMPLE_RATE, TTS_SAMPLE_RATE));
    }
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
