// Pure audio helpers. Phone μ-law paths use these; the simulator path needs no conversion.

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

export function mulawDecode(input: Uint8Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const u = ~input[i]! & 0xff;
    const magnitude = (((u & 0x0f) << 3) + MULAW_BIAS) << ((u & 0x70) >> 4);
    out[i] = u & 0x80 ? MULAW_BIAS - magnitude : magnitude - MULAW_BIAS;
  }
  return out;
}

export function mulawEncode(input: Int16Array): Uint8Array {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let sample = input[i]!;
    const sign = sample < 0 ? 0x80 : 0;
    if (sign) sample = -sample;
    sample = Math.min(sample, MULAW_CLIP) + MULAW_BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    out[i] = ~(sign | (exponent << 4) | ((sample >> (exponent + 3)) & 0x0f)) & 0xff;
  }
  return out;
}

// ponytail: linear interpolation, swap for a windowed-sinc filter if STT accuracy suffers on downsampled audio
export function resample(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || input.length === 0) return input.slice();
  const out = new Int16Array(Math.round((input.length * toRate) / fromRate));
  const step = fromRate / toRate;
  for (let i = 0; i < out.length; i++) {
    const pos = i * step;
    const left = Math.floor(pos);
    const a = input[left] ?? input[input.length - 1]!;
    const b = input[left + 1] ?? a;
    out[i] = Math.round(a + (b - a) * (pos - left));
  }
  return out;
}

export function toBytes(pcm: Int16Array): Uint8Array {
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

export function fromBytes(bytes: ArrayBuffer): Int16Array {
  return new Int16Array(bytes, 0, Math.floor(bytes.byteLength / 2));
}

const THIRD_BAND_TAPS = 47;
// Hann-windowed sinc cut off at 3.4 kHz for 24 kHz input: the phone band, with nothing left to alias at 8 kHz.
const THIRD_BAND_FILTER = Array.from({ length: THIRD_BAND_TAPS }, (_, i) => {
  const n = i - (THIRD_BAND_TAPS - 1) / 2;
  const cutoff = 3400 / 24000;
  const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
  return sinc * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (THIRD_BAND_TAPS - 1)));
});

// Turns 24 kHz speech into 8 kHz phone audio. Keeps state, so chunk edges leave no trace in the result.
export class ThirdRateDownsampler {
  private history = new Int16Array(THIRD_BAND_TAPS - 1);
  private phase = 0;

  process(input: Int16Array): Int16Array {
    const samples = new Int16Array(this.history.length + input.length);
    samples.set(this.history);
    samples.set(input, this.history.length);
    const out = new Int16Array(Math.ceil(input.length / 3));
    let written = 0;
    for (let at = this.history.length + this.phase; at < samples.length; at += 3) {
      let sum = 0;
      for (let tap = 0; tap < THIRD_BAND_TAPS; tap++) sum += THIRD_BAND_FILTER[tap]! * samples[at - tap]!;
      out[written++] = Math.max(-32768, Math.min(32767, Math.round(sum)));
    }
    this.phase = (this.phase + 3 - (input.length % 3)) % 3;
    this.history = samples.slice(samples.length - this.history.length);
    return out.subarray(0, written);
  }
}
