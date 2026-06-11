// Optional live-score proxy for football-data.org (free tier includes the
// World Cup). Set FOOTBALL_DATA_TOKEN in Netlify env to enable; without it
// the site runs purely on manually-entered results.
//
// football-data.org's bulk list endpoints serve aggressively cached
// responses: statuses can be stale and scores are often stripped (null)
// even for FINISHED matches. The per-match detail endpoint is fresh. So we
// use the bulk list only to map API matches onto our match ids and catch
// schedule changes, fetch details for matches that are (or should be, by
// the clock) live or just finished, and persist finished scores to Netlify
// Blobs so they survive upstream cache weirdness and outages.
//
// Match events (goals, yellow/red cards, with player names) aren't in
// football-data's free tier, so those come from ESPN's public scoreboard,
// keyed back onto our matches by team pair. Events ride along on each
// result entry as `ev: [{ t, m, p, s }]` (type, minute, player, side).

import { getStore } from "@netlify/blobs";

const NAME_TO_CODE = {
  mexico: "MEX", "south africa": "RSA", "south korea": "KOR", "korea republic": "KOR",
  czechia: "CZE", "czech republic": "CZE", canada: "CAN", "bosnia and herzegovina": "BIH",
  "bosnia & herzegovina": "BIH", "bosnia-herzegovina": "BIH", qatar: "QAT",
  switzerland: "SUI", brazil: "BRA",
  morocco: "MAR", haiti: "HAI", scotland: "SCO", "united states": "USA", usa: "USA",
  paraguay: "PAR", australia: "AUS", turkey: "TUR", "türkiye": "TUR", germany: "GER",
  "curaçao": "CUW", curacao: "CUW", "ivory coast": "CIV", "côte d'ivoire": "CIV",
  ecuador: "ECU", netherlands: "NED", japan: "JPN", sweden: "SWE", tunisia: "TUN",
  belgium: "BEL", egypt: "EGY", iran: "IRN", "ir iran": "IRN", "new zealand": "NZL",
  spain: "ESP", "cape verde": "CPV", "cabo verde": "CPV", "cape verde islands": "CPV",
  "saudi arabia": "KSA",
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

// Convert an API match into our result entry shape, or null if it carries
// no usable score yet.
const buildEntry = (m, byPair) => {
  if (!["IN_PLAY", "PAUSED", "FINISHED"].includes(m.status)) return null;
  const flipped = m.stage === "GROUP_STAGE" &&
    !byPair[`${normalize(m.homeTeam?.name)}|${normalize(m.awayTeam?.name)}`];
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
  if (m.score?.duration && m.score.duration !== "REGULAR") entry.et = true;
  return entry.hs != null && entry.as != null ? entry : null;
};

export default async function handler(req) {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) return json({ enabled: false, results: {} });
  const headers = { "X-Auth-Token": token };

  const store = getStore("worldcup");
  const saved = (await store.get("live-api", { type: "json" }).catch(() => null)) ??
    { results: {}, kicks: {} };

  let data;
  try {
    const res = await fetch("https://api.football-data.org/v4/competitions/WC/matches", { headers });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    data = await res.json();
  } catch (err) {
    // Upstream down or rate-limited: serve last-known-good instead of nothing.
    return json({ enabled: true, error: String(err?.message ?? err), results: saved.results, kicks: saved.kicks ?? {} });
  }

  // Load our seed to map API matches -> our match ids. Group games map by
  // team pair; knockout pairings aren't known upfront, so those map by
  // stage + nearest kickoff (robust to rescheduled times).
  const seedUrl = new URL("/data/seed.json", req.url);
  const seed = await (await fetch(seedUrl)).json();
  const STAGE = {
    LAST_32: "r32", LAST_16: "r16", QUARTER_FINALS: "qf",
    SEMI_FINALS: "sf", THIRD_PLACE: "third", FINAL: "final",
  };
  const byPair = {};
  const koByStage = {};
  const kickoffOf = {};
  for (const m of seed.matches) {
    kickoffOf[m.id] = m.kickoff;
    if (m.stage === "group") byPair[`${m.home}|${m.away}`] = m.id;
    else (koByStage[m.stage] ??= []).push(m.id);
  }

  const claimed = new Set();
  const matchId = (m) => {
    if (m.stage === "GROUP_STAGE") {
      const h = normalize(m.homeTeam?.name);
      const a = normalize(m.awayTeam?.name);
      return h && a ? byPair[`${h}|${a}`] ?? byPair[`${a}|${h}`] : null;
    }
    const pool = koByStage[STAGE[m.stage]] ?? [];
    const t = Date.parse(m.utcDate);
    let best = null, bestDelta = Infinity;
    for (const id of pool) {
      if (claimed.has(id)) continue;
      const d = Math.abs(Date.parse(kickoffOf[id]) - t);
      if (d < bestDelta) { best = id; bestDelta = d; }
    }
    if (best == null || bestDelta > 48 * 3600 * 1000) return null;
    claimed.add(best);
    return best;
  };

  const results = { ...saved.results };
  const kicks = {};
  const idOfApi = {};
  const needDetail = [];
  const espnDates = new Set();
  const pairToId = {};     // "MEX|RSA" (either order) -> our id, live-window matches
  const homeCodeOf = {};   // our id -> code shown on our home row
  const now = Date.now();
  const apiMatches = (data.matches ?? [])
    .slice()
    .sort((x, y) => Date.parse(x.utcDate) - Date.parse(y.utcDate));

  for (const m of apiMatches) {
    const id = matchId(m);
    if (!id) continue;
    idOfApi[m.id] = id;
    if (m.utcDate && m.utcDate !== kickoffOf[id]) kicks[id] = m.utcDate;

    const ko = Date.parse(m.utcDate);
    const inLiveWindow = now >= ko - 10 * 60e3 && now <= ko + 4.5 * 3600e3;

    // Map team pair -> our id for the ESPN event join. Our 'home' side is
    // the seed's for group games (entries are flipped to match) and the
    // API's for knockout games.
    const h = normalize(m.homeTeam?.name), a = normalize(m.awayTeam?.name);
    if (h && a) {
      pairToId[`${h}|${a}`] = pairToId[`${a}|${h}`] = id;
      homeCodeOf[id] = m.stage === "GROUP_STAGE" && !byPair[`${h}|${a}`] ? a : h;
    }
    // Fetch ESPN events for live matches and recent finishes missing them.
    // ESPN buckets its scoreboard by US Eastern date, not UTC.
    const recentNoEv = m.status === "FINISHED" &&
      now - ko < 4 * 86400e3 && !saved.results[id]?.ev?.length;
    if (inLiveWindow || recentNoEv) {
      const etDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date(ko));
      espnDates.add(etDate.replaceAll("-", ""));
    }

    // Already locked in from a fresh detail fetch — nothing more to do.
    if (saved.results[id]?.status === "FT") continue;

    const entry = buildEntry(m, byPair);
    if (entry) results[id] = entry;

    // Decide whether this match needs a fresh detail lookup: the list says
    // it's live, it says FINISHED but the score was stripped, or the clock
    // says it should be underway regardless of the (possibly stale) status.
    const liveStatus = ["IN_PLAY", "PAUSED"].includes(m.status);
    const finishedNoScore = m.status === "FINISHED" && !entry;
    if (inLiveWindow || liveStatus || finishedNoScore) needDetail.push(m.id);
  }

  // Free tier allows 10 requests/min and we already spent one on the list;
  // cap detail lookups and tolerate individual failures (e.g. 429s) —
  // anything missed is retried on the next invocation.
  let savedDirty = false;
  await Promise.all(needDetail.slice(0, 6).map(async (apiId) => {
    try {
      const r = await fetch(`https://api.football-data.org/v4/matches/${apiId}`, { headers });
      if (!r.ok) return;
      const m = await r.json();
      const entry = buildEntry(m, byPair);
      if (!entry) return;
      const id = idOfApi[apiId];
      results[id] = entry;
      if (entry.status === "FT") {
        saved.results[id] = entry;
        savedDirty = true;
      }
    } catch {}
  }));

  // Goals and cards from ESPN's public scoreboard (football-data's free
  // tier carries no match events). Joined onto our matches by team pair;
  // failures here never block the scores.
  const espnCode = (team) =>
    normalize(team?.displayName) ??
    (seed.teams[team?.abbreviation] ? team.abbreviation : null);
  await Promise.all([...espnDates].slice(0, 3).map(async (date) => {
    try {
      const r = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${date}`);
      if (!r.ok) return;
      const sb = await r.json();
      for (const event of sb.events ?? []) {
        const comp = event.competitions?.[0];
        if (!comp) continue;
        const sides = {}; // ESPN team id -> 'h' | 'a' in our orientation
        let hCode = null, aCode = null;
        for (const c of comp.competitors ?? []) {
          const code = espnCode(c.team);
          if (c.homeAway === "home") hCode = code; else aCode = code;
        }
        if (!hCode || !aCode) continue;
        const id = pairToId[`${hCode}|${aCode}`];
        if (!id) continue;
        const flip = homeCodeOf[id] !== hCode;
        for (const c of comp.competitors ?? []) {
          sides[c.team?.id] = (c.homeAway === "home") !== flip ? "h" : "a";
        }
        const ev = [];
        for (const d of comp.details ?? []) {
          const t = d.redCard ? "R" : d.yellowCard ? "Y"
            : d.ownGoal ? "O" : d.penaltyKick ? "P" : d.scoringPlay ? "G" : null;
          if (!t) continue;
          const who = d.athletesInvolved?.[0];
          ev.push({
            t,
            m: d.clock?.displayValue ?? "",
            p: who?.shortName ?? who?.displayName ?? "",
            s: sides[d.team?.id] ?? "h",
          });
        }
        if (!ev.length) continue;
        const target = results[id];
        if (target) {
          const changed = JSON.stringify(target.ev ?? null) !== JSON.stringify(ev);
          target.ev = ev;
          // keep the persisted copy in sync once the match is done
          if (saved.results[id]?.status === "FT" && changed) {
            saved.results[id].ev = ev;
            savedDirty = true;
          }
        }
      }
    } catch {}
  }));

  if (savedDirty || JSON.stringify(kicks) !== JSON.stringify(saved.kicks ?? {})) {
    await store.setJSON("live-api", {
      results: saved.results, kicks, updatedAt: new Date().toISOString(),
    }).catch(() => {});
  }

  return json({ enabled: true, results, kicks });
}
