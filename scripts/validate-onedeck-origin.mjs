#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Validate and canonicalize the browser origin used by the OneDeck Worker.
 *
 * CORS origins are scheme/host/port only. Accepting a URL path or query here
 * would make the value look valid to a deployment script while never matching
 * the browser's Origin header. The returned value is therefore always the
 * WHATWG URL `origin`, with a single optional trailing slash normalized away.
 */
export function validateOnedeckOrigin(value) {
  const input = String(value ?? "");
  if (!input || input !== input.trim()) {
    throw new Error("Pages origin must be a non-empty URL without surrounding whitespace");
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Pages origin must be a valid absolute URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("Pages origin must use https");
  }
  if (url.username || url.password) {
    throw new Error("Pages origin must not contain userinfo");
  }
  if (url.pathname !== "/") {
    throw new Error("Pages origin must not contain a path");
  }
  if (url.search || url.hash) {
    throw new Error("Pages origin must not contain a query or fragment");
  }

  return url.origin;
}

const scriptPath = process.argv[1];
const isMain =
  scriptPath !== undefined && pathToFileURL(resolve(scriptPath)).href === import.meta.url;

if (isMain) {
  try {
    console.log(validateOnedeckOrigin(process.argv[2]));
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : "invalid Pages origin"}`);
    process.exitCode = 2;
  }
}
