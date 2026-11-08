# Rights and provenance register

Recorded: 2026-11-08. This is a planning/evidence record, not a legal opinion.

## Original work

| Field | Value |
|---|---|
| Project | chesshacker / PJChess |
| Original version | 0.2.0 |
| Original revision (historical) | `b919506a7ce7427e322e9f7717587f6c7e14985f` |
| Published origin | https://www.reverse.dev/pjchess |
| Author field in `package.json` | `picklerpeej` |
| Original license file | **absent** |
| Original `package.json` license | absent (`"private": true`) |
| Copy origin | Local working copy supplied by the owner at `D:\Code\ChessOnGlass` |
| Permission document supplied | **none** |
| Owner decision | Approach **B**: complete rewrite of product code; permission/attribution is a release gate |
| Pre-rewrite baseline in this repository | commit `2aaa0f9` (legacy `src/`, `tests/`, `evals/` retained as reference only) |

The original revision no longer exists in this repository: on 2026-11-08 the owner explicitly requested deletion of the previous local and GitHub history before starting the rewrite. The hash above is retained as provenance evidence for the code that was read.

## Permitted modifications and distribution constraints

- No permission or license was supplied, so no permission to copy, modify or distribute the original implementation is recorded.
- New work must not claim copyright over pre-existing third-party code.
- The new runtime build excludes legacy `src/`, `tests/` and `evals/`.
- External distribution remains blocked until a written permission/license or an independently defensible clean-room record exists, and until third-party notices and artifact provenance are complete.
- Attribution wording and the owner's final license are not yet decided; see `research/16-derivative-rights.md`.

## Brand asset

| Field | Value |
|---|---|
| File | `asset/logo.png` |
| SHA-256 | `3054b16d2b2cfd263fc3bd2997c392cec6fb9f17b7bb1a9a0bdf22af4af79909` |
| Rule | Preserve byte-for-byte; never regenerate, redraw or replace |

## Local-core acceptance checkpoint (2026-11-08, plan 01 Task 14)

- `node scripts/check-brand.mjs` passes: logo SHA-256 unchanged, workspace packages stay
  `private` with no original-author or publisher claim, no runtime import reaches legacy `src/`,
  and no dummy secret marker appears in runtime sources.
- `npm run typecheck`, `npm run build`, `npm run test:unit` (27 files / 191 tests) and
  `npm run eval -- --simulate` pass on the Windows reference machine (Node 26.3.0).
- `npm run test:engine` fails closed: no approved Stockfish binary is installed and
  `CHESSONGLASS_STOCKFISH` is unset. Real engine version/hash evidence is not recorded, and
  `docs/rights/artifacts.json` remains `unverified`.
- `docs/legacy-replacement.md` inventories every baseline `src/` file with
  `removal-approved:false`. No legacy file was deleted, no history was rewritten, and nothing
  was pushed, merged or published.
- External distribution stays blocked until the evidence below exists; the local-core result
  is not permission to distribute.

## Pending evidence

- Written permission from `picklerpeej` (channel found: https://github.com/picklerpeej), or a documented clean-room provenance log.
- Final license choice for the owner's new project.
- Third-party notices for every shipped dependency and binary.
- Artifact version/hash/provenance entries in `docs/rights/artifacts.json` (currently `unverified`).
- An approved Stockfish binary whose version and SHA-256 are recorded, so `npm run test:engine`
  can move from failing closed to passing.
- Owner confirmation of attribution/permission evidence and local core parity before any legacy
  deletion or publication.
