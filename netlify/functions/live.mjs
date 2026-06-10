// Optional live-score proxy for football-data.org (free tier includes the
// World Cup). Set FOOTBALL_DATA_TOKEN in Netlify env to enable; without it
// the site runs purely on manually-entered results.
//
// Maps football-data.org matches onto our match ids by stage + team pair and
// returns the same shape as manually-entered results.

const NAME_TO_CODE = {
  mexico: "MEX", "south africa": "RSA", "south korea": "KOR", "korea republic": "KOR",
  czechia: "CZE", "czech republic": "CZE", canada: "CAN", "bosnia and herzegovina": "BIH",
  "bosnia & herzegovina": "BIH", qatar: "QAT", switzerland: "SUI", brazil: "BRA",
  morocco: "MAR", haiti: "HAI", scotland: "SCO", "united states": "USA", usa: "USA",
  paraguay: "PAR", australia: "AUS", turkey: "TUR", "türkiye": "TUR", germany: "GER",
  "curaçao": "CUW", curacao: "CUW", "ivory coast": "CIV", "côte d'ivoire": "CIV",
  ecuador: "ECU", netherlands: "NED", japan: "JPN", sweden: "SWE", tunisia: "TUN",
  belgium: "BEL", egypt: "EGY", iran: "IRN", "ir iran": "IRN", "new zealand": "NZL",
  spain: "ESP", "cape verde": "CPV", "cabo verde": "CPV", "saudi arabia": "KSA",
  uruguay: "URU", france: "FRA", senegal: "SEN", iraq: "IRQ", norway: "NOR",
  argentina: "ARG", algeria: "ALG", austria: "AUT", jordan: "JOR", portugal: "POR",
  "dr congo": "COD", "congo dr": "COD", uzbekistan: "UZB", colombia: "COL",
  england: "ENG", croatia: "CRO", ghana: "GHA", panama: "PAN",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
  });

const normalize = (name) =>
  NAME_TO_CODE[name?.toLowerCase().replace(/\s+fc$/, "").trim()] ?? null;

export default async function handler(req) {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) return json({ enabled: false, results: {} });

  const res = await fetch("https://api.football-data.org/v4/competitions/WC/matches", {
    headers: { "X-Auth-Token": token },
  });
  if (!res.ok) return json({ enabled: true, error: `upstream ${res.status}`, results: {} }, 502);
  const data = await res.json();

  // Load our seed to map team pairs -> match ids
  const seedUrl = new URL("/data/seed.json", req.url);
  const seed = await (await fetch(seedUrl)).json();
  const byPair = {};
  for (const m of seed.matches) {
    if (m.stage === "group") byPair[`${m.home}|${m.away}`] = m.id;
  }

  const results = {};
  for (const m of data.matches ?? []) {
    if (!["IN_PLAY", "PAUSED", "FINISHED"].includes(m.status)) continue;
    const h = normalize(m.homeTeam?.name);
    const a = normalize(m.awayTeam?.name);
    if (!h || !a) continue;
    const id = byPair[`${h}|${a}`] ?? byPair[`${a}|${h}`];
    if (!id) continue;
    const flipped = !byPair[`${h}|${a}`];
    const ft = m.score?.fullTime ?? {};
    const pens = m.score?.penalties ?? {};
    const entry = {
      hs: flipped ? ft.away : ft.home,
      as: flipped ? ft.home : ft.away,
      status: m.status === "FINISHED" ? "FT" : "LIVE",
    };
    if (pens.home != null) {
      entry.hp = flipped ? pens.away : pens.home;
      entry.ap = flipped ? pens.home : pens.away;
    }
    if (entry.hs != null && entry.as != null) results[id] = entry;
  }
  return json({ enabled: true, results });
}
