// Cloudflare Worker + Durable Object: ephemeral live-cursor / emoji relay.
//
// This is the same architecture PartyKit runs under the hood (one Durable Object
// instance per room, fanning WebSocket messages out to everyone else), but
// deployed to our OWN Cloudflare account so we don't depend on PartyKit's shared
// (and now full) platform. Nothing is persisted — every message is fire-and-
// forget. Free on the Workers plan: a SQLite-backed DO with WebSocket
// hibernation, so idle rooms cost nothing.
//
// Deploy:  npm run cursors:deploy   (prints the workers.dev URL)
// Dev:     npm run cursors:dev      (serves at ws://localhost:8787)

export default {
  async fetch(request, env) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    // One DO instance per room name (?room=cursors). idFromName is deterministic,
    // so every visitor of the same room lands on the same object.
    const room = new URL(request.url).searchParams.get("room") || "cursors";
    const id = env.CURSORS.idFromName(room);
    return env.CURSORS.get(id).fetch(request);
  },
};

export class CursorsRoom {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    // The client's stable per-browser id, stored as the socket's tag so we can
    // name it in "leave" messages after it disconnects.
    const cid = new URL(request.url).searchParams.get("id") || crypto.randomUUID();

    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernation API: the runtime owns the socket; the DO can evict from memory
    // between messages without dropping connections.
    this.state.acceptWebSocket(server, [cid]);

    this.broadcastCount();
    return new Response(null, { status: 101, webSocket: client });
  }

  // Relay each cursor/emote/leave message verbatim to everyone except the sender.
  webSocketMessage(ws, message) {
    for (const peer of this.state.getWebSockets()) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) peer.send(message);
    }
  }

  webSocketClose(ws) {
    this.onGone(ws);
  }

  webSocketError(ws) {
    this.onGone(ws);
  }

  // A socket dropped — drop its cursor on every other client and resync the count.
  onGone(ws) {
    const cid = this.idOf(ws);
    if (cid) this.broadcast(JSON.stringify({ type: "leave", id: cid }), ws);
    this.broadcastCount(ws);
  }

  idOf(ws) {
    const tags = this.state.getTags(ws);
    return tags && tags[0];
  }

  broadcast(str, exclude) {
    for (const peer of this.state.getWebSockets()) {
      if (peer !== exclude && peer.readyState === WebSocket.OPEN) peer.send(str);
    }
  }

  // exclude is the socket that's leaving (when called from onGone) so it isn't
  // counted — getWebSockets() may still include a socket mid-close.
  broadcastCount(exclude) {
    const n = this.state.getWebSockets().filter((w) => w !== exclude).length;
    this.broadcast(JSON.stringify({ type: "count", n }), exclude);
  }
}
