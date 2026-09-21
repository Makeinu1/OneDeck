import assert from "node:assert/strict";
import { test } from "node:test";

import { isOneDeckRequest } from "../src/onedeck-profile.ts";

const request = (path, init = {}) => new Request(`https://worker.example${path}`, init);

test("allows the health root and TURN credential preflight/read", () => {
  assert.equal(isOneDeckRequest(request("/")), true);
  assert.equal(isOneDeckRequest(request("/turn-credentials")), true);
  assert.equal(isOneDeckRequest(request("/turn-credentials", { method: "OPTIONS" })), true);
});

test("allows only the WebSocket lobby path", () => {
  assert.equal(
    isOneDeckRequest(request("/ws", { headers: { Upgrade: "websocket" } })),
    true,
  );
  assert.equal(
    isOneDeckRequest(
      request("/ws", {
        headers: { Upgrade: "websocket", Origin: "https://onedeck-play.pages.dev" },
      }),
      "https://onedeck-play.pages.dev",
    ),
    true,
  );
  assert.equal(
    isOneDeckRequest(
      request("/ws", {
        headers: { Upgrade: "websocket", Origin: "https://evil.example" },
      }),
      "https://onedeck-play.pages.dev",
    ),
    false,
  );
  assert.equal(
    isOneDeckRequest(
      request("/ws", { headers: { Upgrade: "websocket" } }),
      "https://onedeck-play.pages.dev",
    ),
    false,
  );
  assert.equal(
    isOneDeckRequest(
      request("/signal/phase2-ABCDE", {
        headers: { Upgrade: "websocket", Origin: "https://onedeck-play.pages.dev" },
      }),
      "https://onedeck-play.pages.dev",
    ),
    true,
  );
  assert.equal(isOneDeckRequest(request("/ws")), false);
  assert.equal(
    isOneDeckRequest(request("/ws", { method: "POST", headers: { Upgrade: "websocket" } })),
    false,
  );
});

test("rejects import, telemetry, and directory surfaces", () => {
  for (const path of [
    "/import-deck",
    "/telemetry",
    "/servers",
    "/servers/announce",
    "/servers/metrics",
    "/stats",
    "/signal",
    "/signal/a/b",
    `/signal/${"a".repeat(129)}`,
    "/signal/invalid!",
    "/other",
  ]) {
    assert.equal(isOneDeckRequest(request(path)), false, path);
  }
  assert.equal(isOneDeckRequest(request("/turn-credentials", { method: "POST" })), false);
});
