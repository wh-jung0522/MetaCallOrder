import { describe, expect, it, vi } from "vitest";
import { TypecastTts } from "./tts";

const options = { url: "https://tts.test", apiKey: "k", model: "m", voice: "v" };

function streamOf(chunks: Uint8Array[]) {
  return new Response(new ReadableStream({ start(controller) { chunks.forEach((chunk) => controller.enqueue(chunk)); controller.close(); } }));
}

describe("TypecastTts", () => {
  it("drops the WAV header across chunks, keeps sentence order, and converts to 24 kHz", async () => {
    const pcm = new Int16Array(40).fill(1000);
    const bytes = new Uint8Array(44 + pcm.byteLength).fill(9);
    bytes.set(new Uint8Array(pcm.buffer), 44);
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return streamOf([bytes.subarray(0, 10), bytes.subarray(10, 47), bytes.subarray(47)]);
    }));
    const audio: Int16Array[] = [];
    const tts = new TypecastTts({ onAudio: (chunk) => void audio.push(chunk), onFirstChunk() {}, onFailure: (reason) => { throw new Error(reason); } }, options);
    tts.speak("하나", 0.85, "ko");
    tts.speak("two", 1, "en");
    expect(tts.busy).toBe(true);
    await tts.drained();
    expect(tts.busy).toBe(false);
    expect(bodies.map((body) => JSON.parse(body).language)).toEqual(["kor", "eng"]);
    expect(JSON.parse(bodies[0]!).output.audio_tempo).toBe(0.85);
    const samples = audio.flatMap((chunk) => [...chunk]);
    expect(samples).toHaveLength(60);
    expect(new Set(samples)).toEqual(new Set([1000]));
    vi.unstubAllGlobals();
  });

  it("retries a momentary refusal instead of failing the call", async () => {
    const replies = [new Response("unusual", { status: 403 }), streamOf([new Uint8Array(44 + 8)])];
    vi.stubGlobal("fetch", vi.fn(async () => replies.shift()));
    const failures: string[] = [];
    const audio: Int16Array[] = [];
    const tts = new TypecastTts({ onAudio: (chunk) => void audio.push(chunk), onFirstChunk() {}, onFailure: (reason) => void failures.push(reason) }, options);
    tts.speak("하나", 1, "ko");
    await tts.drained();
    expect(failures).toEqual([]);
    expect(audio).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("reports an API error, but stays quiet when cancelled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Insufficient credit", { status: 402 })));
    const failures: string[] = [];
    const tts = new TypecastTts({ onAudio() {}, onFirstChunk() {}, onFailure: (reason) => void failures.push(reason) }, options);
    tts.speak("하나", 1, "ko");
    await tts.drained();
    expect(failures[0]).toContain("402");

    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))));
    tts.speak("둘", 1, "ko");
    tts.cancel();
    await tts.drained();
    expect(failures).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
