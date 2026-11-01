import { CustomerRepository } from "@callorder/adapters";
import { createDb, type Env } from "./env";

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
const NOT_REGISTERED = '<Say language="ko">등록된 번호로만 주문하실 수 있습니다.</Say><Say language="en">Orders are only available from registered numbers.</Say>';

async function answerPhone(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.PHONE_WEBHOOK_TOKEN || request.headers.get("x-callorder-token") !== env.PHONE_WEBHOOK_TOKEN) return new Response("forbidden", { status: 403 });
  const form = await request.formData();
  const caller = toE164(String(form.get("From") ?? ""));
  // Stops strangers spending API credit on a public number before any model runs.
  if (!(await new CustomerRepository(createDb(env)).findByPhone(caller))) return xml(NOT_REGISTERED);
  const callId = crypto.randomUUID();
  // ponytail: the caller id sits in the signed URL and so in access logs; hand it over through the DO if logs ever leave this account
  const query = new URLSearchParams({ callId, caller, sig: await signStream(callId, caller, env.PHONE_WEBHOOK_TOKEN) });
  return xml(`<Connect><Stream url="wss://${url.host}/phone/stream?${query.toString().replaceAll("&", "&amp;")}"/></Connect>`);
}

function corsHeaders(origin: string): HeadersInit {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "x-access-code",
    vary: "origin",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });

    if (url.pathname === "/phone/voice" && request.method === "POST") return answerPhone(request, env, url);
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
