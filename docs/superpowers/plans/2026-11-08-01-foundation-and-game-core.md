# ChessOnGlass Foundation and Game Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy foundation and chess/tracking implementation with a portable, branded, independently testable local game core without making WhatsApp, macOS or a paid pre-check service mandatory.

**Architecture:** npm workspaces contain narrow contracts, platform services, chess rules, perception contracts and a single-writer game coordinator. Dependency direction is `app → game → perception → chess → contracts` and `game/app → platform → contracts`; no lower-level package imports a higher-level one. New code lives in `packages/`; legacy `src/`, `tests/` and `evals/` are excluded from the new build and retained only as reviewed reference until parity and permission gates pass. No product provider, network device, native desktop capture or video overlay is implemented in this slice.

**Tech Stack:** Node.js 24 LTS (`>=24 <25`), TypeScript strict ESM, npm workspaces, chess.js, Vitest, GitHub Actions; immutable third-party artifact metadata.

**Spec:** `docs/superpowers/specs/2026-11-07-cross-platform-rewrite-design.md`

## Global Constraints

- Preserve `asset/logo.png` byte-for-byte; record its SHA-256 and use that file, never regenerate or edit it.
- Every legacy product module is replaced or explicitly removed after parity review; no legacy source enters the new runtime build.
- Windows x64 is the first supported host; shared code cannot import `macos.ts`, `say`, `security`, `screencapture` or OS shell utilities.
- Cloud vision is optional and paid by the owner’s choice; no Jev/TypeSafe dependency is required.
- No claim of third-party copyright ownership, universal hardware support, safe deployment or invoice-capping guarantee.
- Do not publish npm packages, push, merge or rewrite history; local reviewed commits are checkpoints only.
- All test commands are executed from the repository root in the implementation worktree.
- Use dependency versions selected and locked during Task 1 after current compatibility/license review; do not use unreviewed `latest` tags.
- No real cloud credentials, external provider calls or real camera are needed for these unit/contract tests.
- Treat `research/RESEARCH.md` §14 as the legacy baseline only: Windows Node 26.3.0 had 129 passed/2 failed/2 skipped tests; Stockfish and live call were not verified. Do not copy those results into the new runtime’s acceptance report.

## Review Focus

1. A duplicated, reordered or wrong-session frame must not increase move confidence — Task 2 and Task 11.
2. An ambiguous promotion or incomplete mid-game position must wait for user confirmation — Task 8 and Task 11.
3. A late model/engine result after undo, reset or source replacement must not mutate or announce state — Task 11 and Task 12.
4. Secrets, pairing values and credentials must not leak into portable configuration or logs — Task 3 and Task 14.
5. A pause/shutdown during an ignored cancellation signal must leave bounded resources and no pending writes — Task 11 and Task 12.

---

## File map

| Area | New responsibility |
|---|---|
| `package.json`, `tsconfig*.json`, `vitest.config.ts`, `scripts/` | Cross-platform workspace/build/test tooling |
| `packages/contracts/src/` | Shared branded IDs, frame/request/result types, bounded parsing, typed errors |
| `packages/platform/src/` | OS paths, secret storage interface, process/artifact abstractions and safe logging |
| `packages/chess/src/` | chess.js history, legal moves, PGN, promotions and observation candidate matching |
| `packages/perception/src/` | Provider-neutral reader contracts, observation normalization and optional local pre-filter |
| `packages/game/src/` | Position confirmation, single-writer coordinator, cancellable work, persistence and budget ledger |
| `packages/*/test/` | Focused unit/contract tests, no real cloud account |
| `docs/architecture.md`, `docs/rights/` | Dependency direction, provenance, permission and artifact evidence |
| `.github/workflows/ci.yml` | Three-OS build/typecheck/unit validation |

## Task 1: Portable workspace and rights baseline

**Files:**
- Create: `docs/rights/provenance.md`, `docs/rights/artifacts.json`, `docs/architecture.md`
- Modify: `package.json`, `package-lock.json`, `.npmrc`, `.gitignore`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/platform/package.json`, `packages/chess/package.json`, `packages/perception/package.json`, `packages/game/package.json`
- Create: `scripts/build-workspaces.mjs`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces: workspaces `@chessonglass/contracts`, `@chessonglass/platform`, `@chessonglass/chess`, `@chessonglass/perception`, `@chessonglass/game`; root scripts `npm run build`, `npm run typecheck`, `npm test`, `npm run test:unit`.
- Consumes: no legacy runtime module; legacy source remains reference only.

- [ ] **Step 1: Record the pre-rewrite invariants**

  In `docs/rights/provenance.md`, record original revision `b919506a7ce7427e322e9f7717587f6c7e14985f`, origin `https://www.reverse.dev/pjchess`, original author field `picklerpeej`, missing original LICENSE, owner’s B choice and absence of a supplied permission document. Include `docs/rights/artifacts.json` entries for Stockfish and FFmpeg with `version`, `url`, `sha256`, `os`, `arch`, `license`, `sourceUrl`, `buildFlags` fields initially marked `unverified`, not guessed values. Record the unchanged logo hash obtained with `Get-FileHash asset/logo.png -Algorithm SHA256` on Windows or `sha256sum asset/logo.png` on POSIX. Do not alter the logo.

- [ ] **Step 2: Configure failing workspace test discovery**

  Add one smoke test per package importing its public entrypoint. Before entrypoints exist, run `npm test -- --run packages/contracts/test/public-api.test.ts`; expect FAIL for the missing public module, not a silent zero-test success. Keep legacy `src`, `tests` and `evals` excluded from `tsconfig.build.json` and new Vitest include paths.

- [ ] **Step 3: Replace root and workspace configuration**

  Set root package private, `engines.node: ">=24 <25"`, portable Node build script, npm workspaces and no `prepare` script that downloads arbitrary artifacts. Use the owner-facing name `ChessOnGlass`; use a provisional private npm scope `@chessonglass/*` until owner approves publication, rather than claiming a public package name. Root dependency direction is `app → game → perception → chess → contracts`, plus `game/app → platform → contracts`; no reverse imports. Keep `chess.js` only in `packages/chess`. Build each workspace through TypeScript project references or a small Node build script using `child_process.spawn` with argument arrays, never shell command strings.

- [ ] **Step 4: Verify portable workspace and CI**

  Run `npm install`, `npm run typecheck`, `npm run build`, and `npm run test:unit`; expect public entrypoint smoke tests to pass after adding empty documented exports. CI runs on `windows-latest`, `macos-latest`, `ubuntu-latest` with Node 24, checks clean `npm ci`, typecheck/build/unit and fails if a required native integration test is skipped. Do not run hardware or cloud tests in this base job.

- [ ] **Step 5: Commit the verified foundation**

  ```bash
  git add package.json package-lock.json .npmrc .gitignore tsconfig.json tsconfig.build.json vitest.config.ts scripts packages docs/architecture.md docs/rights .github/workflows/ci.yml
  git commit -m "build: establish portable ChessOnGlass workspace"
  ```

## Task 2: Shared identities, frame metadata and bounded mailbox

**Files:**
- Create: `packages/contracts/src/ids.ts`, `packages/contracts/src/positions.ts`, `packages/contracts/src/frames.ts`, `packages/contracts/src/mailbox.ts`, `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/ids.test.ts`, `packages/contracts/test/mailbox.test.ts`

**Interfaces:**

```ts
export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type SessionId = Brand<string, "SessionId">;
export type SourceId = Brand<string, "SourceId">;
export function newSessionId(): SessionId;
export function newSourceId(): SourceId;
export function parseSequence(value: unknown): Sequence;
export type Sequence = bigint;
export type Capabilities = Readonly<{ video: boolean; microphone: boolean; audioOutput: boolean; display: boolean }>;
export type RequestContext = Readonly<{ requestId: string; sessionId: SessionId; positionVersion: number; referenceSequence: Sequence | null }>;
export type Promotion = "q" | "r" | "b" | "n";
export type PositionUncertainty = Readonly<{ castlingRights: boolean; enPassant: boolean; promotion: boolean }>;
export type GamePosition = Readonly<{ initialFen: string; fen: string; history: readonly string[]; uncertainty: PositionUncertainty }>;
export type GameStatus = "needs-position" | "ready" | "waiting" | "confirming" | "uncertain" | "lost" | "paused" | "finished";
export type Frame = Readonly<{
  sessionId: SessionId;
  sourceId: SourceId;
  sequence: Sequence;
  capturedAtMonotonicMs: number | null;
  capturedAtWallMs: number;
  receivedAtMonotonicMs: number;
  bytes: Uint8Array;
  mimeType: "image/jpeg";
}>;
export interface FrameSource {
  readonly capabilities: Capabilities;
  next(signal: AbortSignal): Promise<Frame | null>;
  close(): Promise<void>;
}
export class LatestFrameMailbox {
  constructor(limitBytes?: number);
  offer(frame: Frame): "accepted" | "duplicate" | "out-of-order" | "too-large";
  next(signal: AbortSignal): Promise<Frame | null>;
  close(): void;
}
```

- [ ] **Step 1: Write identity and ordering tests**

  Test `newSessionId()` and `newSourceId()` produce different opaque IDs using `crypto.randomUUID`; `parseSequence("9007199254740993")` preserves the exact bigint; decimals, negatives, unsafe JSON numbers and unknown object keys are rejected. Test the mailbox rejects duplicate and descending sequence per `(sessionId,sourceId)`, does not compare sequences across different sources, replaces an old pending frame with a newer one, and cannot retain over `1_048_576` bytes by default.

- [ ] **Step 2: Run the tests and verify RED**

  Run `npx vitest run packages/contracts/test/ids.test.ts packages/contracts/test/mailbox.test.ts`; expect FAIL because the new modules do not exist.

- [ ] **Step 3: Implement contracts and latest-wins delivery**

  Keep IDs opaque strings; validation lives at boundaries, not by casting untrusted values. A source session begins with sequence zero and increments once per accepted source frame. Store at most one pending frame; `offer` wakes exactly one waiter, `next` aborts promptly, `close` wakes all waiters with `null`, and no unbounded listener/timer is retained. Cross-device `capturedAtMonotonicMs` is `null` until a trusted clock-offset exists; backend `receivedAtMonotonicMs` is always set at receipt.

- [ ] **Step 4: Verify all ordering and shutdown cases**

  Run the two test files, then `npm run typecheck`; expect all tests green and strict BigInt/Uint8Array usage without JSON implicit conversion. Include a frozen-frame test proving repeated sequence cannot be treated as fresh evidence.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/contracts
  git commit -m "feat: add session-aware frame contracts"
  ```

## Task 3: Portable platform services and safe configuration

**Files:**
- Create: `packages/platform/src/services.ts`, `packages/platform/src/paths.ts`, `packages/platform/src/process.ts`, `packages/platform/src/log.ts`, `packages/platform/src/index.ts`
- Test: `packages/platform/test/paths.test.ts`, `packages/platform/test/process.test.ts`, `packages/platform/test/log.test.ts`

**Interfaces:**

```ts
export interface PlatformServices {
  readonly platform: NodeJS.Platform;
  userDataDir(): string;
  readSecret(account: string): Promise<string | null>;
  writeSecret(account: string, secret: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}
export function userDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string;
export function runProcess(file: string, args: readonly string[], options: { signal: AbortSignal; timeoutMs: number; maxOutputBytes: number }): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }>;
export function redactLog(value: unknown): unknown;
```

- [ ] **Step 1: Write failing platform tests**

  Assert `CHESSONGLASS_DATA_DIR` wins only when nonempty; Windows uses `APPDATA/ChessOnGlass`, macOS `~/Library/Application Support/ChessOnGlass`, Linux `XDG_STATE_HOME/ChessOnGlass` or `~/.local/state/ChessOnGlass`; path joining uses `node:path`. Assert process arguments containing spaces/metacharacters remain one argument, timeout aborts, output above `65_536` bytes fails, and no `shell:true` is used. Assert `redactLog` removes authorization/cookie/token/api-key values recursively without mutating input.

- [ ] **Step 2: Run RED**

  Run `npx vitest run packages/platform/test`; expect missing-module failures.

- [ ] **Step 3: Implement small platform primitives**

  Use `envPaths` only if its current pinned version/license is approved; otherwise the specified explicit paths. `runProcess` uses `spawn(file, [...args], {shell:false, windowsHide:true})`, cleans listeners/timers on every exit and kills its owned child on timeout/abort. Secret storage remains an interface; `openExternal` accepts only `http:`/`https:` loopback or explicitly approved external documentation URLs. No automatic plaintext secret fallback.

- [ ] **Step 4: Verify and document secret-store spike requirements**

  Run platform tests and `npm run typecheck`. Document the required Windows Credential Manager/macOS Keychain/Linux Secret Service contract test for later slices; in-memory Linux stores must not be called persistent. No real keychain access occurs in unit tests.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/platform docs/architecture.md
  git commit -m "feat: add portable platform service boundaries"
  ```

## Task 4: Immutable artifact selection and local Stockfish UCI

**Files:**
- Create: `packages/platform/src/artifacts.ts`, `packages/platform/src/uci.ts`
- Test: `packages/platform/test/artifacts.test.ts`, `packages/platform/test/uci.test.ts`

**Interfaces:**

```ts
export type Artifact = Readonly<{ id: "stockfish" | "ffmpeg"; version: string; url: string; sha256: string; os: NodeJS.Platform; arch: string; license: string; sourceUrl: string }>;
export function selectArtifact(records: readonly Artifact[], id: Artifact["id"], os: NodeJS.Platform, arch: string): Artifact;
export function verifyFileDigest(path: string, expectedSha256: string): Promise<void>;
export interface Advisor { best(input: { fen: string; context: RequestContext; signal: AbortSignal }): Promise<{ uci: string; score: { cp?: number; mate?: number } }>; close(): Promise<void>; }
export class UciEngine implements Advisor { static start(executable: string): Promise<UciEngine>; }
```

- [ ] **Step 1: Write artifact and fake-UCI tests**

  Test exact OS/arch match; unknown artifact, mismatched checksum and absent source URL fail closed. Spawn a temporary fake UCI process that answers `uci`, `isready`, `position`, `go movetime 500` and `quit`; verify only a complete legal `bestmove` is returned and malformed/late answers are not consumed by a later request.

- [ ] **Step 2: Run RED**

  Run `npx vitest run packages/platform/test/artifacts.test.ts packages/platform/test/uci.test.ts`; expect missing implementations.

- [ ] **Step 3: Implement bounded process integration**

  Download/install logic is not implicit on `npm install`; artifact acquisition is a later explicit setup task. `verifyFileDigest` streams the file with SHA-256 and does not execute it. UCI requests serialize on one engine, carry request ID and FEN, use `spawn` not shell, impose a deadline and close/restart after timeout before accepting more work. A late response cannot be assigned to a newer FEN.

- [ ] **Step 4: Verify fake and real-engine gates separately**

  Run the fake-UCI tests; then document `npm run test:engine` requiring an approved Stockfish binary from `docs/rights/artifacts.json`. A real-engine release job must fail if the binary is unavailable; no silent `describe.skipIf`.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/platform docs/rights/artifacts.json
  git commit -m "feat: add verified Stockfish process boundary"
  ```

## Task 5: Full chess state and legal-move contracts

**Files:**
- Create: `packages/chess/src/state.ts`, `packages/chess/src/pgn.ts`, `packages/chess/src/index.ts`
- Test: `packages/chess/test/state.test.ts`, `packages/chess/test/pgn.test.ts`

**Interfaces:**

```ts
export class ChessState {
  static initial(): ChessState;
  static fromConfirmed(input: { fen: string; history?: readonly string[]; uncertainty?: Partial<PositionUncertainty> }): ChessState;
  position(): GamePosition;
  legalMoves(): readonly { uci: string; san: string; promotion?: Promotion }[];
  apply(uci: string): GamePosition;
  undo(): GamePosition | null;
  clone(): ChessState;
}
export function toPgn(state: ChessState, names?: { white: string; black: string }): string;
```

- [ ] **Step 1: Write legality and history tests**

  Cover opening, black to move, castling, en passant, all four promotions, checkmate, stalemate, undo and a mid-game FEN with explicit missing-history flags. Assert illegal UCI throws a typed error without mutating prior state, cloning preserves history, and every promotion remains distinguishable even when occupancy is identical.

- [ ] **Step 2: Run RED**

  Run `npx vitest run packages/chess/test`; expect missing state exports.

- [ ] **Step 3: Implement chess.js adapter**

  Keep chess.js behind this package; never expose mutable board internals. Preserve full history separately from current FEN; unknown history cannot be synthesized from an image. `apply` validates before returning the new immutable snapshot. `toPgn` includes starting FEN/history and is deterministic; ambiguity fields are not encoded as false certainty.

- [ ] **Step 4: Verify fixtures and game-over behavior**

  Run tests including the Opera PGN fixture as data only; no copying of legacy implementation. Confirm checkmate/stalemate and documented automatic/claimable draw behavior in tests, with explicit expected results rather than relying on legacy function names.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/chess
  git commit -m "feat: implement history-aware chess rules"
  ```

## Task 6: Typed observation and provider-neutral board reading

**Files:**
- Create: `packages/perception/src/observations.ts`, `packages/perception/src/reader.ts`, `packages/perception/src/index.ts`
- Test: `packages/perception/test/observations.test.ts`, `packages/perception/test/reader.test.ts`

**Interfaces:**

```ts
export type PieceObservation = { square: number; color: "white" | "black" | "empty" | "unknown"; kind: "pawn" | "knight" | "bishop" | "rook" | "queen" | "king" | "unknown"; confidence: number | null };
export type Observation = { context: RequestContext; boardVisible: boolean; handOverBoard: boolean; squares: readonly PieceObservation[]; provider: string; model: string; inputTokens: number; outputTokens: number };
export type ReadFailure = { ok: false; code: "invalid-response" | "unavailable" | "unauthorized" | "cancelled"; message: string; retryable: boolean };
export type ReadResult = { ok: true; observation: Observation } | ReadFailure;
export interface BoardReader { read(input: { frame: Frame; reference: { frame: Frame; position: GamePosition } | null; context: RequestContext; signal: AbortSignal }): Promise<ReadResult>; }
export function parseObservation(value: unknown, context: RequestContext): Observation;
```

- [ ] **Step 1: Write malformed/ambiguous response tests**

  Test 64 unique squares, valid color/kind combinations, empty/unknown cells, numeric confidence only in `[0,1]` or null, no unknown fields, nonnegative finite token counts and exact request context. Reject null, strings, oversized arrays, duplicate squares, NaN/infinite values and wrong context. A hand/occlusion flag never becomes a legal move.

- [ ] **Step 2: Run RED**

  Run `npx vitest run packages/perception/test`; expect missing observation contracts.

- [ ] **Step 3: Implement strict boundary parsing**

  Use explicit field validation without a new schema dependency unless approved in Task 1. Reader implementations must map provider errors into `ReadFailure`, never throw raw provider messages containing secrets into logs. `BoardReader` is transport-neutral; OpenAI/Anthropic adapters belong to the Windows/provider slice and use their official current SDK schemas.

- [ ] **Step 4: Verify invalid-response and cancellation behavior**

  Run tests and typecheck. Assert a provider that ignores abort may finish locally but its caller can classify the result stale by `RequestContext`; no invalid response silently becomes `no_change`.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/perception
  git commit -m "feat: add typed board observation contracts"
  ```

## Task 7: Position candidate and mid-game confirmation editor model

**Files:**
- Create: `packages/chess/src/position-candidate.ts`, `packages/game/src/position-confirmation.ts`
- Test: `packages/chess/test/position-candidate.test.ts`, `packages/game/test/position-confirmation.test.ts`

**Interfaces:**

```ts
export type PositionCandidate = { fen: string; uncertainties: PositionUncertainty; unresolvedSquares: readonly number[] };
export function candidateFromPieces(pieces: readonly PieceObservation[], sideToMove: "w" | "b"): PositionCandidate;
export interface PositionConfirmation {
  review(candidate: PositionCandidate): GamePosition | null;
  confirm(input: { fen: string; history: readonly string[]; uncertainty: PositionUncertainty }): GamePosition;
}
```

- [ ] **Step 1: Write mid-game reconstruction tests**

  Use a known non-opening board with one occluded king, duplicate king, unknown piece type and ambiguous castling rights. Assert unresolved squares remain unresolved, no illegal FEN is accepted and side-to-move is never guessed. A fully known piece layout produces a candidate requiring explicit rights/history confirmation.

- [ ] **Step 2: Run RED**

  Run both new test files; expect FAIL for absent candidate/confirmation APIs.

- [ ] **Step 3: Implement reviewable candidate generation**

  Build only a candidate, never directly a trusted game. `candidateFromPieces` uses validated piece observations and side-to-move input, retains unknown squares/types and marks history-dependent state uncertain. `PositionConfirmation.confirm` is the sole transition to a playable `GamePosition`; the UI/editor later supplies corrected fields.

- [ ] **Step 4: Verify full and partial mid-game paths**

  Run tests proving camera-only occupancy cannot start an arbitrary mid-game and confirmed piece-level layout plus rights can. Assert repeated confirmation does not append phantom moves.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/chess packages/game/src/position-confirmation.ts packages/game/test/position-confirmation.test.ts
  git commit -m "feat: support confirmed mid-game position recovery"
  ```

## Task 8: Legal candidate matching with evidence and promotion ambiguity

**Files:**
- Create: `packages/chess/src/matching.ts`
- Test: `packages/chess/test/matching.test.ts`

**Interfaces:**

```ts
export type MoveCandidate = { uci: string | null; mismatch: number; margin: number; requiresReply: boolean };
export function rankMoves(position: GamePosition, observation: Observation): readonly MoveCandidate[];
export type Evidence = { sequence: Sequence; candidateUci: string | null; margin: number };
export type MoveDecision = { kind: "commit" | "wait" | "confirm" | "no-change" | "uncertain"; uci: string | null; reason: string };
export function decideMove(position: GamePosition, readings: readonly { observation: Observation; candidate: MoveCandidate }[]): MoveDecision;
```

- [ ] **Step 1: Write evidence and promotion tests**

  Assert legal moves are compared to known occupancy, hidden cells do not count as known disagreements, two distinct fresh supporting frames are required, and duplicate/wrong-session readings cannot corroborate. Promotion to queen/rook/bishop/knight returns `confirm` when observation cannot distinguish piece kind. No-confidence, tie, hand-over-board and excessive mismatch do not commit.

- [ ] **Step 2: Run RED**

  Run `npx vitest run packages/chess/test/matching.test.ts`; expect FAIL for absent matcher.

- [ ] **Step 3: Implement bounded candidate scoring**

  Enumerate legal moves via `ChessState`; score known cells only. Use stable candidate ordering and retain runner-up margin. `decideMove` consumes chronological, validated, unique observations and the current position version; automatic commit follows the owner-approved “clear automatic, ambiguous ask” rule. Thresholds are configuration constants with baseline comments, not claimed calibrated accuracy.

- [ ] **Step 4: Verify lookahead and no-hallucination cases**

  Test an opponent reply visible before confirmation, recapture on one square and multiple moves between reads; only the current legal move is committed at a time, unresolved history becomes confirmation instead of invented PGN. Run all chess tests.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/chess/src/matching.ts packages/chess/test/matching.test.ts
  git commit -m "feat: match observations to corroborated legal moves"
  ```

## Task 9: Local optional pre-filter and bounded provider cost ledger

**Files:**
- Create: `packages/perception/src/prefilter.ts`, `packages/game/src/budget.ts`
- Test: `packages/perception/test/prefilter.test.ts`, `packages/game/test/budget.test.ts`

**Interfaces:**

```ts
export interface PreFilter { inspect(frame: Frame, reference: Frame | null): Promise<"read" | "wait" | "uncertain">; }
export class PeriodicFullReadFilter implements PreFilter { constructor(maxConsecutiveWaits?: number); }
export type Price = { inputPerMillion: number; outputPerMillion: number; effectiveAt: string };
export class CostLedger {
  constructor(limitUsd: number, reservePerCallUsd: number);
  reserve(requestId: string, price: Price): { allowed: boolean; reason: string | null };
  settle(requestId: string, inputTokens: number, outputTokens: number, price: Price): void;
  release(requestId: string): void;
  snapshot(): { reservedUsd: number; actualUsd: number; paused: boolean };
}
```

- [ ] **Step 1: Write gate and budget tests**

  Assert no gate is required, failed local gate yields a full read, consecutive waits force a full read, and pending confirmation cannot be skipped. Assert unknown price blocks paid work by default, two reservations share the same cap, `settle` is idempotent and cancel/release frees the reservation. Test `0`, negative, NaN and infinite settings are rejected.

- [ ] **Step 2: Run RED**

  Run both test files; expect missing prefilter and ledger.

- [ ] **Step 3: Implement conservative cost control**

  `PeriodicFullReadFilter` is a local, replaceable heuristic with no TypeSafe/Jev dependency. Ledger conservatively reserves before each cloud request, reconciles actual reported usage afterward and reports estimated spend; the UI must label it as not a guaranteed invoice ceiling. Persist no API keys or raw provider payloads in the ledger.

- [ ] **Step 4: Verify budget race and exhaustion cases**

  Run tests including a request finishing after pause and a locator consuming the same ledger; ensure exhausted budget prevents new work but does not fabricate a refund for an already-completed call.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/perception/src/prefilter.ts packages/perception/test/prefilter.test.ts packages/game/src/budget.ts packages/game/test/budget.test.ts
  git commit -m "feat: add optional local filtering and shared cost control"
  ```

## Task 10: Atomic position journal and resumable session records

**Files:**
- Create: `packages/game/src/journal.ts`, `packages/game/src/storage.ts`
- Test: `packages/game/test/journal.test.ts`, `packages/game/test/storage.test.ts`

**Interfaces:**

```ts
export type GameRecord = { schemaVersion: 1; sessionId: SessionId; position: GamePosition; positionVersion: number; createdAtWallMs: number; updatedAtWallMs: number };
export interface GameStore { load(sessionId: SessionId): Promise<GameRecord | null>; append(record: GameRecord): Promise<void>; exportPgn(sessionId: SessionId): Promise<string>; delete(sessionId: SessionId): Promise<void>; }
export class FileGameStore implements GameStore { constructor(rootDirectory: string); }
```

- [ ] **Step 1: Write journal/recovery tests**

  Assert a committed move and PGN share the same version, partially written JSON is never loaded as valid state, a failed rename retains the previous valid record, duplicate commits do not append twice and frame retention defaults off. A loaded game whose physical board may have changed requires confirmation.

- [ ] **Step 2: Run RED**

  Run `npx vitest run packages/game/test/journal.test.ts packages/game/test/storage.test.ts`; expect missing storage APIs.

- [ ] **Step 3: Implement confined atomic storage**

  Use canonical session IDs mapped to fixed filenames, not user-provided paths. Write a temporary sibling, flush/close and rename to the versioned record; never follow untrusted symlinks. Store schema version, history, uncertainty and ordered moves. No frame JPEGs are written unless an explicit export/record-frames setting is enabled.

- [ ] **Step 4: Verify interrupted-write and deletion behavior**

  Run tests for invalid JSON, duplicate session IDs, `..` path input, deletion of only the selected session and no retention of secrets/raw images. Run typecheck.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/game/src/journal.ts packages/game/src/storage.ts packages/game/test
  git commit -m "feat: persist resumable game state safely"
  ```

## Task 11: Single-writer coordinator and stale-result rejection

**Files:**
- Create: `packages/game/src/coordinator.ts`, `packages/game/src/commands.ts`, `packages/game/src/replace-source.ts`, `packages/game/src/index.ts`
- Test: `packages/game/test/coordinator.test.ts`, `packages/game/test/coordinator-races.test.ts`

**Interfaces:**

```ts
export type GameCommand =
  | { type: "pause" | "resume" | "undo" | "repeat" }
  | { type: "new-game"; initial: GamePosition | null }
  | { type: "manual-move"; uci: string }
  | { type: "choose-promotion"; promotion: Promotion }
  | { type: "confirm-position"; position: GamePosition };
export type GameSnapshot = { sessionId: SessionId; positionVersion: number; status: GameStatus; position: GamePosition | null; suggestion: Result | null; frameAgeMs: number | null; error: string | null };
export type Result = { context: RequestContext; moveUci: string | null; spokenText: string | null; status: GameStatus; reason: string | null };
export class GameCoordinator {
  constructor(dependencies: { reader: BoardReader; advisor: Advisor; store: GameStore; ledger: CostLedger; sink: { publish(result: Result): Promise<void> } });
  start(source: FrameSource, initial: GamePosition | null): Promise<void>; // starts owned work and resolves after initial state is published
  replaceSource(source: FrameSource, initial: GamePosition | null): Promise<void>;
  dispatch(command: GameCommand): Promise<void>;
  snapshot(): GameSnapshot;
  subscribe(listener: (snapshot: GameSnapshot) => void): () => void;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write deterministic asynchronous race tests**

  Use deferred fake readers/advisors. Assert `pause` prevents new reads even while an old provider promise is unresolved; undo/new-game/source replacement increments the position/session epoch; late observation, engine response and queued speech from the old context are dropped. A provider that ignores `AbortSignal` cannot change the new game.

- [ ] **Step 2: Run RED**

  Run both coordinator tests; expect missing coordinator and context mismatch failures.

- [ ] **Step 3: Implement one authoritative state writer**

  Only the coordinator applies moves, confirmation, suggestion and journal writes. Capture and inference may run independently, but results carry `RequestContext` and are checked immediately before mutation/publish. `new-game`, `undo`, `manual-move`, promotion selection and source replacement invalidate pending work and clear stale sink outputs. `close` aborts work, closes source and waits for owned tasks within a bounded shutdown.

- [ ] **Step 4: Verify normal play and owner-approved confirmation**

  Test initial confirmed game, mid-game candidate requiring confirmation, two fresh clear observations auto-commit, ambiguous observation requires user confirmation, suggestion validates legal UCI, user may play a different legal move and game-over stops new paid calls. Run `npm test -- --run packages/game/test`.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/game packages/contracts/src/frames.ts
  git commit -m "feat: coordinate cancellable game sessions safely"
  ```

## Task 12: Result sinks and output lifecycle

**Files:**
- Create: `packages/game/src/results.ts`
- Test: `packages/game/test/results.test.ts`

**Interfaces:**

```ts
export interface ResultSink { publish(result: Result): Promise<void>; clear(context?: RequestContext): void; close(): Promise<void>; }
export class CompositeResultSink implements ResultSink { constructor(sinks: readonly ResultSink[]); }
export class QueuedTextSink implements ResultSink { constructor(speak: (text: string, signal: AbortSignal) => Promise<void>); }
```

- [ ] **Step 1: Write sink ordering/cancellation tests**

  Assert results for one position retain order, clear removes unstarted old-position text, an unavailable sink is reported without losing chess state, and an already-playing utterance cannot be falsely reported as unheard/cancelled when the backend lacks that ability.

- [ ] **Step 2: Run RED**

  Run `npx vitest run packages/game/test/results.test.ts`; expect missing sink implementation.

- [ ] **Step 3: Implement bounded output composition**

  Keep `Result` structured; UI, audio, file and future glasses clients independently select output. Queue length is bounded and old contexts are discarded before starting. TTS is an injected function; no `say`, BlackHole or OS command appears in the core.

- [ ] **Step 4: Verify shutdown and no-stale-output cases**

  Run results and coordinator-race tests together. `close` stops accepting new outputs and resolves/cancels owned queue work; no pending output can target a replaced session.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/game/src/results.ts packages/game/test/results.test.ts
  git commit -m "feat: add session-bound result output sinks"
  ```

## Task 13: Free-running evaluation without answer-key recovery

**Files:**
- Create: `packages/game/src/evaluation.ts`, `packages/game/src/cli-evaluate.ts`
- Test: `packages/game/test/evaluation.test.ts`
- Create: `fixtures/evaluation/README.md`

**Interfaces:**
- Add root `test:engine` and `eval` scripts; `eval -- --simulate` runs only deterministic local fixtures.

```ts
export type TruthMove = { observedAtMonotonicMs: number; uci: string };
export type EvaluationMode = "free-running" | "oracle-assisted";
export type RecordingOutcome = { committed: readonly string[]; manualInterventions: number; recoveryMs: readonly number[]; resultTimesMs: readonly number[] };
export interface RecordingRunner { run(frames: readonly Frame[], initial: GamePosition | null, diagnosticTruth?: readonly TruthMove[]): Promise<RecordingOutcome>; }
export function evaluateRecording(input: { frames: readonly Frame[]; truth: readonly TruthMove[]; initial: GamePosition | null; mode: EvaluationMode; runner: RecordingRunner }): Promise<{ committed: readonly string[]; falseCommits: number; missedMoves: number; duplicateMoves: number; latencyMs: readonly number[] }>;
```

- [ ] **Step 1: Write oracle-isolation tests**

  Build a fake recording with a wrong observation followed by a correct board. In `free-running`, prove inference/recovery cannot read `truth`, cannot reset to a future PGN position and reports false/missed moves. In `oracle-assisted`, explicitly label a diagnostic reset and do not mix its metrics into free-running.

- [ ] **Step 2: Run RED**

  Run `npx vitest run packages/game/test/evaluation.test.ts`; expect missing evaluator.

- [ ] **Step 3: Implement separated scorer and corpus manifest**

  `evaluateRecording` passes truth to `runner.run` only in `oracle-assisted` mode and omits `diagnosticTruth` in `free-running`; its `RecordingRunner` implementation never receives an answer-key channel in free-running. Truth is retained by the outer scorer. Truth and frame observations share the recorder/backend monotonic clock domain; `observedAtMonotonicMs` is not a foreign device clock. Report committed sequence, false/missed/duplicate moves, manual interventions, recovery time and p50/p95 latency; no cherry-picked legacy three-move claim. `fixtures/evaluation/README.md` documents consent, full-game/session splits, timestamped moves, adverse cases and non-commercial dataset restrictions.

- [ ] **Step 4: Verify replay determinism and held-out protocol**

  Run the test twice and assert identical fake results. Add corpus-manifest validation that rejects frames from one recording appearing in both train and holdout. No paid eval runs in normal CI; real model/hardware results are separately labeled.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/game/src/evaluation.ts packages/game/src/cli-evaluate.ts packages/game/test/evaluation.test.ts fixtures/evaluation/README.md
  git commit -m "test: add oracle-free recording evaluation"
  ```

## Task 14: Core acceptance, permission checkpoint and legacy inventory

**Files:**
- Modify: `docs/architecture.md`, `docs/rights/provenance.md`, `README.md`, `DESIGN.md`
- Create: `docs/legacy-replacement.md`, `scripts/check-brand.mjs`

**Interfaces:**
- Produces: an explicit legacy-to-new module inventory and commands proving the new local core independently of WhatsApp/macOS.

- [ ] **Step 1: Write failing acceptance checks**

  `check-brand.mjs` verifies logo SHA-256 matches the recorded value, workspace metadata does not claim the original author or an unapproved npm publisher, no runtime import references `src/macos.ts`, `src/speak.ts` or legacy `src/`, and no log contains dummy secret markers used in tests. `docs/legacy-replacement.md` lists every original `src/` file with `replaced-by`, `contract-test`, `parity-status`, `removal-approved:false`; no silent removal.

- [ ] **Step 2: Run RED and full verification**

  Run `node scripts/check-brand.mjs`; expect it to fail until the new inventory/brand checks are complete. Then run `npm ci`, `npm run typecheck`, `npm run build`, `npm run test:unit`, `npm run test:engine` with an approved engine fixture, and `npm run eval -- --simulate` using the root alias defined in Task 13. Expect all required checks to run, not skip silently.

- [ ] **Step 3: Complete local-core acceptance and limitations**

  Document tested OS/runtime, actual engine version/hash, fake versus real AI coverage, missing native camera/UI/overlay, permission evidence still required and unfinished security audit. Update user-facing README/DESIGN to describe only the new implemented path; do not retain unsupported WhatsApp/macOS claims as current behavior.

- [ ] **Step 4: Review before any legacy deletion or publication**

  Obtain owner confirmation of attribution/permission evidence and local core parity. Do not delete legacy code, rewrite history, publish npm, push or merge automatically. Commit only the reviewed source/docs checkpoint.

- [ ] **Step 5: Commit**

  ```bash
  git add packages scripts docs README.md DESIGN.md fixtures/evaluation/README.md
  git commit -m "test: verify portable ChessOnGlass game core"
  ```

## Slice exit criteria

- [ ] New workspace builds on all three CI operating systems, with real Windows development verification recorded.
- [ ] Legal chess state, mid-game confirmation, all promotions, session/freshness, cancellation, cost reservation and durable journal are covered by executable tests.
- [ ] `free-running` evaluation never reads truth for recovery.
- [ ] No new runtime depends on WhatsApp, BlackHole, Jev, macOS or a hosted backend.
- [ ] No camera, overlay, real AI, hardware, public security or license-clearance claim is made by this slice alone.
- [ ] Continue to `2026-11-08-02-windows-user-journey.md` only after Tasks 1–14 pass and the shared interfaces remain unchanged or all dependent plans are updated together.
