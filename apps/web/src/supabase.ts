import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(url, key);

// Always anon, whoever is logged in on the other client. Public screens read through this, so a session never mixes
// other rows into them and a merchant or guardian sees the same demo data as any visitor.
export const publicDb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "callorder-public" } });
