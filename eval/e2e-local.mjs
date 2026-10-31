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
  consents: [],
};

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
  if (req.method === "GET") return reply(db[table].filter(matches));
  if (req.method === "POST") {
    const rows = [].concat(JSON.parse(body));
    const key = url.searchParams.get("on_conflict");
    const inserted = [];
    for (const row of rows) {
      if (key && db[table].some((existing) => existing[key] === row[key])) continue;
      const stored = { id: crypto.randomUUID(), status: "pending", ...row };
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
  let body = "";
  req.on("data", (part) => (body += part));
  req.on("end", () => (req.url.includes("/chat/completions") ? chat(res, body) : rest(req, res, body)));
});

let stt = null;
const sttStats = { handshake: null, frames: 0 };
const ttsStats = { auth: null, configs: [] };
const sttServer = new WebSocketServer({ noServer: true });
const ttsServer = new WebSocketServer({ noServer: true });
const TTS_MS = 400;

sttServer.on("connection", (socket) => {
  stt = socket;
  socket.on("message", (data, isBinary) => {
    if (isBinary) return void sttStats.frames++;
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
  TTS_API_KEY: "test-tts", TTS_URL: `${fake}/tts`, SUPABASE_URL: fake, SUPABASE_SERVICE_ROLE_KEY: "test-service",
  ALLOWED_ORIGINS: ORIGIN, SIM_ACCESS_CODE: "code",
};
const worker = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(WORKER_PORT), ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])], {
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
  client.send(JSON.stringify({ type: "start", callerId: customer.phone_e164, phoneQuality: true }));

  await until(() => events.some((e) => e.type === "start_ack"), "start_ack");
  await until(() => said("무엇을 드릴까요"), "greeting");
  await until(() => sttStats.handshake, "stt handshake");
  assert.equal(sttStats.handshake.authorization.accessToken, "Bearer test-meta");
  assert.equal(sttStats.handshake.mode, "ENDPOINTING");
  assert.ok(sttStats.handshake.keywords.includes("순대국밥"));
  assert.equal(ttsStats.auth, "Bearer test-tts");
  assert.equal(ttsStats.configs[0].speed, 0.9);
  assert.equal(ttsStats.configs[0].language, "ko");

  // Caller audio reaches the STT and agent audio reaches the caller, as whole 16-bit samples
  client.send(new ArrayBuffer(640));
  await until(() => sttStats.frames > 0, "audio forwarded to stt");
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
  console.log(`e2e ok: order ${db.orders[0].total}원, ${audioBytes} audio bytes, cost $${db.calls[0].cost_usd}`);
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
