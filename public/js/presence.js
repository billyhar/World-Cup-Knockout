// Figma-style live multiplayer cursors for the canvas.
//
// Transport is a Cloudflare Worker + Durable Object (worker/server.js): one tiny
// server relays ephemeral cursor positions + emoji reactions to everyone else in
// the room and tracks the live viewer count. Nothing is persisted — every
// message is fire-and-forget. It's billed by compute, not per fanned-out message
// (and free on the Workers plan), so it scales where Supabase Realtime didn't.
// We talk to it with a plain built-in WebSocket — no third-party CDN, so an ad
// blocker can't break it.
//
// Cursors are exchanged in WORLD coordinates (canvas space) so a cursor lands on
// the same match card for everyone regardless of how each viewer has panned or
// zoomed. Each frame we convert world -> screen using the live transform of the
// #world element (read via getBoundingClientRect, so it tracks translate+scale
// without us having to know the PanZoom internals).

// The deployed Worker URL (printed by `npm run cursors:deploy`). Falls back to
// the local `wrangler dev` server (port 8787) when running on localhost.
// TODO: replace USERNAME with your Cloudflare account subdomain after the first
// deploy (e.g. wss://world-cup-cursors.jane.workers.dev).
const CURSORS_HOST = location.hostname === "localhost"
  ? "ws://localhost:8787"
  : "wss://world-cup-cursors.ioswallpapers.workers.dev";

const ROOM = "cursors";
const SEND_MS = 80;          // throttle cursor broadcasts (~12/sec)
const STALE_MS = 10_000;     // drop a cursor we haven't heard from in 10s

// The first 8 are the keyboard quick-keys (press 1-8). EMOJIS + FLAGS make up
// the full collection shown in the picker.
const EMOJIS = ["⚽️", "🥅", "🧤", "🏆", "🟨", "🟥", "🔥", "🎉",
  "😂", "😍", "🤩", "😱", "😭", "👏", "🙌", "💪",
  "🐐", "⭐️", "💥", "❤️", "💔", "🍺", "📣", "🤬"];

// GIPHY API key for GIF search. Get a free key at https://developers.giphy.com
// and either replace this value or set it via your build system. If left empty,
// the picker falls back to the curated GIFS list below and hides the search box.
const GIPHY_API_KEY = ""; // <-- paste your Giphy API key here

// Football GIF reactions. These are example URLs from GIPHY — replace them with
// your own self-hosted GIFs or licensed assets. The first 8 are mapped to the
// 1-8 keyboard quick-keys while in GIF mode.
const GIFS = [
  { url: "https://media.giphy.com/media/56FwDJAmy5MGkZmVyP/giphy.gif", label: "Goal" },
  { url: "https://media.giphy.com/media/cSTU6GckHzaw5R2SmE/giphy.gif", label: "Celebrate" },
  { url: "https://media.giphy.com/media/dMyMc3bF4FF9m/giphy.gif", label: "Cheer" },
  { url: "https://media.giphy.com/media/RX8Vaidhc3m2gz1eQh/giphy.gif", label: "World Cup" },
  { url: "https://media.giphy.com/media/RGjTCVnCgnFu2rTemJ/giphy.gif", label: "Ball" },
  { url: "https://media.giphy.com/media/eh50GNrUrVRXVzaOYF/giphy.gif", label: "Save" },
  { url: "https://media.giphy.com/media/tHIIvgdO5yPCpQT1kH/giphy.gif", label: "Red card" },
  { url: "https://media.giphy.com/media/QgsB4jveermiAk5O5j/giphy.gif", label: "Fans" },
];

// Every team in the 2026 World Cup, alphabetical by country name. England and
// Scotland use ISO subdivision codes -> regional flag emoji (tag sequences).
const TEAM_FLAGS = [
  "dz", "ar", "au", "at", "be", "ba", "br", "ca", "cv", "co", "hr", "cw",
  "cz", "cd", "ec", "eg", "gb-eng", "fr", "de", "gh", "ht", "ir", "iq", "ci",
  "jp", "jo", "mx", "ma", "nl", "nz", "no", "pa", "py", "pt", "qa", "sa",
  "gb-sct", "sn", "za", "kr", "es", "se", "ch", "tn", "tr", "us", "uy", "uz",
];

function flagEmoji(cc) {
  if (cc.length === 2) {
    return [...cc.toUpperCase()].map((c) =>
      String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("");
  }
  // subdivision flag, e.g. "gb-eng" -> 🏴 + tag chars for "gbeng" + cancel tag
  const tags = [...cc.replace("-", "")].map((c) =>
    String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
  return "\u{1F3F4}" + tags + "\u{E007F}";
}

const FLAGS = TEAM_FLAGS.map(flagEmoji);
const PICKER = EMOJIS.concat(FLAGS);

const COLORS = [
  "#ff5d5d", "#ff9f1c", "#ffd23f", "#2ec4b6", "#3a86ff",
  "#8338ec", "#ff006e", "#06d6a0", "#118ab2", "#f15bb5",
];
const ADJ = ["Flying", "Clinical", "Cheeky", "Lethal", "Wonder", "Golden",
  "Roaring", "Ice-cold", "Speedy", "Mighty"];
const NOUN = ["Striker", "Keeper", "Winger", "Sweeper", "Maestro", "Captain",
  "Playmaker", "Libero", "Poacher", "Gaffer"];

const rand = (a) => a[Math.floor(Math.random() * a.length)];

// Stable per-browser identity (name + colour persist across reloads).
function identity() {
  let me;
  try { me = JSON.parse(localStorage.getItem("wck-presence") || "null"); }
  catch { me = null; }
  if (!me || !me.id) {
    me = {
      id: Math.random().toString(36).slice(2, 10),
      name: `${rand(ADJ)} ${rand(NOUN)}`,
      color: rand(COLORS),
    };
    try { localStorage.setItem("wck-presence", JSON.stringify(me)); } catch {}
  }
  return me;
}

const cursorSVG = (color) => `
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M5 3l14 7-6 1.6L9.6 19 5 3z" fill="${color}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>
  </svg>`;

export function initPresence({ world, WORLD }) {
  const me = identity();
  // Persistent identity (name + colour) is shared across a browser's tabs, but
  // each connection needs a UNIQUE id — otherwise two tabs of the same browser
  // share an id and filter out each other's cursors as "self" (and collide as
  // one connection on the server). Suffix a random per-tab token; not persisted.
  me.id = `${me.id}.${Math.random().toString(36).slice(2, 8)}`;

  // ---- DOM scaffolding ---------------------------------------------------
  const layer = document.createElement("div");
  layer.id = "cursor-layer";
  document.body.appendChild(layer);

  // Reaction dock + viewer count.
  const dock = document.createElement("div");
  dock.id = "presence-dock";
  dock.innerHTML =
    `<div class="pd-picker" hidden></div>
     <button class="pd-current" title="Tap to choose · hold or press space to spray">${EMOJIS[0]}</button>
     <button class="pd-mode" title="Switch to GIF reactions">GIF</button>
     <div class="pd-tip"><span class="pd-tip-text">Press <kbd>space</kbd> to spray</span><button class="pd-tip-x" aria-label="Dismiss">×</button></div>
     <div class="pd-count" title="People here now"><span class="pd-dot"></span><span id="pd-n">1</span></div>`;
  document.body.appendChild(dock);

  // Show the tip on load and keep it until the user dismisses it (× button) or
  // sprays for the first time; the dismissal is remembered across visits.
  const tip = dock.querySelector(".pd-tip");
  const isTouch = matchMedia("(hover: none)").matches;
  if (isTouch) tip.querySelector(".pd-tip-text").textContent = "Tap anywhere to spray";

  const TIP_KEY = "wck-tip-dismissed";
  function dismissTip() {
    if (!tip.classList.contains("show")) return;
    tip.classList.remove("show");
    try { localStorage.setItem(TIP_KEY, "1"); } catch {}
  }
  let tipDismissed = false;
  try { tipDismissed = localStorage.getItem(TIP_KEY) === "1"; } catch {}
  if (!tipDismissed) tip.classList.add("show");
  tip.querySelector(".pd-tip-x").addEventListener("click", (e) => { e.stopPropagation(); dismissTip(); });

  // ---- coordinate helpers ------------------------------------------------
  const worldToScreen = (wx, wy) => {
    const r = world.getBoundingClientRect();
    return { x: r.left + (wx / WORLD.w) * r.width, y: r.top + (wy / WORLD.h) * r.height };
  };
  const screenToWorld = (cx, cy) => {
    const r = world.getBoundingClientRect();
    return { x: ((cx - r.left) / r.width) * WORLD.w, y: ((cy - r.top) / r.height) * WORLD.h };
  };

  // ---- remote cursor state -----------------------------------------------
  const peers = new Map(); // id -> { el, label, x, y, color, name, last }

  function ensurePeer(id, color, name) {
    let p = peers.get(id);
    if (p) return p;
    const el = document.createElement("div");
    el.className = "rc";
    el.innerHTML = `${cursorSVG(color)}
      <div class="rc-label" style="background:${color}">${escapeHtml(name)}</div>`;
    layer.appendChild(el);
    p = { el, label: el.querySelector(".rc-label"),
          x: 0, y: 0, color, name, last: performance.now() };
    peers.set(id, p);
    return p;
  }

  function dropPeer(id) {
    const p = peers.get(id);
    if (p) { p.el.remove(); peers.delete(id); }
  }

  // ---- render loop -------------------------------------------------------
  function frame() {
    const now = performance.now();
    for (const [id, p] of peers) {
      if (now - p.last > STALE_MS) { dropPeer(id); continue; }
      const s = worldToScreen(p.x, p.y);
      const off = s.x < -40 || s.y < -40 || s.x > innerWidth + 40 || s.y > innerHeight + 40;
      p.el.style.opacity = off ? "0" : "1";
      p.el.style.transform = `translate(${s.x}px, ${s.y}px)`;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- realtime channel --------------------------------------------------
  // A plain WebSocket to our Worker, wrapped with auto-reconnect. Passing me.id
  // as ?id means the server's close handler fires a "leave" with the same id our
  // peers map is keyed by, so a disconnected cursor disappears cleanly.
  const url = `${CURSORS_HOST}/?room=${encodeURIComponent(ROOM)}&id=${encodeURIComponent(me.id)}`;
  const socket = reconnectingSocket(url, (e) => onMessage(e));

  // How many people (incl. me) are in the room right now. The server broadcasts
  // a {type:"count"} whenever someone joins or leaves.
  // Cursor/emote broadcasts are gated on this: a SOLO visitor moving the mouse
  // would otherwise fire ~12 messages/sec into the void (every inbound message
  // is still a billable request), which is what blew through the free tier. We
  // only broadcast when there's someone to see it.
  let present = 1;
  const alone = () => present < 2;

  // Single funnel for every outbound broadcast. Two guards live here so no call
  // site can bypass them: (1) skip when alone (nobody to receive it), and (2) a
  // hard per-session cap — a safety net so a tab left open for hours alongside
  // others can never run away with usage. Once capped, this session goes silent
  // (cursors still receive; they just stop sending).
  let sends = 0;
  const MAX_SENDS = 20_000;
  const bcast = (event, payload) => {
    if (alone() || sends >= MAX_SENDS) return;
    sends++;
    try { socket.send(JSON.stringify({ type: event, ...payload })); } catch {}
  };

  // The server relays each message to everyone *except* the sender, so we never
  // see our own. The me.id guards below are just belt-and-braces.
  function onMessage(e) {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    switch (msg.type) {
      case "cursor": {
        if (msg.id === me.id) return;
        const p = ensurePeer(msg.id, msg.color, msg.name);
        p.x = msg.x; p.y = msg.y; p.last = performance.now();
        if (msg.name && msg.name !== p.name) {
          p.name = msg.name; p.label.textContent = msg.name;
        }
        break;
      }
      case "emote": {
        if (msg.id === me.id) return;
        const s = worldToScreen(msg.x, msg.y);
        const reaction = msg.gif
          ? { type: "gif", value: msg.gif }
          : { type: "emoji", value: msg.emoji };
        spawnEmote(reaction, s.x, s.y);
        break;
      }
      case "leave":
        dropPeer(msg.id);
        break;
      case "count": {
        present = msg.n || 1;
        const el = document.getElementById("pd-n");
        if (el) el.textContent = present;
        break;
      }
    }
  }

  // ---- local cursor capture + throttled send -----------------------------
  let lastX = 0, lastY = 0, dirty = false, hasPos = false;

  addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return; // touch has no hover cursor
    const w = screenToWorld(e.clientX, e.clientY);
    lastX = w.x; lastY = w.y; dirty = true; hasPos = true;
  }, { passive: true });

  addEventListener("pointerout", (e) => {
    if (!e.relatedTarget && !e.toElement) bcast("leave", { id: me.id });
  });

  setInterval(() => {
    if (!dirty || !hasPos) return;
    // Tab in the background — don't burn messages (alone() handled by bcast).
    if (document.hidden) return;
    dirty = false;
    bcast("cursor", { id: me.id, name: me.name, color: me.color, x: lastX, y: lastY });
  }, SEND_MS);

  // ---- reactions (emoji + GIF) ------------------------------------------
  // A reaction is either { type: "emoji", value: "⚽️" } or { type: "gif", value: url }.
  let mode = "emoji";                       // "emoji" | "gif"
  let currentReaction = { type: "emoji", value: EMOJIS[0] };
  let sprayTimer = null;

  // GIF search state (only used in GIF mode).
  const gifSearchEnabled = !!GIPHY_API_KEY;
  let gifSearchQuery = "";
  let gifSearchResults = [];
  let gifSearchTimer = null;

  const currentBtn = dock.querySelector(".pd-current");
  const modeBtn = dock.querySelector(".pd-mode");
  const picker = dock.querySelector(".pd-picker");

  function renderCurrentBtn() {
    if (currentReaction.type === "emoji") {
      currentBtn.textContent = currentReaction.value;
    } else {
      currentBtn.innerHTML = `<img src="${escapeHtml(currentReaction.value)}" alt="" loading="eager">`;
    }
  }

  function renderGifButtons(items) {
    return items.map((g) =>
      `<button data-type="gif" data-value="${escapeHtml(g.url)}" title="${escapeHtml(g.label || "")}">
         <img src="${escapeHtml(g.url)}" alt="${escapeHtml(g.label || "gif")}" loading="lazy">
       </button>`).join("");
  }

  function renderPicker() {
    picker.classList.toggle("gif-mode", mode === "gif");
    if (mode === "emoji") {
      picker.innerHTML = PICKER.map((value) =>
        `<button data-type="emoji" data-value="${escapeHtml(value)}">${value}</button>`).join("");
    } else if (gifSearchEnabled) {
      const resultsHtml = gifSearchResults.length
        ? renderGifButtons(gifSearchResults)
        : renderGifButtons(GIFS);
      const placeholder = gifSearchResults.length ? "Search results" : "Search GIFs…";
      picker.innerHTML =
        `<label class="pd-search">
           <input type="text" placeholder="${placeholder}" value="${escapeHtml(gifSearchQuery)}" autocomplete="off">
         </label>
         <div class="pd-results">${resultsHtml}</div>`;
    } else {
      // No API key: show the curated list with a helpful note.
      picker.innerHTML =
        `<div class="pd-search-note">Add a GIPHY_API_KEY to search any GIF</div>
         <div class="pd-results">${renderGifButtons(GIFS)}</div>`;
    }
    highlightCurrent();
  }

  async function searchGifs(query) {
    if (!gifSearchEnabled || !query.trim()) {
      gifSearchResults = [];
      if (gifSearchQuery === query) renderPicker();
      return;
    }
    try {
      const q = encodeURIComponent(query.trim());
      const res = await fetch(
        `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${q}&limit=16&rating=pg-13`);
      const data = await res.json();
      // Ignore stale responses: only keep results if the user hasn't moved on.
      if (gifSearchQuery !== query) return;
      gifSearchResults = (data.data || []).map((item) => ({
        url: item.images.fixed_height_small?.url || item.images.fixed_height?.url || item.images.downsized?.url,
        label: item.title || "GIF",
      })).filter((g) => g.url);
      renderPicker();
      // Keep focus on the search input after re-render.
      const input = picker.querySelector(".pd-search input");
      if (input) {
        input.focus();
        input.setSelectionRange(query.length, query.length);
      }
    } catch {
      if (gifSearchQuery === query) {
        gifSearchResults = [];
        renderPicker();
      }
    }
  }

  function debouncedSearch(query) {
    gifSearchQuery = query;
    clearTimeout(gifSearchTimer);
    gifSearchTimer = setTimeout(() => searchGifs(query), 300);
  }

  function selectReaction(reaction) {
    currentReaction = reaction;
    renderCurrentBtn();
    highlightCurrent();
  }

  function highlightCurrent() {
    const container = picker.querySelector(".pd-results") || picker;
    for (const b of container.querySelectorAll("button")) {
      const sel = b.dataset.type === currentReaction.type && b.dataset.value === currentReaction.value;
      b.classList.toggle("sel", sel);
    }
  }

  function setMode(newMode) {
    mode = newMode;
    gifSearchQuery = "";
    gifSearchResults = [];
    modeBtn.textContent = mode === "emoji" ? "GIF" : "😀";
    modeBtn.title = mode === "emoji" ? "Switch to GIF reactions" : "Switch to emoji reactions";
    // Pick a sensible default when switching modes.
    selectReaction(mode === "emoji"
      ? { type: "emoji", value: EMOJIS[0] }
      : { type: "gif", value: GIFS[0].url });
    renderPicker();
  }

  // Log reaction usage to Umami — once per spray gesture (a tap, a hold, a key),
  // never per particle, so the fountain doesn't flood analytics.
  function trackReaction(reaction) {
    try {
      if (window.umami) {
        if (reaction.type === "emoji") window.umami.track("emoji", { emoji: reaction.value });
        else window.umami.track("gif", { gif: reaction.value });
      }
    } catch {}
  }

  // Where reactions spawn from: the live cursor on desktop, or just above the
  // button on touch devices (which have no hover cursor).
  function anchorWorld() {
    if (hasPos) return { x: lastX, y: lastY };
    const r = currentBtn.getBoundingClientRect();
    return screenToWorld(r.left + r.width / 2, r.top - 8);
  }

  function payloadFor(reaction) {
    return reaction.type === "emoji"
      ? { emoji: reaction.value }
      : { gif: reaction.value };
  }

  // Fire one reaction from the anchor (with optional world-space spread).
  function fireEmote(reaction, spread = 0) {
    const a = anchorWorld();
    const wx = a.x + (Math.random() * 2 - 1) * spread;
    const wy = a.y + (Math.random() * 2 - 1) * spread;
    const s = worldToScreen(wx, wy);
    spawnEmote(reaction, s.x, s.y);
    bcast("emote", { id: me.id, ...payloadFor(reaction), x: wx, y: wy });
  }

  // Fire a reaction at a specific SCREEN point (used by tap-to-spray on mobile).
  function fireAt(cx, cy, reaction, spread = 0) {
    const w = screenToWorld(cx, cy);
    const wx = w.x + (Math.random() * 2 - 1) * spread;
    const wy = w.y + (Math.random() * 2 - 1) * spread;
    const s = worldToScreen(wx, wy);
    spawnEmote(reaction, s.x, s.y);
    bcast("emote", { id: me.id, ...payloadFor(reaction), x: wx, y: wy });
  }

  // A satisfying little burst at a screen point.
  function burstAt(cx, cy, reaction, n = 4) {
    dismissTip();
    trackReaction(reaction);
    // GIFs are larger and busier, so a single pop is enough; emojis get a cluster.
    const count = reaction.type === "gif" ? 1 : n;
    fireAt(cx, cy, reaction, 0);
    let i = 1;
    const t = setInterval(() => { fireAt(cx, cy, reaction, 60); if (++i >= count) clearInterval(t); }, 70);
  }

  // Hold to spray. Emojis become a fast fountain; GIFs are slower (one every
  // 3s) so each animation is actually visible.
  const EMOJI_SPRAY_MS = 75;
  const GIF_SPRAY_MS = 3000;
  let sprayReaction = currentReaction;
  function startSpray(reaction) {
    const wasSpraying = !!sprayTimer;
    const intervalChanged = sprayReaction.type !== reaction.type;
    sprayReaction = reaction;
    // If already spraying and the reaction type changed, restart the interval
    // so GIFs slow down and emojis stay fast.
    if (wasSpraying && intervalChanged) {
      clearInterval(sprayTimer);
      sprayTimer = null;
    }
    if (sprayTimer) return;
    dismissTip();
    trackReaction(reaction);
    if (!wasSpraying) fireEmote(reaction, 0);             // instant first hit on new spray
    const isGif = reaction.type === "gif";
    const interval = isGif ? GIF_SPRAY_MS : EMOJI_SPRAY_MS;
    const spread = isGif ? 0 : 70;
    sprayTimer = setInterval(() => fireEmote(sprayReaction, spread), interval);
  }
  function stopSpray() {
    clearInterval(sprayTimer);
    sprayTimer = null;
  }

  function spawnEmote(reaction, x, y) {
    const el = document.createElement("div");
    el.className = "emote";
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.setProperty("--dx", (Math.random() * 140 - 70) + "px");
    el.style.setProperty("--rot", (Math.random() * 70 - 35) + "deg");
    el.style.setProperty("--scl", (0.85 + Math.random() * 0.5).toFixed(2));
    if (reaction.type === "gif") {
      el.innerHTML = `<img src="${escapeHtml(reaction.value)}" alt="" loading="eager">`;
    } else {
      el.textContent = reaction.value;
    }
    layer.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
  }

  // The single button: a quick tap opens the picker, a hold sprays.
  const countEl = dock.querySelector(".pd-count");
  const setPicker = (open) => {
    picker.hidden = !open;
    currentBtn.classList.toggle("open", open);
    modeBtn.classList.toggle("open", open);
    countEl.style.visibility = open ? "hidden" : "";
  };
  let holdTimer = null, didHold = false, downTouch = false;

  currentBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    didHold = false;
    downTouch = e.pointerType === "touch";
    // mouse: hold sprays. touch: the button only opens the picker (you spray by
    // tapping the canvas), so no hold action.
    if (!downTouch) holdTimer = setTimeout(() => { didHold = true; startSpray(currentReaction); }, 180);
  });
  currentBtn.addEventListener("pointerup", () => {
    clearTimeout(holdTimer);
    if (didHold) stopSpray();
    else setPicker(picker.hidden);             // a tap toggles the picker
  });

  // Toggle between emoji and GIF modes.
  modeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setMode(mode === "emoji" ? "gif" : "emoji");
    setPicker(true);
  });

  // Mobile: tap anywhere on the canvas to spray a burst at that spot.
  const viewport = document.getElementById("viewport");
  let tx = 0, ty = 0, tStart = 0, tMoved = false, tTouches = 0;
  viewport.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    tTouches++;
    if (tTouches === 1) { tx = e.clientX; ty = e.clientY; tStart = performance.now(); tMoved = false; }
  }, { passive: true });
  viewport.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" && Math.hypot(e.clientX - tx, e.clientY - ty) > 12) tMoved = true;
  }, { passive: true });
  const endTouch = (e) => {
    if (e.pointerType !== "touch") return;
    const wasSingle = tTouches === 1;
    tTouches = Math.max(0, tTouches - 1);
    // a quick, still, single-finger tap = spray (not a pan or pinch)
    if (wasSingle && !tMoved && performance.now() - tStart < 300) {
      burstAt(e.clientX, e.clientY, currentReaction);
    }
  };
  viewport.addEventListener("pointerup", endTouch, { passive: true });
  viewport.addEventListener("pointercancel", () => { tTouches = Math.max(0, tTouches - 1); }, { passive: true });

  // Pick a reaction from the collection -> it becomes the current one.
  picker.addEventListener("click", (e) => {
    const b = e.target.closest("[data-type]");
    if (!b) return;
    selectReaction({ type: b.dataset.type, value: b.dataset.value });
    setPicker(false);
    fireEmote(currentReaction, 0);       // a little confirmation pop
  });

  // GIF search input.
  picker.addEventListener("input", (e) => {
    const input = e.target.closest(".pd-search input");
    if (!input) return;
    debouncedSearch(input.value);
  });
  picker.addEventListener("keydown", (e) => {
    // Don't let typing in the search box trigger global spray hotkeys.
    if (e.target.closest(".pd-search input")) e.stopPropagation();
  });

  // Click anywhere else closes the picker.
  addEventListener("pointerdown", (e) => {
    if (!picker.hidden && !dock.contains(e.target)) setPicker(false);
  });

  renderPicker();
  selectReaction(currentReaction);      // set the default (⚽️) for the space hotkey

  // ---- spray hotkeys ----------------------------------------------------
  // any key that started a spray, so the matching keyup stops it
  let sprayKey = null;

  addEventListener("keydown", (e) => {
    if (/^(input|textarea|select)$/i.test(e.target.tagName)) return;

    // Spacebar sprays the currently-selected reaction (hold = fountain).
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();                  // don't scroll / activate buttons
      if (!e.repeat) { startSpray(currentReaction); sprayKey = " "; }
      return;
    }
    if (e.repeat) return;                  // we run our own spray interval
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 8) {
      const reaction = mode === "emoji"
        ? { type: "emoji", value: EMOJIS[n - 1] }
        : { type: "gif", value: GIFS[n - 1]?.url };
      if (reaction.value) { startSpray(reaction); sprayKey = e.key; }
    }
  });

  addEventListener("keyup", (e) => {
    if (sprayKey && (e.key === sprayKey || e.key.toLowerCase() === sprayKey.toLowerCase())) {
      stopSpray();
      sprayKey = null;
    }
  });

  // releasing the mouse (anywhere) ends a dock-button spray
  addEventListener("pointerup", stopSpray);
  addEventListener("pointercancel", stopSpray);
  addEventListener("blur", stopSpray);

  addEventListener("beforeunload", () => {
    // When alone, bcast no-ops — the server's close handler resyncs the count
    // and tells peers to drop our cursor anyway.
    bcast("leave", { id: me.id });
  });
}

// A minimal auto-reconnecting WebSocket: exposes send()/close() and forwards
// every message to onMessage. Exponential backoff (1s→15s) so a dropped or
// briefly-unreachable Worker reconnects on its own without hammering it.
function reconnectingSocket(url, onMessage) {
  let ws, closed = false, retry = 0, timer = null;
  const connect = () => {
    ws = new WebSocket(url);
    ws.addEventListener("open", () => { retry = 0; });
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", () => {
      if (closed) return;
      timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15_000));
    });
    ws.addEventListener("error", () => { try { ws.close(); } catch {} });
  };
  connect();
  return {
    send: (data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(data); } catch {}
      }
    },
    close: () => { closed = true; clearTimeout(timer); try { ws && ws.close(); } catch {} },
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
