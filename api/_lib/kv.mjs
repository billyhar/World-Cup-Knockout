// Tiny JSON key/value store backed by a Supabase `kv` table. This replaces
// Netlify Blobs (getStore("worldcup")) after the move to Vercel: the four keys
// live-output, live-api, results and odds-api now live as rows in public.kv.
//
// All access is server-side with the service_role key, which bypasses RLS —
// the `kv` table has no anon policies, so the store can only ever be written
// from a Vercel function. Plain fetch against PostgREST keeps this dependency-
// free (same approach as predictions.mjs).

const SUPABASE_URL = "https://xozkbbbejhcsglopnoqn.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const REST = `${SUPABASE_URL}/rest/v1/kv`;
const headers = () => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
});

// Read one key. Returns the parsed JSON value, or null if the key is absent
// (or on any error — callers already treat a missing blob as "not published").
export async function kvGet(key) {
  if (!SERVICE_KEY) return null;
  const url = `${REST}?key=eq.${encodeURIComponent(key)}&select=value`;
  const res = await fetch(url, { headers: headers() }).catch(() => null);
  if (!res?.ok) return null;
  const rows = await res.json().catch(() => null);
  return rows?.[0]?.value ?? null;
}

// Upsert one key on the `key` primary key. Mirrors store.setJSON(key, value).
export async function kvSet(key, value) {
  if (!SERVICE_KEY) return;
  await fetch(REST, {
    method: "POST",
    headers: { ...headers(), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  }).catch(() => {});
}
