// Pure audio helpers. Twilio μ-law paths use these; the simulator path needs no conversion.

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
