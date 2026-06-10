// Results entry page. Loads seed + saved results, renders editable rows,
// POSTs the whole results/overrides object back to the function.

let seed, saved = { results: {}, overrides: {} };

const STAGES = [
  ["group", "Group stage"], ["r32", "Round of 32"], ["r16", "Round of 16"],
  ["qf", "Quarter-finals"], ["sf", "Semi-finals"], ["third", "Third place"], ["final", "Final"],
];

const $ = (s, el = document) => el.querySelector(s);

const fmt = (iso) =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .format(new Date(iso));

const flag = (code) => {
  const f = seed.teams[code]?.flag;
  return f ? `<img class="flag" src="https://flagcdn.com/w40/${f}.png" alt="">` : "";
};

function teamSelect(matchId, side, current) {
  const opts = Object.entries(seed.teams)
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .map(([code, t]) => `<option value="${code}" ${current === code ? "selected" : ""}>${t.name}</option>`)
    .join("");
  return `<select data-ov="${matchId}:${side}"><option value="">auto</option>${opts}</select>`;
}

function rowHTML(m) {
  const r = saved.results[m.id] ?? {};
  const ov = saved.overrides[m.id] ?? {};
  const ko = m.stage !== "group";
  const label = (slot) => ko
    ? `<span class="slot">${slot}</span> ${teamSelect(m.id, slot === m.home ? "home" : "away", slot === m.home ? ov.home : ov.away)}`
    : `${flag(slot)} <b>${seed.teams[slot].name}</b>`;
  const num = (side, val) =>
    `<input type="number" min="0" max="99" inputmode="numeric" data-score="${m.id}:${side}" value="${val ?? ""}">`;
  return `
  <div class="row" data-match="${m.id}">
    <span class="mid">${m.stage === "group" ? m.id : "M" + m.id}</span>
    <span class="when">${fmt(m.kickoff)}<br><span class="city">${m.city}</span></span>
    <span class="team home">${label(m.home)}</span>
    <span class="scores">
      ${num("hs", r.hs)} – ${num("as", r.as)}
      ${ko ? `<span class="pens-in">pens ${num("hp", r.hp)} – ${num("ap", r.ap)}</span>` : ""}
    </span>
    <span class="team away">${label(m.away)}</span>
    <label class="live-toggle"><input type="checkbox" data-live="${m.id}" ${r.status === "LIVE" ? "checked" : ""}>live</label>
  </div>`;
}

function render() {
  const main = $("#main");
  main.innerHTML = STAGES.map(([stage, title]) => {
    const matches = seed.matches.filter((m) => m.stage === stage);
    const groups = stage === "group"
      ? Object.keys(seed.groups).map((g) => `
          <details ${anyResult(g) ? "open" : ""}>
            <summary>Group ${g}</summary>
            ${matches.filter((m) => m.group === g).map(rowHTML).join("")}
          </details>`).join("")
      : matches.map(rowHTML).join("");
    return `<section><h2>${title}</h2>${groups}</section>`;
  }).join("");
}

const anyResult = (g) =>
  seed.matches.some((m) => m.group === g && saved.results[m.id]?.hs != null);

function collect() {
  const results = {};
  for (const input of document.querySelectorAll("[data-score]")) {
    const [id, key] = input.dataset.score.split(":");
    if (input.value === "") continue;
    (results[id] ??= {})[key] = Number(input.value);
  }
  for (const box of document.querySelectorAll("[data-live]")) {
    const id = box.dataset.live;
    if (results[id]) results[id].status = box.checked ? "LIVE" : "FT";
  }
  // drop half-entered scores
  for (const [id, r] of Object.entries(results)) {
    if (r.hs == null || r.as == null) delete results[id];
  }
  const overrides = {};
  for (const sel of document.querySelectorAll("[data-ov]")) {
    const [id, side] = sel.dataset.ov.split(":");
    if (sel.value) (overrides[id] ??= {})[side] = sel.value;
  }
  return { results, overrides };
}

function toast(msg, ok = true) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast ${ok ? "ok" : "err"}`;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), 3500);
}

async function save() {
  const token = $("#token").value.trim();
  if (!token) return toast("Enter the admin token first", false);
  localStorage.setItem("wc-admin-token", token);
  const body = collect();
  const res = await fetch("/api/results", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": token },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (res?.ok) {
    saved = body;
    toast(`Saved ${Object.keys(body.results).length} results ✓`);
  } else {
    toast(res?.status === 401 ? "Wrong token" : "Save failed — is the function deployed?", false);
  }
}

(async function boot() {
  seed = await (await fetch("/data/seed.json")).json();
  try {
    const res = await fetch("/api/results");
    if (res.ok) {
      const data = await res.json();
      saved = { results: data.results ?? {}, overrides: data.overrides ?? {} };
    }
  } catch { /* fresh deploy, nothing saved yet */ }
  $("#token").value = localStorage.getItem("wc-admin-token") ?? "";
  render();
  $("#save").addEventListener("click", save);
})();
