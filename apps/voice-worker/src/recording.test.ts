import { describe, expect, it } from "vitest";
import { CallRecorder, purgeOldAudio, RECORD_RATE } from "./recording";

function setup() {
  const clock = { ms: 0 };
  return { clock, recorder: new CallRecorder(0, () => clock.ms) };
}

function decode(wav: Uint8Array) {
  const view = new DataView(wav.buffer);
  const ascii = (at: number, length: number) => String.fromCharCode(...wav.subarray(at, at + length));
  return {
    riff: ascii(0, 4), wave: ascii(8, 4), data: ascii(36, 4),
    riffSize: view.getUint32(4, true), format: view.getUint16(20, true), channels: view.getUint16(22, true), rate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true), blockAlign: view.getUint16(32, true), bits: view.getUint16(34, true), dataBytes: view.getUint32(40, true),
    // Sample of a channel at a call time.
    at: (channel: number, ms: number) => view.getInt16(44 + Math.floor((ms * RECORD_RATE) / 1000) * 4 + channel * 2, true),
  };
}

const chunk = (ms: number, rate: number, value: number) => new Int16Array((ms * rate) / 1000).fill(value);

describe("CallRecorder", () => {
  it("builds a playable 8 kHz stereo WAV header", () => {
    const { clock, recorder } = setup();
    clock.ms = 1000;
    recorder.addCaller(chunk(1000, 16000, 500), 16000);
    const wav = recorder.toWav();
    const file = decode(wav);
    expect([file.riff, file.wave, file.data]).toEqual(["RIFF", "WAVE", "data"]);
    expect([file.format, file.channels, file.rate, file.bits, file.blockAlign, file.byteRate]).toEqual([1, 2, 8000, 16, 4, 32000]);
    expect(file.dataBytes).toBe(32000);
    expect(file.riffSize).toBe(wav.length - 8);
    expect(wav.length).toBe(44 + 32000);
  });

  it("puts each voice on its own channel at the moment it happened", () => {
    const { clock, recorder } = setup();
    clock.ms = 3000;
    recorder.addCaller(chunk(1000, 16000, 700), 16000); // Spoken from 2 s to 3 s.
    clock.ms = 5000;
    expect(recorder.agentStartMs()).toBe(5000);
    recorder.addAgent(chunk(1000, 24000, -900), 24000);
    const file = decode(recorder.toWav());
    expect(file.dataBytes).toBe(6 * RECORD_RATE * 4);
    expect([file.at(0, 1900), file.at(0, 2100), file.at(0, 2900), file.at(0, 3100)]).toEqual([0, 700, 700, 0]);
    expect([file.at(1, 4900), file.at(1, 5100), file.at(1, 5900)]).toEqual([0, -900, -900]);
    expect(file.at(1, 2500)).toBe(0);
  });

  it("queues agent audio that arrives faster than it plays, and reports where the next sentence lands", () => {
    const { clock, recorder } = setup();
    clock.ms = 1000;
    recorder.addAgent(chunk(2000, 24000, 100), 24000);
    clock.ms = 1100;
    expect(recorder.agentStartMs()).toBe(3000);
    recorder.addAgent(chunk(1000, 24000, 200), 24000);
    const file = decode(recorder.toWav());
    expect([file.at(1, 2900), file.at(1, 3100), file.at(1, 3900)]).toEqual([100, 200, 200]);
  });

  it("keeps samples when chunks split a downsampling group", () => {
    const { clock, recorder } = setup();
    clock.ms = 1000;
    for (let sent = 0; sent < 8000; sent++) recorder.addAgent(new Int16Array(3).fill(50).subarray(0, 1 + (sent % 2)), 24000);
    expect(recorder.seconds).toBeCloseTo(1 + 12000 / 3 / RECORD_RATE, 3);
  });

  it("removes what the caller never heard when they interrupt", () => {
    const { clock, recorder } = setup();
    clock.ms = 1000;
    recorder.addAgent(chunk(5000, 24000, 300), 24000);
    clock.ms = 2000;
    recorder.stopAgent();
    expect(recorder.agentStartMs()).toBe(2000);
    expect(recorder.seconds).toBe(2);
    clock.ms = 2500;
    recorder.addCaller(chunk(500, 16000, 1), 16000);
    const file = decode(recorder.toWav());
    expect([file.at(1, 1500), file.at(1, 2100)]).toEqual([300, 0]);
  });

  it("stays on the clock when the sender stops, and when a stalled burst catches up", () => {
    const { clock, recorder } = setup();
    clock.ms = 1000;
    recorder.addCaller(chunk(1000, 16000, 10), 16000);
    // Half a second stalls in the network, then arrives late but whole.
    clock.ms = 2500;
    recorder.addCaller(chunk(1000, 16000, 20), 16000);
    clock.ms = 2500;
    // The microphone goes away for four seconds.
    clock.ms = 7000;
    recorder.addCaller(chunk(1000, 16000, 30), 16000);
    const file = decode(recorder.toWav());
    expect([file.at(0, 500), file.at(0, 1500), file.at(0, 2500)]).toEqual([10, 20, 0]);
    expect([file.at(0, 5900), file.at(0, 6100), file.at(0, 6900)]).toEqual([0, 30, 30]);
  });

  it("stops writing at the ceiling instead of growing past it", () => {
    const { clock, recorder } = setup();
    clock.ms = 20 * 60_000;
    recorder.addCaller(chunk(1000, 16000, 1), 16000);
    expect(recorder.seconds).toBe(16 * 60);
    const late = setup();
    late.clock.ms = 16 * 60_000 - 500;
    late.recorder.addCaller(chunk(1000, 16000, 1), 16000);
    late.clock.ms += 1000;
    late.recorder.addCaller(chunk(5000, 16000, 1), 16000);
    expect(late.recorder.seconds).toBe(16 * 60);
    expect(late.recorder.toWav().length).toBe(44 + 16 * 60 * RECORD_RATE * 4);
  });
});

describe("purgeOldAudio", () => {
  it("removes only files past 30 days", async () => {
    const now = Date.parse("2026-11-01T00:00:00Z");
    let files = [
      { name: "old.wav", created_at: "2026-09-01T00:00:00Z" },
      { name: "new.wav", created_at: "2026-10-30T00:00:00Z" },
    ];
    const removed = await purgeOldAudio({
      list: async () => ({ data: files, error: null }),
      remove: async (paths) => {
        files = files.filter((file) => !paths.includes(file.name));
        return { error: null };
      },
    }, now);
    expect(removed).toBe(1);
    expect(files.map((file) => file.name)).toEqual(["new.wav"]);
  });
});
