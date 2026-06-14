// Outright winner odds for the 2026 World Cup.
//
// Primary source: real bookmaker odds from The Odds API (the-odds-api.com),
// market `soccer_fifa_world_cup_winner` / `outrights`. Set ODDS_API_KEY in
// the Netlify env to enable it. We take the median decimal price per team
// across books, de-vig to a fair implied probability, and cache the result
// in Netlify Blobs for TTL_MS (6 hours), so the upstream is only hit ~4
// times per day — well within The Odds API's free tier of 500 req/month.
//
// Fallback: when no key is set (or the upstream fails with nothing cached),
// we serve the in-house Monte Carlo model from scripts/odds-model.mjs — the
// same numbers baked statically into the /guides/ hub. The `source` field
// ("bookmakers" | "model") tells the client which it's looking at.

// Only call The Odds API when cached data is older than this.
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours → ~120 requests/month

import { getStore } from "@netlify/blobs";
import { modelOdds, nameIndex } from "../../scripts/odds-model.mjs";

const ODDS_URL =
  "https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup_winner/odds/" +
  "?regions=uk,eu,us&markets=outrights&oddsFormat=decimal";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

// Shape the raw outrights payload into { code, name, flag, decimal, prob }
// rows, de-vigged so probabilities sum to 1. Returns null if nothing maps.
function shapeBookmakers(payload, seed) {
  const idx = nameIndex(seed);
  const prices = {}; // code -> [decimal, ...] across bookmakers
  for (const event of payload ?? []) {
    for (const bk of event.bookmakers ?? []) {
      for (const mk of bk.markets ?? []) {
        if (mk.key !== "outrights") continue;
        for (const o of mk.outcomes ?? []) {
          const code = idx[String(o.name).toLowerCase().trim()];
          if (!code || !(o.price > 1)) continue;
          (prices[code] ??= []).push(o.price);
        }
      }
    }
  }
  const codes = Object.keys(prices);
  if (!codes.length) return null;

  const rows = codes.map((code) => {
    const decimal = median(prices[code]);
    return { code, name: seed.teams[code]?.name ?? code, flag: seed.teams[code]?.flag ?? null, decimal };
  });
  // De-vig: normalise raw implied (1/decimal) so the field sums to 100%.
  const total = rows.reduce((s, r) => s + 1 / r.decimal, 0);
  for (const r of rows) r.prob = 1 / r.decimal / total;
  rows.sort((a, b) => b.prob - a.prob);
  return rows;
}

async function loadSeed(req) {
  const seedUrl = new URL("/data/seed.json", req.url);
  return (await fetch(seedUrl)).json();
}

export default async function handler(req) {
  const seed = await loadSeed(req);
  const key = process.env.ODDS_API_KEY;

  // No key configured → serve the model directly.
  if (!key) {
    return json({ source: "model", updatedAt: new Date().toISOString(), teams: modelOdds(seed, { sims: 20000 }) });
  }

  const store = getStore("worldcup");
  const cached = await store.get("odds-api", { type: "json" }).catch(() => null);

  // Serve cached data if it's still fresh — avoids burning a request.
  const cacheAge = cached?.updatedAt ? Date.now() - Date.parse(cached.updatedAt) : Infinity;
  if (cached?.teams?.length && cacheAge < TTL_MS) {
    return json(cached);
  }

  try {
    const res = await fetch(`${ODDS_URL}&apiKey=${key}`);
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const teams = shapeBookmakers(await res.json(), seed);
    if (!teams) throw new Error("no mappable outcomes");
    // Attach our model's win probability to each bookmaker row so the client
    // can render a side-by-side comparison without a second request.
    const model = modelOdds(seed, { sims: 40000 });
    const modelByCode = Object.fromEntries(model.map((r) => [r.code, r.prob]));
    for (const t of teams) t.modelProb = modelByCode[t.code] ?? null;

    const out = { source: "bookmakers", updatedAt: new Date().toISOString(), teams };
    await store.setJSON("odds-api", out).catch(() => {});
    return json(out);
  } catch (err) {
    // Upstream down/rate-limited: serve stale cache if available, else the model.
    if (cached?.teams?.length) return json({ ...cached, stale: true, error: String(err?.message ?? err) });
    return json({ source: "model", updatedAt: new Date().toISOString(), error: String(err?.message ?? err), teams: modelOdds(seed, { sims: 20000 }) });
  }
}
