/**
 * Ephemeral WebRTC signaling rendezvous for the OneDeck profile.
 *
 * A Durable Object is selected by the host peer id. The object relays only
 * SDP/ICE envelopes between the host browser and guests and never persists a
 * snapshot. Once the RTCDataChannel opens, game bytes bypass this object.
 */

const MAX_SIGNAL_BYTES = 64 * 1024;
const CONNECTION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/u;
const PEER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/u;

type SignalType = "offer" | "answer" | "ice" | "close";

interface SignalMessage {
  type: SignalType;
  connectionId: string;
  sdp?: string;
  candidate?: Record<string, unknown>;
}

interface SignalPeer {
  role: "host" | "guest";
  peerId: string;
  socket: WebSocket;
}

interface SignalRoute {
  host?: SignalPeer;
  guest?: SignalPeer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function canonicalIceCandidate(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.candidate !== "string") return null;
  const candidate: Record<string, unknown> = { candidate: value.candidate };
  if (typeof value.sdpMid === "string" || value.sdpMid === null) candidate.sdpMid = value.sdpMid;
  if (typeof value.sdpMLineIndex === "number" || value.sdpMLineIndex === null) {
    candidate.sdpMLineIndex = value.sdpMLineIndex;
  }
  if (typeof value.usernameFragment === "string" || value.usernameFragment === null) {
    candidate.usernameFragment = value.usernameFragment;
  }
  return candidate;
}

export function parseSignalMessage(raw: unknown): SignalMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_SIGNAL_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isRecord(value)) return null;
  const type = value.type;
  const connectionId = value.connectionId;
  if (
    (type !== "offer" && type !== "answer" && type !== "ice" && type !== "close")
    || typeof connectionId !== "string"
    || !CONNECTION_ID_RE.test(connectionId)
  ) return null;
  if (type === "offer" || type === "answer") {
    if (typeof value.sdp !== "string" || value.sdp.length > MAX_SIGNAL_BYTES) return null;
    return { type, connectionId, sdp: value.sdp };
  }
  if (type === "ice") {
    const candidate = canonicalIceCandidate(value.candidate);
    return candidate ? { type, connectionId, candidate } : null;
  }
  return { type, connectionId };
}

function send(socket: WebSocket | undefined, message: Record<string, unknown>): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try { socket.send(JSON.stringify(message)); } catch { /* peer may have closed concurrently */ }
}

export class SignalDO {
  private readonly sockets = new Map<WebSocket, SignalPeer>();
  private readonly routes = new Map<string, SignalRoute>();
  private host: SignalPeer | null = null;
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
    // No state.storage usage is intentional: signaling is ephemeral and game
    // payloads must never become a Durable Object snapshot.
    void state;
  }

  fetch(request: Request): Response {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Not found", { status: 404 });
    }
    const url = new URL(request.url);
    const peerId = url.searchParams.get("peer");
    const role = url.searchParams.get("role");
    if (!peerId || !PEER_ID_RE.test(peerId) || (role !== "host" && role !== "guest")) {
      return new Response("Bad signaling request", { status: 400 });
    }

    if (role === "host" && this.host) {
      return new Response("Host already registered", { status: 409 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const peer: SignalPeer = { role, peerId, socket: server };
    this.sockets.set(server, peer);

    if (role === "host") {
      this.host = peer;
    }

    server.addEventListener("message", (event) => this.onMessage(peer, event.data));
    server.addEventListener("close", () => this.closePeer(peer, 1000, "Socket closed", false));
    server.addEventListener("error", () => this.closePeer(peer, 1011, "Socket error", false));
    send(server, { type: "ready" });
    return new Response(null, { status: 101, webSocket: client });
  }

  private onMessage(sender: SignalPeer, raw: unknown): void {
    const message = parseSignalMessage(raw);
    if (!message) {
      this.closePeer(sender, 1003, "Invalid signaling frame");
      return;
    }
    const route = this.routes.get(message.connectionId);
    if (message.type === "close") {
      const owner = sender.role === "guest" ? route?.guest : route?.host;
      if (!owner || owner.socket !== sender.socket) return;
      const target = sender.role === "guest" ? route?.host : route?.guest;
      send(target?.socket, message);
      this.routes.delete(message.connectionId);
      return;
    }
    if (sender.role === "guest") {
      if (message.type !== "offer" && message.type !== "ice" && message.type !== "close") {
        this.closePeer(sender, 1008, "Guest frame not allowed");
        return;
      }
      if (message.type === "offer") {
        if (route && route.guest?.socket !== sender.socket) return;
        if (!this.host) {
          // Do not retain an orphaned guest route while the host is offline.
          // The guest's existing reconnect loop will establish a fresh offer
          // after the host claims the room again.
          send(sender.socket, { type: "close", connectionId: message.connectionId });
          return;
        }
        const nextRoute = route ?? { guest: sender, host: this.host };
        nextRoute.guest = sender;
        // Bind the host-side lookup before forwarding the first offer. The
        // host's answer and ICE candidates then use the same opaque id.
        nextRoute.host = this.host;
        this.routes.set(message.connectionId, nextRoute);
        send(nextRoute.host.socket, { ...message, peer: sender.peerId });
        return;
      }
      if (!route?.guest || route.guest.socket !== sender.socket) return;
      send(route.host?.socket, { ...message, peer: sender.peerId });
      return;
    }

    // Host answers/ICE/close are routed only to the guest that introduced the
    // connection id. A host cannot inject game payloads because this object
    // accepts only the small signaling union above.
    if (message.type === "offer") {
      this.closePeer(sender, 1008, "Host offer not allowed");
      return;
    }
    if (!route?.guest || route.host?.socket !== sender.socket) return;
    send(route.guest.socket, message as unknown as Record<string, unknown>);
  }

  private closePeer(peer: SignalPeer, code: number, reason: string, notify = true): void {
    if (!this.sockets.has(peer.socket)) return;
    this.sockets.delete(peer.socket);
    if (this.host?.socket === peer.socket) this.host = null;
    for (const [connectionId, route] of this.routes) {
      if (route.host?.socket === peer.socket) {
        if (notify) send(route.guest?.socket, { type: "close", connectionId });
        route.host = undefined;
      }
      if (route.guest?.socket === peer.socket) {
        if (notify) send(route.host?.socket, { type: "close", connectionId });
        route.guest = undefined;
      }
      if (!route.host && !route.guest) this.routes.delete(connectionId);
    }
    try { peer.socket.close(code, reason); } catch { /* best effort */ }
  }
}
