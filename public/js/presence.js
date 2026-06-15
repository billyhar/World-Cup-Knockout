// Figma-style live multiplayer cursors for the canvas.
//
// Uses Supabase Realtime: Broadcast for ephemeral cursor positions, cursor-chat
// text and emoji reactions, and Presence for the live viewer count. No database
// tables are touched — every message lives on the namespaced "cursors" channel.
//
// Cursors are exchanged in WORLD coordinates (canvas space) so a cursor lands on
// the same match card for everyone regardless of how each viewer has panned or
// zoomed. Each frame we convert world -> screen using the live transform of the
// #world element (read via getBoundingClientRect, so it tracks translate+scale
// without us having to know the PanZoom internals).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://xozkbbbejhcsglopnoqn.supabase.co";
const SUPABASE_KEY = "sb_publishable_RIsXDzgjLa6hE3_AFIBzzQ_tUXn9nPR";

const ROOM = "cursors";
const SEND_MS = 50;          // throttle cursor broadcasts (~20/sec)
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

  // ---- DOM scaffolding ---------------------------------------------------
  const layer = document.createElement("div");
  layer.id = "cursor-layer";
  document.body.appendChild(layer);

  // My own cursor-chat input (only I see this; others see the broadcast text).
  const chatBox = document.createElement("div");
  chatBox.id = "my-chat";
  chatBox.hidden = true;
  chatBox.innerHTML = `<span class="chat-caret" style="background:${me.color}"></span>
    <input maxlength="80" placeholder="Say something…" aria-label="Cursor chat">`;
  document.body.appendChild(chatBox);
  const chatInput = chatBox.querySelector("input");

  // Reaction dock + viewer count.
  const dock = document.createElement("div");
  dock.id = "presence-dock";
  dock.innerHTML =
    `<div class="pd-picker" hidden>${PICKER.map((e) =>
       `<button data-emoji="${e}">${e}</button>`).join("")}</div>
     <button class="pd-current" title="Tap to choose · hold or press space to spray">${EMOJIS[0]}</button>
     <div class="pd-tip">Press <kbd>space</kbd> to spray</div>`;
  document.body.appendChild(dock);

  // Reveal the tip briefly on load, then leave it hover-only. Touch devices get
  // a tap hint instead of the spacebar one.
  const tip = dock.querySelector(".pd-tip");
  const isTouch = matchMedia("(hover: none)").matches;
  if (isTouch) tip.innerHTML = "Tap to react · hold for emojis";
  tip.classList.add("show");
  setTimeout(() => tip.classList.remove("show"), 4500);

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
  const peers = new Map(); // id -> { el, label, msgEl, x, y, msg, color, name, last }

  function ensurePeer(id, color, name) {
    let p = peers.get(id);
    if (p) return p;
    const el = document.createElement("div");
    el.className = "rc";
    el.innerHTML = `${cursorSVG(color)}
      <div class="rc-label" style="background:${color}">${escapeHtml(name)}</div>
      <div class="rc-msg" style="--c:${color}" hidden></div>`;
    layer.appendChild(el);
    p = { el, label: el.querySelector(".rc-label"), msgEl: el.querySelector(".rc-msg"),
          x: 0, y: 0, msg: "", color, name, last: performance.now() };
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
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    realtime: { params: { eventsPerSecond: 25 } },
  });

  const channel = supabase.channel(ROOM, {
    config: { broadcast: { self: false }, presence: { key: me.id } },
  });

  channel
    .on("broadcast", { event: "cursor" }, ({ payload }) => {
      if (payload.id === me.id) return;
      const p = ensurePeer(payload.id, payload.color, payload.name);
      p.x = payload.x; p.y = payload.y; p.last = performance.now();
      if (payload.name && payload.name !== p.name) {
        p.name = payload.name; p.label.textContent = payload.name;
      }
      const msg = payload.msg || "";
      if (msg !== p.msg) {
        p.msg = msg;
        p.msgEl.textContent = msg;
        p.msgEl.hidden = !msg;
      }
    })
    .on("broadcast", { event: "emote" }, ({ payload }) => {
      if (payload.id === me.id) return;
      const s = worldToScreen(payload.x, payload.y);
      spawnEmote(payload.emoji, s.x, s.y);
    })
    .on("broadcast", { event: "leave" }, ({ payload }) => dropPeer(payload.id))
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ id: me.id, name: me.name, color: me.color });
      }
    });

  // ---- local cursor capture + throttled send -----------------------------
  let lastX = 0, lastY = 0, dirty = false, hasPos = false;
  let liveMsg = "";

  addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return; // touch has no hover cursor
    const w = screenToWorld(e.clientX, e.clientY);
    lastX = w.x; lastY = w.y; dirty = true; hasPos = true;
    if (!chatBox.hidden) positionChat(e.clientX, e.clientY);
  }, { passive: true });

  addEventListener("pointerout", (e) => {
    if (!e.relatedTarget && !e.toElement) {
      channel.send({ type: "broadcast", event: "leave", payload: { id: me.id } });
    }
  });

  setInterval(() => {
    if (!dirty || !hasPos) return;
    dirty = false;
    channel.send({
      type: "broadcast", event: "cursor",
      payload: { id: me.id, name: me.name, color: me.color, x: lastX, y: lastY, msg: liveMsg },
    });
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
    channel.send({ type: "broadcast", event: "emote",
      payload: { id: me.id, emoji, x: wx, y: wy } });
  }

  // A satisfying little burst for a single tap.
  function fireBurst(emoji, n = 4) {
    fireEmote(emoji, 0);
    let i = 1;
    const t = setInterval(() => { fireEmote(emoji, 60); if (++i >= n) clearInterval(t); }, 70);
  }

  // Hold to spray a fountain of emojis; tap = a single one. This sprays the
  // given emoji *temporarily* — it never changes the chosen button emoji
  // (only the picker does that), so the 1-8 keys are throwaway quick-fires.
  let sprayEmoji = currentEmoji;
  function startSpray(emoji) {
    sprayEmoji = emoji;
    if (sprayTimer) return;
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
  const setPicker = (open) => {
    picker.hidden = !open;
    currentBtn.classList.toggle("open", open);
    if (open) tip.classList.remove("show");
  };
  let holdTimer = null, didHold = false, downTouch = false;

  currentBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    didHold = false;
    downTouch = e.pointerType === "touch";
    if (downTouch) {
      // touch: tap sprays, long-press opens the picker
      holdTimer = setTimeout(() => { didHold = true; setPicker(true); }, 350);
    } else {
      // mouse: tap opens picker, hold sprays
      holdTimer = setTimeout(() => { didHold = true; startSpray(currentEmoji); }, 180);
    }
  });
  currentBtn.addEventListener("pointerup", () => {
    clearTimeout(holdTimer);
    if (downTouch) {
      if (!didHold) fireBurst(currentEmoji);   // a tap spits out a few emojis
    } else if (didHold) {
      stopSpray();
    } else {
      setPicker(picker.hidden);                // a tap toggles the picker
    }
  });

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

  // ---- cursor chat (press "/") ------------------------------------------
  function openChat() {
    chatBox.hidden = false;
    chatInput.value = "";
    liveMsg = "";
    positionChat(toScreenX(lastX), toScreenY(lastY));
    chatInput.focus();
  }
  function closeChat(send) {
    chatBox.hidden = true;
    liveMsg = ""; dirty = true;          // clear my bubble for everyone
    chatInput.blur();
  }
  function positionChat(cx, cy) {
    chatBox.style.transform = `translate(${cx + 18}px, ${cy + 6}px)`;
  }
  const toScreenX = (wx) => worldToScreen(wx, 0).x;
  const toScreenY = (wy) => worldToScreen(0, wy).y;

  // any key that started a spray, so the matching keyup stops it
  let sprayKey = null;

  addEventListener("keydown", (e) => {
    const typingElsewhere = /^(input|textarea|select)$/i.test(e.target.tagName)
      && e.target !== chatInput;
    if (typingElsewhere) return;

    if (chatBox.hidden) {
      if (e.key === "/") { e.preventDefault(); openChat(); return; }
      // Spacebar sprays the currently-selected emoji (hold = fountain).
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();                  // don't scroll / activate buttons
        if (!e.repeat) { startSpray(currentEmoji); sprayKey = " "; }
        return;
      }
      if (e.repeat) return;                  // we run our own spray interval
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 8) { startSpray(EMOJIS[n - 1]); sprayKey = e.key; }
      return;
    }
    // chat is open
    if (e.key === "Escape") { closeChat(false); }
    else if (e.key === "Enter") { closeChat(true); }
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

  chatInput.addEventListener("input", () => {
    liveMsg = chatInput.value.slice(0, 80);
    dirty = true; // push the live text on the next cursor tick
  });

  addEventListener("beforeunload", () => {
    try { channel.send({ type: "broadcast", event: "leave", payload: { id: me.id } }); } catch {}
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
