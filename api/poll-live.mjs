// Live-score poller. Driven once a minute by a Cloudflare Worker cron trigger
// (worker/server.js) that pings this endpoint with the CRON_SECRET bearer. It
// does ALL the upstream fetching (football-data.org + ESPN), then writes the
// fully-computed result set to the `live-output` kv key. The public /api/live
// endpoint (live.mjs) only ever READS that key — so upstream request volume is
// a flat ~1 poll/min no matter how much traffic the site gets, how the CDN
// caches, or how many edge regions go hot during a spike. That keeps us
// comfortably under football-data's 10 req/min free-tier limit and well off
// ESPN's radar, so a Reddit hug-of-death can't get us rate-limited or blocked.
//
// (Was a Netlify scheduled function on `* * * * *`. Vercel's free plan can't run
// minute crons, so the schedule now lives in the Cloudflare Worker; this file is
// a plain endpoint gated by the CRON_SECRET bearer so it can't be abused.)
//
// football-data.org's bulk list endpoints serve aggressively cached responses:
// statuses can be stale and scores are often stripped (null) even for FINISHED
// matches. The per-match detail endpoint is fresh. So we use the bulk list only
// to map API matches onto our match ids and catch schedule changes, fetch
// details for matches that are (or should be, by the clock) live or just
// finished, and persist finished scores to the kv store so they survive
// upstream cache weirdness and outages.
//
// football-data's free tier also withholds in-play data: fullTime/halfTime stay
// null for the whole match and only populate at FINISHED. So live scores, the
// match clock, and match events (goals, yellow/red cards, with player names)
// all come from ESPN's public scoreboard, keyed back onto our matches by team
// pair. ESPN seeds the live entry while a match is in progress; football-data's
// FINISHED feed stays authoritative for the final score (and is persisted to
// kv). Events ride along on each result entry as `ev: [{ t, m, p, s }]`
// (type, minute, player, side).

import { kvGet, kvSet } from "./_lib/kv.mjs";

// Static seed source. Prefer this deployment's own origin (VERCEL_URL) so the
// poller reads the seed.json it was deployed with. This is resilient during the
// Netlify→Vercel cutover, when the apex may still point at the old (possibly
// down) host — fetching the seed from the dead apex would otherwise crash the
// whole poll. Falls back to the apex only when neither override is present.
const BASE = process.env.POLL_BASE ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://worldcupknockout.football");

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

async function pollLive(req) {
  // Cron-only: this endpoint does upstream fetching and kv writes, so it must
  // not be publicly invokable. The Cloudflare Worker cron sends the bearer.
  if (!process.env.CRON_SECRET ||
      req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) return new Response("disabled: no FOOTBALL_DATA_TOKEN", { status: 200 });
  const headers = { "X-Auth-Token": token };

  const saved = (await kvGet("live-api")) ?? { results: {}, kicks: {} };

  let data;
  try {
    const res = await fetch("https://api.football-data.org/v4/competitions/WC/matches", { headers });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    data = await res.json();
  } catch (err) {
    // Upstream down or rate-limited: leave the previous live-output untouched
    // so /api/live keeps serving last-known-good, and bail until next minute.
    return new Response(`skip: ${String(err?.message ?? err)}`, { status: 200 });
  }

  // Load our seed to map API matches -> our match ids. Group games map by
  // team pair; knockout pairings aren't known upfront, so those map by
  // stage + nearest kickoff (robust to rescheduled times).
  const seed = await (await fetch(`${BASE}/data/seed.json`)).json();
  const STAGE = {
    LAST_32: "r32", LAST_16: "r16", QUARTER_FINALS: "qf",
    SEMI_FINALS: "sf", THIRD_PLACE: "third", FINAL: "final",
  };
  const byPair = {};
  const koByStage = {};
  const kickoffOf = {};
  const isKnockout = {};
  for (const m of seed.matches) {
    kickoffOf[m.id] = m.kickoff;
    if (m.stage === "group") byPair[`${m.home}|${m.away}`] = m.id;
    else { (koByStage[m.stage] ??= []).push(m.id); isKnockout[m.id] = true; }
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
    // Re-verify recently-finished KNOCKOUT matches against ESPN every poll:
    // football-data's free tier regularly reports a wrong scoreline for ties
    // settled in extra time or on penalties (it has stored plain-90' results
    // for matches that actually went to a shootout). ESPN is correct for those,
    // so we keep checking and let the ESPN branch override a wrong FT lock. This
    // also self-heals results that were already persisted wrong.
    const recentKo = isKnockout[id] && m.status === "FINISHED" &&
      now - ko < 3 * 86400e3;
    if (inLiveWindow || recentNoEv || recentKo) {
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
  // anything missed is retried on the next poll.
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
  // Matches in (or just out of) a penalty shootout, for the per-kick breakdown
  // fetched from ESPN's summary endpoint after the scoreboard pass.
  const shootoutEvents = [];
  // Most-recent dates first so the bounded fan-out always covers live/just-
  // finished matches before older ones being re-verified.
  await Promise.all([...espnDates].sort((a, b) => b.localeCompare(a)).slice(0, 5).map(async (date) => {
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
        // ESPN is our live source. football-data's free tier withholds in-play
        // scores, so while ESPN reports a match in progress we build the live
        // entry straight from its scoreboard — seeding it when football-data
        // produced nothing (the usual case) and otherwise keeping the score in
        // lock-step with the scorers. ESPN also exposes the match clock, which
        // football-data doesn't.
        //
        // For KNOCKOUT matches ESPN is also our fast finaliser: football-data's
        // free tier lags badly (often many minutes) flipping a tie to FINISHED
        // once it's settled in extra time or on penalties — which is exactly
        // when the bracket needs to advance. So the moment ESPN reports a
        // knockout match completed we lock in its result ourselves instead of
        // waiting. football-data stays authoritative for group-stage finishes,
        // which it handles fine. Either way we never reopen an FT-locked result.
        const st = event.status?.type;
        const clock = event.status?.displayClock;
        const espnLive = st?.state === "in";
        const espnDone = st?.completed === true || st?.state === "post";
        // ESPN keeps the match "in" through the shootout (it isn't FINISHED
        // until decided), exposing the running tally on each competitor's
        // shootoutScore; football-data only surfaces penalties at FINISHED.
        const inPens = /pen/i.test(st?.detail ?? "") ||
          comp.competitors?.some((c) => c.shootoutScore != null);
        const wentToEt = inPens || (event.status?.period ?? 0) > 2;
        const espnFinalize = espnDone && isKnockout[id];
        const ftLocked = saved.results[id]?.status === "FT";

        // While a match is live we never reopen one already locked FT. But for a
        // COMPLETED knockout match ESPN overrides even a persisted football-data
        // FT — football-data is the unreliable side for ET/penalty results, and
        // ESPN's completed result is authoritative, so this corrects (and self-
        // heals) wrong scorelines instead of waiting for a manual override.
        let target = results[id];
        if ((espnLive && !ftLocked) || espnFinalize) {
          target = results[id] ??= {};
          target.status = espnLive ? "LIVE" : "FT";
          let hs, as, hp, ap;
          for (const c of comp.competitors ?? []) {
            const side = sides[c.team?.id];
            const n = Number.parseInt(c.score, 10);
            if (!Number.isNaN(n)) { if (side === "h") hs = n; else if (side === "a") as = n; }
            const sp = Number.parseInt(c.shootoutScore, 10);
            if (!Number.isNaN(sp)) { if (side === "h") hp = sp; else if (side === "a") ap = sp; }
          }
          if (hs != null) target.hs = hs;
          if (as != null) target.as = as;
          if (hp != null && ap != null) { target.hp = hp; target.ap = ap; }
          else if (espnFinalize) { delete target.hp; delete target.ap; }
          // Reaching extra time / penalties flags the entry so the UI shows
          // "aet"/"pens"; label the live clock "Pens" rather than a frozen 120'.
          if (wentToEt) target.et = true;
          else if (espnFinalize) delete target.et;
          if (espnLive) target.min = inPens ? "Pens" : (clock ?? target.min);
          else delete target.min;
          // Lock the ESPN result into persistence so it survives the next poll
          // and isn't re-clobbered by football-data's (possibly wrong) FT.
          if (target.status === "FT" && target.hs != null && target.as != null) {
            saved.results[id] = target;
            savedDirty = true;
          }
        }

        // Queue a per-kick shootout breakdown (who scored / who missed) while a
        // shootout is live and once it's done.
        if ((espnLive || espnFinalize) && inPens && event.id) {
          shootoutEvents.push({ id, eventId: event.id, sides });
        }
        const ev = [];
        for (const d of comp.details ?? []) {
          // Skip shootout kicks — those are carried separately in `pens`, and
          // counting them here would inflate the score/scorer tooltip.
          if (d.shootout) continue;
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

  // Per-kick shootout breakdowns from ESPN's summary endpoint. The lightweight
  // scoreboard only lists *scored* kicks; the summary's `shootout` array carries
  // both makes and misses, in order, per team — so we can show exactly who
  // scored and who missed. ESPN isn't a rate-limit concern and there are at most
  // a couple of shootouts at once, so this is a small bounded fan-out.
  await Promise.all(shootoutEvents.slice(0, 4).map(async ({ id, eventId, sides }) => {
    try {
      const r = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=${eventId}`);
      if (!r.ok) return;
      const sum = await r.json();
      const pens = [];
      for (const block of sum.shootout ?? []) {
        const s = sides[block.id];
        if (!s) continue;
        for (const shot of block.shots ?? []) {
          pens.push({ s, n: shot.shotNumber, ok: !!shot.didScore, p: shot.player ?? "" });
        }
      }
      if (!pens.length) return;
      pens.sort((a, b) => a.n - b.n);
      const target = results[id];
      if (!target) return;
      target.pens = pens;
      // Keep the persisted copy in sync so the breakdown survives once FT.
      if (saved.results[id]?.status === "FT") {
        saved.results[id].pens = pens;
        savedDirty = true;
      }
    } catch {}
  }));

  // Persist FT-locked results + schedule changes for our own continuity across
  // polls (this is what `saved` reloads next minute).
  if (savedDirty || JSON.stringify(kicks) !== JSON.stringify(saved.kicks ?? {})) {
    await kvSet("live-api", {
      results: saved.results, kicks, updatedAt: new Date().toISOString(),
    });
  }

  // Publish the full computed feed (incl. in-progress LIVE scores) for
  // /api/live to read verbatim.
  await kvSet("live-output", {
    enabled: true, results, kicks, updatedAt: new Date().toISOString(),
  });

  return new Response("ok", { status: 200 });
}

export const GET = pollLive;
export const POST = pollLive;
