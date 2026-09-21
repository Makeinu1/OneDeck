import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_LIMITS,
  evaluateFeasibility,
  parseWasmMemory,
  summarizeAsset,
} from "../../scripts/probe-onedeck-authority.mjs";

function wasmWithMemory(initialPages, maximumPages = null) {
  const limits = maximumPages === null ? [0x00, initialPages] : [0x01, initialPages, maximumPages];
  return Uint8Array.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    0x05,
    limits.length + 1,
    0x01,
    ...limits,
  ]);
}

test("parseWasmMemory reads initial and maximum pages", () => {
  assert.deepEqual(parseWasmMemory(wasmWithMemory(3, 8)), {
    initialPages: 3,
    maximumPages: 8,
    initialBytes: 3 * 65536,
    maximumBytes: 8 * 65536,
    shared: false,
    memory64: false,
  });
});

test("summarizeAsset produces stable gzip sizes", () => {
  const bytes = Buffer.from("onedeck-stage2-a");
  const first = summarizeAsset("fixture", bytes);
  const second = summarizeAsset("fixture", bytes);
  assert.deepEqual(second, first);
  assert.equal(first.rawBytes, bytes.byteLength);
  assert.ok(first.gzipBytes > 0);
});

test("evaluateFeasibility distinguishes a pass from Cloudflare stop conditions", () => {
  const base = {
    assets: {
      cardData: { rawBytes: 1000 },
      engineWasm: { rawBytes: 1000 },
    },
    engine: { memory: { initialBytes: 65536 } },
    runtime: {
      available: true,
      state: { name: "state", rawBytes: 1000 },
    },
  };
  assert.equal(evaluateFeasibility(base).status, "pass");

  const oversizedState = structuredClone(base);
  oversizedState.runtime.state.rawBytes = DEFAULT_LIMITS.durableObjectValueBytes + 1;
  const stateResult = evaluateFeasibility(oversizedState);
  assert.equal(stateResult.status, "fail");
  assert.match(stateResult.blockers[0], /state is/);

  const oversizedCorpus = structuredClone(base);
  oversizedCorpus.assets.cardData.rawBytes = DEFAULT_LIMITS.workerMemoryBytes;
  const corpusResult = evaluateFeasibility(oversizedCorpus);
  assert.equal(corpusResult.status, "fail");
  assert.match(corpusResult.blockers.join(" "), /estimated resident input/);
});
