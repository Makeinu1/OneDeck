import handler, { LobbyDO, type Env } from "./index";
import { isOneDeckRequest } from "./onedeck-profile";
import { SignalDO } from "./signaling-do";

export interface OneDeckEnv extends Env {
  SIGNAL: DurableObjectNamespace;
}

// The OneDeck entry point keeps the upstream lobby implementation reusable but
// applies a smaller public route surface before any Durable Object or optional
// service binding can be reached.
export { LobbyDO };
export { SignalDO };

export default {
  fetch(request: Request, env: OneDeckEnv, ctx: ExecutionContext): Promise<Response> {
    if (!isOneDeckRequest(request, env.ALLOWED_ORIGINS)) {
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }
    const url = new URL(request.url);
    if (url.pathname.startsWith("/signal/")) {
      const hostPeerId = url.pathname.slice("/signal/".length);
      const id = env.SIGNAL.idFromName(hostPeerId);
      return env.SIGNAL.get(id).fetch(request);
    }
    return handler.fetch(request, env, ctx);
  },
};
