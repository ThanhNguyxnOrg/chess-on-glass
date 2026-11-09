# ChessOnGlass design

ChessOnGlass is an international, cross-platform chess assistant: watch a physical board with a
camera, track the position, suggest a move with a local engine, and present or speak the result.
Windows x64 is the first target; macOS and Linux follow. Camera, microphone, audio output and
display are independent capabilities, so a device may use any subset of them.

This document describes the rewritten architecture. Acceptance evidence lives in
[docs/architecture.md](docs/architecture.md); rights and release gates live in
[docs/rights/provenance.md](docs/rights/provenance.md). The legacy modules and their
replacement status are inventoried in
[docs/legacy-replacement.md](docs/legacy-replacement.md).

## Principles

- **One authoritative state writer.** Capture and inference may run concurrently, but only the
  coordinator applies moves, confirmations, suggestions and journal writes. Every asynchronous
  result carries a `RequestContext` and is re-checked immediately before it may mutate or
  publish.
- **Fresh evidence only.** A move is committed only when separate fresh frames agree; repeated
  sequence numbers and frozen frames never add confidence. A tie or disagreement asks the user
  instead of guessing.
- **Explicit uncertainty.** Castling rights, en-passant rights and promotion type cannot come
  from a single image. They stay unknown until the user or verified history supplies them, and
  a mid-game resume always requires confirmation.
- **Local first.** The core runs without a hosted backend. Cloud vision is optional, bounded,
  off by default, and never a mandatory dependency.
- **Bounded everything.** Frames, mailboxes, queues, shutdown waits, retries and estimated cost
  all have explicit limits; nothing may grow without one.

## Packages

| Package | Responsibility |
|---|---|
| `@chessonglass/contracts` | Branded IDs, frame/session metadata, `RequestContext`, bounded mailbox, `GamePosition`, observation values |
| `@chessonglass/platform` | OS paths, injected secret storage, bounded process execution, aggregate artifacts, safe log redaction, Stockfish-compatible UCI adapter |
| `@chessonglass/chess` | chess.js-backed legal state/history/PGN, position candidates, observation-to-move matching with evidence |
| `@chessonglass/perception` | Provider-neutral `BoardReader` contract, strict observation parsing, optional local pre-filter |
| `@chessonglass/game` | Single-writer coordinator, commands, cost ledger, atomic journal/storage, result sinks, free-running evaluation |

Dependency direction:

```text
app → game → perception → chess → contracts
game/app → platform → contracts
```

No package above `contracts` imports a package below it. OS services are injected behind small
interfaces; there is no `macos.ts`-style platform branch in the core.

## Data flow

1. A `FrameSource` produces a frame tagged with session, source and sequence.
2. The coordinator feeds fresh frames to a `BoardReader`, which returns a strict `Observation`
   or a typed, sanitized failure; the observation echoes the request context.
3. `rankMoves` scores every legal move against the observation; `decideMove` commits only
   corroborated, unambiguous moves and asks for confirmation otherwise.
4. A committed move updates the chess state and position version, writes the atomic journal,
   and lets the advisor suggest a reply for the new position.
5. Result sinks present or speak the structured `Result`. Any invalidating event — undo, new
   game, manual move, promotion choice, position confirmation, source replacement, pause or
   close — bumps a generation, aborts pending work and clears stale output, so a late provider
   or engine answer can never mutate or announce an old state.

## Sessions and persistence

- A session is an opaque UUID. `GameCoordinator.start`/`replaceSource` accept a caller-provided
  canonical session ID so a frame source can stamp its frames with it; a fresh ID is generated
  when the caller does not bind one. Frames from another session are ignored, and a source that
  keeps sending them is reported instead of silently leaving a "ready" session dead.
- Duplicate or out-of-order sequences are dropped, and consecutive byte-identical frames are
  treated as frozen: they cause no paid read and cannot corroborate a move.
- `FileGameStore` maps canonical session IDs to hashed fixed filenames, writes a sibling
  temporary file, flushes, closes and renames it over the previous record. Partial or forged
  JSON is never loaded as valid state.
- Appending an already-stored version with the same position is an idempotent no-op; stale or
  conflicting writes are rejected without replacing the stored record.
- A loaded game is marked as requiring user confirmation, because the physical board may have
  changed while the application was closed.
- Frame images are not persisted by default.

## Cost and outputs

- One `CostLedger` covers vision, locator and optional gates. It reserves a conservative budget
  before work, reconciles reported token usage afterwards, refuses to treat an unknown price as
  free, and exposes a dynamic paused state. Caps are estimates, not a guaranteed provider
  invoice ceiling.
- `Result` stays structured; UI, audio, file and future clients independently select the fields
  they render.
- `QueuedTextSink` bounds and orders speech, drops unstarted text from an invalidated position,
  and never reports an in-flight utterance as cancelled when the backend cannot cancel it.

## Evaluation

- `free-running` evaluation never receives the answer key. Only the explicitly labelled
  `oracle-assisted` diagnostic may reset with truth, and its numbers are reported separately.
- Reports include the committed sequence, false/missed/duplicate moves, manual interventions,
  recovery time and p50/p95 latency. A short anecdote is not evidence.
- Corpus splits are by full game or session; manifest validation rejects a recording that
  leaks into both train and holdout.

## Gates and status

- Windows x64 is the reference host, verified locally on Node 26.3.0; CI pins Node 24 LTS
  across Windows, macOS and Linux.
- `npm run test:engine` is release-only and fails closed until an approved Stockfish binary
  matches `docs/rights/artifacts.json`.
- This slice makes no camera, overlay, real-AI, speech, hardware or security-audit claim.
- Nothing is published, and external distribution stays blocked until permission/attribution
  evidence and the final license are decided.
