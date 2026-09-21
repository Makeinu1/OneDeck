/**
 * Small WebRTC transport used by the OneDeck Cloudflare profile.
 *
 * PeerJS is retained for the upstream/default build, but its cloud signaling
 * endpoint is not an acceptable dependency for a user-owned deployment. This
 * module implements only the DataConnection/Peer surface consumed by the
 * existing host/guest adapters. The signaling Worker sees SDP/ICE metadata;
 * game protocol bytes stay on the encrypted RTCDataChannel.
 */

type PeerEvent = "open" | "connection" | "close" | "disconnected" | "error";
type ConnectionEvent = "open" | "data" | "close" | "error";
type Handler = (...args: any[]) => void;

// PeerJS BinaryPack splits binary messages into <=16,300 byte SCTP frames.
// Keep the native transport's wire contract independent of the browser's
// negotiated max-message-size by applying the same bounded payload size here.
const NATIVE_CHUNK_MAGIC = new Uint8Array([0x4f, 0x44, 0x43, 0x31]);
const NATIVE_CHUNK_HEADER_BYTES = 12;
const NATIVE_CHUNK_PAYLOAD_BYTES = 16_000;
const NATIVE_MAX_CHUNKS = 4_096;
const NATIVE_MAX_REASSEMBLED_BYTES = NATIVE_CHUNK_PAYLOAD_BYTES * NATIVE_MAX_CHUNKS;
const NATIVE_REASSEMBLY_TIMEOUT_MS = 30_000;

interface ChunkAssembly {
  count: number;
  chunks: Array<Uint8Array | undefined>;
  received: number;
  totalBytes: number;
  expires: ReturnType<typeof setTimeout>;
}

function isChunkFrame(bytes: Uint8Array): boolean {
  return bytes.length >= NATIVE_CHUNK_MAGIC.length
    && NATIVE_CHUNK_MAGIC.every((value, index) => bytes[index] === value);
}

export interface NativePeerOptions {
  id: string;
  role: "host" | "guest";
  hostPeerId: string;
  config: RTCConfiguration;
  signalingBaseUrl: string;
}

interface SignalEnvelope {
  type: "offer" | "answer" | "ice" | "close" | "ready";
  connectionId?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

function randomId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}${uuid}`;
  return `${prefix}${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function errorWithType(message: string, type: string): Error & { type: string } {
  return Object.assign(new Error(message), { type });
}

function signalUrl(baseUrl: string, hostPeerId: string, peerId: string, role: NativePeerOptions["role"]): string {
  if (!baseUrl) throw errorWithType("OneDeck signaling URL is not configured", "network");
  const url = new URL(`${baseUrl.replace(/\/$/u, "")}/${encodeURIComponent(hostPeerId)}`);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw errorWithType("OneDeck signaling URL must use HTTP(S) or WS(S)", "network");
  }
  url.searchParams.set("peer", peerId);
  url.searchParams.set("role", role);
  return url.toString();
}

function emit(map: Map<string, Set<Handler>>, event: string, ...args: any[]): void {
  for (const handler of [...(map.get(event) ?? [])]) handler(...args);
}

export class NativeDataConnection {
  readonly peer: string;
  readonly connectionId: string;
  readonly label: string;
  readonly reliable = true;
  readonly serialization = "binary";
  readonly peerConnection: RTCPeerConnection;
  dataChannel: RTCDataChannel | null = null;
  open = false;

  private readonly handlers = new Map<string, Set<Handler>>();
  private closed = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionReady = false;
  private nextChunkMessageId = 1;
  private readonly chunkAssemblies = new Map<number, ChunkAssembly>();

  constructor(peer: string, connectionId: string, peerConnection: RTCPeerConnection, label = "phase") {
    this.peer = peer;
    this.connectionId = connectionId;
    this.label = label;
    this.peerConnection = peerConnection;
    peerConnection.addEventListener("connectionstatechange", () => {
      if (["failed", "closed"].includes(peerConnection.connectionState)) this.close();
    });
  }

  on(event: ConnectionEvent, handler: Handler): this {
    const set = this.handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(event, set);
    return this;
  }

  once(event: ConnectionEvent, handler: Handler): this {
    const once = (...args: any[]) => {
      this.off(event, once);
      handler(...args);
    };
    return this.on(event, once);
  }

  off(event: ConnectionEvent, handler: Handler): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  private dispatch(event: ConnectionEvent, ...args: any[]): void {
    emit(this.handlers, event, ...args);
  }

  bindDataChannel(channel: RTCDataChannel): void {
    if (this.closed) {
      channel.close();
      return;
    }
    this.dataChannel = channel;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("open", () => {
      if (this.closed) return;
      this.open = true;
      this.dispatch("open");
    });
    channel.addEventListener("message", (event) => {
      if (this.closed) return;
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        this.dispatchBinary(new Uint8Array(data));
      } else if (ArrayBuffer.isView(data)) {
        this.dispatchBinary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } else {
        this.dispatch("data", data);
      }
    });
    channel.addEventListener("error", () => this.dispatch("error", errorWithType("Data channel error", "connection-closed")));
    channel.addEventListener("close", () => this.close());
    if (channel.readyState === "open") {
      this.open = true;
      queueMicrotask(() => this.dispatch("open"));
    }
  }

  private dispatchBinary(bytes: Uint8Array): void {
    if (!isChunkFrame(bytes)) {
      this.dispatch("data", bytes);
      return;
    }
    if (bytes.length < NATIVE_CHUNK_HEADER_BYTES) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const messageId = view.getUint32(4);
    const index = view.getUint16(8);
    const count = view.getUint16(10);
    if (count < 2 || count > NATIVE_MAX_CHUNKS || index >= count) return;
    const payload = bytes.slice(NATIVE_CHUNK_HEADER_BYTES);
    let assembly = this.chunkAssemblies.get(messageId);
    if (!assembly) {
      if (this.chunkAssemblies.size >= 32) return;
      assembly = {
        count,
        chunks: Array.from({ length: count }),
        received: 0,
        totalBytes: 0,
        expires: setTimeout(() => this.chunkAssemblies.delete(messageId), NATIVE_REASSEMBLY_TIMEOUT_MS),
      };
      this.chunkAssemblies.set(messageId, assembly);
    }
    if (assembly.count !== count || assembly.chunks[index]) return;
    assembly.chunks[index] = payload;
    assembly.received += 1;
    assembly.totalBytes += payload.byteLength;
    if (assembly.totalBytes > NATIVE_MAX_REASSEMBLED_BYTES) {
      clearTimeout(assembly.expires);
      this.chunkAssemblies.delete(messageId);
      return;
    }
    if (assembly.received !== assembly.count) return;
    const complete = new Uint8Array(assembly.totalBytes);
    let offset = 0;
    for (const chunk of assembly.chunks) {
      if (!chunk) return;
      complete.set(chunk, offset);
      offset += chunk.byteLength;
    }
    clearTimeout(assembly.expires);
    this.chunkAssemblies.delete(messageId);
    this.dispatch("data", complete);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.peerConnection.setRemoteDescription(description);
    this.remoteDescriptionReady = true;
    const pending = this.pendingCandidates.splice(0);
    for (const candidate of pending) await this.peerConnection.addIceCandidate(candidate);
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescriptionReady) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.peerConnection.addIceCandidate(candidate);
  }

  send(data: unknown): void {
    if (!this.open || !this.dataChannel || this.dataChannel.readyState !== "open") {
      throw errorWithType("Connection is closed", "connection-closed");
    }
    if (typeof data === "string") {
      this.dataChannel.send(data);
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (bytes.byteLength <= NATIVE_CHUNK_PAYLOAD_BYTES) {
        this.dataChannel.send(bytes);
        return;
      }
      const count = Math.ceil(bytes.byteLength / NATIVE_CHUNK_PAYLOAD_BYTES);
      if (count > NATIVE_MAX_CHUNKS) throw errorWithType("Data channel payload is too large", "message-too-big");
      const messageId = this.nextChunkMessageId++ >>> 0;
      for (let index = 0; index < count; index += 1) {
        const start = index * NATIVE_CHUNK_PAYLOAD_BYTES;
        const payload = bytes.subarray(start, Math.min(bytes.byteLength, start + NATIVE_CHUNK_PAYLOAD_BYTES));
        const frame = new Uint8Array(NATIVE_CHUNK_HEADER_BYTES + payload.byteLength);
        frame.set(NATIVE_CHUNK_MAGIC, 0);
        const header = new DataView(frame.buffer);
        header.setUint32(4, messageId);
        header.setUint16(8, index);
        header.setUint16(10, count);
        frame.set(payload, NATIVE_CHUNK_HEADER_BYTES);
        this.dataChannel.send(frame);
      }
    } else {
      throw errorWithType("Unsupported data channel payload", "connection-closed");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    for (const assembly of this.chunkAssemblies.values()) clearTimeout(assembly.expires);
    this.chunkAssemblies.clear();
    try { this.dataChannel?.close(); } catch { /* best effort */ }
    try { this.peerConnection.close(); } catch { /* best effort */ }
    this.dispatch("close");
  }
}

export class NativePeer {
  readonly id: string;
  readonly options: { config: RTCConfiguration };
  readonly role: NativePeerOptions["role"];
  open = false;
  disconnected = true;
  destroyed = false;

  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly connections = new Map<string, NativeDataConnection>();
  private readonly hostPeerId: string;
  private readonly signalingBaseUrl: string;
  private readonly config: RTCConfiguration;
  private socket: WebSocket | null = null;
  private openPromise: Promise<void> | null = null;

  constructor(options: NativePeerOptions) {
    this.id = options.id;
    this.role = options.role;
    this.hostPeerId = options.hostPeerId;
    this.signalingBaseUrl = options.signalingBaseUrl;
    this.config = options.config;
    this.options = { config: options.config };
    this.startSignaling();
  }

  on(event: PeerEvent, handler: Handler): this {
    const set = this.handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(event, set);
    return this;
  }

  once(event: PeerEvent, handler: Handler): this {
    const once = (...args: any[]) => {
      this.off(event, once);
      handler(...args);
    };
    return this.on(event, once);
  }

  off(event: PeerEvent, handler: Handler): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  private dispatch(event: PeerEvent, ...args: any[]): void {
    emit(this.handlers, event, ...args);
  }

  private startSignaling(): void {
    void this.connectSignaling().catch(() => {
      // The failure is already surfaced through the peer error/disconnected
      // events. Constructor and reconnect paths are intentionally fire-and-
      // forget, so they must consume the rejected connection promise.
    });
  }

  private trackConnection(connectionId: string, connection: NativeDataConnection): void {
    this.connections.set(connectionId, connection);
    connection.once("close", () => {
      if (this.connections.get(connectionId) !== connection) return;
      this.connections.delete(connectionId);
      this.sendSignal({ type: "close", connectionId });
    });
  }

  private async connectSignaling(): Promise<void> {
    if (this.destroyed) return;
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let socket: WebSocket;
      try {
        socket = new WebSocket(signalUrl(this.signalingBaseUrl, this.hostPeerId, this.id, this.role));
      } catch (error) {
        reject(error);
        this.dispatch("error", error);
        this.openPromise = null;
        return;
      }
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (this.destroyed) return;
        this.open = true;
        this.disconnected = false;
        if (!settled) { settled = true; resolve(); }
        this.dispatch("open", this.id);
      });
      socket.addEventListener("message", (event) => {
        void this.handleSignal(event.data);
      });
      socket.addEventListener("error", () => {
        const error = errorWithType("OneDeck signaling socket failed", "network");
        if (!settled) { settled = true; reject(error); }
        this.dispatch("error", error);
      });
      socket.addEventListener("close", () => {
        this.open = false;
        this.disconnected = true;
        this.socket = null;
        this.openPromise = null;
        if (!this.destroyed) this.dispatch("disconnected", this.id);
        if (!settled) {
          settled = true;
          reject(errorWithType("OneDeck signaling socket closed", "socket-closed"));
        }
      });
    });
    return this.openPromise;
  }

  private sendSignal(message: SignalEnvelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private async handleSignal(raw: unknown): Promise<void> {
    if (typeof raw !== "string") return;
    let message: SignalEnvelope;
    try { message = JSON.parse(raw) as SignalEnvelope; } catch { return; }
    if (!message || typeof message.type !== "string") return;
    const id = message.connectionId;
    if (message.type === "ready") return;
    if (!id) return;
    const connection = this.connections.get(id);
    if (message.type === "offer" && this.role === "host") {
      if (connection) return;
      // The signaling DO binds the connection id to the guest socket. The
      // peer id is carried in the optional `peer` field by the DO.
      const remotePeer = (message as SignalEnvelope & { peer?: string }).peer ?? "unknown";
      const peerConnection = new RTCPeerConnection(this.config);
      const incoming = new NativeDataConnection(remotePeer, id, peerConnection);
      this.trackConnection(id, incoming);
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) this.sendSignal({ type: "ice", connectionId: id, candidate: event.candidate.toJSON() });
      };
      peerConnection.ondatachannel = (event) => incoming.bindDataChannel(event.channel);
      this.dispatch("connection", incoming);
      try {
        await incoming.setRemoteDescription({ type: "offer", sdp: message.sdp ?? "" });
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        this.sendSignal({ type: "answer", connectionId: id, sdp: answer.sdp ?? "" });
      } catch (error) {
        this.connections.delete(id);
        incoming.close();
        this.dispatch("error", errorWithType(`Signaling offer failed: ${String(error)}`, "server-error"));
      }
      return;
    }
    if (message.type === "answer" && this.role === "guest" && connection) {
      try { await connection.setRemoteDescription({ type: "answer", sdp: message.sdp ?? "" }); }
      catch { this.connections.delete(id); connection.close(); }
      return;
    }
    if (message.type === "ice" && connection && message.candidate) {
      try { await connection.addIceCandidate(message.candidate); } catch { /* ICE may race teardown. */ }
      return;
    }
    if (message.type === "close" && connection) {
      this.connections.delete(id);
      connection.close();
    }
  }

  connect(peerId: string, options: { label?: string; reliable?: boolean } = {}): NativeDataConnection {
    if (this.destroyed) throw errorWithType("Peer is destroyed", "disconnected");
    const connectionId = randomId("dc_");
    const peerConnection = new RTCPeerConnection(this.config);
    const connection = new NativeDataConnection(peerId, connectionId, peerConnection, options.label ?? "phase");
    this.trackConnection(connectionId, connection);
    const dataChannel = peerConnection.createDataChannel(connection.label, { ordered: options.reliable !== false });
    connection.bindDataChannel(dataChannel);
    let offerSent = false;
    const pendingIce: RTCIceCandidateInit[] = [];
    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate = event.candidate.toJSON();
      if (!offerSent) pendingIce.push(candidate);
      else this.sendSignal({ type: "ice", connectionId, candidate });
    };
    void this.connectSignaling().then(async () => {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      this.sendSignal({ type: "offer", connectionId, sdp: offer.sdp ?? "" });
      offerSent = true;
      for (const candidate of pendingIce.splice(0)) this.sendSignal({ type: "ice", connectionId, candidate });
    }).catch((error) => {
      this.connections.delete(connectionId);
      connection.close();
      this.dispatch("error", errorWithType(`Signaling offer failed: ${String(error)}`, "server-error"));
    });
    return connection;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const connections = [...this.connections.values()];
    this.connections.clear();
    for (const connection of connections) connection.close();
    try { this.socket?.close(); } catch { /* best effort */ }
    this.socket = null;
    this.open = false;
    this.disconnected = true;
    this.dispatch("close");
  }

  disconnect(): void {
    if (this.destroyed) return;
    try { this.socket?.close(); } catch { /* best effort */ }
  }

  reconnect(): void {
    if (!this.destroyed && this.disconnected) this.startSignaling();
  }
}
