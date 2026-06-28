// Data loading + tournament logic: group standings, best-thirds allocation,
// knockout slot resolution.

export async function loadSeed() {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * attempt));
      const res = await fetch("/data/seed.json");
      if (res.ok) return res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Failed to load seed data");
}

// Manual results (admin-entered via /admin.html) change rarely — only when an
// admin submits a correction. Cache them client-side for 5 minutes so we don't
// hit the serverless function on every 60-second refresh. The CDN also caches
// the endpoint for 60s (s-maxage), so these two layers together cut invocations
// by ~99% vs the previous no-store behaviour.
let _manualCache = null;
let _manualCachedAt = 0;
const MANUAL_TTL = 5 * 60 * 1000;

export async function loadResults() {
  // Manual results (Netlify Blobs) + optional live API, merged.
  // Manual entries win over live so mistakes upstream can be corrected.
  const out = { results: {}, overrides: {}, kicks: {} };

  const now = Date.now();
  const manualPromise =
    now - _manualCachedAt > MANUAL_TTL
      ? fetch("/api/results")
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => { _manualCache = d; _manualCachedAt = Date.now(); return d; })
      : Promise.resolve(_manualCache);

  const [live, manual] = await Promise.allSettled([
    fetch("/api/live").then((r) => (r.ok ? r.json() : null)),
    manualPromise,
  ]);
  if (live.status === "fulfilled" && live.value?.results) {
    Object.assign(out.results, live.value.results);
    out.kicks = live.value.kicks ?? {};
  }
  if (manual.status === "fulfilled" && manual.value) {
    Object.assign(out.results, manual.value.results ?? {});
    out.overrides = manual.value.overrides ?? {};
    out.updatedAt = manual.value.updatedAt;
  }
  return out;
}

const hasScore = (r) => r && r.hs != null && r.as != null;

// ---- Group standings -------------------------------------------------------

export function computeStandings(seed, results, group) {
  const rows = Object.fromEntries(
    seed.groups[group].map((t) => [t, { team: t, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }])
  );
  const groupMatches = seed.matches.filter((m) => m.stage === "group" && m.group === group);
  let played = 0;
  for (const m of groupMatches) {
    const r = results[m.id];
    if (!hasScore(r)) continue;
    played++;
    const h = rows[m.home], a = rows[m.away];
    h.p++; a.p++;
    h.gf += r.hs; h.ga += r.as;
    a.gf += r.as; a.ga += r.hs;
    if (r.hs > r.as) { h.w++; a.l++; h.pts += 3; }
    else if (r.hs < r.as) { a.w++; h.l++; a.pts += 3; }
    else { h.d++; a.d++; h.pts++; a.pts++; }
  }
  const table = Object.values(rows).map((r) => ({ ...r, gd: r.gf - r.ga }));

  // FIFA tiebreakers (simplified): points, GD, GF, head-to-head points, name
  const h2h = (x, y) => {
    let pts = 0;
    for (const m of groupMatches) {
      const r = results[m.id];
      if (!hasScore(r)) continue;
      if (m.home === x.team && m.away === y.team) pts += r.hs > r.as ? 3 : r.hs === r.as ? 1 : 0;
      if (m.home === y.team && m.away === x.team) pts += r.as > r.hs ? 3 : r.hs === r.as ? 1 : 0;
    }
    return pts;
  };
  // stable sort: teams level on everything keep official seed order
  table.sort((a, b) =>
    b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || h2h(b, a) - h2h(a, b)
  );
  return { table, complete: played === groupMatches.length, played };
}

export function allStandings(seed, results) {
  const out = {};
  for (const g of Object.keys(seed.groups)) out[g] = computeStandings(seed, results, g);
  return out;
}

// ---- Best thirds -----------------------------------------------------------

// The 8 best third-placed teams fill the R32 slots written as "3:ABCDF" etc.
// Which slot each third lands in depends on the qualified combination; we
// solve it as a constraint-matching problem (each slot accepts thirds from
// the listed groups only). FIFA's official table is one valid solution of
// the same constraints.
export function allocateThirds(seed, results, standings) {
  const groups = Object.keys(seed.groups);
  if (!groups.every((g) => standings[g].complete)) return null;

  const thirds = groups
    .map((g) => ({ group: g, ...standings[g].table[2] }))
    .sort((a, b) =>
      b.pts - a.pts || b.gd - a.gd || b.gf - a.gf ||
      seed.teams[a.team].name.localeCompare(seed.teams[b.team].name)
    )
    .slice(0, 8);

  const slots = seed.matches
    .filter((m) => m.stage === "r32" && m.away.startsWith("3:"))
    .map((m) => ({ id: m.id, allowed: m.away.slice(2).split("") }));

  // Backtracking: assign each qualified third to a slot that allows its group,
  // trying most-constrained slots first.
  slots.sort((a, b) => a.allowed.length - b.allowed.length);
  const assignment = {};
  const used = new Set();
  const solve = (i) => {
    if (i === slots.length) return true;
    const slot = slots[i];
    for (const t of thirds) {
      if (used.has(t.group) || !slot.allowed.includes(t.group)) continue;
      assignment[slot.id] = t.team;
      used.add(t.group);
      if (solve(i + 1)) return true;
      delete assignment[slot.id];
      used.delete(t.group);
    }
    return false;
  };
  return solve(0) ? { assignment, qualified: thirds } : { assignment: {}, qualified: thirds };
}

// ---- Knockout resolution ---------------------------------------------------

export function matchWinner(m, resolved, results) {
  const r = results[m.id];
  if (!hasScore(r) || r.status === "LIVE") return { winner: null, loser: null };
  const teams = resolved[m.id];
  if (!teams?.home || !teams?.away) return { winner: null, loser: null };
  if (r.hs > r.as) return { winner: teams.home, loser: teams.away };
  if (r.hs < r.as) return { winner: teams.away, loser: teams.home };
  if (r.hp != null && r.ap != null && r.hp !== r.ap) {
    return r.hp > r.ap
      ? { winner: teams.home, loser: teams.away }
      : { winner: teams.away, loser: teams.home };
  }
  return { winner: null, loser: null };
}

// Returns { [matchId]: { home, away } } with team codes or null when unknown.
export function resolveBracket(seed, results, overrides, standings) {
  const thirdAlloc = allocateThirds(seed, results, standings);
  const resolved = {};
  const ko = seed.matches.filter((m) => m.stage !== "group");

  const slotTeam = (slot) => {
    if (/^[12][A-L]$/.test(slot)) {
      const pos = Number(slot[0]) - 1;
      const g = slot[1];
      return standings[g].complete ? standings[g].table[pos].team : null;
    }
    if (slot.startsWith("3:")) {
      const m = ko.find((x) => x.away === slot);
      return thirdAlloc?.assignment[m?.id] ?? null;
    }
    if (/^[WL]\d+$/.test(slot)) {
      const src = ko.find((x) => x.id === slot.slice(1));
      if (!src) return null;
      const { winner, loser } = matchWinner(src, resolved, results);
      return slot[0] === "W" ? winner : loser;
    }
    return null;
  };

  // Knockout matches are seed-ordered (73..104) so sources resolve first.
  for (const m of ko) {
    const ov = overrides?.[m.id] ?? {};
    resolved[m.id] = {
      home: ov.home ?? slotTeam(m.home),
      away: ov.away ?? slotTeam(m.away),
    };
  }
  return { resolved, thirdAlloc };
}

export function slotLabel(slot) {
  if (/^1[A-L]$/.test(slot)) return `Winner Group ${slot[1]}`;
  if (/^2[A-L]$/.test(slot)) return `Runner-up ${slot[1]}`;
  if (slot.startsWith("3:")) return `3rd · ${slot.slice(2).split("").join("/")}`;
  if (slot.startsWith("W")) return `Winner M${slot.slice(1)}`;
  if (slot.startsWith("L")) return `Loser M${slot.slice(1)}`;
  return slot;
}

// Viewer's timezone abbreviation during the tournament (e.g. BST, EDT, CEST).
// Uses a tournament date so DST resolves correctly whatever today is.
export const tzAbbr = (() => {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(new Date("2026-06-11T19:00:00Z"))
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch { return ""; }
})();

export const fmtDate = (iso) =>
  new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" })
    .format(new Date(iso));

// Zero-padded hours (03:00, not 3:00). Intl ignores hour: "2-digit" in some
// 12-hour locales, so pad the leading hour digit ourselves.
export const fmtTime = (iso) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
    .format(new Date(iso))
    .replace(/^(\d):/, "0$1:");

export const isToday = (iso) => {
  const d = new Date(iso), now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
};
