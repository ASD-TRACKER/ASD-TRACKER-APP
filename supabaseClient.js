import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// If the env vars aren't set (e.g. running locally before Supabase is configured),
// the app still runs — it just falls back to local-only state with no sync/persistence.
export const supabase = url && anonKey ? createClient(url, anonKey) : null;

if (!supabase && typeof window !== "undefined") {
  // eslint-disable-next-line no-console
  console.warn(
    "[ASD Project Hub] Supabase env vars not set — running in local-only mode. " +
    "Data will not be saved or shared with the team. See README.md."
  );
}
