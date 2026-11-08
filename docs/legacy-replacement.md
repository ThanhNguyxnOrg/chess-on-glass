# Legacy-to-new module inventory

Recorded: 2026-11-08. Baseline: commit `2aaa0f9`, which retains the original `src/`,
`tests/` and `evals/` as reference only. Nothing in this table has been deleted or
approved for deletion: every row records `removal-approved:false`. Deletion is a separate
owner-reviewed operation that requires the written permission or clean-room record
described in `docs/rights/provenance.md`.

Status vocabulary:

- **replaced** — the new implementation exists and its own contract tests pass.
- **interface replaced** — the new contract exists and is tested; the native adapter is a
  later slice.
- **not yet ported** — planned in a later slice; the legacy file remains the only
  implementation and is not used by the new runtime.

| Legacy file | Original responsibility | Replaced by | Contract test | Parity status | removal-approved |
|---|---|---|---|---|---|
| `src/bin.ts` | CLI entry point | `packages/app` CLI (plan 02 Task 9, pending) | pending plan 02 | not yet ported | false |
| `src/board-svg.ts` | Board SVG rendering | `packages/ui` board component (plan 02 Task 10, pending) | pending plan 02 | not yet ported | false |
| `src/capture.ts` | Screen/window capture | frame sources in `packages/app` (plan 02 Task 5, pending) | pending plan 02 | not yet ported | false |
| `src/cli.ts` | Command-line parsing | `packages/app` CLI (plan 02 Task 9, pending) | pending plan 02 | not yet ported | false |
| `src/config.ts` | Configuration and API keys | settings (plan 02 Task 7, pending) plus `packages/platform` secret interface (`services.ts`) | `packages/platform/test/public-api.test.ts` | interface replaced; native store pending | false |
| `src/doctor.ts` | Dependency diagnostics | doctor checks (plan 02 Task 7, pending) | pending plan 02 | not yet ported | false |
| `src/engine.ts` | Stockfish UCI process | `packages/platform/src/uci.ts` | `packages/platform/test/uci.test.ts` plus the `npm run test:engine` gate | replaced; real binary unverified | false |
| `src/events.ts` | Event bus and outputs | `packages/game/src/coordinator.ts`, `packages/game/src/results.ts` | `packages/game/test/coordinator.test.ts`, `results.test.ts` | replaced | false |
| `src/feed.ts` | Frame feed | frame sources (plan 02 Task 5, pending) | pending plan 02 | not yet ported | false |
| `src/game.ts` | Game loop and state | `packages/chess/src/state.ts` plus `packages/game/src/coordinator.ts` | `packages/chess/test/state.test.ts`, `packages/game/test/coordinator.test.ts` | core replaced; app wiring pending | false |
| `src/gate.ts` | Optional pre-read gate | `packages/perception/src/prefilter.ts` | `packages/perception/test/prefilter.test.ts` | local gate replaced; remote gate pending | false |
| `src/geometry.ts` | Overlay geometry | overlay geometry (plan 03, pending) | pending plan 03 | not in this slice | false |
| `src/keychain.ts` | OS keychain access | `packages/platform/src/services.ts` interface; native adapters plan 02 Task 4 | `packages/platform/test/public-api.test.ts` | interface replaced; native store pending | false |
| `src/locate.ts` | Board locator | provider adapters (plan 02 Task 8, pending) | pending plan 02 | not yet ported | false |
| `src/macos.ts` | macOS-only OS services | injected `packages/platform` services (`paths.ts`, `process.ts`) | `packages/platform/test/paths.test.ts`, `process.test.ts` | replaced; no OS branch retained | false |
| `src/main.ts` | Application entry point | `packages/app` runtime (plan 02 Task 9, pending) | pending plan 02 | not yet ported | false |
| `src/match.ts` | Observation-to-move matching | `packages/chess/src/matching.ts` | `packages/chess/test/matching.test.ts` | replaced | false |
| `src/overlay.ts` | Video overlay renderer | overlay renderer (plan 03, pending) | pending plan 03 | not in this slice | false |
| `src/pricing.ts` | Cost tracking and caps | `packages/game/src/budget.ts` | `packages/game/test/budget.test.ts` | ledger replaced; live price table pending | false |
| `src/speak.ts` | Speech output | `packages/game/src/results.ts` plus native speech adapter (plan 02 Task 8, pending) | `packages/game/test/results.test.ts` | core replaced; native voice pending | false |
| `src/static/index.html` | Browser command center | `packages/ui` dashboard (plan 02 Task 10, pending) | pending plan 02 | not yet ported | false |
| `src/vision.ts` | Vision provider calls | `packages/perception` reader/observation contracts; provider adapters plan 02 Task 8 | `packages/perception/test/reader.test.ts`, `observations.test.ts` | contract replaced; providers pending | false |
| `src/watch.ts` | Frame watcher loop | coordinator frame pump (`packages/game/src/coordinator.ts`) | `packages/game/test/coordinator-races.test.ts` | replaced | false |
| `src/web.ts` | Local web server | local HTTP dashboard (plan 02 Task 9, pending) | pending plan 02 | not yet ported | false |

`scripts/check-brand.mjs` fails if a legacy file is missing from this inventory, if a row
does not carry `removal-approved:false`, or if any runtime source imports a legacy module.
The legacy `tests/` and `evals/` trees are likewise reference material only and are excluded
from new build and test discovery.
