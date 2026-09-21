/**
 * Public HTTP surface for the personal OneDeck Cloudflare deployment.
 *
 * The shared Phase worker contains optional import, telemetry, and server
 * directory routes. OneDeck's free-tier profile deliberately does not expose
 * those routes: the Worker is only a room broker, an ephemeral WebRTC
 * signaling relay, and the short-lived TURN credential endpoint. Keeping this
 * as a pure request predicate makes the boundary testable without loading the
 * Rust/WASM Durable Object.
 */
function originAllowed(request: Request, allowedOrigins: string): boolean {
  const allow = allowedOrigins.trim();
  if (!allow || allow === "*") return true;
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  return allow.split(",").map((value) => value.trim()).filter(Boolean).includes(origin);
}

export function isOneDeckRequest(request: Request, allowedOrigins = "*"): boolean {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (url.pathname === "/" && method === "GET") return true;
  if (
    url.pathname === "/turn-credentials"
    && (method === "GET" || method === "OPTIONS")
  ) {
    return true;
  }

  if (
    /^\/signal\/[A-Za-z0-9_-]{1,128}$/u.test(url.pathname)
    && method === "GET"
    && request.headers.get("Upgrade")?.toLowerCase() === "websocket"
    && originAllowed(request, allowedOrigins)
  ) {
    return true;
  }

  return (
    url.pathname === "/ws"
    && method === "GET"
    && request.headers.get("Upgrade")?.toLowerCase() === "websocket"
    && originAllowed(request, allowedOrigins)
  );
}
