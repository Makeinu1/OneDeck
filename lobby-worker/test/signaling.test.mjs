import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSignalMessage } from "../src/signaling-do.ts";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeSocket.OPEN;
  sent = [];
  accept() {}
  send(value) { this.sent.push(value); }
  close() { this.readyState = FakeSocket.CLOSED; }
}

const pairs = [];
globalThis.WebSocket = FakeSocket;
globalThis.WebSocketPair = class {
  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
    pairs.push(this);
  }
};
globalThis.Response = class {
  constructor(_body, init = {}) {
    this.status = init.status ?? 200;
    this.webSocket = init.webSocket;
  }
};

const { SignalDO } = await import("../src/signaling-do.ts");

test("accepts only bounded SDP/ICE signaling envelopes", () => {
  const offer = parseSignalMessage(JSON.stringify({
    type: "offer",
    connectionId: "dc_12345678",
    sdp: "v=0",
    gameState: "must-not-forward",
  }));
  assert.deepEqual(offer, { type: "offer", connectionId: "dc_12345678", sdp: "v=0" });
  const ice = parseSignalMessage(JSON.stringify({
    type: "ice",
    connectionId: "dc_12345678",
    candidate: {
      candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
      secret: "must-not-forward",
    },
    savedState: "must-not-forward",
  }));
  assert.deepEqual(ice, {
    type: "ice",
    connectionId: "dc_12345678",
    candidate: {
      candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    },
  });
});

test("rejects game payloads, malformed ids, and oversized frames", () => {
  assert.equal(parseSignalMessage(JSON.stringify({ type: "game_action", payload: "secret" })), null);
  assert.equal(parseSignalMessage(JSON.stringify({ type: "offer", connectionId: "short", sdp: "v=0" })), null);
  assert.equal(parseSignalMessage(JSON.stringify({
    type: "answer",
    connectionId: "dc_12345678",
    sdp: "x".repeat(65 * 1024),
  })), null);
  assert.equal(parseSignalMessage("not-json"), null);
});

test("routes offer/answer to the matching peer and rejects a second host", () => {
  const signal = new SignalDO({});
  const host = signal.fetch(new Request("https://worker.example/signal/phase2-ABCDE?peer=phase2-ABCDE&role=host", {
    headers: { Upgrade: "websocket" },
  }));
  assert.equal(host.status, 101);
  const duplicate = signal.fetch(new Request("https://worker.example/signal/phase2-ABCDE?peer=phase2-OTHER&role=host", {
    headers: { Upgrade: "websocket" },
  }));
  assert.equal(duplicate.status, 409);

  const guest = signal.fetch(new Request("https://worker.example/signal/phase2-ABCDE?peer=phase2-GUEST&role=guest", {
    headers: { Upgrade: "websocket" },
  }));
  assert.equal(guest.status, 101);
  const hostServer = pairs[0][1];
  const guestServer = pairs[1][1];
  guestServer.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({
      type: "offer",
      connectionId: "dc_12345678",
      sdp: "v=0",
      gameState: "must-not-forward",
    }),
  }));
  const forwardedOffer = JSON.parse(hostServer.sent.at(-1));
  assert.equal(forwardedOffer.peer, "phase2-GUEST");
  assert.equal(forwardedOffer.gameState, undefined);
  guestServer.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({
      type: "ice",
      connectionId: "dc_12345678",
      candidate: {
        candidate: "candidate:guest",
        sdpMid: "0",
        sdpMLineIndex: 0,
        savedState: "must-not-forward",
      },
      gameState: "must-not-forward",
    }),
  }));
  const forwardedIce = JSON.parse(hostServer.sent.at(-1));
  assert.equal(forwardedIce.gameState, undefined);
  assert.deepEqual(forwardedIce.candidate, {
    candidate: "candidate:guest",
    sdpMid: "0",
    sdpMLineIndex: 0,
  });
  hostServer.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({ type: "answer", connectionId: "dc_12345678", sdp: "v=0" }),
  }));
  assert.equal(JSON.parse(guestServer.sent.at(-1)).type, "answer");

  guestServer.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({ type: "close", connectionId: "dc_12345678" }),
  }));
  assert.equal(JSON.parse(hostServer.sent.at(-1)).type, "close");
  const guestSentAfterClose = guestServer.sent.length;
  hostServer.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({ type: "answer", connectionId: "dc_12345678", sdp: "stale" }),
  }));
  hostServer.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({
      type: "ice",
      connectionId: "dc_12345678",
      candidate: { candidate: "candidate:stale" },
    }),
  }));
  assert.equal(guestServer.sent.length, guestSentAfterClose);
});

test("closes an orphaned guest offer while the host is offline", () => {
  const signal = new SignalDO({});
  const guest = signal.fetch(new Request("https://worker.example/signal/phase3-ABCDE?peer=phase3-GUEST&role=guest", {
    headers: { Upgrade: "websocket" },
  }));
  assert.equal(guest.status, 101);
  const guestServer = pairs.at(-1)[1];
  guestServer.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({ type: "offer", connectionId: "dc_orphan1", sdp: "v=0" }),
  }));
  assert.equal(JSON.parse(guestServer.sent.at(-1)).type, "close");

  const guestSentAfterClose = guestServer.sent.length;
  const host = signal.fetch(new Request("https://worker.example/signal/phase3-ABCDE?peer=phase3-ABCDE&role=host", {
    headers: { Upgrade: "websocket" },
  }));
  assert.equal(host.status, 101);
  const hostServer = pairs.at(-1)[1];
  hostServer.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({ type: "answer", connectionId: "dc_orphan1", sdp: "stale" }),
  }));
  assert.equal(guestServer.sent.length, guestSentAfterClose);
});
