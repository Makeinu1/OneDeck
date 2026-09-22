import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);

function readRepoFile(relativePath) {
  return readFileSync(new URL(relativePath, repoRoot), "utf8");
}

test("keeps the TURN limiter binding aligned with the runtime contract", () => {
  const wranglerConfig = readRepoFile("lobby-worker/wrangler.onedeck.toml");
  const turnRuntime = readRepoFile("lobby-worker/src/turn.ts");

  assert.match(
    wranglerConfig,
    /\[\[ratelimits\]\]\s+name = "TURN_LIMIT"\s+namespace_id = "1005"\s+simple = \{ limit = 30, period = 60 \}/m,
  );
  assert.match(turnRuntime, /TURN_LIMIT\?: RateLimit/);
  assert.match(turnRuntime, /env\.TURN_LIMIT/);
});

test("keeps the normalized Pages origin connected to the deploy boundary", () => {
  const workflow = readRepoFile(".github/workflows/onedeck-cloudflare.yml");
  const buildScript = readRepoFile("scripts/build-onedeck-cloudflare.sh");

  assert.match(workflow, /id: normalize-pages-origin/);
  assert.match(workflow, /printf 'origin=%s\\n' "\$canonical_origin" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /CANONICAL_PAGES_ORIGIN: \$\{\{ steps\.normalize-pages-origin\.outputs\.origin \}\}/);
  assert.match(workflow, /--var "ALLOWED_ORIGINS:\$CANONICAL_PAGES_ORIGIN"/);
  assert.equal(workflow.includes('--var "ALLOWED_ORIGINS:${{'), false);
  assert.match(buildScript, /node scripts\/validate-onedeck-origin\.mjs "\$ONEDECK_PAGES_ORIGIN"/);
});
