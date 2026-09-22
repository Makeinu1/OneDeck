# OneDeck Cloudflare free-tier profile

This profile deploys a playable web shell to Cloudflare Pages while keeping the
large, immutable runtime inputs in an operator-owned R2 bucket. It is separate
from the phase.rs production lobby and TURN credentials:

```text
Pages (shell, JS/CSS, small images)
        │
        ├── OneDeck R2 (gzip card data + gzip engine/draft WASM)
        └── OneDeck Worker (lobby broker + WebRTC signaling + short-lived TURN mint)
```

The Worker reuses the lobby implementation behind the narrow
`lobby-worker/src/onedeck.ts` entry point. `lobby-worker/wrangler.onedeck.toml`
gives it a different Worker name and a new SQLite-backed Durable Object
namespace. No official lobby rooms, directory, import service, or TURN token
is shared. The lobby WebSocket admits only the configured Pages origin as a
browser-origin abuse guard; this is not authentication because non-browser
clients can forge an `Origin` header.

## Operator setup

1. Create a private R2 bucket and a public custom domain (or `r2.dev` URL) for
   it. The URL passed as `r2_public_url` must be the bucket prefix used only by
   this profile.
2. Configure R2 CORS for `GET`/`HEAD` from the exact Pages origin. The objects
   are public immutable game inputs; no player deck, save, or match state is
   uploaded.
3. Create a Cloudflare Realtime TURN key dedicated to OneDeck. Add these GitHub
   Actions secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `ONEDECK_TURN_KEY_ID`, and `ONEDECK_TURN_API_TOKEN`.
4. Run **Deploy OneDeck Cloudflare profile** manually from the exact commit you
   want to publish. Supply the Pages project/origin, Worker HTTPS URL, R2 public
   URL, and R2 bucket. The workflow deploys the Worker first, then builds and
   deploys Pages.

The checked-in Worker profile binds `TURN_LIMIT` as a per-IP, 30-per-minute
Cloudflare Rate Limiting throttle before it calls the Realtime TURN API. Its
namespace id is an operator-chosen binding identifier, not a secret or a
separately provisioned database. If you copy this profile into another
Cloudflare account, keep the binding and choose a namespace id that is not
shared with an unrelated application.

The Worker CORS allowlist is injected from `pages_origin`; the checked-in
`https://onedeck-play.pages.dev` value is only a safe default for a newly created
project. Do not replace it with `*` in a production deployment.

This Stage 1 profile is intended for a personal or trusted-user deployment.
`/turn-credentials` uses the exact Pages-origin CORS allowlist and the
`TURN_LIMIT` throttle, but neither CORS nor Rate Limiting is authentication:
non-browser callers can forge `Origin`, and Rate Limiting is location-scoped
and eventually consistent. Monitor TURN usage and add authentication and
authorization before opening the Worker to an untrusted public audience.

## Build boundary

`scripts/build-onedeck-cloudflare.sh` performs the following in order:

- generates card data and the release WASM when requested by CI;
- computes SHA-256 names from the uncompressed card, engine-WASM, and draft-WASM bytes;
- creates deterministic `gzip -9 -n` objects, stages them for the isolated R2
  upload step, and uploads them with
  `Content-Encoding: gzip`, the correct MIME type, and immutable cache headers;
- builds Vite with the dedicated Worker/R2 URLs and empty Supabase/telemetry
  settings. The OneDeck profile leaves URL-based deck import disabled, so a
  deck is entered from the local file/paste path and never crosses the lobby;
- removes every entry from `data-files.json`, the content-addressed card JSON,
  and both WASM binaries from `client/dist`;
- copies the Cloudflare `_headers` file and the SPA fallback;
- fails if any Pages file exceeds 25 MiB, if generated runtime data/WASM or an
  environment file remains, or if credential markers appear in the artifact;
- optionally checks remote gzip headers and card/WASM round trips with
  `curl --compressed`.

The browser automatically decompresses the R2 response before JSON parsing or
WASM instantiation. The script therefore hashes the raw bytes, not the gzip
container, so a deployment cannot pair a WASM build with a different card
schema.

The privacy promise here is about the published artifact and the broker wire:
player decks, browser saves, and authoritative match state are not placed in
Pages, R2, the lobby registration payload, or SignalDO. LobbyDO may still keep
room-admission data such as a room password or reservation token in its private
Durable Object snapshot; that is not public artifact data and is not a claim
that no secret is ever stored at rest.

## Play flow and authority boundary

`/setup` now offers both **AIとプレイ** and **対人プレイ**. The AI button keeps
the existing solo path. The multiplayer button enters the existing
`/multiplayer?view=host-setup` screen, whose default Commander table has two
seats and still allows the supported 2–6 player P2P range.

For this free-tier profile, solo runs the Phase WASM engine in the browser and
multiplayer uses the existing host-authoritative P2P adapter. The dedicated
Worker brokers the room, relays only WebRTC signaling metadata through an
ephemeral SignalDO, and mints TURN credentials; it does not run the Phase game
engine or persist authoritative match state. The OneDeck build selects the
native `RTCPeerConnection` transport, so it has no dependency on the PeerJS
cloud signaling service. A server-authoritative Durable Object is deliberately
a separate feasibility project because loading the full card corpus and native
server dependencies into a 128 MiB Worker is a different architecture.

Stage 2-A keeps that boundary explicit and provides a measurement-only probe
for the existing engine-WASM build: see
[`onedeck-cloudflare-stage2-a.md`](onedeck-cloudflare-stage2-a.md). A missing
runtime artifact or a local pass is not deployment authorization; the later
stage still requires a deployed Worker/DO measurement and real-player evidence.

## Acceptance evidence

After a preview deployment, verify:

```bash
curl -I "$CARD_DATA_URL"    # Content-Encoding: gzip
curl -I "$ENGINE_WASM_URL"  # Content-Encoding: gzip
curl -I "$DRAFT_WASM_URL"   # Content-Encoding: gzip
curl --compressed -fsS "$CARD_DATA_URL" | jq empty
find client/dist -type f -size +25M -print   # no output
```

From the deployed Pages origin, confirm that the R2 bucket returns the expected
`Access-Control-Allow-Origin` value for both `GET` and `HEAD`; a local `curl`
alone does not prove browser CORS behavior.

In two browser profiles, open `/setup`, start a solo match through the first
priority action, then host and join a two-player room through the same entry
point. Browser network logs must show the OneDeck Worker/R2 hosts and no
`lobby.phase-rs.dev`, `phase-rs.dev/turn-credentials`, or `0.peerjs.com`
request. The latter check also catches an accidental fallback to the upstream
PeerJS cloud rather than the OneDeck signaling route.
