# OneDeck Cloudflare Stage 2-A: authority feasibility

Stage 1 publishes the OneDeck shell and immutable card/WASM inputs on Pages +
R2, while the dedicated Worker only brokers signalling and TURN credentials.
Stage 2-A answers the narrower question: **can a server-authoritative game
session fit the free Cloudflare Worker/Durable Object envelope?**

## Goal

Measure the existing `engine-wasm` build, rather than inventing a second game
engine or changing the live multiplayer path. The probe records:

- raw and deterministic gzip sizes for card data and engine WASM;
- the module's declared WASM memory and local compile time;
- optional engine-glue startup, card-database load, and initial game setup;
- an exported or supplied game-state JSON size;
- an engine-authored action submission time when an action fixture is supplied.

The report is local feasibility evidence. It is not a claim that Node memory or
local timings equal a deployed Worker measurement.

## Non-goals

- no Game Durable Object or server-authoritative production switch;
- no reuse of the Phase public lobby, directory, or TURN credentials;
- no upload of decks, saves, auth material, or match state;
- no synthetic or guessed legal action: `--action-file` must come from an
  engine-authored fixture or a captured test result;
- no full card corpus copied into Pages or committed to the repository.

## Run it

Generated WASM and card data are ignored build artifacts, so a plain checkout
may only produce a pending-input report and still exits successfully:

```bash
node scripts/probe-onedeck-authority.mjs --json
```

With release artifacts present, run the complete local probe:

```bash
node scripts/probe-onedeck-authority.mjs \
  --card-data client/public/card-data.json \
  --engine-wasm client/src/wasm/engine_wasm_bg.wasm \
  --engine-glue client/src/wasm/engine_wasm.js \
  --state /path/to/exported-game-state.json \
  --json
```

`--enforce` is intentionally opt-in. It exits non-zero unless all required
inputs are present and the conservative gates pass; it must not be used as a
substitute for a deployed Worker/DO measurement.

## Acceptance and stop conditions

Stage 2-A is complete when the probe and its `node:test` coverage are green in
the lobby-worker test job, and a release-artifact run produces a JSON report
without secrets or timestamps. The following gates are deliberately fail-closed
for any later Game Durable Object work:

1. A state snapshot over the configured Durable Object value threshold stops
   the design. Use a bounded patch/snapshot protocol only after measuring it;
   do not silently truncate state.
2. The conservative resident estimate (card JSON retained by JS and the WASM
   database, engine bytes, declared linear memory, and headroom) over the
   Worker memory threshold stops the full-corpus design. The next option is a
   measured game-scoped card subset or a different runtime, not a larger
   request body.
3. Any compile, initialization, card-load, or engine-action error stops the
   production switch until the engine boundary is fixed and remeasured.
4. A report with missing runtime artifacts is `inconclusive`, not `pass`.
   It can land as feasibility evidence, but it cannot authorize a
   server-authoritative deployment.

The thresholds in the report are conservative defaults for planning and must be
checked against the current Cloudflare account limits during the later
deployment gate. A successful local report therefore authorizes only the next
measurement stage; it does not replace real browser or deployed Worker evidence.
