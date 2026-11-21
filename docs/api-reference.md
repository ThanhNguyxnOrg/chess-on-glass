# Local API Reference

`@chessonglass/app` exposes a loopback-only (`127.0.0.1`) HTTP and Server-Sent Events (SSE) API consumed by `@chessonglass/ui`.

## Authentication & Security Rules

- **Loopback only:** Server binds exclusively to `127.0.0.1`.
- **Bearer token required:** Every `/api/*` request must include:
  ```http
  Authorization: Bearer <256-bit-session-token>
  ```
  Tokens are never accepted in query strings.
- **Exact Origin on mutations:** Every `POST`, `PUT`, `PATCH`, and `DELETE` request must carry an `Origin` header matching the server's exact `http://127.0.0.1:<port>` origin.
- **Bounded request bodies:** JSON endpoints enforce strict payload size limits (`application/json`); JPEG frame uploads enforce `image/jpeg` and `FRAME_BODY_LIMIT`.

---

## Game & Dashboard Endpoints

### `GET /api/snapshot`
Returns the current JSON-safe `DashboardSnapshot` (`sessionId`, `positionVersion`, `status`, `position`, `suggestion`, `frameAgeMs`, `error`).

### `GET /api/events`
Server-Sent Events stream (`Accept: text/event-stream`). Immediately emits the current `DashboardSnapshot` and streams every subsequent state transition.

### `POST /api/command`
Dispatches a command to `GameCoordinator` (`202 Accepted`):
```json
{ "type": "pause" | "resume" | "undo" | "repeat" | "new-game" }
```
Manual move:
```json
{ "type": "manual-move", "uci": "e2e4" }
```
Promotion disambiguation:
```json
{ "type": "choose-promotion", "promotion": "q" | "r" | "b" | "n" }
```

---

## Settings & Secrets Endpoints

### `GET /api/settings`
Returns current `settings`, `secrets` status (`{ configured, source }` — never secret values), `catalog` (supported models & pricing), `ledger` (`reservedUsd`, `actualUsd`, `paused`), and `capabilities` (`stockfish`, `ffmpeg`, `speech`, `wgc`).

### `PUT /api/settings`
Validates and atomically persists partial `AppSettings` updates (`provider`, `visionModel`, `cloudEnabled`, `speechEnabled`, `voiceId`, `browserFps`, `replayFps`, `maxCostUsd`).

### `POST /api/secrets`
Writes a provider API key to the OS keyring (`@napi-rs/keyring`). Never echoes the secret back.
```json
{ "provider": "openai" | "anthropic", "secret": "..." }
```

---

## Frame Source Endpoints

### Browser Camera / Glasses Feed
- `POST /api/source/browser/start` — allocates `{ sessionId, sourceId }` and attaches a `BrowserFrameSource` to `GameCoordinator` (`202`).
- `POST /api/source/browser/frame` — ingests one `image/jpeg` frame with headers `x-frame-session`, `x-frame-source`, `x-frame-sequence`, `x-frame-wall-ms`, `x-frame-request-id`, `x-frame-position-version` (`202`).
- `POST /api/source/browser/stop` — closes the active browser source (`202`).

### Windows Window Capture (WGC)
- `GET /api/source/screen/targets` — lists capturable desktop windows (`{ targets: [{ id, title, processName }] }`).
- `POST /api/source/screen/pick` — invokes native picker if supported.
- `POST /api/source/screen/preview` — captures a single JPEG preview for `{ targetId }`.
- `POST /api/source/screen/start` — starts capturing `{ targetId }` and attaches `WindowsScreenSource` (`202`).
- `POST /api/source/screen/stop` — stops window capture (`202`).

### Video Replay (FFmpeg)
- `POST /api/source/replay/start` — starts `FfmpegReplaySource` for `{ path, fps?, speed? }` (`202`).
- `POST /api/source/replay/stop` — stops active replay (`202`).

---

## Overlay & Video Export Endpoints

- `GET /api/overlay/status` — reports overlay readiness, geometry freshness, and display state.
- `GET /api/overlay/frame` — returns the latest rendered overlay JPEG (`image/jpeg`) or `503` when no frame is available.
- `GET /api/export/overlay/status` — reports whether an MP4 overlay export is currently active.
- `POST /api/export/overlay/start` — starts a bounded H.264 `yuv420p` export for `{ fileName, fps? }`.
- `POST /api/export/overlay/frame` — appends one rendered overlay JPEG frame (`409` if busy).
- `POST /api/export/overlay/stop` — finalizes and closes the active MP4 export cleanly.
