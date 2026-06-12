import { PanZoom } from "./canvas.js";
import {
  loadSeed, loadResults, allStandings, resolveBracket, matchWinner,
  slotLabel, fmtDate, fmtTime, isToday, tzAbbr,
} from "./data.js";

// ---- world layout: mirrored bracket, final in the middle -------------------
// groups L | R32 | R16 | QF | SF | FINAL | SF | QF | R16 | R32 | groups R
const G = { w: 380, h: 478, gapX: 44, gapY: 48 };
const K = { w: 304, h: 104, gapY: 30 };
const MID_Y = 980;
const WORLD = { w: 5260, h: 1960 };

const COL_X = {
  groupsL: [60, 484],
  r32L: 940, r16L: 1324, qfL: 1708, sfL: 2092,
  final: 2476,
  sfR: 2860, qfR: 3244, r16R: 3628, r32R: 4012,
  groupsR: [4396, 4820],
};

// Column order top→bottom per side, derived from who feeds whom.
const R32_L = ["74", "77", "73", "75", "83", "84", "81", "82"];
const R32_R = ["76", "78", "79", "80", "86", "88", "85", "87"];
const R16_L = ["89", "90", "93", "94"], R16_R = ["91", "92", "95", "96"];
const QF_L = ["97", "98"], QF_R = ["99", "100"];
const FEEDERS = {
  89: ["74", "77"], 90: ["73", "75"], 91: ["76", "78"], 92: ["79", "80"],
  93: ["83", "84"], 94: ["81", "82"], 95: ["86", "88"], 96: ["85", "87"],
  97: ["89", "90"], 98: ["93", "94"], 99: ["91", "92"], 100: ["95", "96"],
  101: ["97", "98"], 102: ["99", "100"], 104: ["101", "102"],
};
// Groups sit on the side of the bracket their WINNER enters, ordered by the
// row of that R32 match (each runner-up crosses to the other side by design,
// so a perfect split doesn't exist). Left winners: 1E(74) 1I(77) 1F(75)
// 1H(84) 1D(81) 1G(82); right winners: 1C(76) 1A(79) 1L(80) 1J(86) 1B(85) 1K(87).
const GROUPS_L = ["E", "I", "F", "H", "D", "G"];
const GROUPS_R = ["C", "A", "L", "J", "B", "K"];

let seed, panzoom;
let state = { results: {}, overrides: {} };
const world = document.getElementById("world");
const sections = {}; // name -> world rect for nav (wide screens)
const sectionsNarrow = {}; // phone variant: one column per round, readable zoom

const flagImg = (code) => {
  const f = seed.teams[code]?.flag;
  const name = seed.teams[code]?.name ?? code;
  return f
    ? `<img class="flag" src="https://flagcdn.com/w40/${f}.png" srcset="https://flagcdn.com/w80/${f}.png 2x" alt="${esc(name)}" loading="lazy" decoding="async">`
    : `<span class="flag flag-tbd"></span>`;
};

const scoreText = (r) => (r == null || r.hs == null ? null : `${r.hs}–${r.as}`);

// ---- match events (goals/cards from the live API) --------------------------

const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const EV_ICON = { G: "⚽", P: "⚽", O: "⚽", Y: "🟨", R: "🟥" };
const evLine = (e, codes) => {
  const extra = e.t === "P" ? " (pen)" : e.t === "O" ? " (og)" : "";
  return `${e.m} ${EV_ICON[e.t]} ${e.p}${extra}${codes ? ` · ${codes[e.s]}` : ""}`;
};

// subtle hanging yellow/red tags; hovering lists everything we know
function evTagsHTML(r, codes) {
  const ev = r?.ev ?? [];
  const y = ev.filter((e) => e.t === "Y").length;
  const red = ev.filter((e) => e.t === "R").length;
  if (!y && !red) return "";
  const tip = ev.map((e) => evLine(e, codes)).join("\n");
  return `<span class="evtags" data-tip="${esc(tip)}">${
    y ? `<span class="evtag y">${y > 1 ? y : ""}</span>` : ""}${
    red ? `<span class="evtag r">${red > 1 ? red : ""}</span>` : ""}</span>`;
}

// scorer list shown when hovering a score
const goalsTipAttr = (r, codes, side) => {
  const gs = (r?.ev ?? []).filter((e) =>
    ["G", "P", "O"].includes(e.t) && (!side || e.s === side));
  return gs.length
    ? ` data-tip="${esc(gs.map((e) => evLine(e, side ? null : codes)).join("\n"))}"`
    : "";
};

// kickoff with any live schedule correction from the API applied
const kick = (m) => state.kicks?.[m.id] ?? m.kickoff;

// ---- live panel (top-right, only while matches are in play) ----------------

const STAGE_LABEL = {
  r32: "Round of 32", r16: "Round of 16", qf: "Quarter-final",
  sf: "Semi-final", third: "Third place", final: "Final",
};

function renderLivePanel(resolved) {
  const panel = document.getElementById("live-panel");
  const live = seed.matches.filter((m) => state.results[m.id]?.status === "LIVE");
  panel.hidden = !live.length;
  if (!live.length) return;

  const rows = live.map((m) => {
    const r = state.results[m.id];
    const h = m.stage === "group" ? m.home : resolved[m.id]?.home;
    const a = m.stage === "group" ? m.away : resolved[m.id]?.away;
    const ev = r.ev ?? [];
    const goals = ev.filter((e) => ["G", "P", "O"].includes(e.t)).slice(-3);
    const y = ev.filter((e) => e.t === "Y").length;
    const red = ev.filter((e) => e.t === "R").length;
    const where = m.stage === "group" ? `Group ${m.group}` : STAGE_LABEL[m.stage];
    return `
    <button class="lp-match" data-target="${m.stage === "group" ? `group-${m.group}` : `match-${m.id}`}">
      <span class="lp-meta">
        <span>${where} · ${esc(m.city)}</span>
        <span class="lp-min">${esc(r.min ?? "")}</span>
      </span>
      <span class="lp-line">
        ${flagImg(h)} ${h ?? "—"} <b class="lp-score">${r.hs}–${r.as}</b> ${a ?? "—"} ${flagImg(a)}
      </span>
      ${goals.map((e) => `<span class="lp-goal">${esc(evLine(e, { h, a }))}</span>`).join("")}
      ${y || red ? `<span class="lp-goal">${y ? `🟨 ${y}` : ""}${y && red ? " · " : ""}${red ? `🟥 ${red}` : ""}</span>` : ""}
    </button>`;
  }).join("");

  panel.innerHTML = `<div class="lp-head"><span class="live-dot"></span>Live now</div>${rows}`;
}

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
    const ko = kick(m);
    const today = isToday(ko);
    const done = !!score && !live;
    const showToday = today && !done && !live;
    const codes = { h: m.home, a: m.away };
    return `
    <div class="g-fix ${live ? "live" : ""} ${showToday ? "today" : ""} ${done ? "done" : ""}">
      <span class="g-fix-date">${live ? '<span class="live-badge"><span class="live-dot"></span>LIVE</span>' : showToday ? "Today" : fmtDate(ko).replace(/^\w+ /, "")}</span>
      <span class="g-fix-team home">${m.home} ${flagImg(m.home)}</span>
      <span class="g-fix-score ${score ? "has" : ""}"${goalsTipAttr(r, codes)}>${score ?? fmtTime(ko)}</span>
      <span class="g-fix-team away">${flagImg(m.away)} ${m.away}</span>
      ${evTagsHTML(r, codes)}
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
      ${pens}<span class="k-score"${goalsTipAttr(r, null, side)}>${score}</span>
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
  const ko = kick(m);
  const today = isToday(ko);
  const done = r?.hs != null && !live;
  const showToday = today && !done && !live;
  const cls = [
    "card", "ko-card",
    m.stage === "final" ? "final-card" : "",
    live ? "is-live" : "", showToday ? "is-today" : "", done ? "is-done" : "",
  ].join(" ");
  const aet = r?.et ? ' · <span class="aet">aet</span>' : "";
  const codes = { h: teams.home ?? "—", a: teams.away ?? "—" };
  return `
  <div class="${cls}" id="match-${m.id}">
    ${evTagsHTML(r, codes)}
    <div class="k-meta">
      <span>M${m.id} · ${showToday ? '<b class="today-tag">Today</b>' : fmtDate(ko)} · ${fmtTime(ko)}${aet}</span>
      <span class="k-city">${live ? '<span class="live-badge"><span class="live-dot"></span>LIVE</span>' : m.city}</span>
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

  const pos = {};

  // groups: 2 cols × 3 rows per side, vertically centred on the bracket
  const groupsTop = MID_Y - (3 * G.h + 2 * G.gapY) / 2;
  const placeGroups = (letters, cols) => letters.forEach((g, i) => {
    pos[`group-${g}`] = { x: cols[i % 2], y: groupsTop + Math.floor(i / 2) * (G.h + G.gapY) };
  });
  placeGroups(GROUPS_L, COL_X.groupsL);
  placeGroups(GROUPS_R, COL_X.groupsR);

  // knockout columns
  const r32Top = MID_Y - (8 * (K.h + K.gapY) - K.gapY) / 2;
  R32_L.forEach((id, i) => { pos[`match-${id}`] = { x: COL_X.r32L, y: r32Top + i * (K.h + K.gapY) }; });
  R32_R.forEach((id, i) => { pos[`match-${id}`] = { x: COL_X.r32R, y: r32Top + i * (K.h + K.gapY) }; });
  const centerOf = (id) => pos[`match-${id}`].y + K.h / 2;
  const place = (ids, x) => ids.forEach((id) => {
    const [a, b] = FEEDERS[id];
    pos[`match-${id}`] = { x, y: (centerOf(a) + centerOf(b)) / 2 - K.h / 2 };
  });
  place(R16_L, COL_X.r16L); place(R16_R, COL_X.r16R);
  place(QF_L, COL_X.qfL); place(QF_R, COL_X.qfR);
  place(["101"], COL_X.sfL); place(["102"], COL_X.sfR);
  place(["104"], COL_X.final);
  pos["match-103"] = { x: COL_X.final, y: pos["match-104"].y + K.h + 130 };

  let html = "";

  // round labels above each column's top card
  const labelCols = [
    ["Round of 32", COL_X.r32L, R32_L], ["Round of 32", COL_X.r32R, R32_R],
    ["Round of 16", COL_X.r16L, R16_L], ["Round of 16", COL_X.r16R, R16_R],
    ["Quarter-finals", COL_X.qfL, QF_L], ["Quarter-finals", COL_X.qfR, QF_R],
    ["Semi-final", COL_X.sfL, ["101"]], ["Semi-final", COL_X.sfR, ["102"]],
    ["Final", COL_X.final, ["104"]],
  ];
  for (const [label, x, ids] of labelCols) {
    const top = Math.min(...ids.map((id) => pos[`match-${id}`].y));
    html += `<div class="round-label" style="left:${x}px;top:${top - 42}px;width:${K.w}px">${label}</div>`;
  }
  html += `<div class="round-label minor" style="left:${COL_X.final}px;top:${pos["match-103"].y - 30}px;width:${K.w}px">Third place</div>`;

  // connectors (mirrored: works in both directions)
  let paths = "";
  for (const [parent, kids] of Object.entries(FEEDERS)) {
    const p = pos[`match-${parent}`];
    for (const kid of kids) {
      const c = pos[`match-${kid}`];
      const cy = c.y + K.h / 2, py = p.y + K.h / 2;
      const x1 = p.x >= c.x + K.w ? c.x + K.w : c.x;
      const x2 = p.x >= c.x + K.w ? p.x : p.x + K.w;
      const mid = (x1 + x2) / 2;
      paths += `<path d="M ${x1} ${cy} H ${mid} V ${py} H ${x2}"/>`;
    }
  }
  html += `<svg class="connectors" width="${WORLD.w}" height="${WORLD.h}" viewBox="0 0 ${WORLD.w} ${WORLD.h}">${paths}</svg>`;

  for (const g of Object.keys(seed.groups)) html += groupCardHTML(g, standings);
  for (const m of Object.values(ko)) html += koCardHTML(m, resolved);

  // champion banner above the final
  const finalWinner = matchWinner(ko["104"], resolved, state.results).winner;
  if (finalWinner) {
    html += `<div class="champion" style="left:${pos["match-104"].x - 40}px;top:${pos["match-104"].y - 150}px">
      🏆 ${flagImg(finalWinner)} <b>${seed.teams[finalWinner].name}</b> — World Champions
    </div>`;
  }

  world.innerHTML = html;
  renderLivePanel(resolved);

  for (const [id, p] of Object.entries(pos)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    if (id.startsWith("group-")) { el.style.width = `${G.w}px`; el.style.height = `${G.h}px`; }
    else { el.style.width = `${K.w}px`; }
  }

  // nav rects: each round spans its two mirrored columns
  const span = (xl, xr, ids) => {
    const ys = ids.map((id) => pos[`match-${id}`].y);
    const top = Math.min(...ys), bottom = Math.max(...ys) + K.h;
    return { x: xl - 60, y: top - 90, w: xr + K.w - xl + 120, h: bottom - top + 150 };
  };
  sections.r32 = span(COL_X.r32L, COL_X.r32R, [...R32_L, ...R32_R]);
  sections.r16 = span(COL_X.r16L, COL_X.r16R, [...R16_L, ...R16_R]);
  sections.qf = span(COL_X.qfL, COL_X.qfR, [...QF_L, ...QF_R]);
  sections.sf = span(COL_X.sfL, COL_X.sfR, ["101", "102"]);
  sections.final = { x: COL_X.final - 220, y: pos["match-104"].y - 320, w: K.w + 440, h: 920 };
  sections.groups = { x: 0, y: groupsTop - 90, w: COL_X.groupsL[1] + G.w + 60, h: 3 * (G.h + G.gapY) + 140 };
  sections.all = { x: 0, y: groupsTop - 70, w: WORLD.w, h: 3 * (G.h + G.gapY) - G.gapY + 140 };

  // phones: fly to the left column of each round instead of the full span
  const colRect = (x, ids) => {
    const ys = ids.map((id) => pos[`match-${id}`].y);
    const top = Math.min(...ys), bottom = Math.max(...ys) + K.h;
    return { x: x - 26, y: top - 64, w: K.w + 52, h: bottom - top + 110 };
  };
  sectionsNarrow.r32 = colRect(COL_X.r32L, R32_L);
  sectionsNarrow.r16 = colRect(COL_X.r16L, R16_L);
  sectionsNarrow.qf = colRect(COL_X.qfL, QF_L);
  sectionsNarrow.r32R = colRect(COL_X.r32R, R32_R);
  sectionsNarrow.r16R = colRect(COL_X.r16R, R16_R);
  sectionsNarrow.qfR = colRect(COL_X.qfR, QF_R);
  sectionsNarrow.sf = colRect(COL_X.sfL, ["101"]);
  sectionsNarrow.final = colRect(COL_X.final, ["104", "103"]);
  sectionsNarrow.all = sections.all;
}

// ---- chrome ------------------------------------------------------------------

function bindChrome() {
  const sideRow = document.getElementById("side-chips");
  let currentRound = null;

  document.getElementById("nav-chips").addEventListener("click", (e) => {
    const goto = e.target.dataset.goto;
    if (!goto) return;
    const narrow = panzoom.view().w < 700;
    const rects = narrow ? sectionsNarrow : sections;
    if (rects[goto]) panzoom.flyTo(rects[goto], narrow ? 14 : 60);
    for (const b of e.currentTarget.children) b.classList.toggle("active", b === e.target);
    // on phones, two-column rounds get a side 1 / side 2 switcher
    currentRound = goto;
    const sided = narrow && ["r32", "r16", "qf"].includes(goto);
    sideRow.hidden = !sided;
    if (sided) for (const b of sideRow.children) b.classList.toggle("active", b.dataset.side === "1");
  });

  sideRow.addEventListener("click", (e) => {
    const side = e.target.dataset.side;
    if (!side || !currentRound) return;
    const rect = sectionsNarrow[side === "2" ? `${currentRound}R` : currentRound];
    if (rect) panzoom.flyTo(rect, 14);
    for (const b of sideRow.children) b.classList.toggle("active", b === e.target);
  });
  document.getElementById("zoom-in").onclick = () => panzoom.zoomCenter(1.35);
  document.getElementById("zoom-out").onclick = () => panzoom.zoomCenter(1 / 1.35);
  document.getElementById("zoom-fit").onclick = () => panzoom.flyTo(sections.all, 40);

  // one-time rotate tip on phones
  const tip = document.getElementById("rotate-tip");
  if (innerWidth < 700 && !localStorage.getItem("wc-rotate-tip")) tip.hidden = false;
  const dismissTip = () => { tip.hidden = true; localStorage.setItem("wc-rotate-tip", "1"); };
  document.getElementById("rotate-tip-close").onclick = dismissTip;

  document.getElementById("rotate").onclick = () => {
    dismissTip();
    const vp = document.getElementById("viewport");
    panzoom.rotated = vp.classList.toggle("rotated");
    sideRow.hidden = true;
    // refit: rotated mode reads like landscape, so show everything
    if (panzoom.rotated) panzoom.flyTo(sections.all, 24, 0);
    else phoneGroupsView();
  };

  // live panel: tap a match to fly to its card on the canvas
  document.getElementById("live-panel").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-target]");
    const el = btn && document.getElementById(btn.dataset.target);
    if (!el) return;
    const narrow = panzoom.view().w < 700;
    panzoom.flyTo(
      { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight },
      narrow ? 20 : 140,
    );
  });

  const hint = document.getElementById("hint");
  setTimeout(() => hint.classList.add("fade"), 6000);
  ["pointerdown", "wheel"].forEach((ev) =>
    addEventListener(ev, () => hint.classList.add("fade"), { once: true, capture: true }));
}

function setStatus() {
  const pill = document.getElementById("status-pill");
  const n = Object.values(state.results).filter((r) => r.hs != null).length;
  pill.hidden = false;
  pill.textContent = tzAbbr
    ? `All times ${tzAbbr}${n ? ` · ${n} result${n === 1 ? "" : "s"} in` : ""}`
    : n ? `${n} result${n === 1 ? "" : "s"} in` : "";
  if (!pill.textContent) pill.hidden = true;
}

// phone portrait default: one group column filling the width
function phoneGroupsView() {
  const groupsTop = MID_Y - (3 * G.h + 2 * G.gapY) / 2;
  const v = panzoom.view();
  const s = (v.w - 28) / (G.w + 16);
  panzoom.animateTo(14 - (COL_X.groupsL[0] - 8) * s, 128 - (groupsTop - 56) * s, s, 0);
}

// ---- tooltip (fixed overlay so it escapes all card stacking contexts) ------

function setupTooltip() {
  const tip = document.createElement("div");
  tip.id = "ev-tooltip";
  tip.hidden = true;
  document.body.appendChild(tip);

  let tipTarget = null;

  const show = (el) => {
    if (el === tipTarget) return;
    tipTarget = el;
    if (!el?.dataset.tip) { tip.hidden = true; return; }
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    // Default: right-aligned below the element
    tip.style.top = `${r.bottom + 6}px`;
    tip.style.left = `${r.right}px`;
    tip.style.transform = "translateX(-100%)";
    // Keep inside viewport bounds
    requestAnimationFrame(() => {
      const tr = tip.getBoundingClientRect();
      if (tr.left < 8) { tip.style.left = "8px"; tip.style.transform = "none"; }
      if (tr.right > innerWidth - 8) { tip.style.left = `${innerWidth - 8 - tr.width}px`; tip.style.transform = "none"; }
      if (tr.bottom > innerHeight - 8) tip.style.top = `${r.top - tr.height - 6}px`;
    });
  };

  world.addEventListener("mouseover", (e) => show(e.target.closest("[data-tip]")));
  world.addEventListener("mouseout", (e) => {
    if (e.target === tipTarget && !e.relatedTarget?.closest?.("[data-tip]")) {
      tipTarget = null;
      tip.hidden = true;
    }
  });
  // Hide during pan/pinch
  world.addEventListener("pointerdown", () => { tipTarget = null; tip.hidden = true; });
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
  setupTooltip();

  // initial view: everything on desktop; on mobile fill the width with the
  // first group column, anchored just below the header
  if (innerWidth < 700) phoneGroupsView();
  else panzoom.flyTo(sections.all, 50, 0);

  setInterval(refresh, 60_000);
  // returning to the tab mid-match: don't wait out the interval
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
})();
