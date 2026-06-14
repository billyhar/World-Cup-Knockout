// Shared title-odds model + helpers, used by both the static build
// (scripts/build-guides.mjs, which bakes a snapshot into the /guides/ hub)
// and the live endpoint (netlify/functions/odds.mjs, which serves this as
// the fallback whenever real bookmaker odds aren't available).
//
// The model is a Monte Carlo of the *real* 2026 bracket from seed.json:
// simulate all 12 groups from team strength ratings, pick the eight best
// third-placed teams, slot them into the eight `3:XXXXX` Round-of-32 ties
// (respecting which groups each slot can draw from), then play out the
// knockout tree to a champion. Repeated tens of thousands of times, the
// share of titles won is each team's modelled win probability.
//
// Ratings are approximate Elo-style strengths (eloratings.net-ish, early
// 2026). They drive a model estimate, not a real market — the live endpoint
// labels the source accordingly.

// Approximate Elo strength per team code. Unlisted codes fall back to DEFAULT.
export const RATINGS = {
  ARG: 2105, FRA: 2092, ESP: 2088, BRA: 2060, ENG: 2045,
  POR: 1992, NED: 1975, GER: 1962, BEL: 1945, CRO: 1918,
  URU: 1930, COL: 1902, MAR: 1898, SUI: 1862, SEN: 1858,
  USA: 1842, MEX: 1838, JPN: 1848, ECU: 1822, AUT: 1828,
  TUR: 1812, NOR: 1808, KOR: 1792, SWE: 1778, ALG: 1772,
  IRN: 1778, SCO: 1762, CIV: 1760, EGY: 1758, CAN: 1782,
  CZE: 1758, PAR: 1742, GHA: 1728, AUS: 1722, TUN: 1708,
  COD: 1700, BIH: 1700, RSA: 1680, QAT: 1678, KSA: 1660,
  PAN: 1660, UZB: 1640, CPV: 1620, IRQ: 1620, JOR: 1618,
  CUW: 1500, NZL: 1498, HAI: 1452,
};
const DEFAULT_RATING = 1650;
const ratingOf = (code) => RATINGS[code] ?? DEFAULT_RATING;

// Standard deviation of the random shock applied to each team in a group
// simulation (in Elo points). Larger → more group-stage upsets.
const GROUP_SD = 150;

// Box–Muller normal sample.
function gauss(sd) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Elo win probability for `a` over `b` (used for knockout ties; draws are
// resolved by extra time / penalties, so this is a straight two-way split).
const pWin = (ra, rb) => 1 / (1 + 10 ** ((rb - ra) / 400));

// Kuhn's algorithm: find an assignment of qualified third-place groups to the
// eight `3:` slots such that every group lands in a slot that can host it.
function assignThirds(groups, slots) {
  const slotTaken = new Array(slots.length).fill(-1);
  const tryAssign = (gi, seen) => {
    for (let si = 0; si < slots.length; si++) {
      if (seen[si] || !slots[si].cand.has(groups[gi])) continue;
      seen[si] = true;
      if (slotTaken[si] === -1 || tryAssign(slotTaken[si], seen)) {
        slotTaken[si] = gi;
        return true;
      }
    }
    return false;
  };
  for (let gi = 0; gi < groups.length; gi++) tryAssign(gi, new Array(slots.length).fill(false));
  return slotTaken; // slotIndex -> groupIndex (or -1)
}

// Build the static bracket scaffolding once from the seed.
function bracket(seed) {
  const groups = seed.groups;
  const r32 = seed.matches.filter((m) => m.stage === "r32");
  // The eight ties that draw a third-placed team, with their candidate groups.
  const thirdSlots = [];
  for (const m of r32) {
    for (const side of ["home", "away"]) {
      if (m[side].startsWith("3:")) {
        thirdSlots.push({ matchId: m.id, side, cand: new Set(m[side].slice(2)) });
      }
    }
  }
  // Knockout matches in dependency order (r32 → final); W-refs always point back.
  const order = { r32: 0, r16: 1, qf: 2, sf: 3, third: 4, final: 5 };
  const ko = seed.matches
    .filter((m) => order[m.stage] != null && m.stage !== "third")
    .sort((a, b) => order[a.stage] - order[b.stage]);
  return { groups, thirdSlots, ko };
}

// One tournament. Returns the champion's team code.
function simulateOnce(b) {
  const groupRank = {}; // group letter -> [1st,2nd,3rd,4th] codes
  const thirds = [];    // { group, code, score }
  for (const [g, codes] of Object.entries(b.groups)) {
    const ranked = codes
      .map((c) => ({ c, s: ratingOf(c) + gauss(GROUP_SD) }))
      .sort((x, y) => y.s - x.s);
    groupRank[g] = ranked.map((r) => r.c);
    thirds.push({ group: g, code: ranked[2].c, score: ranked[2].s });
  }
  // Eight best third-placed teams advance.
  thirds.sort((a, b2) => b2.score - a.score);
  const qualified = thirds.slice(0, 8);
  const qGroups = qualified.map((t) => t.group);
  const codeForGroup = Object.fromEntries(qualified.map((t) => [t.group, t.code]));

  // Slot the qualified thirds into the eight `3:` ties.
  const assign = assignThirds(qGroups, b.thirdSlots);
  const thirdForSlot = {}; // `${matchId}:${side}` -> code
  assign.forEach((gi, si) => {
    if (gi === -1) return;
    const slot = b.thirdSlots[si];
    thirdForSlot[`${slot.matchId}:${slot.side}`] = codeForGroup[qGroups[gi]];
  });

  const resolve = (matchId, side, slot, winners) => {
    if (slot.startsWith("W")) return winners[slot.slice(1)];
    if (slot.startsWith("3:")) return thirdForSlot[`${matchId}:${side}`];
    const rank = slot[0] === "1" ? 0 : 1;
    return groupRank[slot[1]][rank];
  };

  const winners = {};
  let champ = null;
  for (const m of b.ko) {
    const h = resolve(m.id, "home", m.home, winners);
    const a = resolve(m.id, "away", m.away, winners);
    const w = Math.random() < pWin(ratingOf(h), ratingOf(a)) ? h : a;
    winners[m.id] = w;
    if (m.stage === "final") champ = w;
  }
  return champ;
}

// Run the Monte Carlo and return rows sorted by win probability, descending.
// Each row: { code, name, flag, prob, decimal } (decimal = fair 1/prob).
export function modelOdds(seed, { sims = 40000 } = {}) {
  const b = bracket(seed);
  const wins = {};
  for (let i = 0; i < sims; i++) {
    const c = simulateOnce(b);
    wins[c] = (wins[c] ?? 0) + 1;
  }
  return Object.entries(wins)
    .map(([code, n]) => {
      const prob = n / sims;
      return {
        code,
        name: seed.teams[code]?.name ?? code,
        flag: seed.teams[code]?.flag ?? null,
        prob,
        decimal: 1 / prob,
      };
    })
    .sort((x, y) => y.prob - x.prob);
}

// Lowercased team-name → code, built from the seed plus common bookmaker
// aliases, so The Odds API outcome names map onto our codes.
export function nameIndex(seed) {
  const idx = {};
  for (const [code, t] of Object.entries(seed.teams)) {
    idx[t.name.toLowerCase()] = code;
  }
  const alias = {
    usa: "USA", "united states of america": "USA", "korea republic": "KOR",
    "south korea": "KOR", turkey: "TUR", "türkiye": "TUR", "czech republic": "CZE",
    "ivory coast": "CIV", "côte d'ivoire": "CIV", "bosnia and herzegovina": "BIH",
    curacao: "CUW", "cape verde islands": "CPV", "cabo verde": "CPV",
    "dr congo": "COD", "congo dr": "COD", iran: "IRN", "ir iran": "IRN",
  };
  return { ...idx, ...alias };
}
