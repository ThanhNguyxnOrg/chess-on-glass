# ChessOnGlass architecture (slice 1)

Status: foundation slice in progress. This file describes the new `packages/` runtime only; legacy `src/`, `tests/` and `evals/` are reference material and are excluded from the new build and test discovery.

## Workspace layout

| Package | Responsibility |
|---|---|
| `@chessonglass/contracts` | Branded identity types, frame/session metadata, bounded mailbox, observation value types, typed errors |
| `@chessonglass/platform` | OS paths, secret-storage interface, bounded process execution, artifact evidence, Stockfish UCI adapter, safe logging |
| `@chessonglass/chess` | chess.js-backed legal state/history/PGN, position candidates, observation-to-move matching |
| `@chessonglass/perception` | Provider-neutral board-reader contract, strict observation parsing, optional local pre-filter |
| `@chessonglass/game` | Single-writer coordinator, commands, cost ledger, journal/storage, result sinks, free-running evaluation |

## Dependency direction

```text
app → game → perception → chess → contracts
game/app → platform → contracts
```

- `chess` never imports `perception` or `game`.
- `perception` never imports `game`.
- `platform` never imports product packages above `contracts`.
- The two observation value types (`PieceObservation`, `Observation`) live in `contracts` so both `chess` and `perception` can share them without a cycle; `perception` re-exports them.

The direction is enforced by package manifests and review, not by a runtime mechanism.

## Build and test

- Node.js 24 LTS is the supported baseline. This Windows reference machine verifies on Node 26.3.0; CI pins Node 24.
- `npm run typecheck` — TypeScript project-reference build check.
- `npm run build` — portable Node script invoking `tsc -b` via `spawn` argument arrays (no shell strings).
- `npm test` — all new unit/contract tests under `packages/*/test`.
- `npm run test:unit` — same suite, explicit package scope.
- Native/real-engine/cloud tests are separate, explicitly labelled jobs added by later slices. A skipped native test must fail its release job; no silent skip in this base job.

## Boundaries in this slice

- No real camera, overlay, cloud provider, network device, WhatsApp, BlackHole or macOS service is implemented.
- No package is published; the npm scope `@chessonglass/*` is provisional and private.
- `asset/logo.png` is preserved byte-for-byte; see `docs/rights/provenance.md`.
