import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [baseArg, directory, expectedSha] = process.argv.slice(2);
const base = new URL(baseArg);
if (base.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)?onedeck-play\.pages\.dev$/.test(base.hostname)) throw new Error('Unexpected deployment target');
if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '')) throw new Error('Exact source SHA required');
const local = JSON.parse(fs.readFileSync(path.join(directory, 'onedeck-build.json'), 'utf8'));
if (local.source_commit !== expectedSha) throw new Error('Local artifact source mismatch');
const encoded = JSON.parse(fs.readFileSync(path.join(directory, 'encoded-assets.json'), 'utf8'));
async function get(p, timeout = 120000) {
  const r = await fetch(new URL(p, base), {signal: AbortSignal.timeout(timeout), cache: 'no-store'});
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r;
}
// Retry only small public reads while the edge publishes the new deployment.
// This never retries a deployment or accepts a different build as equivalent.
let visible = false;
for (let attempt = 0; attempt < 12; attempt++) {
  try {
    const receipt = await (await get('/onedeck-build.json', 10000)).json();
    if (JSON.stringify(receipt) === JSON.stringify(local)) { visible = true; break; }
  } catch { /* exact provenance remains required after bounded propagation */ }
  await new Promise(resolve => setTimeout(resolve, 5000));
}
if (!visible) throw new Error('Exact remote artifact provenance did not become visible');
const checks = new Map(Object.entries(encoded).map(([p, v]) => [p, {sha256: v.sha256, type: v.type}]));
const cardPath = `/card-data-${local.card_data_sha256.slice(0, 16)}.json`;
checks.set(cardPath, {sha256: local.card_data_sha256, type: 'application/json'});
const wasmPaths = [
  ...Object.keys(encoded).filter(p => /\/engine_wasm_bg-[^/]+\.wasm$/.test(p)),
  ...fs.readdirSync(path.join(directory, 'assets')).filter(p => /^engine_wasm_bg-[^/]+\.wasm$/.test(p)).map(p => '/assets/' + p),
];
if (new Set(wasmPaths).size !== 1) throw new Error('Expected exactly one published engine WASM');
checks.set(wasmPaths[0], {sha256: local.wasm_sha256, type: 'application/wasm'});
for (const [p, expected] of checks) {
  const r = await get(p);
  if (!(r.headers.get('content-type') ?? '').startsWith(expected.type)) throw new Error(`${p}: wrong content type`);
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of r.body) { digest.update(chunk); bytes += chunk.length; }
  if (digest.digest('hex') !== expected.sha256) throw new Error(`${p}: decoded hash mismatch`);
  console.log('PASS decoded hash:', p, bytes, 'bytes');
}
const setup = await get('/setup');
const html = await setup.text();
if (!html.includes('<div id="root"')) throw new Error('Setup did not return application HTML');
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
if (!scripts.some(p => /\/assets\/.+\.js$/.test(p))) throw new Error('No compiled application script');
for (const p of scripts) {
  const r = await get(p);
  if ((r.headers.get('content-type') ?? '').includes('text/html')) throw new Error('Script resolved to SPA fallback');
  await r.arrayBuffer();
}
console.log('PASS: exact build provenance, decoded artifact hashes, SPA route and script responses');
