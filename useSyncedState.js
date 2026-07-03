import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

/**
 * Drop-in replacement for useState that also persists the value to a
 * single row in Supabase's `app_data` table (keyed by `key`) and keeps
 * every connected team member's browser live-synced via Realtime.
 *
 * - On mount: loads the current value from Supabase (or seeds the row
 *   with `initialValue` if this is the very first run).
 * - On local change: writes back to Supabase (debounced ~400ms).
 * - On remote change (another teammate edits): updates local state
 *   automatically via a Realtime subscription.
 *
 * If Supabase isn't configured (no env vars), it silently behaves like
 * a normal useState so local development still works.
 */
export function useSyncedState(key, initialValue) {
  const [value, setValue] = useState(initialValue);
  const [loaded, setLoaded] = useState(!supabase);
  const skipNextWrite = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  // Initial load (+ seed row on first-ever run)
  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("app_data")
        .select("value")
        .eq("key", key)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        console.error(`[sync] failed to load "${key}"`, error);
      } else if (data) {
        skipNextWrite.current = true;
        setValue(data.value);
      } else {
        await supabase
          .from("app_data")
          .upsert({ key, value: initialValue, updated_at: new Date().toISOString() });
      }
      setLoaded(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Realtime subscription — pick up changes made by other team members
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel(`app_data_${key}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "app_data", filter: `key=eq.${key}` },
        (payload) => {
          skipNextWrite.current = true;
          setValue(payload.new.value);
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [key]);

  // Write-through on local change (debounced so rapid edits don't spam the DB)
  useEffect(() => {
    if (!supabase || !loaded) return;
    if (skipNextWrite.current) { skipNextWrite.current = false; return; }
    const t = setTimeout(() => {
      supabase
        .from("app_data")
        .upsert({ key, value: valueRef.current, updated_at: new Date().toISOString() })
        .then(({ error }) => { if (error) console.error(`[sync] failed to save "${key}"`, error); });
    }, 400);
    return () => clearTimeout(t);
  }, [value, key, loaded]);

  return [value, setValue];
}
