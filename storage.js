import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const apiKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || // new key: sb_publishable_...
  import.meta.env.VITE_SUPABASE_ANON_KEY;          // legacy fallback

export const supabase = url && apiKey ? createClient(url, apiKey) : null;

// --- Startup diagnostics: open the browser console (F12) to read these ---
if (typeof window !== "undefined") {
  if (!supabase) {
    console.warn(
      "%c[Smashallah] Supabase is NOT configured in this build.",
      "color:#e0a100;font-weight:bold"
    );
    console.warn(
      "  VITE_SUPABASE_URL present?", Boolean(url),
      "| VITE_SUPABASE_PUBLISHABLE_KEY present?", Boolean(apiKey)
    );
    console.warn(
      "  Fix: add BOTH vars in Vercel (Production), then REDEPLOY, then hard-refresh."
    );
  } else {
    console.info("[Smashallah] Supabase configured for", url);
  }
}

// Reads one row from the `kv` table and returns its JSON value (or null).
export async function kvGet(key) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("kv").select("value").eq("key", key).maybeSingle();
  if (error) { console.error("[Smashallah] READ failed:", error.message, error); throw error; }
  return data ? data.value : null;
}

// Inserts or updates one row (last write wins).
export async function kvSet(key, value) {
  if (!supabase) return;
  const { error } = await supabase
    .from("kv")
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) { console.error("[Smashallah] WRITE failed:", error.message, error); throw error; }
}
