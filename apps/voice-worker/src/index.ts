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
