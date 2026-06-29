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
    `<div class="pd-picker" hidden>${PICKER.map((e) =>
       `<button data-emoji="${e}">${e}</button>`).join("")}</div>
     <button class="pd-current" title="Tap to choose · hold or press space to spray">${EMOJIS[0]}</button>
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
        spawnEmote(msg.emoji, s.x, s.y);
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

  // ---- emoji reactions ---------------------------------------------------
  let currentEmoji = EMOJIS[0];   // the one "f" / hold sprays
  let sprayTimer = null;

  const currentBtn = dock.querySelector(".pd-current");
  const picker = dock.querySelector(".pd-picker");

  function selectEmoji(emoji) {
    currentEmoji = emoji;
    currentBtn.textContent = emoji;          // the single button shows the choice
    for (const b of picker.querySelectorAll("button"))
      b.classList.toggle("sel", b.dataset.emoji === emoji);
  }

  // Log emoji usage to Umami — once per spray gesture (a tap, a hold, a key),
  // never per particle, so the fountain doesn't flood analytics. View the
  // "emoji" event's data breakdown to see the most popular emoji.
  function trackEmoji(emoji) {
    try { window.umami && window.umami.track("emoji", { emoji }); } catch {}
  }

  // Where emojis spawn from: the live cursor on desktop, or just above the
  // emoji button on touch devices (which have no hover cursor).
  function anchorWorld() {
    if (hasPos) return { x: lastX, y: lastY };
    const r = currentBtn.getBoundingClientRect();
    return screenToWorld(r.left + r.width / 2, r.top - 8);
  }

  // Fire one emoji from the anchor (with optional world-space spread).
  function fireEmote(emoji, spread = 0) {
    const a = anchorWorld();
    const wx = a.x + (Math.random() * 2 - 1) * spread;
    const wy = a.y + (Math.random() * 2 - 1) * spread;
    const s = worldToScreen(wx, wy);
    spawnEmote(emoji, s.x, s.y);
    bcast("emote", { id: me.id, emoji, x: wx, y: wy });
  }

  // Fire an emoji at a specific SCREEN point (used by tap-to-spray on mobile).
  function fireAt(cx, cy, emoji, spread = 0) {
    const w = screenToWorld(cx, cy);
    const wx = w.x + (Math.random() * 2 - 1) * spread;
    const wy = w.y + (Math.random() * 2 - 1) * spread;
    const s = worldToScreen(wx, wy);
    spawnEmote(emoji, s.x, s.y);
    bcast("emote", { id: me.id, emoji, x: wx, y: wy });
  }

  // A satisfying little burst at a screen point.
  function burstAt(cx, cy, emoji, n = 4) {
    dismissTip();
    trackEmoji(emoji);
    fireAt(cx, cy, emoji, 0);
    let i = 1;
    const t = setInterval(() => { fireAt(cx, cy, emoji, 60); if (++i >= n) clearInterval(t); }, 70);
  }

  // Hold to spray a fountain of emojis; tap = a single one. This sprays the
  // given emoji *temporarily* — it never changes the chosen button emoji
  // (only the picker does that), so the 1-8 keys are throwaway quick-fires.
  let sprayEmoji = currentEmoji;
  function startSpray(emoji) {
    sprayEmoji = emoji;
    if (sprayTimer) return;
    dismissTip();
    trackEmoji(emoji);
    fireEmote(emoji, 0);                                  // instant first hit
    sprayTimer = setInterval(() => fireEmote(sprayEmoji, 70), 75);
  }
  function stopSpray() {
    clearInterval(sprayTimer);
    sprayTimer = null;
  }

  function spawnEmote(emoji, x, y) {
    const el = document.createElement("div");
    el.className = "emote";
    el.textContent = emoji;
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.setProperty("--dx", (Math.random() * 140 - 70) + "px");
    el.style.setProperty("--rot", (Math.random() * 70 - 35) + "deg");
    el.style.setProperty("--scl", (0.85 + Math.random() * 0.5).toFixed(2));
    layer.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
  }

  // The single button: a quick tap opens the picker, a hold sprays.
  const countEl = dock.querySelector(".pd-count");
  const setPicker = (open) => {
    picker.hidden = !open;
    currentBtn.classList.toggle("open", open);
    countEl.style.visibility = open ? "hidden" : "";
  };
  let holdTimer = null, didHold = false, downTouch = false;

  currentBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    didHold = false;
    downTouch = e.pointerType === "touch";
    // mouse: hold sprays. touch: the button only opens the picker (you spray by
    // tapping the canvas), so no hold action.
    if (!downTouch) holdTimer = setTimeout(() => { didHold = true; startSpray(currentEmoji); }, 180);
  });
  currentBtn.addEventListener("pointerup", () => {
    clearTimeout(holdTimer);
    if (didHold) stopSpray();
    else setPicker(picker.hidden);             // a tap toggles the picker
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
      burstAt(e.clientX, e.clientY, currentEmoji);
    }
  };
  viewport.addEventListener("pointerup", endTouch, { passive: true });
  viewport.addEventListener("pointercancel", () => { tTouches = Math.max(0, tTouches - 1); }, { passive: true });

  // Pick an emoji from the collection -> it becomes the current one.
  picker.addEventListener("click", (e) => {
    const b = e.target.closest("[data-emoji]");
    if (!b) return;
    selectEmoji(b.dataset.emoji);
    setPicker(false);
    fireEmote(currentEmoji, 0);          // a little confirmation pop
  });

  // Click anywhere else closes the picker.
  addEventListener("pointerdown", (e) => {
    if (!picker.hidden && !dock.contains(e.target)) setPicker(false);
  });

  selectEmoji(currentEmoji);    // set the default (⚽️) for the "f" hotkey

  // ---- spray hotkeys ----------------------------------------------------
  // any key that started a spray, so the matching keyup stops it
  let sprayKey = null;

  addEventListener("keydown", (e) => {
    if (/^(input|textarea|select)$/i.test(e.target.tagName)) return;

    // Spacebar sprays the currently-selected emoji (hold = fountain).
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();                  // don't scroll / activate buttons
      if (!e.repeat) { startSpray(currentEmoji); sprayKey = " "; }
      return;
    }
    if (e.repeat) return;                  // we run our own spray interval
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 8) { startSpray(EMOJIS[n - 1]); sprayKey = e.key; }
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
