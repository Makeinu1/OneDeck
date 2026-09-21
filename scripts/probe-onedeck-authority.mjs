#!/usr/bin/env node

/**
 * Stage 2-A feasibility probe for a server-authoritative OneDeck session.
 *
 * This is deliberately a measurement tool, not a Worker game runtime.  It
 * reuses the generated engine-WASM glue when the build artifacts are present
 * and otherwise reports the static inputs that are available.
 */

import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_LIMITS = Object.freeze({
  workerMemoryBytes: 128 * 1024 * 1024,
  durableObjectValueBytes: 2 * 1024 * 1024,
  runtimeHeadroomBytes: 16 * 1024 * 1024,
});

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("expected an ArrayBuffer or typed array");
}

/** Read one unsigned LEB128 value without 32-bit bitwise overflow. */
export function readUnsignedLeb128(bytes, start) {
  const input = asBytes(bytes);
  let value = 0;
  let shift = 0;
  let offset = start;

  while (offset < input.length) {
    const byte = input[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
    if (shift > 53) throw new RangeError("WASM integer is too large");
  }

  throw new RangeError("truncated unsigned LEB128 value");
}

/**
 * Read the first wasm32 memory declaration from a binary module.
 * Imported-only memory returns null because its limits live in the import
 * section rather than the module memory section.
 */
export function parseWasmMemory(bytes) {
  const input = asBytes(bytes);
  if (
    input.length < 8 ||
    input[0] !== 0x00 ||
    input[1] !== 0x61 ||
    input[2] !== 0x73 ||
    input[3] !== 0x6d
  ) {
    throw new TypeError("not a WebAssembly binary");
  }

  let offset = 8;
  while (offset < input.length) {
    const sectionId = input[offset++];
    const length = readUnsignedLeb128(input, offset);
    offset = length.offset;
    const end = offset + length.value;
    if (end > input.length) throw new RangeError("truncated WASM section");

    if (sectionId === 5) {
      const count = readUnsignedLeb128(input, offset);
      offset = count.offset;
      if (count.value === 0) return null;

      const flags = readUnsignedLeb128(input, offset);
      offset = flags.offset;
      const initial = readUnsignedLeb128(input, offset);
      offset = initial.offset;
      let maximumPages = null;
      if ((flags.value & 0x01) !== 0) {
        const maximum = readUnsignedLeb128(input, offset);
        maximumPages = maximum.value;
      }

      return {
        initialPages: initial.value,
        maximumPages,
        initialBytes: initial.value * 65536,
        maximumBytes: maximumPages === null ? null : maximumPages * 65536,
        shared: (flags.value & 0x02) !== 0,
        memory64: (flags.value & 0x04) !== 0,
      };
    }

    offset = end;
  }

  return null;
}

export function summarizeAsset(name, bytes) {
  const input = asBytes(bytes);
  const compressed = gzipSync(input, { level: 9, mtime: 0 });
  return {
    name,
    rawBytes: input.byteLength,
    gzipBytes: compressed.byteLength,
    gzipRatio: input.byteLength === 0 ? null : compressed.byteLength / input.byteLength,
  };
}

function cardCount(jsonText) {
  try {
    const value = JSON.parse(jsonText);
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === "object") {
      if (value.data && typeof value.data === "object") return Object.keys(value.data).length;
      return Object.keys(value).length;
    }
  } catch {
    // The engine will report the authoritative parse error during runtime load.
  }
  return null;
}

function stateMeasurements(report) {
  return [report.runtime?.state, report.runtime?.persistedState].filter(Boolean);
}

/**
 * Apply conservative gates to a probe report. The resident-memory estimate is
 * intentionally a heuristic: only a deployed Worker/DO measurement can close
 * the Cloudflare acceptance gate.
 */
export function evaluateFeasibility(report, limits = DEFAULT_LIMITS) {
  const blockers = [];
  const warnings = [];
  const cardBytes = report.assets?.cardData?.rawBytes;
  const engineBytes = report.assets?.engineWasm?.rawBytes;
  const wasmInitialBytes = report.engine?.memory?.initialBytes;

  if (report.engine?.compiled === false) {
    blockers.push(`engine WASM did not compile: ${report.engine.compileError ?? "unknown error"}`);
  }
  if (report.runtime?.error) {
    blockers.push(`runtime probe failed: ${report.runtime.error}`);
  }

  for (const state of stateMeasurements(report)) {
    if (state.rawBytes > limits.durableObjectValueBytes) {
      blockers.push(
        `${state.name} is ${state.rawBytes} bytes (limit ${limits.durableObjectValueBytes})`,
      );
    }
  }

  if (cardBytes !== undefined && engineBytes !== undefined && wasmInitialBytes !== undefined) {
    const estimatedResidentBytes =
      cardBytes * 2 + engineBytes + wasmInitialBytes + limits.runtimeHeadroomBytes;
    report.evaluation = {
      ...(report.evaluation ?? {}),
      estimatedResidentBytes,
    };
    if (estimatedResidentBytes > limits.workerMemoryBytes) {
      blockers.push(
        `estimated resident input is ${estimatedResidentBytes} bytes (limit ${limits.workerMemoryBytes})`,
      );
    }
  } else {
    warnings.push("card data, engine WASM, or declared WASM memory is missing");
  }

  if (report.runtime?.available !== true) {
    warnings.push("generated engine glue is unavailable; runtime measurements are pending");
  }
  if (!report.runtime?.state && !report.runtime?.persistedState) {
    warnings.push("no persisted game-state sample was supplied or exported");
  }

  const status = blockers.length > 0 ? "fail" : warnings.length > 0 ? "inconclusive" : "pass";
  return {
    status,
    blockers,
    warnings,
    limits,
    ...(report.evaluation ?? {}),
  };
}

function parseArgs(argv) {
  const options = { json: false, enforce: false };
  const valueFlags = new Map([
    ["--card-data", "cardDataPath"],
    ["--engine-wasm", "engineWasmPath"],
    ["--engine-glue", "engineGluePath"],
    ["--state", "statePath"],
    ["--action-file", "actionPath"],
    ["--actor", "actor"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--enforce") {
      options.enforce = true;
    } else if (valueFlags.has(arg)) {
      const key = valueFlags.get(arg);
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      options[key] = value;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  return options;
}

async function loadBytes(path, label, report) {
  if (!path) {
    report.missing.push(`${label} path`);
    return null;
  }
  try {
    return await readFile(path);
  } catch (error) {
    report.missing.push(`${label}: ${error.code === "ENOENT" ? "file not found" : error.message}`);
    return null;
  }
}

async function initializeGlue(path, module) {
  const glue = await import(pathToFileURL(resolve(path)).href);
  if (typeof glue.initSync === "function") {
    glue.initSync({ module });
  } else if (typeof glue.default === "function") {
    await glue.default({ module_or_path: module });
  } else {
    throw new Error("generated glue has neither initSync nor default initializer");
  }
  return glue;
}

function elapsedMs(start) {
  return Number((performance.now() - start).toFixed(3));
}

export async function runProbe(options = {}) {
  const report = {
    schemaVersion: 1,
    measurementMode: "static",
    missing: [],
    assets: {},
    engine: {},
    runtime: { available: false },
  };

  const cardBytes = await loadBytes(options.cardDataPath, "card data", report);
  const engineBytes = await loadBytes(options.engineWasmPath, "engine WASM", report);
  let compiledModule = null;
  if (cardBytes) {
    report.assets.cardData = summarizeAsset("card-data.json", cardBytes);
    report.assets.cardData.cardCount = cardCount(cardBytes.toString("utf8"));
  }
  if (engineBytes) {
    report.assets.engineWasm = summarizeAsset("engine_wasm_bg.wasm", engineBytes);
    try {
      report.engine.memory = parseWasmMemory(engineBytes);
    } catch (error) {
      report.engine.memoryError = error.message;
    }

    const compileStart = performance.now();
    try {
      compiledModule = await WebAssembly.compile(engineBytes);
      report.engine.compileMs = elapsedMs(compileStart);
      report.engine.compiled = true;
    } catch (error) {
      report.engine.compiled = false;
      report.engine.compileError = error.message;
    }
  }

  if (options.statePath) {
    const stateBytes = await loadBytes(options.statePath, "state sample", report);
    if (stateBytes) {
      report.runtime.persistedState = summarizeAsset("persisted-state.json", stateBytes);
    }
  }

  if (options.engineGluePath && compiledModule) {
    const runtimeStart = performance.now();
    try {
      const glue = await initializeGlue(options.engineGluePath, compiledModule);
      report.runtime.available = true;
      report.runtime.measurementMs = elapsedMs(runtimeStart);
      report.measurementMode = "runtime";

      if (typeof glue.ping === "function") {
        const pingStart = performance.now();
        glue.ping();
        report.runtime.pingMs = elapsedMs(pingStart);
      }

      if (cardBytes && typeof glue.load_card_database === "function") {
        const beforeRss = process.memoryUsage().rss;
        const loadStart = performance.now();
        const result = glue.load_card_database(cardBytes.toString("utf8"));
        report.runtime.cardDatabase = {
          result,
          loadMs: elapsedMs(loadStart),
          rssDeltaBytes: process.memoryUsage().rss - beforeRss,
        };
      }

      if (typeof glue.initialize_game === "function") {
        const initStart = performance.now();
        const result = glue.initialize_game(null, 42, null, null, 2, 0);
        report.runtime.initialization = {
          resultType: typeof result,
          initMs: elapsedMs(initStart),
        };
      }

      if (typeof glue.export_game_state_json === "function") {
        const stateJson = glue.export_game_state_json();
        const state = Buffer.from(String(stateJson), "utf8");
        report.runtime.state = summarizeAsset("exported-game-state.json", state);
      }

      if (options.actionPath && typeof glue.submit_action === "function") {
        const actionBytes = await loadBytes(options.actionPath, "action sample", report);
        if (actionBytes) {
          const action = JSON.parse(actionBytes.toString("utf8"));
          const actor = Number(options.actor ?? 0);
          const actionStart = performance.now();
          const result = glue.submit_action(actor, action);
          report.runtime.action = {
            actor,
            resultType: typeof result,
            submitMs: elapsedMs(actionStart),
          };
        }
      }
    } catch (error) {
      report.runtime.error = error.message;
      report.runtime.measurementMode = "failed";
    }
  } else if (options.engineGluePath) {
    report.missing.push("compiled engine WASM required before engine glue");
  }

  report.evaluation = evaluateFeasibility(report);
  report.ready = report.missing.length === 0 && report.engine.compiled === true;
  return report;
}

function usage() {
  return [
    "Usage: node scripts/probe-onedeck-authority.mjs [options]",
    "",
    "  --card-data PATH       card-data.json to measure and optionally load",
    "  --engine-wasm PATH     engine_wasm_bg.wasm to compile and inspect",
    "  --engine-glue PATH     generated engine_wasm.js for runtime probes",
    "  --state PATH           persisted game-state JSON sample",
    "  --action-file PATH     engine-authored action JSON sample",
    "  --actor N              actor for --action-file (default: 0)",
    "  --json                 emit the complete report as JSON",
    "  --enforce              fail unless the report is a complete pass",
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const report = await runProbe(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Stage 2-A authority probe: ${report.evaluation.status}`);
    for (const [name, asset] of Object.entries(report.assets)) {
      console.log(`  ${name}: ${asset.rawBytes} bytes raw, ${asset.gzipBytes} bytes gzip`);
    }
    if (report.evaluation.estimatedResidentBytes !== undefined) {
      console.log(`  estimated resident input: ${report.evaluation.estimatedResidentBytes} bytes`);
    }
    for (const warning of report.evaluation.warnings) console.log(`  warning: ${warning}`);
    for (const blocker of report.evaluation.blockers) console.log(`  blocker: ${blocker}`);
    if (report.missing.length > 0) console.log(`  pending inputs: ${report.missing.join(", ")}`);
  }

  if (options.enforce && report.evaluation.status !== "pass") process.exitCode = 1;
}

const isMain =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(`Stage 2-A probe failed: ${error.message}`);
    process.exitCode = 2;
  });
}
