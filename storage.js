import { createClient } from "@supabase/supabase-js";

// Normalise the URL: trim whitespace and strip a trailing slash or a stray
// "/rest/v1" — those cause PostgREST error PGRST125 "Invalid path in request URL".
const rawUrl = import.meta.env.VITE_SUPABASE_URL;
const url = rawUrl
  ? rawUrl.trim().replace(/\/rest\/v1\/?$/i, "").replace(/\/+$/, "")
  : rawUrl;

const apiKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || // new key: sb_publishable_...
  import.meta.env.VITE_SUPABASE_ANON_KEY;          // legacy fallback

export const supabase = url && apiKey ? createClient(url, apiKey) : null;

// --- Startup diagnostics: open the browser console (F12) to read these ---
if (typeof window !== "undefined") {
  if (!supabase) {
    console.warn("%c[Smashallah] Supabase NOT configured in this build.", "color:#e0a100;font-weight:bold");
    console.warn("  VITE_SUPABASE_URL present?", Boolean(url));
    console.warn("  VITE_SUPABASE_PUBLISHABLE_KEY present?", Boolean(apiKey));
    console.warn("  If both are false: .env isn't being read — check the file is named exactly");
    console.warn("  '.env' (not .env.txt), sits next to package.json, and RESTART `npm run dev`.");
  } else {
    if (rawUrl && rawUrl.trim() !== url) {
      console.warn("[Smashallah] Your VITE_SUPABASE_URL had extra characters and was auto-trimmed to:", url);
      console.warn("            Please also fix it in .env / Vercel to just https://<ref>.supabase.co");
    }
    const kind =
      apiKey.startsWith("sb_publishable_") ? "publishable  (correct)" :
      apiKey.startsWith("sb_secret_")      ? "SECRET  (WRONG — use the publishable key)" :
      apiKey.startsWith("eyJ")             ? "legacy JWT anon (being retired; ok for now)" :
                                             "UNKNOWN FORMAT (likely a bad/partial paste)";
    console.info("[Smashallah] Supabase URL:", url);
    console.info("[Smashallah] Key type:", kind, "| length:", apiKey.length, "chars");
  }
}

export async function kvGet(key) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("kv").select("value").eq("key", key).maybeSingle();
  if (error) { console.error("[Smashallah] READ failed:", error.message, error); throw error; }
  return data ? data.value : null;
}

export async function kvSet(key, value) {
  if (!supabase) return;
  const { error } = await supabase
    .from("kv")
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) { console.error("[Smashallah] WRITE failed:", error.message, error); throw error; }
}
