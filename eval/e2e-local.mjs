// Drives a real `wrangler dev` Worker through a whole order call, with Meta, Soniox and Supabase
// replaced by local fakes. Needs no API keys. Run with: pnpm e2e
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const FAKE_PORT = 8799;
const WORKER_PORT = 8798;
const ORIGIN = "http://localhost:5173";
const fake = `http://127.0.0.1:${FAKE_PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const customer = { id: "c1", phone_e164: "+821000000001", name: "김순자", default_address: "행복동 12번지", lat: 37, lng: 127, dietary_notes: null, order_spend_limit: 50000, daily_spend_limit: 100000, preferred_speech_rate: 0.9, is_demo: true };
const store = { id: "s1", name: "행복국밥", phone_e164: "+8220000001", address: "행복동 3번지", lat: 37, lng: 127, adapter_type: "dashboard", adapter_config: {}, is_open: true, delivery_fee: 2000, min_order_amount: 8000, eta_minutes: 30 };
const db = {
  customers: [customer],
  guardians: [{ id: "g1", customer_id: "c1", name: "김민지", phone_e164: "+821000000011", notify_on_order: true }],
  stores: [store],
  menu_items: [{ id: "m1", store_id: "s1", name: "순대국밥", aliases: ["국밥"], price: 9000, options: [], is_available: true }],
  orders: [],
  calls: [],
  call_logs: [],
  consents: [],
};
const audioFiles = new Map();
const OLD_AUDIO = { name: "old.wav", created_at: "2020-01-01T00:00:00Z" };
audioFiles.set(OLD_AUDIO.name, Buffer.alloc(0));
const removedAudio = [];

// Just enough of the Storage API: upload, list and remove.
function storage(req, res, body) {
  const json = (data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
  if (req.url.startsWith("/storage/v1/object/list/call-audio")) {
    return json([...audioFiles.keys()].map((name) => ({ name, created_at: name === OLD_AUDIO.name ? OLD_AUDIO.created_at : new Date().toISOString() })));
  }
  if (req.method === "DELETE") {
    const { prefixes } = JSON.parse(body.toString());
    prefixes.forEach((name) => { audioFiles.delete(name); removedAudio.push(name); });
    return json([]);
  }
  const name = decodeURIComponent(req.url.split("/call-audio/")[1]);
  if (req.headers.authorization !== "Bearer test-service") return json({ message: "unauthorized" }, 401);
  audioFiles.set(name, body);
  json({ Key: `call-audio/${name}` });
}

// Just enough PostgREST for this flow: eq/neq/in/gte filters, upsert, and single-object responses.
function rest(req, res, body) {
  const url = new URL(req.url, fake);
  const table = url.pathname.split("/").pop();
  const filters = [...url.searchParams].filter(([key]) => !["select", "order", "limit", "on_conflict", "columns"].includes(key));
  const matches = (row) => filters.every(([key, raw]) => {
    const [op, ...rest] = raw.split(".");
    const value = rest.join(".");
    if (op === "eq") return String(row[key]) === value;
    if (op === "neq") return String(row[key]) !== value;
    if (op === "in") return value.slice(1, -1).split(",").map((v) => v.replaceAll('"', "")).includes(String(row[key]));
    return true;
  });
  const reply = (rows, status = 200) => {
    const single = (req.headers.accept ?? "").includes("vnd.pgrst.object");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(single ? rows[0] ?? null : rows));
  };
  // Embeds the store for selects like "stores(name, eta_minutes)".
  const withStore = (row) => ((url.searchParams.get("select") ?? "").includes("stores(") ? { ...row, stores: db.stores.find((store) => store.id === row.store_id) ?? null } : row);
  if (req.method === "GET") return reply(db[table].filter(matches).map(withStore));
  if (req.method === "POST") {
    const rows = [].concat(JSON.parse(body));
    const key = url.searchParams.get("on_conflict");
    const inserted = [];
    for (const row of rows) {
      if (key && db[table].some((existing) => existing[key] === row[key])) continue;
      const stored = { id: crypto.randomUUID(), status: "pending", created_at: new Date().toISOString(), ...(table === "customers" ? { is_demo: false } : {}), ...row };
      db[table].push(stored);
      inserted.push(stored);
    }
    return reply(inserted, 201);
  }
  if (req.method === "PATCH") {
    const rows = db[table].filter(matches);
    rows.forEach((row) => Object.assign(row, JSON.parse(body)));
    return reply(rows);
  }
  res.writeHead(405).end();
}

const toolCall = (name, args) => ({ id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } });

// The sub-agent is non-streaming and has the order tools; it walks the cart steps, then places the order once told it is confirmed.
function orderAgentReply(messages) {
  const state = JSON.parse(messages[1].content.replace("[시스템 상태] ", ""));
  const done = messages.filter((m) => m.role === "tool").length;
  const final = (summary) => ({ role: "assistant", content: JSON.stringify({ status: "ok", summary }) });
  if (state.confirmation?.confirmed) {
    return done === 0 ? { role: "assistant", content: null, tool_calls: [toolCall("place_order", { confirmation_token: state.confirmation.token })] } : final("주문 완료");
  }
  if (done === 0) return { role: "assistant", content: null, tool_calls: [toolCall("cart_add", { store_id: "s1", menu_item_id: "m1", quantity: 2 })] };
  if (done === 1) return { role: "assistant", content: null, tool_calls: [toolCall("request_confirmation", {})] };
  return final("복창 완료");
}

function mainReply(messages) {
  const last = messages.at(-1);
  if (last.role === "tool") {
    if (last.content.includes("주문 완료")) return { text: "주문이 끝났습니다. 삼십 분 뒤 도착합니다.", tool: toolCall("end_call", {}) };
    return { text: "조금만 기다려 주세요." };
  }
  if (last.content.includes("[시스템 상태]")) return { text: "안녕하세요, 김순자 고객님. 무엇을 드릴까요?" };
  if (last.content.includes("국밥")) return { tool: toolCall("order_agent", { instruction: "순대국밥 두 개 복창" }) };
  if (/^(네|1)/.test(last.content)) return { tool: toolCall("order_agent", { instruction: "주문 실행" }) };
  return { text: "다시 말씀해 주시겠어요?" };
}

function chat(res, body) {
  const request = JSON.parse(body);
  if (!request.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id: "x", choices: [{ index: 0, finish_reason: "stop", message: orderAgentReply(request.messages) }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  }
  const reply = mainReply(request.messages);
  const chunk = (delta) => res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta }] })}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (reply.text) chunk({ content: reply.text });
  if (reply.tool) chunk({ tool_calls: [{ index: 0, ...reply.tool }] });
  res.write(`data: ${JSON.stringify({ id: "x", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

const providers = createServer((req, res) => {
  const parts = [];
  req.on("data", (part) => parts.push(part));
  req.on("end", () => {
    const body = Buffer.concat(parts);
    if (req.url.startsWith("/storage/")) return storage(req, res, body);
    return req.url.includes("/chat/completions") ? chat(res, body.toString()) : rest(req, res, body.toString());
  });
});

let stt = null;
const sttStats = { handshake: null, voicedFrames: 0 };
const ttsStats = { auth: null, configs: [], refuse: false };
const sttServer = new WebSocketServer({ noServer: true });
const ttsServer = new WebSocketServer({ noServer: true });
const TTS_MS = 400;

sttServer.on("connection", (socket) => {
  stt = socket;
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      // Silence padding also arrives here, so only frames carrying samples prove caller audio got through.
      if (data.some((byte) => byte !== 0)) sttStats.voicedFrames++;
      return;
    }
    const message = JSON.parse(data.toString());
    if (message.authorization) {
      sttStats.handshake = message;
      socket.send(JSON.stringify({ sessionId: "s" }));
    }
  });
});

ttsServer.on("connection", (socket, req) => {
  ttsStats.auth = req.headers.authorization;
  const configs = new Map();
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.cancel) return socket.send(JSON.stringify({ stream_id: message.stream_id, terminated: true }));
    if (message.model) {
      configs.set(message.stream_id, message);
      ttsStats.configs.push(message);
    }
    if (message.text_end && ttsStats.refuse) {
      socket.send(JSON.stringify({ stream_id: message.stream_id, error_message: "refused for key test-tts" }));
      return socket.send(JSON.stringify({ stream_id: message.stream_id, terminated: true }));
    }
    if (message.text_end) {
      // An odd-length first chunk proves split samples get re-joined.
      const samples = Buffer.alloc(Math.floor((24000 * TTS_MS) / 1000) * 2, 1);
      const id = message.stream_id;
      socket.send(JSON.stringify({ stream_id: id, audio: samples.subarray(0, 101).toString("base64") }));
      socket.send(JSON.stringify({ stream_id: id, audio: samples.subarray(101).toString("base64"), audio_end: true }));
      socket.send(JSON.stringify({ stream_id: id, terminated: true }));
    }
  });
});

providers.on("upgrade", (req, socket, head) => {
  const server = req.url.startsWith("/stt") ? sttServer : ttsServer;
  server.handleUpgrade(req, socket, head, (ws) => server.emit("connection", ws, req));
});

await new Promise((resolve) => providers.listen(FAKE_PORT, resolve));

const vars = {
  META_API_KEY: "test-meta", META_BASE_URL: `${fake}/v1`, META_STT_URL: `${fake}/stt`,
  TTS_PROVIDER: "soniox", TTS_API_KEY: "test-tts", TTS_URL: `${fake}/tts`, SUPABASE_URL: fake, SUPABASE_SERVICE_ROLE_KEY: "test-service",
  ALLOWED_ORIGINS: ORIGIN, SIM_ACCESS_CODE: "code", PHONE_WEBHOOK_TOKEN: "test-phone",
};
const worker = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(WORKER_PORT), "--test-scheduled", ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])], {
  cwd: new URL("../apps/voice-worker/", import.meta.url), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, detached: true,
});
let workerLog = "";
worker.stdout.on("data", (part) => (workerLog += part));
worker.stderr.on("data", (part) => (workerLog += part));

const base = `http://127.0.0.1:${WORKER_PORT}`;
const events = [];
let audioBytes = 0;
let client;

async function until(predicate, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`timed out: ${label}\nevents: ${JSON.stringify(events.slice(-12), null, 1)}`);
}

const said = (text) => events.some((event) => event.type === "assistant_text" && event.text.includes(text));
function speak(text) {
  stt.send(JSON.stringify({ type: "speechStart", turnId: 1, audioProcessedMs: 0 }));
  stt.send(JSON.stringify({ type: "transcript", transcript: text, final: false, audioProcessedMs: 1 }));
  stt.send(JSON.stringify({ type: "speechEnd", turnId: 1, audioProcessedMs: 2 }));
  stt.send(JSON.stringify({ type: "speechComplete", turnId: 1, transcript: text, audioProcessedMs: 3 }));
}

try {
  await until(() => workerLog.includes("Ready on"), "worker ready", 40000);

  // Trust boundary checks
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/sim/callers?code=code`, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(`${base}/sim/callers?code=wrong`, { headers: { origin: ORIGIN } })).status, 401);
  const callers = await (await fetch(`${base}/sim/callers?code=code`, { headers: { origin: ORIGIN } })).json();
  assert.deepEqual(callers.map((c) => c.phone_e164), [customer.phone_e164]);

  client = new WebSocket(`ws://127.0.0.1:${WORKER_PORT}/sim/stream?callId=e2e-call-0001&code=code`, { headers: { origin: ORIGIN } });
  client.binaryType = "arraybuffer";
  client.on("message", (data, isBinary) => {
    if (isBinary) audioBytes += data.byteLength;
    else events.push(JSON.parse(data.toString()));
  });
  await new Promise((resolve, reject) => { client.on("open", resolve); client.on("error", reject); });
  client.send(JSON.stringify({ type: "start", callerId: customer.phone_e164, phoneQuality: true, lang: "ko" }));

  await until(() => events.some((e) => e.type === "start_ack"), "start_ack");
  await until(() => said("무엇을 주문해 드릴까요"), "greeting");
  await until(() => sttStats.handshake, "stt handshake");
  assert.equal(sttStats.handshake.authorization.accessToken, "Bearer test-meta");
  assert.equal(sttStats.handshake.mode, "ENDPOINTING");
  assert.ok(sttStats.handshake.keywords.includes("순대국밥"));
  assert.equal(ttsStats.auth, "Bearer test-tts");
  assert.equal(ttsStats.configs[0].speed, 0.9);
  assert.equal(ttsStats.configs[0].language, "ko");

  // Caller audio reaches the STT and agent audio reaches the caller, as whole 16-bit samples
  client.send(new Int16Array(320).fill(1000).buffer);
  await until(() => sttStats.voicedFrames > 0, "caller audio forwarded to stt");
  await until(() => audioBytes > 0, "agent audio received");
  await sleep(1500);
  assert.equal(audioBytes % 2, 0, "audio must be whole samples");

  speak("저번에 시킨 국밥 두 그릇 갖다 줘요");
  await until(() => said("보내드릴까요"), "recap");
  assert.ok(said("네, 확인해 볼게요"), "filler before the tool call");
  assert.ok(said("행복국밥에서 순대국밥 두 개, 배달비 포함 이만 원, 행복동 12번지로"), "recap is verbatim");

  // "네" spoken over the recap is a backchannel and must not place the order
  speak("네");
  await sleep(150);
  assert.equal(db.orders.length, 0, "backchannel during the recap must not order");
  await sleep(TTS_MS * 2 + 400);
  assert.equal(db.orders.length, 0);

  speak("네");
  await until(() => db.orders.length === 1, "order inserted");
  assert.equal(db.orders[0].total, 20000);
  assert.equal(db.orders[0].call_sid, "e2e-call-0001");
  await until(() => events.some((e) => e.type === "guardian_sms"), "guardian notified");
  await until(() => events.some((e) => e.type === "hangup"), "hangup after end_call", 15000);
  await until(() => db.calls[0]?.outcome, "call record finished");

  assert.equal(db.calls[0].outcome, "ordered");
  assert.ok(db.calls[0].cost_usd > 0);
  assert.ok(db.calls[0].transcript.some((line) => line.role === "caller" && line.text === "네"));
  assert.ok(db.consents.length >= 2);

  // Every log row is written, in order, in one insert, with nothing secret in it.
  await until(() => db.call_logs.length && audioFiles.has("e2e-call-0001.wav"), "logs and audio written");
  const logs = db.call_logs.filter((row) => row.call_sid === "e2e-call-0001");
  assert.deepEqual(logs.map((row) => row.seq), logs.map((_, index) => index), "seq runs in order with no gaps");
  const kinds = new Set(logs.map((row) => row.kind));
  for (const kind of ["call_start", "stt_speech_start", "speech_end", "stt_final", "llm_request", "llm_response", "tool_call", "say", "tts_start", "latency", "usage", "call_end", "audio"]) assert.ok(kinds.has(kind), `log has ${kind}`);
  const llm = logs.filter((row) => row.kind === "llm_response");
  assert.ok(llm.some((row) => row.payload.agent === "conversation"), "conversation reply logged");
  assert.ok(llm.some((row) => row.payload.agent === "order"), "order agent logged");
  assert.ok(logs.some((row) => row.kind === "tool_call" && row.payload.tool === "place_order" && row.payload.result.order_id), "tool result logged");
  assert.ok(logs.some((row) => row.kind === "tool_call" && row.payload.tool === "order_agent"), "conversation tool logged");
  assert.ok(logs.some((row) => row.kind === "stt_final" && row.payload.ignored === true), "the skipped backchannel is logged");
  assert.ok(logs.find((row) => row.kind === "stt_final").payload.partials >= 1, "partials counted");
  const secrets = JSON.stringify(logs);
  for (const secret of ["test-meta", "test-tts", "test-service", "accessToken", "authorization", "test-phone"]) assert.ok(!secrets.includes(secret), `${secret} must not be logged`);

  // The WAV is stereo on the call clock: the agent's voice starts where the log says it does.
  const wav = audioFiles.get("e2e-call-0001.wav");
  assert.equal(wav.toString("latin1", 0, 4), "RIFF");
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 8000);
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  const sample = (channel, ms) => wav.readInt16LE(44 + Math.floor(ms * 8) * 4 + channel * 2);
  const started = logs.filter((row) => row.kind === "tts_start");
  assert.ok(started.length >= 3, "each sentence has its place in the audio");
  assert.equal(sample(1, started[0].payload.audio_ms + 50), 257, "agent voice at the logged moment");
  assert.ok(started[0].payload.audio_ms > 0 ? sample(1, started[0].payload.audio_ms - 5) === 0 : true, "silence before the first sentence");
  const audioEntry = logs.find((row) => row.kind === "audio");
  assert.equal(audioEntry.payload.path, "e2e-call-0001.wav");
  assert.ok(Math.abs(wav.readUInt32LE(40) / 32000 - audioEntry.payload.seconds) < 0.01, "file length matches the log");
  // The 1000-valued caller frame went to the left channel only.
  let callerSamples = 0;
  for (let at = 44; at + 3 < wav.length; at += 4) if (wav.readInt16LE(at) === 1000) callerSamples++;
  assert.equal(callerSamples, 160);
  assert.equal(db.calls[0].channel, "simulator");

  // The daily cron removes old audio and leaves recent audio alone.
  assert.equal((await fetch(`${base}/__scheduled?cron=0+3+*+*+*`)).status, 200);
  await until(() => removedAudio.includes(OLD_AUDIO.name), "old audio purged");
  assert.ok(audioFiles.has("e2e-call-0001.wav"));

  // A refused voice must not end a simulator call: the screen is told, the call carries on in text, and the failure is logged.
  ttsStats.refuse = true;
  stt = null;
  const silent = [];
  const second = new WebSocket(`ws://127.0.0.1:${WORKER_PORT}/sim/stream?callId=e2e-call-0002&code=code`, { headers: { origin: ORIGIN } });
  second.on("message", (data, isBinary) => { if (!isBinary) silent.push(JSON.parse(data.toString())); });
  await new Promise((resolve, reject) => { second.on("open", resolve); second.on("error", reject); });
  second.send(JSON.stringify({ type: "start", callerId: customer.phone_e164, lang: "ko" }));
  await until(() => silent.some((e) => e.type === "voice_off"), "voice off event");
  // Calling back while the first order is still on its way: the call opens with how long is left.
  await until(() => silent.some((e) => e.type === "assistant_text" && e.text.includes("주문하신 순대국밥") && e.text.includes("약 30분 뒤 도착합니다")), "order on its way announced");
  await until(() => stt, "second stt");
  await sleep(300);
  const repliesBefore = silent.filter((e) => e.type === "assistant_text").length;
  speak("여보세요 들리세요");
  await until(() => silent.filter((e) => e.type === "assistant_text").length > repliesBefore, "text reply after the voice went off");
  assert.ok(!silent.some((e) => e.type === "hangup" || e.type === "fail_safe"), "call still up");
  second.close();
  await until(() => db.call_logs.some((row) => row.call_sid === "e2e-call-0002" && row.kind === "tts_off"), "tts failure logged");
  assert.ok(!JSON.stringify(db.call_logs.filter((row) => row.call_sid === "e2e-call-0002")).includes("test-tts"), "provider errors are scrubbed");
  ttsStats.refuse = false;

  // A number's first call asks for the address, keeps what was said, and tells the caller delivery stays at the demo address.
  stt = null;
  const firstTime = [];
  const newcomer = new WebSocket(`ws://127.0.0.1:${WORKER_PORT}/sim/stream?callId=e2e-call-0003&code=code`, { headers: { origin: ORIGIN } });
  newcomer.on("message", (data, isBinary) => { if (!isBinary) firstTime.push(JSON.parse(data.toString())); });
  await new Promise((resolve, reject) => { newcomer.on("open", resolve); newcomer.on("error", reject); });
  newcomer.send(JSON.stringify({ type: "start", callerId: "+821077770001", lang: "ko" }));
  const agentSaid = (text) => firstTime.some((e) => e.type === "assistant_text" && e.text.includes(text));
  await until(() => agentSaid("배달 받으실 주소를 말씀해 주세요"), "address asked first");
  assert.ok(!agentSaid("무엇을 주문해 드릴까요"), "no order question before the address");
  newcomer.send(JSON.stringify({ type: "utterance", text: "서울 마포구 망원동 12번지요" }));
  await until(() => agentSaid("시연 중이라 배달 주소는 행복동 12번지로 정해집니다"), "demo address notice");
  await until(() => db.customers.find((row) => row.phone_e164 === "+821077770001")?.stated_address, "stated address saved");
  assert.equal(db.customers.find((row) => row.phone_e164 === "+821077770001").stated_address, "서울 마포구 망원동 12번지요");
  newcomer.close();

  // A first-time caller is registered and privately. A blocked caller id still connects, as a phone call, with no customer.
  const callIn = async (from) => {
    const body = new FormData();
    body.set("From", from);
    const response = await fetch(`${base}/phone/voice`, { method: "POST", headers: { "x-callorder-token": "test-phone" }, body });
    assert.equal(response.status, 200);
    const xml = await response.text();
    assert.ok(xml.includes("<Connect><Stream"), xml);
    return xml.match(/url="wss:\/\/[^/]+([^"]+)"/)[1].replaceAll("&amp;", "&");
  };
  await callIn("010-5555-0001");
  const created = db.customers.find((row) => row.phone_e164 === "+821055550001");
  assert.equal(created.name, "고객");
  assert.equal(created.is_demo, false);
  await callIn("010-5555-0001");
  assert.equal(db.customers.filter((row) => row.phone_e164 === "+821055550001").length, 1, "a repeat caller is not added twice");
  await callIn(customer.phone_e164);
  assert.equal(db.customers.find((row) => row.id === "c1").name, "김순자", "an existing customer is left alone");

  // A screen watching a number sees that number's real calls, and only those, even when two calls run at once.
  const watchers = await Promise.all(["+821055550001", customer.phone_e164].map(async (number) => {
    const socket = new WebSocket(`ws://127.0.0.1:${WORKER_PORT}/sim/watch?phone=${encodeURIComponent(number)}&code=code`, { headers: { origin: ORIGIN } });
    const events = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString())));
    await new Promise((resolve, reject) => { socket.on("open", resolve); socket.on("error", reject); });
    return { socket, events };
  }));
  const lines = await Promise.all(["010-5555-0001", customer.phone_e164].map(async (from) => {
    const line = new WebSocket(`ws://127.0.0.1:${WORKER_PORT}${await callIn(from)}`);
    await new Promise((resolve, reject) => { line.on("open", resolve); line.on("error", reject); });
    line.send(JSON.stringify({ event: "start" }));
    return line;
  }));
  await until(() => watchers.every(({ events }) => events.some((event) => event.type === "start_ack")), "both screens see their call start");
  lines.forEach((line) => line.send(JSON.stringify({ event: "stop" })));
  await until(() => watchers.every(({ events }) => events.some((event) => event.type === "hangup")), "both screens see their call end");
  const [firstCalls, secondCalls] = watchers.map(({ events }) => new Set(events.map((event) => event.callId)));
  assert.equal(firstCalls.size, 1, "one call per screen");
  assert.equal(secondCalls.size, 1, "one call per screen");
  assert.notDeepEqual([...firstCalls], [...secondCalls], "calls at the same time stay apart");
  watchers.forEach(({ socket }) => socket.terminate());

  const count = db.customers.length;
  const path = await callIn("anonymous");
  assert.equal(db.customers.length, count);
  stt = null;
  const blockedSid = new URLSearchParams(path.split("?")[1]).get("callId");
  const phone = new WebSocket(`ws://127.0.0.1:${WORKER_PORT}${path}`);
  await new Promise((resolve, reject) => { phone.on("open", resolve); phone.on("error", reject); });
  phone.send(JSON.stringify({ event: "start" }));
  await until(() => db.calls.some((row) => row.call_sid === blockedSid), "blocked call started");
  const blocked = db.calls.find((row) => row.call_sid === blockedSid);
  assert.equal(blocked.channel, "phone", "a blocked caller must stay a private phone call");
  assert.equal(blocked.customer_id, null);
  phone.send(JSON.stringify({ event: "stop" }));
  await until(() => db.call_logs.some((row) => row.call_sid === blockedSid && row.kind === "call_end"), "blocked call logged");

  console.log(`e2e ok: order ${db.orders[0].total}원, ${audioBytes} audio bytes, ${logs.length} log rows, ${wav.length} byte recording, cost $${db.calls[0].cost_usd}`);
} catch (error) {
  console.error(error);
  console.error(workerLog.slice(-3000));
  process.exitCode = 1;
} finally {
  client?.terminate();
  try { process.kill(-worker.pid); } catch {}
  providers.closeAllConnections?.();
  providers.close();
  setTimeout(() => process.exit(), 200);
}
