# ChessOnGlass

ChessOnGlass is an international, cross-platform chess assistant. The goal is to watch a real
board with a camera, track the game, suggest a move from a local engine, and present or speak
the result — without requiring WhatsApp, macOS-only audio routing or a hosted backend.

**Status: foundation slice complete (2026-11-08).** The portable game core is implemented and
tested; camera, dashboard, native speech and cloud vision arrive in later slices. See
[DESIGN.md](DESIGN.md) for the architecture and [docs/architecture.md](docs/architecture.md)
for the acceptance record.

## What works today

| Package | Responsibility |
|---|---|
| `@chessonglass/contracts` | Session/frame identity, bounded frame mailbox, observation types |
| `@chessonglass/platform` | Paths, injected secret storage, bounded process execution, log redaction, aggregate artifacts, Stockfish-compatible UCI adapter |
| `@chessonglass/chess` | Legal state/history/PGN, position candidates, observation-to-move matching with corroboration and promotion ambiguity |
| `@chessonglass/perception` | Board-reader contract, strict observation parsing, optional local pre-filter |
| `@chessonglass/game` | Single-writer coordinator with stale-result rejection, atomic resumable journal, shared cost ledger, result sinks, free-running evaluation |

191 unit and contract tests cover these packages.

## Run the core locally

Requires Node.js 24 LTS or newer.

```sh
npm install
npm run typecheck
npm run build
npm run test:unit
node scripts/check-brand.mjs
npm run eval -- --simulate
```

`npm run eval -- --simulate` prints one deterministic, oracle-free evaluation run from a
built-in fixture. Real recordings need a separately approved model and hardware run and are
never started by the normal suite.

`npm run test:engine` is a release-only gate. It needs `CHESSONGLASS_STOCKFISH` to point at an
approved Stockfish binary whose version and SHA-256 match `docs/rights/artifacts.json`; without
one it fails closed instead of skipping.

## Boundaries in this slice

- No camera or window capture, no browser dashboard, no overlay, no real speech output.
- No real vision-provider call: every AI path is exercised with fakes, and no paid evaluation
  runs in CI.
- No WhatsApp, BlackHole, macOS-only service or hosted backend is part of the new runtime.
- Nothing is published. The `@chessonglass/*` scope is provisional and every package stays
  `private`.
- External distribution is blocked until permission/attribution evidence and the final license
  are decided; see [docs/rights/provenance.md](docs/rights/provenance.md).
- The legacy implementation is retained as reference only:
  [docs/legacy-replacement.md](docs/legacy-replacement.md) lists every original file and its
  replacement status. Nothing is approved for removal.
- `asset/logo.png` is preserved byte-for-byte; `scripts/check-brand.mjs` verifies its SHA-256.
