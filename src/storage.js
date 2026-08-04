import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

// If env vars are missing (e.g. first local run) the app still works,
// it just won't sync across devices until you add them.
export const supabase = url && anon ? createClient(url, anon) : null;

// Reads one row from the `kv` table and returns its JSON value (or null).
export async function kvGet(key) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("kv").select("value").eq("key", key).maybeSingle();
  if (error) throw error;
  return data ? data.value : null;
}

// Inserts or updates one row (last write wins).
export async function kvSet(key, value) {
  if (!supabase) return;
  const { error } = await supabase
    .from("kv")
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
}
