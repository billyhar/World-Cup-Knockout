const LS_KEY = "wc-votes-v1";
const cache = {}; // match_id -> { home, draw, away }
let myVotes = null;

function loadMyVotes() {
  if (myVotes) return;
  try { myVotes = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}"); }
  catch { myVotes = {}; }
}

function saveMyVotes() {
  localStorage.setItem(LS_KEY, JSON.stringify(myVotes));
}

export async function loadPredictions() {
  loadMyVotes();
  try {
    const res = await fetch("/api/predictions");
    if (!res.ok) return;
    Object.assign(cache, await res.json());
  } catch {}
}

export function getPrediction(matchId) {
  return cache[matchId] ?? null;
}

export function getMyVote(matchId) {
  loadMyVotes();
  return myVotes[String(matchId)] ?? null;
}

export async function castVote(matchId, choice) {
  loadMyVotes();
  if (myVotes[String(matchId)]) return { error: "already_voted" };

  try {
    const res = await fetch("/api/predictions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ match_id: matchId, choice }),
    });
    const data = await res.json();
    if (res.ok && !data.error) {
      cache[matchId] = { home: data.home, draw: data.draw, away: data.away };
      myVotes[String(matchId)] = choice;
      saveMyVotes();
    }
    return data;
  } catch (err) {
    return { error: String(err) };
  }
}
