# ChessOnGlass architecture (slice 1)

Status: foundation slice Tasks 1–14 complete (2026-11-08); the local-core acceptance record is below. This file describes the new `packages/` runtime only; legacy `src/`, `tests/` and `evals/` are reference material and are excluded from the new build and test discovery.

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
- `npm run test:unit` — same suite, explicit package scope (191 tests on 2026-11-08).
- `node scripts/check-brand.mjs` (also `npm run check:brand`) — logo hash, workspace metadata, legacy-import isolation, dummy-secret-marker and legacy-inventory checks.
- `npm run eval -- --simulate` — deterministic oracle-free evaluation fixture; no provider call.
- Native/real-engine/cloud tests are separate, explicitly labelled jobs added by later slices. A skipped native test must fail its release job; no silent skip in this base job.
- `npm run test:engine` is release-only. It requires `CHESSONGLASS_STOCKFISH` to point at an approved binary whose version and SHA-256 match `docs/rights/artifacts.json`. The command fails when the binary is absent; it is never converted to `describe.skipIf`.

## Secret-storage contract to verify in the Windows/platform slice

`PlatformServices.readSecret`/`writeSecret` are interfaces only in this slice; no unit test touches a real keychain. A later native contract test must prove, per OS:

- Windows: Windows Credential Manager, persistent across process restart, per-user scope.
- macOS: Keychain item, persistent across restart, correct access group.
- Linux: Secret Service via the session bus; if only an in-memory store is available it must report non-persistent and must not be labelled persistent.
- No plaintext file fallback may be introduced silently; a failed secret store surfaces an actionable error.

## Local-core acceptance (2026-11-08)

Commands run on the Windows reference machine (Windows, Node 26.3.0, npm from Node 26):

| Command | Result |
|---|---|
| `node scripts/check-brand.mjs` | pass |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm run test:unit` | pass, 27 files / 191 tests |
| `npm run eval -- --simulate` | pass, deterministic `free-running` report |
| `npm run test:engine` | **fails closed** — no approved Stockfish binary is installed and `CHESSONGLASS_STOCKFISH` is unset, so the release gate cannot run |

Coverage is real for the portable core: legal state, history and PGN; mid-game confirmation;
all four promotions; frozen/duplicate/out-of-order frames; cancellation and stale-result
rejection; cost reservation and settlement; atomic journal recovery; session-bound output
queues; and oracle-free evaluation.

Coverage is **fake-only** for everything outside that core:

- The UCI adapter is tested against a fake process; no real engine version or hash is recorded,
  and `docs/rights/artifacts.json` is still `unverified`.
- Every vision path is tested against fakes; no real provider call exists in this slice and no
  paid request runs in CI.
- No native camera or window capture, no browser dashboard, no overlay, no real speech output
  and no OS keychain integration exist yet.

Still missing or unfinished: written permission/attribution evidence and the final license
(external distribution remains blocked), third-party notices, and a security audit. CI runs on
the three-OS matrix but only this Windows machine has recorded real development verification.

## Boundaries in this slice

- No real camera, overlay, cloud provider, network device, WhatsApp, BlackHole or macOS service is implemented.
- No package is published; the npm scope `@chessonglass/*` is provisional and private.
- `asset/logo.png` is preserved byte-for-byte; see `docs/rights/provenance.md`.
- Legacy `src/` is retained unchanged; `docs/legacy-replacement.md` lists every original file
  with `removal-approved:false` and `scripts/check-brand.mjs` enforces that inventory.
