import { createClient } from "@supabase/supabase-js";

const DB_TIMEOUT_MS = 8000;

export function createDb(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(DB_TIMEOUT_MS) }) },
  });
}

export interface Env {
  CALL_SESSION: DurableObjectNamespace;
  META_API_KEY: string;
  META_LLM_MODEL: string;
  META_STT_MODEL: string;
  META_BASE_URL: string;
  META_STT_URL: string;
  TTS_PROVIDER: "typecast" | "soniox" | "none";
  TTS_API_KEY: string;
  TTS_URL: string;
  TTS_MODEL: string;
  TTS_VOICE: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ALLOWED_ORIGINS: string;
  SIM_ACCESS_CODE: string;
  PHONE_WEBHOOK_TOKEN: string;
}

export function missingSecrets(env: Env): string[] {
  const required: (keyof Env)[] = ["META_API_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
  if (env.TTS_PROVIDER !== "none") required.push("TTS_API_KEY");
  return required.filter((name) => !env[name]);
}
