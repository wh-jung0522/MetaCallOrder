import { describe, expect, it } from "vitest";
import { mulawDecode, mulawEncode, resample, ThirdRateDownsampler } from "./index";

describe("mulaw", () => {
  it("round-trips within quantization error", () => {
    const pcm = Int16Array.from([0, 100, -100, 1000, -1000, 8000, -8000, 32000, -32000]);
    const back = mulawDecode(mulawEncode(pcm));
    pcm.forEach((sample, i) => {
      expect(Math.abs(sample - back[i]!)).toBeLessThanOrEqual(Math.max(16, Math.abs(sample) * 0.04));
    });
  });

  it("encodes silence to the standard 0xFF byte", () => {
    expect(mulawEncode(Int16Array.from([0]))[0]).toBe(0xff);
  });

  it("clips extremes without overflowing", () => {
    const back = mulawDecode(mulawEncode(Int16Array.from([32767, -32768])));
    expect(back[0]).toBeGreaterThan(30000);
    expect(back[1]).toBeLessThan(-30000);
  });
});

describe("resample", () => {
  it("doubles length 8k→16k and interpolates", () => {
    const out = resample(Int16Array.from([0, 100, 200, 300]), 8000, 16000);
    expect(out.length).toBe(8);
    expect(out[1]).toBe(50);
  });

  it("halves length 16k→8k", () => {
    expect(resample(new Int16Array(320), 16000, 8000).length).toBe(160);
  });

  it("returns a copy at equal rates and handles empty input", () => {
    const input = Int16Array.from([1, 2]);
    const out = resample(input, 8000, 8000);
    expect(Array.from(out)).toEqual([1, 2]);
    expect(out).not.toBe(input);
    expect(resample(new Int16Array(0), 8000, 16000).length).toBe(0);
  });
});

describe("ThirdRateDownsampler", () => {
  const tone = (hz: number, length: number) => Int16Array.from({ length }, (_, i) => Math.round(10000 * Math.sin((2 * Math.PI * hz * i) / 24000)));
  const rms = (pcm: Int16Array) => Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length);

  it("keeps speech and removes what would alias at 8 kHz", () => {
    expect(rms(new ThirdRateDownsampler().process(tone(1000, 24000)).subarray(100))).toBeGreaterThan(6500);
    expect(rms(new ThirdRateDownsampler().process(tone(6000, 24000)).subarray(100))).toBeLessThan(300);
  });

  it("gives the same result however the audio is chunked", () => {
    const whole = new ThirdRateDownsampler().process(tone(1000, 2400));
    const chunked = new ThirdRateDownsampler();
    const parts = [1, 2, 500, 7, 890, 1000].flatMap((size, index, sizes) => {
      const start = sizes.slice(0, index).reduce((a, b) => a + b, 0);
      return [...chunked.process(tone(1000, 2400).subarray(start, start + size))];
    });
    expect(parts).toEqual([...whole]);
  });
});
