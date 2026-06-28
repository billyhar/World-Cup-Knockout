import { createHash } from "node:crypto";

const SUPABASE_URL = "https://xozkbbbejhcsglopnoqn.supabase.co";
// Set SUPABASE_ANON_KEY in Netlify environment variables.
// Value: the anon key from the Supabase project dashboard.
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const HEADERS = {
  "Content-Type": "application/json",
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

const json = (body, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": cache },
  });

const cors = (res) => {
  res.headers.set("access-control-allow-origin", "*");
  return res;
};

const clientIp = (req) => {
  // Netlify injects the real client IP here
  const nf = req.headers.get("x-nf-client-connection-ip");
  if (nf) return nf;
  const xff = req.headers.get("x-forwarded-for");
  return xff ? xff.split(",")[0].trim() : "unknown";
};

const hashIp = (ip) =>
  createHash("sha256").update(ip).digest("hex").slice(0, 24);

export default async function handler(req) {
  if (!SUPABASE_KEY) return cors(json({ error: "not_configured" }, 503));

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST" },
    });
  }

  if (req.method === "GET") {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/match_predictions?select=match_id,home_votes,draw_votes,away_votes`,
      { headers: HEADERS },
    ).catch(() => null);

    if (!res?.ok) return cors(json({ error: "upstream" }, 502));

    const rows = await res.json();
    const data = {};
    for (const row of rows) {
      data[row.match_id] = { home: row.home_votes, draw: row.draw_votes, away: row.away_votes };
    }
    return cors(json(data, 200, "public, s-maxage=30, max-age=0"));
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return cors(json({ error: "invalid_json" }, 400)); }

    const { match_id, choice } = body ?? {};
    if (!match_id || !["home", "draw", "away"].includes(choice)) {
      return cors(json({ error: "invalid_input" }, 400));
    }

    const ip = clientIp(req);
    const ip_hash = hashIp(ip);

    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/cast_vote`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ p_match_id: Number(match_id), p_ip_hash: ip_hash, p_choice: choice }),
    }).catch(() => null);

    if (!res?.ok) return cors(json({ error: "vote_failed" }, 502));

    const result = await res.json();

    if (result?.error === "already_voted") return cors(json({ error: "already_voted" }, 409));

    return cors(json({
      home: result.home_votes ?? 0,
      draw: result.draw_votes ?? 0,
      away: result.away_votes ?? 0,
    }));
  }

  return cors(json({ error: "method_not_allowed" }, 405));
}
