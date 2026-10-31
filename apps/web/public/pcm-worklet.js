// Runs at the AudioContext's 16 kHz rate: captures 20 ms mic frames and plays queued agent audio.
const FRAME_SAMPLES = 320;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
    this.phoneQuality = false;
    this.held = 0;
    this.noise = 0;
    this.port.onmessage = ({ data }) => {
      if (data.phoneQuality !== undefined) this.phoneQuality = data.phoneQuality;
      if (data.noise !== undefined) this.noise = data.noise;
    };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      // Telephone mode: sample and hold at 8 kHz throws away everything above 4 kHz, like the real network.
      if (!this.phoneQuality || this.filled % 2 === 0) this.held = channel[i];
      const noisy = this.held + (Math.random() * 2 - 1) * this.noise;
      this.frame[this.filled++] = Math.max(-1, Math.min(1, noisy)) * 0x7fff;
      if (this.filled === FRAME_SAMPLES) {
        const out = this.frame.slice();
        this.port.postMessage(out.buffer, [out.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.port.onmessage = ({ data }) => {
      if (data === "clear") {
        this.queue = [];
        this.offset = 0;
      } else {
        this.queue.push(data);
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      const head = this.queue[0];
      if (!head) {
        out[i] = 0;
        continue;
      }
      out[i] = head[this.offset++];
      if (this.offset >= head.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("capture", CaptureProcessor);
registerProcessor("playback", PlaybackProcessor);
