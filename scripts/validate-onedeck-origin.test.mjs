import assert from "node:assert/strict";
import test from "node:test";

import { validateOnedeckOrigin } from "./validate-onedeck-origin.mjs";

test("accepts an HTTPS origin and normalizes a single trailing slash", () => {
  assert.equal(
    validateOnedeckOrigin("https://onedeck-play.pages.dev"),
    "https://onedeck-play.pages.dev",
  );
  assert.equal(
    validateOnedeckOrigin("https://onedeck-play.pages.dev/"),
    "https://onedeck-play.pages.dev",
  );
  assert.equal(validateOnedeckOrigin("https://example.test:8443/"), "https://example.test:8443");
});

test("rejects non-origin deployment inputs", () => {
  for (const value of [
    "http://onedeck-play.pages.dev",
    "https://onedeck-play.pages.dev/path",
    "https://onedeck-play.pages.dev?preview=1",
    "https://onedeck-play.pages.dev#fragment",
    "https://user:pass@onedeck-play.pages.dev",
    " https://onedeck-play.pages.dev",
  ]) {
    assert.throws(() => validateOnedeckOrigin(value), /Pages origin/);
  }
});
