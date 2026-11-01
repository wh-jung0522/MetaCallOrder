export const RECORD_RATE = 8000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;
const BLOCK_FRAMES = RECORD_RATE * 60;
const MAX_BLOCKS = 16; // MAX_CALL_MS is 15 minutes, plus a minute for the goodbye to finish playing.
export const AUDIO_BUCKET = "call-audio";

// Memory ceiling, against the Durable Object limit of 128 MB:
//   8000 Hz x 2 channels x 2 bytes x 960 s = 30.72 MB of blocks while recording.
//   61.44 MB for the moment toWav() copies them into one body.
// That is why this is 8 kHz: at 16 kHz the same call peaks at 123 MB, which does not fit beside anything else and is
// over Supabase's 50 MB free plan upload limit. Blocks are allocated as the call reaches them, so a two minute call
// costs about 8 MB. Objects can share an isolate, so two longest-possible calls ending at the same instant is the
// one case near the limit.
// ponytail: stream the upload instead of toWav() if isolates ever hold several long calls at once.

// Frames written ahead of or behind the clock by more than this mean the sender stopped or restarted, not jitter.
const MAX_BEHIND_FRAMES = RECORD_RATE;
const MAX_AHEAD_FRAMES = Math.floor(RECORD_RATE * 0.3);

interface Track {
  channel: 0 | 1;
  cursor: number;
  started: boolean;
  // Downsampling averages each group of samples, and a group can span two chunks.
  sum: number;
  count: number;
}

// Caller on the left, agent on the right, both on the call clock: second N of the file is second N of the call,
// so a log entry's ms is directly a seek position.
export class CallRecorder {
  private blocks: (Int16Array | undefined)[] = [];
  private caller: Track = { channel: 0, cursor: 0, started: false, sum: 0, count: 0 };
  private agent: Track = { channel: 1, cursor: 0, started: false, sum: 0, count: 0 };
  private end = 0;

  constructor(private startedAt: number, private now: () => number = Date.now) {}

  // Arrives in real time, so it is placed by when it arrived, minus how long the chunk itself lasts.
  addCaller(pcm: Int16Array, rate: number): void {
    const track = this.caller;
    const expected = Math.max(0, this.clockFrames() - Math.round((pcm.length * RECORD_RATE) / rate));
    const drift = expected - track.cursor;
    if (!track.started || drift > MAX_BEHIND_FRAMES || drift < -MAX_AHEAD_FRAMES) track.cursor = expected;
    this.write(track, pcm, rate);
  }

  // Arrives faster than real time and plays back later, so each chunk follows the last unless playback has run dry.
  addAgent(pcm: Int16Array, rate: number): void {
    this.agent.cursor = Math.max(this.agent.cursor, this.clockFrames());
    this.write(this.agent, pcm, rate);
  }

  // Where the next agent audio lands, in call milliseconds.
  agentStartMs(): number {
    return Math.round((Math.max(this.agent.cursor, this.clockFrames()) * 1000) / RECORD_RATE);
  }

  // The caller only heard up to now, so the rest of what was queued comes back out.
  stopAgent(): void {
    const now = this.clockFrames();
    for (let frame = now; frame < this.agent.cursor; frame++) {
      const block = this.blocks[Math.floor(frame / BLOCK_FRAMES)];
      if (block) block[(frame % BLOCK_FRAMES) * CHANNELS + 1] = 0;
    }
    this.agent.cursor = Math.min(this.agent.cursor, now);
    this.agent.sum = this.agent.count = 0;
    this.end = Math.min(MAX_BLOCKS * BLOCK_FRAMES, Math.max(this.caller.cursor, this.agent.cursor));
  }

  get seconds(): number {
    return this.end / RECORD_RATE;
  }

  // Hands the blocks over as it copies them, so call this once, at the end.
  toWav(): Uint8Array {
    const dataBytes = this.end * CHANNELS * BYTES_PER_SAMPLE;
    const wav = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
    const view = new DataView(wav.buffer);
    const ascii = (at: number, text: string) => [...text].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
    ascii(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    ascii(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, CHANNELS, true);
    view.setUint32(24, RECORD_RATE, true);
    view.setUint32(28, RECORD_RATE * CHANNELS * BYTES_PER_SAMPLE, true);
    view.setUint16(32, CHANNELS * BYTES_PER_SAMPLE, true);
    view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
    ascii(36, "data");
    view.setUint32(40, dataBytes, true);
    const blockBytes = BLOCK_FRAMES * CHANNELS * BYTES_PER_SAMPLE;
    this.blocks.forEach((block, index) => {
      if (!block) return;
      const at = index * blockBytes;
      if (at < dataBytes) wav.set(new Uint8Array(block.buffer, 0, Math.min(blockBytes, dataBytes - at)), WAV_HEADER_BYTES + at);
      this.blocks[index] = undefined;
    });
    return wav;
  }

  private clockFrames(): number {
    return Math.floor(((this.now() - this.startedAt) * RECORD_RATE) / 1000);
  }

  private write(track: Track, pcm: Int16Array, rate: number): void {
    const group = rate / RECORD_RATE;
    for (const sample of pcm) {
      track.sum += sample;
      if (++track.count < group) continue;
      this.put(track, Math.round(track.sum / track.count));
      track.sum = track.count = 0;
    }
    track.started = true;
    this.end = Math.min(MAX_BLOCKS * BLOCK_FRAMES, Math.max(this.end, track.cursor));
  }

  private put(track: Track, value: number): void {
    const index = Math.floor(track.cursor / BLOCK_FRAMES);
    if (index >= MAX_BLOCKS) return;
    const block = (this.blocks[index] ??= new Int16Array(BLOCK_FRAMES * CHANNELS));
    block[(track.cursor % BLOCK_FRAMES) * CHANNELS + track.channel] = value;
    track.cursor++;
  }
}

const AUDIO_KEEP_DAYS = 30;
const PAGE = 1000;

interface AudioBucket {
  list(path: string, options: { limit: number; sortBy: { column: string; order: string } }): Promise<{ data: { name: string; created_at: string | null }[] | null; error: unknown }>;
  remove(paths: string[]): Promise<{ error: unknown }>;
}

// pg_cron cannot do this: Supabase refuses direct deletes from storage.objects, so it goes through the Storage API.
export async function purgeOldAudio(bucket: AudioBucket, now = Date.now()): Promise<number> {
  const cutoff = now - AUDIO_KEEP_DAYS * 86_400_000;
  let removed = 0;
  for (;;) {
    const { data, error } = await bucket.list("", { limit: PAGE, sortBy: { column: "created_at", order: "asc" } });
    if (error) throw error;
    const old = (data ?? []).filter((file) => file.created_at && new Date(file.created_at).getTime() < cutoff).map((file) => file.name);
    if (old.length) {
      const { error: failure } = await bucket.remove(old);
      if (failure) throw failure;
      removed += old.length;
    }
    if (old.length < PAGE) return removed;
  }
}
