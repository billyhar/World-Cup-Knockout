import { PanZoom } from "./canvas.js";
import {
  loadSeed, loadResults, allStandings, resolveBracket, matchWinner,
  slotLabel, fmtDate, fmtTime, isToday,
} from "./data.js";

// ---- world layout constants ------------------------------------------------
const G = { x: 60, y: 200, w: 380, h: 478, gapX: 44, gapY: 48, cols: 4 };
const K = { x: 2080, y: 200, w: 304, h: 104, gapY: 30, colStep: 384 };
const WORLD = { w: 3960, h: 2400 };

// Bracket wiring: column order top→bottom, derived from who feeds whom.
const R32_ORDER = ["74", "77", "73", "75", "83", "84", "81", "82", "76", "78", "79", "80", "86", "88", "85", "87"];
const R16_ORDER = ["89", "90", "93", "94", "91", "92", "95", "96"];
const QF_ORDER = ["97", "98", "99", "100"];
const SF_ORDER = ["101", "102"];
const FEEDERS = {
  89: ["74", "77"], 90: ["73", "75"], 91: ["76", "78"], 92: ["79", "80"],
  93: ["83", "84"], 94: ["81", "82"], 95: ["86", "88"], 96: ["85", "87"],
  97: ["89", "90"], 98: ["93", "94"], 99: ["91", "92"], 100: ["95", "96"],
  101: ["97", "98"], 102: ["99", "100"], 104: ["101", "102"],
};

let seed, panzoom;
let state = { results: {}, overrides: {} };
const world = document.getElementById("world");
const sections = {}; // name -> world rect for nav

const flagImg = (code) => {
  const f = seed.teams[code]?.flag;
  return f
    ? `<img class="flag" src="https://flagcdn.com/w40/${f}.png" srcset="https://flagcdn.com/w80/${f}.png 2x" alt="" loading="lazy">`
    : `<span class="flag flag-tbd"></span>`;
};

const scoreText = (r) => {
  if (r == null || r.hs == null) return null;
  let s = `${r.hs}–${r.as}`;
  return s;
};

// ---- group cards -----------------------------------------------------------

function groupCardHTML(g, standings) {
  const { table, complete } = standings[g];
  const matches = seed.matches.filter((m) => m.stage === "group" && m.group === g);
  const rows = table.map((row, i) => `
    <div class="g-row q${i < 2 ? "1" : i === 2 ? "3" : "0"}">
      <span class="pos">${i + 1}</span>
      ${flagImg(row.team)}
      <span class="g-name">${seed.teams[row.team].name}</span>
      <span class="g-stat">${row.p}</span>
      <span class="g-stat">${row.gd > 0 ? "+" : ""}${row.gd}</span>
      <span class="g-stat g-pts">${row.pts}</span>
    </div>`).join("");

  const fixtures = matches.map((m) => {
    const r = state.results[m.id];
    const score = scoreText(r);
    const live = r?.status === "LIVE";
    return `
    <div class="g-fix ${live ? "live" : ""} ${isToday(m.kickoff) ? "today" : ""}">
      <span class="g-fix-date">${fmtDate(m.kickoff).replace(/^\w+ /, "")}</span>
      <span class="g-fix-team home">${m.home} ${flagImg(m.home)}</span>
      <span class="g-fix-score ${score ? "has" : ""}">${score ?? fmtTime(m.kickoff)}</span>
      <span class="g-fix-team away">${flagImg(m.away)} ${m.away}</span>
      ${live ? '<span class="live-dot"></span>' : ""}
    </div>`;
  }).join("");

  return `
  <div class="card group-card" id="group-${g}">
    <div class="g-head">
      <h2>Group ${g}</h2>
      ${complete ? '<span class="badge done">final</span>' : ""}
    </div>
    <div class="g-cols"><span></span><span></span><span></span><span>P</span><span>GD</span><span>Pts</span></div>
    ${rows}
    <div class="g-fixtures">${fixtures}</div>
  </div>`;
}

// ---- knockout cards ----------------------------------------------------------

function teamRowHTML(code, slot, r, side, winner) {
  const isWin = winner && code && winner === code;
  const score = r?.hs != null ? (side === "h" ? r.hs : r.as) : "";
  const pens = r?.hp != null ? `<span class="pens">${side === "h" ? r.hp : r.ap}</span>` : "";
  if (code) {
    return `<div class="k-row ${isWin ? "win" : winner ? "lose" : ""}">
      ${flagImg(code)}<span class="k-name">${seed.teams[code].name}</span>
      ${pens}<span class="k-score">${score}</span>
    </div>`;
  }
  return `<div class="k-row tbd">
    <span class="flag flag-tbd"></span><span class="k-name">${slotLabel(slot)}</span>
  </div>`;
}

function koCardHTML(m, resolved) {
  const r = state.results[m.id];
  const teams = resolved[m.id];
  const { winner } = matchWinner(m, resolved, state.results);
  const live = r?.status === "LIVE";
  const today = isToday(m.kickoff);
  const cls = [
    "card", "ko-card",
    m.stage === "final" ? "final-card" : "",
    live ? "is-live" : "", today ? "is-today" : "",
  ].join(" ");
  return `
  <div class="${cls}" id="match-${m.id}">
    <div class="k-meta">
      <span>M${m.id} · ${fmtDate(m.kickoff)} · ${fmtTime(m.kickoff)}</span>
      <span class="k-city">${live ? '<span class="live-dot"></span> LIVE' : m.city}</span>
    </div>
    ${teamRowHTML(teams.home, m.home, r, "h", winner)}
    ${teamRowHTML(teams.away, m.away, r, "a", winner)}
  </div>`;
}

// ---- render ------------------------------------------------------------------

function render() {
  const standings = allStandings(seed, state.results);
  const { resolved } = resolveBracket(seed, state.results, state.overrides, standings);
  const ko = Object.fromEntries(seed.matches.filter((m) => m.stage !== "group").map((m) => [m.id, m]));

  let html = "";
  html += `<h1 class="zone-title" style="left:${G.x}px;top:80px">Group Stage</h1>`;
  html += `<h1 class="zone-title" style="left:${K.x}px;top:80px">Knockout Stage</h1>`;

  // group cards
  const groups = Object.keys(seed.groups);
  const pos = {};
  groups.forEach((g, i) => {
    const col = i % G.cols, row = Math.floor(i / G.cols);
    const x = G.x + col * (G.w + G.gapX);
    const y = G.y + row * (G.h + G.gapY);
    pos[`group-${g}`] = { x, y };
  });

  // knockout positions
  const colX = (c) => K.x + c * K.colStep;
  const colHeights = R32_ORDER.length * (K.h + K.gapY) - K.gapY;
  R32_ORDER.forEach((id, i) => { pos[`match-${id}`] = { x: colX(0), y: K.y + i * (K.h + K.gapY) }; });
  const centerOf = (id) => pos[`match-${id}`].y + K.h / 2;
  const place = (order, col) => order.forEach((id) => {
    const [a, b] = FEEDERS[id];
    pos[`match-${id}`] = { x: colX(col), y: (centerOf(a) + centerOf(b)) / 2 - K.h / 2 };
  });
  place(R16_ORDER, 1);
  place(QF_ORDER, 2);
  place(SF_ORDER, 3);
  place(["104"], 4);
  pos["match-103"] = { x: colX(4), y: pos["match-104"].y + K.h + 110 };

  // round labels
  const roundLabels = [["Round of 32", 0], ["Round of 16", 1], ["Quarter-finals", 2], ["Semi-finals", 3], ["Final", 4]];
  for (const [label, c] of roundLabels) {
    html += `<div class="round-label" style="left:${colX(c)}px;top:${K.y - 44}px;width:${K.w}px">${label}</div>`;
  }
  html += `<div class="round-label minor" style="left:${colX(4)}px;top:${pos["match-103"].y - 30}px;width:${K.w}px">Third place</div>`;

  // connectors
  let paths = "";
  const link = (childId, parentId) => {
    const c = pos[`match-${childId}`], p = pos[`match-${parentId}`];
    const x1 = c.x + K.w, y1 = c.y + K.h / 2;
    const x2 = p.x, y2 = p.y + K.h / 2;
    const mid = x1 + (x2 - x1) / 2;
    return `<path d="M ${x1} ${y1} H ${mid} V ${y2} H ${x2}"/>`;
  };
  for (const [parent, kids] of Object.entries(FEEDERS)) {
    for (const kid of kids) paths += link(kid, parent);
  }
  html += `<svg class="connectors" width="${WORLD.w}" height="${WORLD.h}" viewBox="0 0 ${WORLD.w} ${WORLD.h}">${paths}</svg>`;

  for (const g of groups) html += groupCardHTML(g, standings);
  for (const m of Object.values(ko)) html += koCardHTML(m, resolved);

  // champion banner
  const finalWinner = matchWinner(ko["104"], resolved, state.results).winner;
  if (finalWinner) {
    html += `<div class="champion" style="left:${pos["match-104"].x - 20}px;top:${pos["match-104"].y - 130}px">
      🏆 ${flagImg(finalWinner)} <b>${seed.teams[finalWinner].name}</b> — World Champions
    </div>`;
  }

  world.innerHTML = html;

  // apply positions
  for (const [id, p] of Object.entries(pos)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    if (id.startsWith("group-")) { el.style.width = `${G.w}px`; el.style.height = `${G.h}px`; }
    else { el.style.width = `${K.w}px`; }
  }

  // nav rects
  const groupsRect = { x: G.x - 40, y: 60, w: G.cols * (G.w + G.gapX), h: G.y + 3 * (G.h + G.gapY) };
  sections.groups = groupsRect;
  sections.r32 = { x: colX(0) - 60, y: K.y - 80, w: K.w + 540, h: colHeights + 120 };
  sections.r16 = { x: colX(1) - 60, y: K.y - 80, w: K.w + 540, h: colHeights + 120 };
  sections.qf = { x: colX(2) - 60, y: K.y - 80, w: K.w + 540, h: colHeights + 120 };
  sections.final = { x: colX(3) - 80, y: pos["match-104"].y - 360, w: K.colStep + K.w + 160, h: 900 };
  sections.all = { x: 0, y: 0, w: WORLD.w, h: WORLD.h };
}

// ---- chrome ------------------------------------------------------------------

function bindChrome() {
  document.getElementById("nav-chips").addEventListener("click", (e) => {
    const goto = e.target.dataset.goto;
    if (goto && sections[goto]) panzoom.flyTo(sections[goto]);
  });
  document.getElementById("zoom-in").onclick = () =>
    panzoom.zoomAt(innerWidth / 2, innerHeight / 2, 1.35);
  document.getElementById("zoom-out").onclick = () =>
    panzoom.zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.35);
  document.getElementById("zoom-fit").onclick = () => panzoom.flyTo(sections.all, 40);

  const hint = document.getElementById("hint");
  setTimeout(() => hint.classList.add("fade"), 6000);
  ["pointerdown", "wheel"].forEach((ev) =>
    addEventListener(ev, () => hint.classList.add("fade"), { once: true, capture: true }));
}

function setStatus() {
  const pill = document.getElementById("status-pill");
  const n = Object.values(state.results).filter((r) => r.hs != null).length;
  if (!n) { pill.hidden = true; return; }
  pill.hidden = false;
  pill.textContent = `${n} result${n === 1 ? "" : "s"} in`;
}

async function refresh() {
  try {
    state = await loadResults();
  } catch { /* offline → keep last known */ }
  render();
  setStatus();
}

// ---- boot ----------------------------------------------------------------------

(async function boot() {
  seed = await loadSeed();
  state = await loadResults().catch(() => state);
  render();
  setStatus();

  panzoom = new PanZoom(document.getElementById("viewport"), world, WORLD);
  bindChrome();

  // initial view: groups overview on desktop; on mobile fill the width with
  // one group column, anchored just below the header
  if (innerWidth < 700) {
    const s = (innerWidth - 28) / (G.w + 16);
    panzoom.animateTo(14 - (G.x - 8) * s, 108 - (G.y - 56) * s, s, 0);
  } else {
    panzoom.flyTo(sections.groups, 40, 0);
  }

  setInterval(refresh, 60_000);
})();
