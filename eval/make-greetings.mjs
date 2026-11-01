// Records the fixed opening lines once, so calls start instantly and spend no TTS credit on them.
// Rerun after changing these lines, TTS_VOICE or TTS_MODEL: TTS_API_KEY=... node eval/make-greetings.mjs
import { writeFileSync } from "node:fs";
import { resample } from "../packages/audio/src/index.ts";

const VOICE = "tc_69f2e455ea79fd197aa0476f";
const MODEL = "ssfm-v31";
const OUT = new URL("../apps/voice-worker/src/greetings/", import.meta.url);
const CLIPS = {
  "ko-greeting": ["kor", "안녕하세요, 콜오더 주문 전화입니다. AI가 주문을 도와드립니다. 통화 내용은 주문 처리를 위해 기록됩니다."],
  "ko-other": ["kor", "한국어로 말씀하셔도 됩니다."],
  "en-greeting": ["eng", "Hello, this is CallOrder. An AI will help with your order, and this call is recorded to process it."],
  "en-other": ["eng", "You can also speak English."],
};

for (const [name, [language, text]] of Object.entries(CLIPS)) {
  const response = await fetch("https://api.typecast.ai/v1/text-to-speech", {
    method: "POST",
    headers: { "X-API-KEY": process.env.TTS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ voice_id: VOICE, text, model: MODEL, language, output: { audio_format: "wav" } }),
  });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status} ${await response.text()}`);
  const wav = Buffer.from(await response.arrayBuffer());
  const rate = wav.readUInt32LE(24);
  const data = wav.indexOf("data") + 8;
  const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + data, wav.byteOffset + wav.length - ((wav.length - data) % 2)));
  writeFileSync(new URL(`${name}.pcm`, OUT), new Uint8Array(resample(pcm, rate, 24000).buffer));
  console.log(name, rate, `${(pcm.length / rate).toFixed(1)}s`);
}
