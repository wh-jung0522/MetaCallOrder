import { CustomerRepository } from "@callorder/adapters";
import { createDb, type Env } from "./env";
import { AUDIO_BUCKET, purgeOldAudio } from "./recording";

export { CallSession } from "./call-session";

export function isAllowedOrigin(origin: string | null, allowed: string): boolean {
  if (!origin) return false;
  return allowed.split(",").some((pattern) => {
    const source = pattern.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+");
    return new RegExp(`^${source}$`).test(origin);
  });
}

const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

// Binds a stream to the caller id the webhook vouched for, so nobody can open one claiming a customer's number.
export async function signStream(callId: string, caller: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${callId}:${caller}`)));
}

export function toE164(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, "");
  return digits.startsWith("0") ? `+82${digits.slice(1)}` : digits;
}

const xml = (body: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { "content-type": "application/xml" } });
const CALLER_ID = /^\+\d{8,15}$/;

// Twilio signs the webhook URL plus its form fields, sorted by name, with the account's Auth Token.
export async function twilioSignature(url: string, form: FormData, authToken: string): Promise<string> {
  const fields = [...new Set(form.keys())].sort().map((name) => `${name}${form.get(name)}`).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(url + fields));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function answerPhone(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.PHONE_WEBHOOK_TOKEN || request.headers.get("x-callorder-token") !== env.PHONE_WEBHOOK_TOKEN) return new Response("forbidden", { status: 403 });
  return connectCaller(await request.formData(), env, url.host, false);
}

async function answerTwilio(request: Request, env: Env, url: URL): Promise<Response> {
  const form = await request.formData();
  const expected = env.TWILIO_AUTH_TOKEN && (await twilioSignature(`https://${url.host}${url.pathname}`, form, env.TWILIO_AUTH_TOKEN));
  if (!expected || request.headers.get("x-twilio-signature") !== expected) return new Response("forbidden", { status: 403 });
  return connectCaller(form, env, url.host, true);
}

async function connectCaller(form: FormData, env: Env, host: string, twilio: boolean): Promise<Response> {
  const caller = toE164(String(form.get("From") ?? ""));
  // Anyone can order from any phone. A blocked caller id connects with no customer, which the call handles as unregistered.
  const known = CALLER_ID.test(caller);
  if (known) {
    try {
      await new CustomerRepository(createDb(env)).ensureCaller(caller);
    } catch (error) {
      console.error("caller registration failed", error);
    }
  }
  const callId = crypto.randomUUID();
  // ponytail: the caller id sits in the signed URL and so in access logs; hand it over through the DO if logs ever leave this account
  const signedCaller = known ? caller : "";
  const dialed = toE164(String(form.get("To") ?? ""));
  const lang = dialed.startsWith("+1") ? "en" : "ko";
  const sig = await signStream(callId, signedCaller, env.PHONE_WEBHOOK_TOKEN);
  // Twilio does not allow a query string on a stream URL.
  if (twilio) return xml(`<Connect><Stream url="wss://${host}/twilio/stream/${callId}/${lang}/${signedCaller.slice(1) || "none"}/${sig}"/></Connect>`);
  const query = new URLSearchParams({ callId, caller: signedCaller, lang, sig });
  return xml(`<Connect><Stream url="wss://${host}/phone/stream?${query.toString().replaceAll("&", "&amp;")}"/></Connect>`);
}

function corsHeaders(origin: string): HeadersInit {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "x-access-code",
    vary: "origin",
  };
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    console.log("purged call audio", await purgeOldAudio(createDb(env).storage.from(AUDIO_BUCKET)));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });

    if (url.pathname === "/phone/voice" && request.method === "POST") return answerPhone(request, env, url);
    if (url.pathname === "/twilio/voice" && request.method === "POST") return answerTwilio(request, env, url);
    if (url.pathname.startsWith("/twilio/stream/")) {
      const [callId = "", lang = "", digits = "", sig = ""] = url.pathname.split("/").slice(3);
      const caller = digits === "none" ? "" : `+${digits}`;
      if (!env.PHONE_WEBHOOK_TOKEN || sig !== (await signStream(callId, caller, env.PHONE_WEBHOOK_TOKEN))) return new Response("forbidden", { status: 403 });
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
      const query = new URLSearchParams({ callId, caller, lang, provider: "twilio" });
      return env.CALL_SESSION.getByName(callId).fetch(new Request(`https://${url.host}/phone/stream?${query}`, request));
    }
    if (url.pathname === "/phone/stream") {
      const callId = url.searchParams.get("callId") ?? "";
      const caller = url.searchParams.get("caller") ?? "";
      if (!env.PHONE_WEBHOOK_TOKEN || url.searchParams.get("sig") !== (await signStream(callId, caller, env.PHONE_WEBHOOK_TOKEN))) return new Response("forbidden", { status: 403 });
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
      return env.CALL_SESSION.getByName(callId).fetch(request);
    }

    const origin = request.headers.get("origin");
    if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) return new Response("forbidden origin", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin!) });

    // Origin stops other sites, not scripts. The code stops strangers spending API credit and writing orders.
    const code = url.searchParams.get("code") ?? request.headers.get("x-access-code");
    if (!env.SIM_ACCESS_CODE || code !== env.SIM_ACCESS_CODE) {
      return new Response("invalid access code", { status: 401, headers: corsHeaders(origin!) });
    }

    if (url.pathname === "/sim/callers") {
      // No service key yet: the simulator still opens and the call explains what is missing.
      if (!env.SUPABASE_SERVICE_ROLE_KEY) return Response.json([], { headers: corsHeaders(origin!) });
      return Response.json(await new CustomerRepository(createDb(env)).listDemo(), { headers: corsHeaders(origin!) });
    }

    if (url.pathname === "/sim/stream") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
      const callId = url.searchParams.get("callId") ?? "";
      if (!/^[a-zA-Z0-9-]{8,64}$/.test(callId)) return new Response("invalid callId", { status: 400 });
      return env.CALL_SESSION.getByName(callId).fetch(request);
    }

    return new Response("not found", { status: 404, headers: corsHeaders(origin!) });
  },
} satisfies ExportedHandler<Env>;
