# Architecture

ChessOnGlass is structured as a strict-dependency TypeScript monorepo designed for local-first operation, deterministic state transitions, and isolated platform adapters.

## Dependency Graph

```text
app ──► game ──► perception ──► chess ──► contracts
 │       │
 └───────┴──► platform ──► contracts

ui ──(loopback HTTP/SSE · Authorization: Bearer)──► app
```

### Enforced Boundaries

- `@chessonglass/contracts` has zero runtime product dependencies and holds shared identity types (`SessionId`, `SourceId`, `Sequence`), `Frame`, `FrameSource`, `RequestContext`, `GamePosition`, `Observation`, and `LatestFrameMailbox`.
- `@chessonglass/chess` wraps `chess.js` behind immutable snapshots and never imports `perception`, `game`, or `platform`.
- `@chessonglass/perception` defines vision readers, board homography/projection, freshness-aware board tracking, and overlay rendering. It never imports `game`.
- `@chessonglass/platform` isolates OS paths, child-process boundaries, native keyring storage (`@napi-rs/keyring`), SHA-256 verified binary installation, and the Stockfish UCI process adapter.
- `@chessonglass/game` owns live game coordination, cost accounting, atomic persistence, and result sinks.
- `@chessonglass/app` composes the runtime, CLI, local HTTP/SSE server, frame sources, speech helper, and overlay video exporter.
- `@chessonglass/ui` is a standalone Vite SPA with no Node.js dependencies; it communicates with `@chessonglass/app` strictly over authenticated loopback HTTP/SSE.

## Core Runtime Invariants

### 1. Single-Writer Game Coordinator
Only `GameCoordinator` (`packages/game/src/coordinator.ts`) mutates live game state. Every asynchronous vision read and engine calculation carries a `RequestContext`:

- `requestId`
- `sessionId`
- `positionVersion`
- `referenceSequence`

When a user pauses, undoes, starts a new game, replaces a source, or commits a move, in-flight requests are aborted and any late result whose `RequestContext` no longer matches is rejected before touching state or output sinks.

### 2. Bounded Ingestion & Freshness
- Frame sources (`BrowserFrameSource`, `WindowsScreenSource`, `FfmpegReplaySource`) use capacity-one/latest-wins buffering (`LatestFrameMailbox`) so slow vision calls never build an unbounded backlog.
- Freshness is measured on the backend receipt clock, never on untrusted client timestamps.
- Byte-identical (frozen), duplicate, and out-of-order frames are dropped before reaching paid vision readers.

### 3. Corroborated Move Matching
Observations from vision models are parsed strictly and scored against legal moves from the current `ChessState`. A move is committed only after corroborating fresh observations agree, with explicit handling for occlusion (hand over board), promotion ambiguity, and mid-game position confirmation.

### 4. Spend Accounting (`CostLedger`)
Every vision read:
1. **Reserves** a conservative per-call amount before contacting the provider.
2. **Settles** actual `inputTokens` and `outputTokens` against the catalog rate on completion (even if the request became stale in-flight, since tokens were consumed).
3. **Releases** the reservation on failure or cancellation.

When `actualUsd + reservedUsd + reservePerCallUsd > limitUsd`, `CostLedger` transitions to `paused` and the coordinator halts paid work until the user intervenes.

### 5. Atomic Persistence
`FileGameStore` writes game journals atomically (temp file + rename) with strict schema validation on load, allowing safe crash recovery without corrupting saved PGN/position history.

### 6. Overlay & Export Pipeline
Board geometry uses validated 4-point homography (`fitBoardHomography`, `validateGeometry`, `projectSquare`). Stale or invalid geometry hides the projected overlay cleanly instead of drawing misaligned arrows. Dashboard preview (`/api/overlay/frame`) and MP4 video export (`FfmpegOverlayWriter` via `/api/export/overlay/*`) share the same renderer and bounded frame limits.
