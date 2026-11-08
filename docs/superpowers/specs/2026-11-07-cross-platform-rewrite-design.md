# ChessOnGlass cross-platform rewrite — design

Date: 2026-11-07; scope answers confirmed 2026-11-08. Status: **approved by owner 2026-11-08 for implementation planning**.

## Intent and scope

Rewrite all product code for ChessOnGlass as a supported, branded, cross-platform chess assistant rather than a WhatsApp/macOS demo. Preserve `asset/logo.png` byte-for-byte; the asset is not a dependency to download, modify, redraw, or regenerate. Use ChessOnGlass branding for user-facing UI, executable, package metadata and release artifacts. The npm package name, publisher identity and final license are not yet decided.

The owner selected approach **B**: a complete rewrite with permission/attribution handled as a release gate, not preserving code merely because it already exists. Every legacy module is either replaced by a new implementation and contract tests or deliberately removed with the obsolete workflow. `src/macos.ts` is not generalized with more platform conditionals; OS services are injected behind interfaces.

## Goals

1. Windows x64 is the first supported reference host; macOS and Linux receive native integrations and clean-machine verification before being marked supported.
2. One local-first core accepts local camera/replay and later network/device adapters; WhatsApp and Meta are optional integrations, not architectural prerequisites.
3. Camera, microphone, audio playback and display are separate capabilities; a camera-only device can use a different output device.
4. Premium cloud vision is allowed. Supporting software must not require a second paid service; Jev is optional, never required. Stockfish and chess legality remain local.
5. Support direct audio/text results without a virtual microphone; virtual-mic routing is optional and subject to driver/license/runtime gates.
6. Replace sequential, stale-prone, under-tested orchestration with bounded, cancellable, session-aware processing.
7. Deliver a useful branded dashboard, recoverable game state, overlay video, PGN and testable evaluation workflow.
8. Preserve behavior as a testable product contract, not as a promise that legacy bugs, undocumented benchmark results or all third-party SDK APIs are compatible.

## Non-goals and anti-goals

- No assertion that every glasses model, camera, call app, Linux desktop, browser or phone works without an adapter and hardware evidence.
- No optical world-locked AR promise. Overlay-on-video and in-glasses text HUD are separate capabilities; camera–display–eye calibration is a later project.
- No mandatory Docker Desktop, hosted backend, account system, custom chess engine, custom VLM training, React framework, Electron rewrite or media-server stack.
- No universal free-call-app audio injection. WhatsApp/other calling applications are only sources or sinks where an authorized path is verified.
- No bypass of OS security, driver-signing requirements, certificate warnings, firewall protections or provider restrictions.
- No use for covert rated/tournament assistance; friendly consensual training and accessible/recorded games are the supported context.
- No automatic deletion of legacy source, history, notices or user data. Deleting the original implementation after the replacement passes is a separate reviewed operation.

## Rights, provenance and release boundary

The user selected B, but no license/permission document was supplied in this planning session. Selecting B is not a legal conclusion. The original repository has no LICENSE file and the legacy `package.json` identifies `picklerpeej` as author.

- Keep a rights register naming original source/version, origin of the copy, permission, permitted modifications, notices and distribution constraints.
- Preserve required notices and attribution; do not claim copyright of pre-existing code merely because it is rewritten, renamed or published privately.
- Do not create a LICENSE assigning third-party rights. Choose the owner’s new-project license only after rights and all shipped components have been reviewed.
- Treat ideas/functional requirements separately from copied implementation. This is a risk-reduction workflow, not a warranty of copyright clearance.
- Before public distribution, complete the rights/provenance review; consult counsel for commercial/high-stakes distribution.
- Inventory every dependency and binary by version, OS, architecture, source hash, build flags, license, redistribution rights, source offer and branding terms. This includes FFmpeg, Stockfish, AI SDKs and optional drivers.
- No paid default supporting tools. VB-CABLE is not the universal free default. BlackHole source licensing does not automatically grant installer redistribution.
- **Owner decision 2026-11-08:** pilot/source and development or self-signed packages are acceptable with explicit security warnings and no bypass instructions. Do not promise warning-free production signing for free; production signing/notarization may be a separately funded release milestone.
- Research source: `research/16-derivative-rights.md` and `research/RESEARCH.md`.

## Approaches considered

### Selected: new modular TypeScript core with narrow platform/device adapters

Retain the public behavior that matters, not the legacy implementation. Write new modules in place only behind an explicit rewrite boundary; tests use fakes at external boundaries and real integrations in CI. Windows is delivered first without forking the core for other operating systems. This makes device and OS changes independent of chess state and cost policy.

Trade-off: more upfront contract work than replacing a few OS commands, but less risk of silently changing state, privacy or pricing behavior.

### Rejected as main path: incremental port of the current application

It would leave legacy orchestration, model coupling, stale overlay corners and OS assumptions in place. Small isolated fixes do not meet the owner’s complete-rewrite requirement.

### Rejected as main path: new desktop/mobile native application before proving the core

A native phone or desktop shell does not solve frame quality, session correctness or device support. It also creates extra release surfaces before the shared behavior is stable.

## Product deployment model

### Local-first runtime

- Node.js 24 LTS, TypeScript strict, ESM, npm workspaces for explicit core/adapters/app boundaries.
- Backend runs native on the reference desktop. Docker is an optional developer/server packaging path, not a required dependency and not a camera/audio security bypass.
- A browser dashboard is served locally with Vite-built TypeScript/CSS/static assets. No required hosted web service.
- Windows-first interactive dashboard starts via CLI; packaged native launchers are a later release deliverable, not a prerequisite to test the engine.
- The backend owns cloud credentials. Never ship provider keys to cameras, IoT clients or public browser bundles.
- Network exposure is off by default. Localhost control has explicit session-bound anti-CSRF authorization; LAN exposure requires separate authenticated pairing and trusted transport configuration.

### External boundaries

1. `FrameSource`: local browser webcam, replay, desktop window capture, network ingress or device SDK.
2. `BoardReader`: strong AI provider with a typed observation result; provider adapters translate only transport, authentication and response envelopes.
3. `ChessRules`: chess.js legal move generation, move application, full state/history and PGN.
4. `Advisor`: Stockfish UCI; validates output against current chess state.
5. `ResultSink`: structured results for dashboard/audio/display/file; text, TTS, video overlay and future glasses HUD are independent sinks.
6. `PlatformServices`: secret storage, user-data paths, browser opener, sleep policy, permissions and native executables.
7. `CaptureBackend`: webcam/replay/desktop adapters; not all require the same OS API.

### No hidden mandatory services

Local `node:http`, UCI and one cloud vision provider are sufficient for the first useful path. `ws` is introduced only for the network-ingest phase. MediaMTX/aiortc/RTSP/WebRTC are not in the base installation. FFmpeg is required only for replay/video export, with a recorded license/build review. Sharp is limited to bounded image processing/overlay composition.

## Domain contracts

These contracts are design targets, not claims that they exist today. Exact names are fixed for the implementation plan.

```ts
type Brand<T, Name extends string> = T & { readonly __brand: Name };
type SessionId = Brand<string, "SessionId">;
type SourceId = Brand<string, "SourceId">;
type Sequence = bigint;

type Capabilities = {
  video: boolean;
  microphone: boolean;
  audioOutput: boolean;
  display: boolean;
};

type Frame = {
  sessionId: SessionId;
  sourceId: SourceId;
  sequence: Sequence;
  capturedAtMonotonicMs: number | null;
  capturedAtWallMs: number;
  receivedAtMonotonicMs: number;
  bytes: Uint8Array;
  mimeType: "image/jpeg";
};

type RequestContext = {
  requestId: string;
  sessionId: SessionId;
  positionVersion: number;
  referenceSequence: Sequence | null;
};

type PositionUncertainty = {
  castlingRights: boolean;
  enPassant: boolean;
  promotion: boolean;
};

type GamePosition = {
  initialFen: string;
  fen: string;
  history: readonly string[];
  uncertainty: PositionUncertainty;
};

type PieceObservation = {
  square: number;
  color: "white" | "black" | "empty" | "unknown";
  kind: "pawn" | "knight" | "bishop" | "rook" | "queen" | "king" | "unknown";
  confidence: number | null;
};

type Observation = {
  context: RequestContext;
  boardVisible: boolean;
  handOverBoard: boolean;
  squares: readonly PieceObservation[];
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

type GameStatus = "needs-position" | "ready" | "waiting" | "confirming" | "uncertain" | "lost" | "paused" | "finished";

type Result = {
  context: RequestContext;
  moveUci: string | null;
  spokenText: string | null;
  status: GameStatus;
  reason: string | null;
};
```

- The backend issues cryptographically random, opaque session IDs. Sequence numbers are unique and strictly increasing per `(sessionId, sourceId)`. Duplicate, malformed, wrong-session or unauthorized frames are rejected, never counted as fresh evidence.
- Monotonic time measures freshness within one trusted clock domain; wall time is display metadata only. Browser/phone/IoT monotonic timestamps are not assumed comparable with the backend. Cross-device capture-to-receipt latency requires explicit clock-offset estimation with measured uncertainty; otherwise freshness uses backend receipt time and one-way latency is reported unknown. `receivedAtMonotonicMs` never masquerades as actual camera capture time.
- Vision, geometry, Stockfish and queued result sinks share `RequestContext`. A result can update state only if request ID, session, position version and reference still match the active request. Cancellation is best effort; the identity check is mandatory even if a provider ignores cancellation.
- Camera/audio/display capabilities are independent. Unsupported capabilities are disabled with actionable explanations, not silently substituted.
- Source lifecycle is `idle → starting → live → reconnecting → stopped`; a stopped/replaced source invalidates its session. Reconnect never reuses old sequence evidence.
- A single bounded latest-frame mailbox replaces older frames under load; request queues, body size, decoded pixel count, connection count, processing time and log retention all have explicit limits.

## Chess, perception and temporal correctness

### Game state

- A position includes FEN plus verified move history and unresolved promotion/rights uncertainty. A single image cannot establish castling rights, en-passant rights or promotion type; initial/interrupted games request the missing information.
- **Owner decision 2026-11-08:** the first release must support camera-based mid-game continuation. Piece-level observations plus a reviewable position editor supply the candidate board; the user confirms position, side to move and unavailable castling/en-passant/history information before tracking starts. An occupancy-only answer cannot silently resume an arbitrary mid-game.
- **Owner decision 2026-11-08:** automatically commit only moves corroborated by separate fresh frames and meeting the measured confidence policy; ask for confirmation whenever confidence, identity, piece type, promotion or history is ambiguous. Do not require confirmation of every clear move.
- `needs-position` requires confirmation of the starting position. `uncertain` pauses suggestions until an allowed recovery or explicit user action. `lost` never silently continues PGN or suggestions as if correct.
- All four promotion choices are supported. Occupancy-only ambiguity requires explicit choice; no default queen promotion.
- The tracker compares legal candidate observations with known position. Separate fresh frames are required; repeated sequence numbers and frozen frames cannot add confidence.
- A move application and its PGN persistence have a consistent ordered journal. Recovery cannot invent history. Resume marks the saved position pending user confirmation where the physical board may have changed.
- Evaluation has separate **free-running** and **oracle-assisted diagnostics** modes. Free-running inference and recovery cannot access ground-truth PGN. The scorer receives it only after predictions.

### Vision and geometry

- The premium vision model reports observations with uncertainty; it does not directly choose Stockfish’s move, mutate files, invoke tools or create FEN history from an ambiguous image.
- Provider schemas validate all fields and bounds. Invalid responses become `uncertain`, never implicit empty boards or zero-cost successes.
- Local geometry aligns the board and rejects invalid/degenerate/non-finite homographies. A homography handles the board plane, not piece parallax or occlusion.
- Fast preview/tracking is separate from slower model inference. Optical flow/local change detection is optional until a measured spike establishes a reliable configuration; do not require OpenCV for the baseline.
- Board locator and suggestion outputs have frame identity and freshness. Invalid, stale or low-confidence geometry hides the on-board overlay while retaining a clearly labeled state message.
- A later measured optimizer may crop/align images and send fewer model requests, but periodic independent full-board reads and manual correction remain available.

### Concurrency and cancellation

- Commands are accepted independently of the vision call and applied by a single state writer at defined boundaries. Pause takes effect immediately for new work; it does not pretend an already-paid provider request never happened.
- The coordinator uses request IDs and session/position epochs. Undo, new game, source replacement, loss and shutdown invalidate pending work and queued speech/results for the old state.
- Engine requests include FEN identity and a bounded search duration. A late engine response cannot become the suggestion for a different position. A timed-out engine is stopped/restarted before reuse.
- Cloud calls have explicit timeout/retry budgets and cancellation where supported. Only transient errors are retried; no retry on persistent authentication/model errors.
- Shared ledger covers vision, locator and optional gates. Reserve conservative request budgets before work, reconcile actual usage afterward and show that billing caps are estimates, not a guaranteed provider invoice ceiling. Unknown model prices cannot silently count as zero.

## Platform integrations

### Windows first

- Webcam/replay first: local browser `getUserMedia` for a device chosen by the user; FFmpeg for supported replay formats.
- Desktop window capture uses Windows Graphics Capture behavior through a maintained Node-compatible backend after a supported-version spike. The baseline does not promise minimized/occluded/RDP behavior. Window selection requires user consent and shows the target preview.
- Windows TTS uses a supported System.Speech/native bridge or a maintained equivalent after a voice-availability check. Do not assume a Vietnamese voice exists; list/test voices and retain text output.
- Secret storage uses a maintained native credential-store binding, with no silent plaintext fallback. Linux in-memory-only stores are not labeled persistent.
- Stockfish/FFmpeg use per-OS/per-architecture immutable artifacts with SHA-256 and provenance. No generic macOS-only archive or executable search behavior is presented as cross-platform.
- Portable Node build scripts replace POSIX `rm`, `cp`, `chmod`, `open` and archive assumptions.

### macOS and Linux

- macOS ScreenCaptureKit and `say`/native speech are adapters. WhatsApp/BlackHole support is optional and separate from core.
- Linux capture distinguishes X11 and Wayland. Use portal/PipeWire where appropriate; unsupported combinations are reported, not forced through an incompatible Windows/macOS path.
- Linux TTS uses available speech-dispatcher/espeak-ng or a user-selected supported service; absent voices degrade to text, not an unapproved network TTS service.
- Linux PipeWire/PulseAudio virtual routing is optional. No default system audio-stack migration.

### Calls and devices

- Generic desktop capture allows an authorized window from a calling app selected by the user; this does not promise audio injection into that app.
- WhatsApp is one optional preset, not the product’s only path. Other call apps are named supported only after video and return-path tests.
- Network JPEG input is the first device-independent extension, using bounded authenticated sessions. Add RTSP for existing IP cameras and WebRTC for demonstrated duplex needs; never install both by default.
- Meta DAT, Brilliant Frame and ESP32/IoT adapters declare their actual capabilities. A device that cannot produce video or receive output is not marked supported.
- **Owner decision 2026-11-08:** Gate 2 must deliver the overlay both on the dashboard source preview and as an exported overlay video. An always-on-top desktop window is not in the first scope. In-glasses HUD/display support is a separate adapter and does not imply world-locked AR.

## Dashboard and branding

- Use ChessOnGlass name and the unchanged `asset/logo.png` in UI and packaged assets. No change to its pixels, filename or content.
- Replace legacy static HTML with a Vite-built, typed UI. No backend HTML strings containing unescaped game/provider data. State moves and logs use safe DOM/text APIs; SVG board generation validates and escapes dynamic content.
- One primary game surface: source preview, tracked position, status, suggestion, next required action, connection/freshness, cost and move history. Separate setup/diagnostics and advanced settings; no redundant stacked controls.
- All important operations have idle/active/success/error/empty/unsupported states. Provide pause, repeat, undo, manual move, new game, explicit promotion choice and recovery confirmation.
- Show when an image is old, model is working, board is uncertain, source disconnected, output is unavailable or saved game needs confirmation.
- Responsive desktop and narrow-screen layout with keyboard-accessible controls and non-color-only status indicators. Browser automation verifies the golden path and edge states.

## Local and network security

- Bind dashboard/control APIs to loopback by default. Use unguessable per-run authorization for controls, bind requests to that session and intended origin, and do not accept `null` or arbitrary origins.
- Require `Content-Type: application/json`, a finite Content-Length/body ceiling and request/read timeouts. Stop reading after the limit and safely terminate the bounded request. Protect mutation paths against missing/cross-site origins without treating Origin as user authentication.
- Serve a restrictive Content Security Policy, `X-Content-Type-Options: nosniff`, appropriate referrer policy and no-store on private frame/state responses. Browser preview uses HTTPS when required by `getUserMedia` outside localhost.
- LAN is a distinct mode: explicit opt-in, short-lived single-use pairing code, desktop confirmation, per-device revocable token, transport trust and authenticated result/control scopes. A QR code alone is not TLS or authorization.
- Network ingress enforces path/origin/token binding, binary type/length, metadata schema, sequence/session checks, connection quotas, backpressure, ping timeout and cleanup. Use `ws` only for this extension, with bounded payload and queued-byte handling verified in its current documentation.
- Keep logs free of API keys, bearer/pairing tokens, raw query credentials and unnecessary image data. Secret error messages are sanitized at the logging boundary.
- Retention defaults to events and PGN without frame images; frame capture/export is an explicit operator choice. Provide delete/export and show the actual retention setting. Never send unrelated windows or entire desktops to the cloud by default.
- No public Internet deployment until authenticated transport, deployment threat model and rate/cost limits are verified. TURN/remote access is out of the base release.

## Packaging and release engineering

- npm workspaces: `packages/contracts`, `packages/chess`, `packages/perception`, `packages/game`, `packages/platform`, `packages/app`, `packages/ui` only where needed; do not create a package for every tiny function. A small dependency direction is documented and enforced.
- Pin exact dependency versions/lockfile, native binary version/hash/provenance and supported OS/architecture matrix. No unreviewed `latest`, floating download or implicit global Stockfish/FFmpeg.
- CI builds and type-checks on Windows, macOS and Linux; tests use real engine and media executables where applicable. Skipped native tests fail the relevant release job rather than silently reporting coverage.
- Run unit, contract, integration, replay-free-running, local HTTP security and browser golden-path tests. Real cloud and real-device tests are separately labeled, optional paid/manual jobs.
- Provide one command per development setup, `doctor` capability report and test path, then native packaging/installer for the selected reference host. Docker optional.
- Each task lands as a small reviewed commit. Do not push/merge/publish merely because the plan says to commit; explicit owner approval is required for those shared-state actions.
- Remove legacy modules only after their replacements and relevant tests pass. Preserve the legacy revision/reference and do not rewrite history.

## Validation and release gates

### Gate 0 — baseline and permission

- Record original revision, permission evidence, license/notice inventory, existing test/build results and unverified claims.
- Obtain consented full-game recordings with move timestamps and adverse cases. Test/holdout split by complete game/session, not adjacent frames.
- Establish a Windows reference environment and named hardware/browser matrix.

### Gate 1 — useful Windows local application

- Clean install/setup works on a reference Windows machine.
- Webcam and replay → vision observation → legal move → Stockfish → dashboard/TTS/text works without WhatsApp, BlackHole or Jev.
- Logo and package/CLI/UI identity are ChessOnGlass; no npm publication occurs before name/publisher approval.
- Golden-path browser test and a real model/engine smoke test pass. The latter is never implied by mocks.

### Gate 2 — robust game and overlay

- Session identity, stale-result rejection, cancellation, pause/reset, frozen/duplicate/out-of-order frames, all promotions and lost-track recovery pass.
- Free-running evaluation uses no PGN oracle. Publish false/missed/duplicate moves, manual interventions, latency p50/p95, cost, memory and recovery time on a held-out corpus.
- Invalid/stale geometry hides overlay; no false “live” state when video is frozen.
- Thresholds are fixed after baseline and before holdout evaluation; no unmeasured “real-time” or “fully accurate” claims.

### Gate 3 — cross-platform support

- Windows/macOS/Linux CI passes with actual native integration checks, not only a shared TypeScript build.
- Each supported OS receives clean-machine install, source selection, native audio, credential storage, executable loading and upgrade/uninstall tests.
- Unsupported Linux display/audio configurations are explicitly documented.

### Gate 4 — devices, security and pilot

- Two different source types use the same core without source-specific chess logic.
- Pairing expiry/reuse/revocation, unauthorized requests, body/connection limits, reconnect isolation and no-secret-log checks pass.
- Phone camera, if shipped, has an explicit trusted-HTTPS/companion choice and foreground/background tests.
- External pilot users complete setup, a full game and recovery without developer intervention. Known limits are published.
- Rights, third-party notices, artifact hashes and corresponding-source requirements pass before distribution.

## Delivery slices

1. **Foundation and brand:** workspace, contracts, CI, native paths/secrets/processes, unchanged logo, replacement metadata and legacy behavior matrix.
2. **Playable local core:** chess/history, observation parsing, Stockfish, bounded state coordinator, PGN and free-running eval.
3. **Windows user journey:** webcam/replay, dashboard, native TTS/text, settings/doctor, local authorization, full smoke tests.
4. **Perception/overlay:** geometry validation, freshness, tracking spike, safe overlay, benchmark and budget controls.
5. **macOS/Linux:** native services/capture/audio/installers and support-matrix evidence.
6. **Network/devices:** authenticated JPEG sessions, output clients, capability adapters and second-source proof.
7. **Optional integrations/release:** call-app audio routing, Meta/Frame/ESP32, RTSP/WebRTC if required, package/release/pilot and removal of legacy implementation.

Detailed implementation planning should be split into executable plans by these slices, not one unreviewable rewrite commit. Slice 1–3 form the first usable Windows release; later slices must not be implied complete by their design presence.

## Builder decisions left open

- Exact npm package scope/name, publisher, public/private distribution and license after rights review.
- The actual author permission document and required attribution/notice wording.
- Node-compatible WGC binding and native secret-store/TTS implementation selected by a Windows spike with pinned versions.
- Exact performance/cost thresholds after baseline, before holdout evaluation.
- First phone client approach (trusted PWA versus native companion) and first physical glasses model.
- Vietnamese TTS availability and quality on each supported device.
- Whether frame-image retention is enabled by an operator; default is off.
- Which legacy UX details are product requirements versus incidental implementation choices.

## Implementation clarifications from plan review

- `packages/contracts` owns shared `Frame`, `RequestContext`, `GamePosition`, `GameStatus`, `Capabilities` and identity types. Dependency direction is `app → game → perception → chess → contracts`, with `game/app → platform → contracts`; chess never imports perception, and perception never imports game.
- `FrameSource.next(signal)` is the common asynchronous pull surface for webcam/replay/network mailbox sources; it waits for a fresh frame, or returns `null` only for end-of-source/closure/abort, never as a hot-loop timeout. Network producers only offer frames to a bounded latest-frame mailbox.
- `Observation.squares` is the validated array of `PieceObservation`-equivalent records; unknown color/kind remains unknown rather than fabricated piece history.
- Cross-device freshness defaults to backend receipt time. Actual one-way camera latency remains unknown without explicit clock-offset estimation.
- Detailed commands, paths and tests live in `../plans/`; the approved design governs scope, not proof that any planned module exists.

## Evidence and remaining limitations

- `research/RESEARCH.md`: external research and release roadmap.
- `research/15-refactor-architecture.md`: source seam evidence and platform candidates.
- `research/16-derivative-rights.md`: permission and distribution constraints.
- `README.md`, `DESIGN.md`, legacy `src/`, `tests/`, `evals/`: existing behavioral baseline, not proof of the new implementation.
- Node.js 24 official docs: cancellation and platform APIs; Vite official docs: local static build/relative base; `ws` official docs: handshake, payload/backpressure/heartbeat.
- The previous security audit did not complete and established no “safe” verdict. New implementation requires a fresh scoped security review after the new network/control paths exist.
- No new product code has been written or executed under this design. No hardware, real cloud model or cross-platform UI has been validated for the rewrite.
