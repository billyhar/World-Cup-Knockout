import { PanZoom } from "./canvas.js";
import {
  loadSeed, loadResults, allStandings, resolveBracket, matchWinner,
  slotLabel, fmtDate, fmtTime, isToday, tzAbbr,
} from "./data.js";
import { loadBroadcasters, watchOn } from "./broadcasters.js";
import { initPresence } from "./presence.js";
import { loadPredictions, getPrediction, getMyVote, castVote } from "./predictions.js";

// "Where to watch" line for a match in the viewer's country (location-based,
// like the times). Rights split per game, so this resolves per match id and
// renders only when we know the channel.
const tvHTML = (matchId) => {
  const w = watchOn(matchId);
  return w
    ? `<span class="tv" data-tip="Broadcasting in ${esc(w.name)}">${esc(w.on)}</span>`
    : "";
};

// ---- world layout: mirrored bracket, final in the middle -------------------
// groups L | R32 | R16 | QF | SF | FINAL | SF | QF | R16 | R32 | groups R
const G = { w: 380, h: 590, gapX: 44, gapY: 56 };
const K = { w: 304, h: 148, gapY: 30 };
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
    ? `<img class="flag" src="https://flagcdn.com/w40/${f}.png" srcset="https://flagcdn.com/w80/${f}.png 2x" alt="${esc(name)}" decoding="async">`
    : `<span class="flag flag-tbd"></span>`;
};

const scoreText = (r) => (r == null || r.hs == null ? null : `${r.hs}–${r.as}`);

// Some codes differ from common display usage
const DISPLAY_CODE = { COD: "DRC" };
const displayCode = (code) => DISPLAY_CODE[code] ?? code;

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

// ---- live dock (bottom centre, only while matches are in play) -------------

const STAGE_LABEL = {
  r32: "Round of 32", r16: "Round of 16", qf: "Quarter-final",
  sf: "Semi-final", third: "Third place", final: "Final",
};

let scoreDayKey = null;
let scoresOpen = localStorage.getItem("wc-scores-open") === "1";
let lastResolved = {};
let futureDays = [];

const dayKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// ---- scores carousel (BBC Sport-style day-by-day match strip) -------------

function renderScoresCarousel(resolved) {
  lastResolved = resolved;
  const panel = document.getElementById("scores-carousel");
  const btn = document.getElementById("scores-btn");
  panel.hidden = !scoresOpen;
  btn?.classList.toggle("active", scoresOpen);
  if (!scoresOpen) return;

  // Group matches by local calendar day
  const dayMap = new Map();
  for (const m of seed.matches) {
    const k = dayKey(kick(m));
    if (!dayMap.has(k)) dayMap.set(k, []);
    dayMap.get(k).push(m);
  }
  const allDays = [...dayMap.keys()].sort();
  const todayK = dayKey(new Date().toISOString());

  // Only show today and future days
  futureDays = allDays.filter((d) => d >= todayK);

  // Auto-select: today if it has matches, else first future day
  if (!scoreDayKey || !futureDays.includes(scoreDayKey)) {
    scoreDayKey = futureDays[0] ?? allDays.at(-1);
  }

  const formatDayTab = (k) => {
    if (k === todayK) return "Today";
    const [y, mo, d] = k.split("-").map(Number);
    return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" })
      .format(new Date(y, mo - 1, d));
  };

  // Day tabs — only future days
  const daysEl = document.getElementById("sc-days");
  daysEl.innerHTML = futureDays.map((k) => {
    const hasLive = dayMap.get(k).some((m) => state.results[m.id]?.status === "LIVE");
    return `<button class="sc-day${k === scoreDayKey ? " active" : ""}${k === todayK ? " today" : ""}" data-k="${k}">${
      hasLive ? '<span class="live-dot"></span>' : ""
    }${formatDayTab(k)}</button>`;
  }).join("");

  // Scroll active tab into view
  const activeTab = daysEl.querySelector(".sc-day.active");
  if (activeTab) {
    const mid = activeTab.offsetLeft - (daysEl.clientWidth - activeTab.offsetWidth) / 2;
    daysEl.scrollLeft = Math.max(0, mid);
  }

  // Arrow disabled states
  const idx = futureDays.indexOf(scoreDayKey);
  const prevBtn = document.getElementById("sc-prev");
  const nextBtn = document.getElementById("sc-next");
  if (prevBtn) prevBtn.disabled = idx <= 0;
  if (nextBtn) nextBtn.disabled = idx >= futureDays.length - 1;

  // Match cards for selected day: live first, then by kickoff
  const matches = (dayMap.get(scoreDayKey) ?? [])
    .slice()
    .sort((a, b) => {
      const aLive = state.results[a.id]?.status === "LIVE" ? 0 : 1;
      const bLive = state.results[b.id]?.status === "LIVE" ? 0 : 1;
      if (aLive !== bLive) return aLive - bLive;
      return kick(a).localeCompare(kick(b));
    });

  const scStrip = document.getElementById("sc-strip");
  scStrip.scrollLeft = 0;
  scStrip.innerHTML = matches.map((m) => {
    const r = state.results[m.id];
    const live = r?.status === "LIVE";
    const score = scoreText(r);
    const done = !!score && !live;

    const homeCode = m.stage === "group" ? m.home : resolved[m.id]?.home;
    const awayCode = m.stage === "group" ? m.away : resolved[m.id]?.away;
    const homeLbl = displayCode(homeCode ?? slotLabel(m.home));
    const awayLbl = displayCode(awayCode ?? slotLabel(m.away));
    const stageLabel = m.stage === "group" ? `Group ${m.group}` : (STAGE_LABEL[m.stage] ?? "");
    const target = m.stage === "group" ? `group-${m.group}` : `match-${m.id}`;
    const minLabel = live && r.min ? esc(r.min) : "";

    const metaLine = live
      ? `<span class="live-badge"><span class="live-dot"></span>LIVE</span>${minLabel ? `<span class="sc-min">${minLabel}</span>` : ""}`
      : done
      ? `${esc(stageLabel)}<span class="badge done sc-badge-ft">Played</span>`
      : esc(stageLabel);

    return `<button class="sc-card${live ? " live" : ""}${done ? " done" : ""}" data-target="${target}">
      <span class="sc-meta">${metaLine}</span>
      <span class="sc-matchup">
        <span class="sc-team home">${flagImg(homeCode)}<span class="sc-name">${esc(homeLbl)}</span></span>
        <span class="sc-result">${score ?? fmtTime(kick(m))}</span>
        <span class="sc-team away"><span class="sc-name">${esc(awayLbl)}</span>${flagImg(awayCode)}</span>
      </span>
    </button>`;
  }).join("");

  updateStripArrow();
}

function updateStripArrow() {
  const strip = document.getElementById("sc-strip");
  if (!strip) return;
  const atStart = strip.scrollLeft <= 4;
  const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 4;
  document.getElementById("sc-strip-prev")?.classList.toggle("at-start", atStart);
  document.getElementById("sc-strip-next")?.classList.toggle("at-end", atEnd);
}

// ---- group cards -----------------------------------------------------------

function groupTableRowsHTML(table) {
  return table.map((row, i) => `
    <div class="g-row q${i < 2 ? "1" : i === 2 ? "3" : "0"}">
      <span class="pos">${i + 1}</span>
      ${flagImg(row.team)}
      <span class="g-name">${seed.teams[row.team].name}</span>
      <span class="g-stat">${row.p}</span>
      <span class="g-stat">${row.gd > 0 ? "+" : ""}${row.gd}</span>
      <span class="g-stat g-pts">${row.pts}</span>
    </div>`).join("");
}

function groupFixturesHTML(matches) {
  return matches.map((m) => {
    const r = state.results[m.id];
    const score = scoreText(r);
    const live = r?.status === "LIVE";
    const ko = kick(m);
    const today = isToday(ko);
    const done = !!score && !live;
    const showToday = today && !done && !live;
    const codes = { h: m.home, a: m.away };
    const tv = tvHTML(m.id);
    return `
    <div class="g-fix ${live ? "live" : ""} ${showToday ? "today" : ""} ${done ? "done" : ""}" data-mid="${m.id}">
      <span class="g-fix-date">${live ? '<span class="live-badge"><span class="live-dot"></span>LIVE</span>' : showToday ? "Today" : fmtDate(ko).replace(/^\w+ /, "")}</span>
      <span class="g-fix-team home">${displayCode(m.home)} ${flagImg(m.home)}</span>
      <span class="g-fix-score ${score ? "has" : ""}"${goalsTipAttr(r, codes)}>${score ?? fmtTime(ko)}</span>
      <span class="g-fix-team away">${flagImg(m.away)} ${displayCode(m.away)}</span>
      <span class="g-fix-spacer" aria-hidden="true"></span>
      ${evTagsHTML(r, codes)}
      <span class="g-fix-city">${m.city}${tv ? ` · ${tv}` : ""}</span>
    </div>`;
  }).join("");
}

function groupCardHTML(g, standings) {
  const { table, complete } = standings[g];
  const matches = seed.matches.filter((m) => m.stage === "group" && m.group === g);

  return `
  <div class="card group-card" id="group-${g}">
    <div class="g-head">
      <h2>Group ${g}</h2>
      ${complete ? '<span class="badge done">final</span>' : ""}
    </div>
    <div class="g-cols"><span></span><span></span><span></span><span>P</span><span>GD</span><span>Pts</span></div>
    <div class="g-table">${groupTableRowsHTML(table)}</div>
    <div class="g-fixtures">${groupFixturesHTML(matches)}</div>
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

function predWidgetHTML(m, teams) {
  const homeCode = teams?.home;
  const awayCode = teams?.away;
  const r = state.results[m.id];
  const live = r?.status === "LIVE";
  const played = r?.hs != null && !live;

  if (!homeCode || !awayCode || played) return '<div class="pred pred-spacer"></div>';

  const pred = getPrediction(m.id);
  const myVote = getMyVote(m.id);
  const total = pred ? pred.home + pred.draw + pred.away : 0;
  const hasVotes = total > 0;
  const hp = total ? Math.round(pred.home / total * 100) : 0;
  const ap = total ? Math.round(pred.away / total * 100) : 0;
  const hPick = myVote === "home", aPick = myVote === "away";

  const btns = myVote ? "" : `<div class="pred-btns">
    <button class="pred-btn" data-mid="${m.id}" data-choice="home">${esc(displayCode(homeCode))}</button>
    <button class="pred-btn pred-btn-draw" data-mid="${m.id}" data-choice="draw">Draw</button>
    <button class="pred-btn" data-mid="${m.id}" data-choice="away">${esc(displayCode(awayCode))}</button>
  </div>`;

  const bar = (hasVotes || myVote) ? `<div class="pred-bar">
    <div class="pred-fill home${hPick ? " my-pick" : ""}" style="--pct:${hp}"></div>
    <div class="pred-fill away${aPick ? " my-pick" : ""}" style="--pct:${ap};animation-delay:0.08s"></div>
  </div>
  <div class="pred-labels">
    <span class="home${hPick ? " my-pick" : ""}">${esc(displayCode(homeCode))} ${hp}%</span>
    <span class="away${aPick ? " my-pick" : ""}">${esc(displayCode(awayCode))} ${ap}%</span>
    <span class="pred-total">${total.toLocaleString()} vote${total !== 1 ? "s" : ""}</span>
  </div>` : "";

  return `<div class="pred${myVote ? " pred-voted" : ""}" data-mid="${m.id}">
    ${btns}
    ${bar}
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
  const tv = tvHTML(m.id);
  return `
  <div class="${cls}" id="match-${m.id}">
    ${evTagsHTML(r, codes)}
    <div class="k-meta">
      <span>M${m.id} · ${showToday ? '<b class="today-tag">Today</b>' : fmtDate(ko)} · ${fmtTime(ko)}${aet}</span>
      <span class="k-city">${live ? '<span class="live-badge"><span class="live-dot"></span>LIVE</span>' : done ? '<span class="badge done">played</span>' : m.city}</span>
    </div>
    ${teamRowHTML(teams.home, m.home, r, "h", winner)}
    ${teamRowHTML(teams.away, m.away, r, "a", winner)}
    ${tv ? `<div class="k-tv">${tv}</div>` : ""}
    ${predWidgetHTML(m, teams)}
  </div>`;
}

// ---- render ------------------------------------------------------------------

function render() {
  const standings = allStandings(seed, state.results);
  const { resolved } = resolveBracket(seed, state.results, state.overrides, standings);
  lastResolved = resolved;
  lastResolvedStr = JSON.stringify(resolved);
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
  const r32GapY = K.gapY + 30;
  const r32Top = MID_Y - (8 * (K.h + r32GapY) - r32GapY) / 2;
  R32_L.forEach((id, i) => { pos[`match-${id}`] = { x: COL_X.r32L, y: r32Top + i * (K.h + r32GapY) }; });
  R32_R.forEach((id, i) => { pos[`match-${id}`] = { x: COL_X.r32R, y: r32Top + i * (K.h + r32GapY) }; });
  const centerOf = (id) => pos[`match-${id}`].y + K.h / 2;
  const place = (ids, x) => ids.forEach((id) => {
    const [a, b] = FEEDERS[id];
    pos[`match-${id}`] = { x, y: (centerOf(a) + centerOf(b)) / 2 - K.h / 2 };
  });
  place(R16_L, COL_X.r16L); place(R16_R, COL_X.r16R);
  // Fan R16 cards outward from their column centre so they breathe more.
  // QF/SF/Final use centerOf() on the modified positions, so they follow automatically.
  const spreadR16 = (ids, bonus) => {
    const mid = (ids.length - 1) / 2;
    ids.forEach((id, i) => { pos[`match-${id}`].y += (i - mid) * bonus; });
  };
  spreadR16(R16_L, 50); spreadR16(R16_R, 50);
  place(QF_L, COL_X.qfL); place(QF_R, COL_X.qfR);
  place(["101"], COL_X.sfL); place(["102"], COL_X.sfR);
  place(["104"], COL_X.final);
  pos["match-103"] = { x: COL_X.final, y: pos["match-104"].y + K.h + 130 };
  pos104 = pos["match-104"];

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
  renderScoresCarousel(resolved);

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
    if (e.target.dataset.action === "scores") {
      scoresOpen = !scoresOpen;
      localStorage.setItem("wc-scores-open", scoresOpen ? "1" : "0");
      renderScoresCarousel(lastResolved);
      return;
    }
    const goto = e.target.dataset.goto;
    if (!goto) return;
    const narrow = panzoom.view().w < 700;
    const rects = narrow ? sectionsNarrow : sections;
    if (rects[goto]) panzoom.flyTo(rects[goto], narrow ? 14 : 60);
    for (const b of e.currentTarget.children) {
      if (b.dataset.action) continue; // preserve scores button state
      b.classList.toggle("active", b === e.target);
    }
    // on phones, two-column rounds get a side 1 / side 2 switcher
    currentRound = goto;
    const sided = narrow && ["r32", "r16", "qf"].includes(goto);
    sideRow.hidden = !sided;
    if (sided) for (const b of sideRow.children) b.classList.toggle("active", b.dataset.side === "1");
  });

  // Scores carousel: arrows, day tab switching + match card fly-to
  document.getElementById("scores-carousel").addEventListener("click", (e) => {
    const arrow = e.target.closest(".sc-arrow");
    if (arrow) {
      const dir = arrow.id === "sc-next" ? 1 : -1;
      const next = futureDays[futureDays.indexOf(scoreDayKey) + dir];
      if (next) { scoreDayKey = next; renderScoresCarousel(lastResolved); }
      return;
    }
    const tab = e.target.closest(".sc-day");
    if (tab) {
      scoreDayKey = tab.dataset.k;
      renderScoresCarousel(lastResolved);
      return;
    }
    const card = e.target.closest("[data-target]");
    if (!card) return;
    const el = document.getElementById(card.dataset.target);
    if (!el) return;
    const narrow = panzoom.view().w < 700;
    panzoom.flyTo(
      { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight },
      narrow ? 20 : 140,
    );
  });

  sideRow.addEventListener("click", (e) => {
    const side = e.target.dataset.side;
    if (!side || !currentRound) return;
    const rect = sectionsNarrow[side === "2" ? `${currentRound}R` : currentRound];
    if (rect) panzoom.flyTo(rect, 14);
    for (const b of sideRow.children) b.classList.toggle("active", b === e.target);
  });
  // Strip scroll arrows (mobile only — CSS hides them on desktop)
  document.getElementById("sc-strip")?.addEventListener("scroll", updateStripArrow, { passive: true });
  document.getElementById("sc-strip-prev")?.addEventListener("click", () => {
    document.getElementById("sc-strip")?.scrollBy({ left: -165, behavior: "smooth" });
  });
  document.getElementById("sc-strip-next")?.addEventListener("click", () => {
    document.getElementById("sc-strip")?.scrollBy({ left: 165, behavior: "smooth" });
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

  const hint = document.getElementById("hint");
  setTimeout(() => hint.classList.add("fade"), 6000);
  ["pointerdown", "wheel"].forEach((ev) =>
    addEventListener(ev, () => hint.classList.add("fade"), { once: true, capture: true }));

  // Prediction vote buttons.
  // We use pointerdown/pointerup (not click) because touch-action:none on the
  // viewport suppresses synthetic click events on touch devices, and the panzoom
  // captures the pointer which can also swallow clicks on desktop.
  let predTapStart = null;
  world.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".pred-btn")) return;
    e.stopPropagation(); // prevent panzoom from capturing this pointer
    predTapStart = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  world.addEventListener("pointercancel", () => { predTapStart = null; });

  world.addEventListener("pointerup", async (e) => {
    if (!predTapStart || predTapStart.id !== e.pointerId) return;
    const start = predTapStart;
    predTapStart = null;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) return; // drag, not tap

    const btn = e.target.closest(".pred-btn[data-choice]");
    if (!btn) return;
    e.stopPropagation();

    const mid = Number(btn.dataset.mid);
    const choice = btn.dataset.choice;

    const widget = world.querySelector(`.pred[data-mid="${mid}"]`);
    if (widget) widget.innerHTML = `<div class="pred-loading">…</div>`;

    await castVote(mid, choice);

    // eslint-disable-next-line eqeqeq
    const m = seed.matches.find((x) => x.id == mid);
    if (m && widget?.isConnected) {
      widget.outerHTML = predWidgetHTML(m, lastResolved[mid]);
    }
  });
}

function showPredHint() {
  if (localStorage.getItem("wc-pred-hint")) return;

  // Find first upcoming knockout match with both teams already known
  const m = seed.matches.find((x) =>
    x.stage !== "group" &&
    !state.results[x.id]?.hs &&
    lastResolved[x.id]?.home &&
    lastResolved[x.id]?.away,
  );
  if (!m) return;

  localStorage.setItem("wc-pred-hint", "1");

  const el = document.getElementById(`match-${m.id}`);
  if (!el) return;

  const hint = document.createElement("div");
  hint.className = "pred-hint-callout";
  hint.textContent = "✦ New — tap to predict the winner";
  // Position in canvas space, centred below the card's pred widget
  hint.style.left = `${el.offsetLeft + el.offsetWidth / 2}px`;
  hint.style.top = `${el.offsetTop + el.offsetHeight + 8}px`;
  world.appendChild(hint);

  // Fly to this card so the user sees it
  panzoom.flyTo(
    { x: el.offsetLeft, y: el.offsetTop - 30, w: el.offsetWidth, h: el.offsetHeight + 80 },
    60, 700,
  );

  const remove = () => hint.remove();
  setTimeout(remove, 6000);
  world.addEventListener("pointerdown", remove, { once: true });
}

function setStatus() {
  const pill = document.getElementById("status-pill");
  const n = Object.values(state.results).filter((r) => r.hs != null).length;
  pill.hidden = false;
  // phones: the pill sits beside the brand, so keep it short
  pill.textContent = tzAbbr
    ? innerWidth < 700
      ? tzAbbr
      : `All times ${tzAbbr}${n ? ` · ${n} result${n === 1 ? "" : "s"} in` : ""}`
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

  document.addEventListener("mouseover", (e) => show(e.target.closest?.("[data-tip]")));
  document.addEventListener("mouseout", (e) => {
    if (e.target === tipTarget && !e.relatedTarget?.closest?.("[data-tip]")) {
      tipTarget = null;
      tip.hidden = true;
    }
  });
  // Hide during pan/pinch
  world.addEventListener("pointerdown", () => { tipTarget = null; tip.hidden = true; });
}

// Stale-data guard: no match is still running ~5h after kickoff. If the
// upstream feed wedges mid-match and never reports FINISHED, demote the
// entry to a plain result so all LIVE UI (badges, dock) clears itself.
function sanitizeLive() {
  for (const m of seed.matches) {
    const r = state.results[m.id];
    if (r?.status === "LIVE" && Date.now() - Date.parse(kick(m)) > 4.75 * 3600e3) {
      delete r.status;
    }
  }
}

// After a re-render, find every score element whose value changed and
// trigger the slide-in animation on it so goals read as live events.
function markChangedScores(prev) {
  const flash = (el) => {
    if (!el) return;
    el.classList.remove("score-changed");
    void el.offsetWidth; // force reflow to restart animation
    el.classList.add("score-changed");
  };
  for (const m of seed.matches) {
    const old = prev[m.id];
    const cur = state.results[m.id];
    const oldTxt = old?.hs != null ? `${old.hs}-${old.as}` : null;
    const newTxt = cur?.hs != null ? `${cur.hs}-${cur.as}` : null;
    if (!newTxt || newTxt === oldTxt) continue;
    // Knockout card: two .k-score spans inside #match-{id}
    document.getElementById(`match-${m.id}`)
      ?.querySelectorAll(".k-score").forEach(flash);
    // Group fixture: .g-fix-score inside [data-mid="{id}"]
    flash(document.querySelector(`.g-fix[data-mid="${m.id}"] .g-fix-score`));
  }
}

// Incremental DOM update: only patches elements whose underlying data changed.
// Much cheaper than a full render (no innerHTML wipe, flags aren't re-fetched).
function patchDOM(prev, prevResolved, standings, resolved) {
  // Group cards
  for (const g of Object.keys(seed.groups)) {
    const matches = seed.matches.filter((m) => m.stage === "group" && m.group === g);
    const changed = matches.some(
      (m) => JSON.stringify(state.results[m.id]) !== JSON.stringify(prev[m.id]),
    );
    if (!changed) continue;

    const card = document.getElementById(`group-${g}`);
    if (!card) continue;
    const { table, complete } = standings[g];

    const tableEl = card.querySelector(".g-table");
    if (tableEl) tableEl.innerHTML = groupTableRowsHTML(table);

    const fixEl = card.querySelector(".g-fixtures");
    if (fixEl) fixEl.innerHTML = groupFixturesHTML(matches);

    if (complete && !card.querySelector(".badge.done")) {
      card.querySelector(".g-head")?.insertAdjacentHTML("beforeend", '<span class="badge done">final</span>');
    }
  }

  // Knockout cards — only update those where score or resolved teams changed
  const ko = Object.fromEntries(seed.matches.filter((m) => m.stage !== "group").map((m) => [m.id, m]));
  for (const m of Object.values(ko)) {
    const rChanged = JSON.stringify(state.results[m.id]) !== JSON.stringify(prev[m.id]);
    const teamsChanged = JSON.stringify(resolved[m.id]) !== JSON.stringify(prevResolved[m.id]);
    if (!rChanged && !teamsChanged) continue;
    const el = document.getElementById(`match-${m.id}`);
    if (!el) continue;
    // Preserve absolute position before replacing (outerHTML wipes inline styles)
    const { left, top, width } = el.style;
    el.outerHTML = koCardHTML(m, resolved);
    const newEl = document.getElementById(`match-${m.id}`);
    if (newEl) { newEl.style.left = left; newEl.style.top = top; if (width) newEl.style.width = width; }
  }

  // Champion banner
  const finalWinner = matchWinner(ko["104"], resolved, state.results).winner;
  const existingBanner = world.querySelector(".champion");
  if (finalWinner && !existingBanner) {
    const p = { x: pos104.x, y: pos104.y };
    world.insertAdjacentHTML(
      "beforeend",
      `<div class="champion" style="left:${p.x - 40}px;top:${p.y - 150}px">
        🏆 ${flagImg(finalWinner)} <b>${seed.teams[finalWinner].name}</b> — World Champions
      </div>`,
    );
  } else if (!finalWinner && existingBanner) {
    existingBanner.remove();
  }

  renderScoresCarousel(resolved);
}

let lastResultsStr = "";
let lastResolvedStr = "";
let pos104 = { x: COL_X.final, y: 0 }; // updated by render()

async function refresh() {
  const prev = { ...state.results };
  const prevResolved = { ...lastResolved };
  let newState;
  try {
    newState = await loadResults();
  } catch { return; }

  // Sanitize the incoming state before comparing so LIVE badges that timed out
  // are cleared even when the API hasn't updated yet.
  state = newState;
  sanitizeLive();

  const newStr = JSON.stringify(state.results);
  if (newStr === lastResultsStr) {
    renderScoresCarousel(lastResolved);
    return;
  }

  lastResultsStr = newStr;

  const standings = allStandings(seed, state.results);
  const { resolved } = resolveBracket(seed, state.results, state.overrides, standings);

  const resolvedStr = JSON.stringify(resolved);
  const structureChanged = resolvedStr !== lastResolvedStr;
  lastResolvedStr = resolvedStr;
  lastResolved = resolved;

  markChangedScores(prev);

  if (structureChanged) {
    // A new team entered the bracket — full render keeps connectors and positions correct.
    render();
  } else {
    patchDOM(prev, prevResolved, standings, resolved);
  }

  setStatus();
}

// ---- boot ----------------------------------------------------------------------

function hideLoader() {
  const loader = document.getElementById("boot-loader");
  if (!loader) return;
  loader.classList.add("done");
  loader.addEventListener("transitionend", () => loader.remove(), { once: true });
}

function showBootError() {
  const loader = document.getElementById("boot-loader");
  if (loader) {
    loader.style.pointerEvents = "auto";
    loader.innerHTML = `
      <p class="bl-text">Failed to load — check your connection</p>
      <button onclick="location.reload()" style="padding:8px 22px;border-radius:8px;border:none;background:var(--accent);color:#07090f;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">Try again</button>
    `;
  }
}

(async function boot() {
  try {
    [seed] = await Promise.all([loadSeed(), loadBroadcasters()]);
  } catch {
    showBootError();
    return;
  }
  // Load results and prediction vote counts in parallel so both are ready
  // before the first render — avoids a second re-render for predictions.
  const [loadedState] = await Promise.all([
    loadResults().catch(() => state),
    loadPredictions(),
  ]);
  state = loadedState;
  sanitizeLive();
  lastResultsStr = JSON.stringify(state.results);
  render();
  hideLoader();
  setStatus();

  panzoom = new PanZoom(document.getElementById("viewport"), world, WORLD);
  bindChrome();
  setupTooltip();

  // Figma-style live multiplayer cursors, cursor chat and emoji reactions.
  initPresence({ world, WORLD });

  // initial view: everything on desktop; on mobile fill the width with the
  // first group column, anchored just below the header.
  // Defer until the viewport actually has a size — if this runs before the
  // first layout pass (a 0-size viewport), the fit math collapses and the
  // canvas shows blank until a manual refresh.
  const initialView = () => {
    if (innerWidth < 700) phoneGroupsView();
    else panzoom.flyTo(sections.all, 50, 0);
  };
  const fitWhenSized = (tries = 0) => {
    if (panzoom.hasSize() || tries > 30) {
      initialView();
      setTimeout(showPredHint, 1800); // show after user has oriented
    } else {
      requestAnimationFrame(() => fitWhenSized(tries + 1));
    }
  };
  fitWhenSized();

  setInterval(refresh, 60_000);
  // returning to the tab mid-match: don't wait out the interval
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
})();
