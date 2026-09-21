import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NativeDataConnection, NativePeer } from "../nativeSignaling";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readonly sent: string[] = [];
  readonly url: string;
  readyState = 0;

  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  binaryType = "arraybuffer";
  readonly sent: unknown[] = [];

  send(value: unknown): void {
    this.sent.push(value);
  }

  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  message(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];
  readonly channels: FakeDataChannel[] = [];
  readonly addedCandidates: RTCIceCandidateInit[] = [];
  readonly createOffer = vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" }));
  readonly createAnswer = vi.fn(async () => ({ type: "answer", sdp: "answer-sdp" }));
  readonly setLocalDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {});
  readonly setRemoteDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {});
  readonly addIceCandidate = vi.fn(async (candidate: RTCIceCandidateInit) => {
    this.addedCandidates.push(candidate);
  });
  connectionState: RTCPeerConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  iceConnectionState: RTCIceConnectionState = "new";
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;

  constructor(_configuration?: RTCConfiguration) {
    super();
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(_label: string, _options?: RTCDataChannelInit): RTCDataChannel {
    const channel = new FakeDataChannel();
    this.channels.push(channel);
    return channel as unknown as RTCDataChannel;
  }

  close(): void {
    this.connectionState = "closed";
  }

  emitDataChannel(channel: FakeDataChannel): void {
    this.ondatachannel?.({ channel } as unknown as RTCDataChannelEvent);
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function makePeer(role: "host" | "guest", id: string, hostPeerId = "host-id"): NativePeer {
  return new NativePeer({
    id,
    role,
    hostPeerId,
    config: {},
    signalingBaseUrl: "https://worker.example/signal",
  });
}

beforeEach(() => {
  FakeSocket.instances = [];
  FakePeerConnection.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NativePeer", () => {
  it("surfaces a pre-open signaling failure without an unhandled rejection", async () => {
    const guest = makePeer("guest", "guest-failure-id");
    const socket = FakeSocket.instances[0];
    const onError = vi.fn();
    guest.on("error", onError);
    socket.dispatchEvent(new Event("error"));
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    guest.destroy();
  });

  it("dials guest to host, applies queued ICE, and reconnects with a new connection id", async () => {
    const guest = makePeer("guest", "guest-id");
    const socket = FakeSocket.instances[0];
    socket.open();
    await flush();

    const first = guest.connect("host-id", { reliable: true });
    await flush();
    const firstOffer = JSON.parse(socket.sent.find((value) => JSON.parse(value).type === "offer")!);
    expect(socket.url).toContain("/signal/host-id?peer=guest-id&role=guest");
    expect(firstOffer).toMatchObject({ type: "offer", connectionId: expect.any(String), sdp: "offer-sdp" });

    const candidate = { candidate: "candidate:guest" };
    socket.message(JSON.stringify({ type: "ice", connectionId: firstOffer.connectionId, candidate }));
    socket.message(JSON.stringify({ type: "answer", connectionId: firstOffer.connectionId, sdp: "answer-sdp" }));
    await flush();
    expect(FakePeerConnection.instances[0].addedCandidates).toEqual([candidate]);
    const firstOpen = vi.fn();
    first.on("open", firstOpen);
    FakePeerConnection.instances[0].channels[0].open();
    expect(first.open).toBe(true);
    expect(firstOpen).toHaveBeenCalledTimes(1);

    const remote = new NativeDataConnection("guest-id", "remote-dc", new FakePeerConnection() as unknown as RTCPeerConnection);
    const remoteChannel = new FakeDataChannel();
    const received = vi.fn();
    remote.on("data", received);
    remote.bindDataChannel(remoteChannel as unknown as RTCDataChannel);
    remoteChannel.open();
    const largePayload = new Uint8Array(50_123).map((_value, index) => index % 251);
    const senderChannel = FakePeerConnection.instances[0].channels[0];
    senderChannel.sent.length = 0;
    first.send(largePayload);
    expect(senderChannel.sent.length).toBeGreaterThan(1);
    expect(senderChannel.sent.every((frame) => (frame as Uint8Array).byteLength <= 16_300)).toBe(true);
    for (const frame of senderChannel.sent) remoteChannel.message(frame);
    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0][0]).toEqual(largePayload);
    remote.close();

    first.close();
    expect(socket.sent.map((value) => JSON.parse(value)).some((value) => value.type === "close" && value.connectionId === firstOffer.connectionId)).toBe(true);

    const second = guest.connect("host-id", { reliable: true });
    await flush();
    const offers = socket.sent.map((value) => JSON.parse(value)).filter((value) => value.type === "offer");
    const secondOffer = offers[offers.length - 1]!;
    expect(secondOffer.connectionId).not.toBe(firstOffer.connectionId);
    socket.message(JSON.stringify({ type: "answer", connectionId: secondOffer.connectionId, sdp: "answer-sdp" }));
    await flush();
    const secondPeerConnection = FakePeerConnection.instances[FakePeerConnection.instances.length - 1]!;
    secondPeerConnection.channels[0].open();
    expect(second.open).toBe(true);
    guest.destroy();
  });

  it("receives a guest offer, emits one connection, and answers it", async () => {
    const host = makePeer("host", "host-id");
    const socket = FakeSocket.instances[0];
    const onConnection = vi.fn();
    host.on("connection", onConnection);
    socket.open();
    await flush();

    socket.message(JSON.stringify({
      type: "offer",
      connectionId: "dc_guest01",
      sdp: "offer-sdp",
      peer: "guest-id",
    }));
    await flush();
    expect(onConnection).toHaveBeenCalledTimes(1);
    const connection = onConnection.mock.calls[0][0] as { peer: string; open: boolean; on: (event: string, handler: () => void) => void };
    expect(connection.peer).toBe("guest-id");
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "answer", connectionId: "dc_guest01", sdp: "answer-sdp" });

    const channel = new FakeDataChannel();
    const opened = vi.fn();
    connection.on("open", opened);
    FakePeerConnection.instances[0].emitDataChannel(channel);
    channel.open();
    expect(connection.open).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
    host.destroy();
  });
});
