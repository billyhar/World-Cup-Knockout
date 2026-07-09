// Public live-scores endpoint. This is now a THIN READER: all the upstream
// fetching (football-data.org + ESPN) happens in the scheduled poller
// (poll-live.mjs), which runs once a minute and writes the fully-computed feed
// to the `live-output` kv key. /api/live just returns that value.
//
// Why: this decouples upstream API request volume from site traffic entirely.
// No matter how many people hit the site or how the CDN fans out across edge
// regions during a spike, upstream sees a flat ~1 poll/min — so we can't be
// rate-limited or IP-blocked by football-data/ESPN. Reads here are cheap kv
// lookups with no external dependency.

import { kvGet } from "./_lib/kv.mjs";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    // s-maxage caches at the CDN; max-age=0 lets tabs returning mid-match
    // revalidate. This only reads kv (no upstream dependency), so a shorter
    // CDN window is cheap and just lets live scores/shootout updates surface
    // sooner — the poller still refreshes the value once a minute, so this is
    // bounded regardless of traffic.
    headers: { "content-type": "application/json", "cache-control": "public, s-maxage=30, max-age=0" },
  });

const handler = async () => {
  // Mirror the old behaviour: with no token configured the site runs purely on
  // manually-entered results, and the poller never writes live-output.
  if (!process.env.FOOTBALL_DATA_TOKEN) return json({ enabled: false, results: {} });

  const out = await kvGet("live-output");
  if (out) return json(out);

  // Poller hasn't published yet (e.g. fresh deploy, or upstream was down on
  // every poll since boot). Fall back to the FT-locked persistence so finished
  // scores still show.
  const saved = await kvGet("live-api");
  return json({ enabled: true, results: saved?.results ?? {}, kicks: saved?.kicks ?? {} });
};

export const GET = handler;
