# ChessOnGlass Windows User Journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first usable Windows x64 application: ChessOnGlass CLI opens a branded browser dashboard; webcam/replay/consented window capture reaches the shared game coordinator; results are visible and optionally spoken without WhatsApp, BlackHole or Jev.

**Architecture:** `packages/app` composes platform services, native sources, provider adapters, bounded local HTTP and the shared coordinator. `packages/ui` is a Vite-built vanilla TypeScript dashboard. All native operations sit behind small interfaces with cancellation/timeouts; no chess rules are duplicated in the app or browser.

**Tech Stack:** Node.js 24 LTS, TypeScript strict ESM, npm workspaces, `node:http`, Vite 8, vanilla TypeScript/CSS/DOM, Sharp, pinned FFmpeg/Stockfish, Windows Graphics Capture selected by a real spike, minimal .NET `System.Speech` helper, maintained native keyring, Vitest and Playwright.

**Spec:** `docs/superpowers/specs/2026-11-07-cross-platform-rewrite-design.md`

## Global Constraints

- Finish plan 01 first. Use its actual `Frame`, `RequestContext`, `GamePosition`, `FrameSource`, `BoardReader`, `Advisor`, `GameCoordinator` and `PlatformServices`; do not create a parallel game model.
- Keep `asset/logo.png` unchanged. Its verified SHA-256 is `3054b16d2b2cfd263fc3bd2997c392cec6fb9f17b7bb1a9a0bdf22af4af79909`.
- Windows x64 is the first reference host. Do not claim other OSes, minimized/occluded/RDP capture, real webcam or Vietnamese TTS until separately verified.
- Browser uploads use backend receipt freshness. Untrusted browser monotonic time is diagnostic only; `Frame.capturedAtMonotonicMs` stays `null` unless a trusted clock domain/offset exists.
- Default cloud off. No paid request in unit, browser or normal CI tests; real-provider smoke requires explicit opt-in and a cost limit.
- Bind local dashboard to `127.0.0.1`; reject non-loopback binding as not implemented. Network device pairing is plan 04.
- Per-run random local authorization, exact Origin checks and bounded bodies are mandatory. No token in query strings, logs or persisted settings.
- Do not use `ffmpeg-static`, arbitrary PATH executables, general shell commands, silent plaintext secrets or automatic driver installation.
- Package scope/publisher/license remain private and undecided. No npm publication, push, merge, history rewrite or legacy deletion.
- Exact dependency versions are selected after current compatibility/license review and saved with `--save-exact`; do not blindly copy stale versions from this plan.
- Every task runs its focused RED test, implements the smallest passing change, reruns focused tests plus typecheck, then creates a local reviewed commit.

## Review Focus

1. Missing/cross-site authorization, malformed lengths and truncated uploads must be rejected before state changes — Task 2 and Task 3.
2. Clock skew, duplicate/frozen/out-of-order frames and source replacement cannot create fresh evidence or false-live status — Task 3 and Task 9.
3. Native helper hangs/malformed output/nonzero exits must time out, clean up and preserve text output — Tasks 4–6.
4. Provider/secret-controlled strings cannot become HTML or leak in logs/snapshots — Tasks 7, 8 and 10.
5. Late model/engine/speech results after undo/reset/source replacement must be discarded — Tasks 8–10.

---

## File map

- `packages/ui`: Vite build, logo, safe DOM dashboard, webcam uploader and API client.
- `packages/app/src/http`: loopback server, authorization, bounded requests, API routes and static-file safety.
- `packages/app/src/sources`: browser frames, FFmpeg replay and Windows window capture.
- `packages/perception/src/providers`: official OpenAI/Anthropic transport adapters and strict response mapping.
- `packages/app/src/native`, `packages/app/native`: narrow native helper protocols, speech and screen capture.
- `packages/app/src/runtime`: application composition, source lifecycle and JSON-safe view models.
- `packages/app/src/{settings,secrets,doctor}`: no-secret configuration, native secret storage and capability diagnostics.
- `packages/app/test`, `packages/ui/test`: HTTP, source, native-fake, browser and explicit real integration gates.

## Task 1: Branded Vite workspace and unchanged logo

**Files:**
- Create: `packages/app/package.json`, `packages/app/tsconfig.json`, `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/vite.config.ts`, `packages/ui/index.html`, `packages/ui/src/main.ts`, `packages/ui/src/styles.css`, `packages/ui/scripts/copy-brand-assets.mjs`
- Test: `packages/ui/test/brand-build.test.ts`

**Interfaces:**
- Produces `npm run build --workspace=packages/ui`, `packages/ui/dist/index.html`, `packages/ui/dist/logo.png`; command name `chessonglass` is registered later by the app.

- [ ] **Step 1: Write RED brand assertions**

  Test source logo hash equals the exact value above, output bytes equal source bytes, HTML contains `ChessOnGlass` but not `chesshacker`, generated JS/CSS URLs are relative, and no inline script is present. The source image is read, never edited.

- [ ] **Step 2: Run and expect RED**

  Run `npm test --workspace=packages/ui -- --run tests/brand-build.test.ts`; expect missing UI build/output failure.

- [ ] **Step 3: Implement portable Vite build**

  Configure Vite `base:"./"`, `publicDir:false`, production `dist` and development host `127.0.0.1`. Use static external CSS/module script. `copy-brand-assets.mjs` copies the original to `dist/logo.png` with `node:fs`, then verifies source and destination hashes. Keep all packages private; do not decide npm publisher/license.

- [ ] **Step 4: Verify and commit**

  Run UI typecheck, build and brand test; expect PASS and unchanged logo. Commit `build: add branded ChessOnGlass dashboard shell`.

## Task 2: Secure loopback HTTP and local session authorization

**Files:**
- Create: `packages/app/src/http/auth.ts`, `body.ts`, `errors.ts`, `static-files.ts`, `server.ts`, `packages/app/src/api/api-error.ts`
- Test: `packages/app/test/http/local-http-security.test.ts`, `static-files.test.ts`

**Interfaces:**

```ts
export const JSON_BODY_LIMIT = 16 * 1024;
export const FRAME_BODY_LIMIT = 5 * 1024 * 1024;
export type LocalSession = { sessionId: SessionId; token: string; origin: string };
export function createLocalSession(origin: string): LocalSession;
export type DashboardServer = { url: string; launchUrl: string; localSession: LocalSession; close(): Promise<void> };
export function startDashboardServer(options: { staticDir: string; routes: DashboardRoutes; port?: number }): Promise<DashboardServer>;
```

`launchUrl` is returned only to local CLI composition and is never logged. Task 9 supplies concrete `DashboardRoutes`; Task 2 defines the route contract and tests it with a fake implementation.

- [ ] **Step 1: Write RED HTTP matrix**

  Assert no/bad token returns 401; cross-site and `Origin:null` mutations return 403; text/plain returns 415; missing/chunked/conflicting Content-Length returns 411/400; body over 16 KiB returns 413; malformed JSON returns 400; valid authorized command returns 202. Query-token access stays 401 and unauthorized requests never invoke the fake route.

- [ ] **Step 2: Write static/security-header assertions**

  Require `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `X-Content-Type-Options:nosniff`, `Referrer-Policy:no-referrer`, appropriate camera Permissions Policy and `Cache-Control:no-store` on private data. `/../package.json`, encoded traversal, symlink escape and unknown assets return 404.

- [ ] **Step 3: Implement bounded server**

  Generate 256-bit token with `crypto.randomBytes`, compare with length-checked `timingSafeEqual`, return launch URL with token only in fragment. Bind loopback and random free port. Require Bearer and exact configured Origin on mutations; do not treat Origin as authentication. Use explicit Content-Length, 15-second request and 10-second header timeouts, bounded listener cleanup and `Connection:close` after an oversized request. No CORS wildcard or directory listing.

- [ ] **Step 4: Verify and commit**

  Run both HTTP test files and typecheck; expect all responses, cleanup and headers to pass with no open handles. Commit `feat: secure the local dashboard boundary`.

## Task 3: Authorized browser webcam upload and backend-owned freshness

**Files:**
- Create: `packages/app/src/sources/browser-frame-metadata.ts`, `browser-frame-source.ts`, `packages/app/src/http/browser-frame-routes.ts`, `packages/ui/src/media/webcam-uploader.ts`, `packages/ui/src/api/browser-source-client.ts`
- Test: `packages/app/test/sources/browser-frame-source.test.ts`, `packages/app/test/http/browser-frame-auth.test.ts`, `packages/ui/test/webcam-uploader.test.ts`

**Interfaces:**

```ts
export type BrowserFrameUpload = {
  frame: Frame;
  clientCapturedAtMonotonicMs: number;
};
export class BrowserFrameSource implements FrameSource {
  constructor(sessionId: SessionId, sourceId: SourceId);
  readonly capabilities: Capabilities;
  accept(upload: BrowserFrameUpload): void;
  next(signal: AbortSignal): Promise<Frame | null>;
  close(): Promise<void>;
}
export class WebcamUploader {
  start(deviceId: string | null): Promise<void>;
  captureOnce(): Promise<void>;
  stop(): Promise<void>;
}
```

- [ ] **Step 1: Write identity, size and clock tests**

  Assert duplicate/out-of-order sequence →409, wrong source session →403, stale position version →409, oversize →413, invalid JPEG →400, missing auth →401. For `clientCapturedAtMonotonicMs=Number.MAX_SAFE_INTEGER`, backend `receivedAtMonotonicMs` is receipt time, `capturedAtMonotonicMs` is `null`, wall time is only metadata and freshness uses receipt time. Sequence `1n,2n,3n` offered before consumption yields only `3n`.

- [ ] **Step 2: Run RED and implement backend validation**

  Run source/auth tests; expect missing implementation. Start/stop routes allocate opaque capture session/source IDs and pass the allocated session ID to `GameCoordinator.start`/`replaceSource` so uploaded frames are bound to the active game session (a frame stamped with another session is ignored and the misbinding is reported). Upload headers carry session, source, decimal sequence, wall timestamp, request ID, position version and optional reference sequence; validate all against active state. Read at most 5 MiB and Sharp-decode/re-encode with a 12 MP limit. `close():Promise<void>` releases mailbox waiters.

- [ ] **Step 3: Implement explicit browser capture**

  Only the Start button calls `getUserMedia({video:{deviceId},audio:false})`. Capture canvas at most 1280×720, JPEG 0.85, default 2 fps, one in-flight upload, no unbounded queue. Sequence is local bigint serialized decimal. On stop/pagehide, abort fetch, stop every track, clear `srcObject` and show permission/upload failures as actionable states.

- [ ] **Step 4: Verify and commit**

  Run app source/auth and uploader tests with synthetic JPEG/fake media; expect PASS but record no real webcam claim. Commit `feat: ingest authorized browser webcam frames`.

## Task 4: Bounded FFmpeg replay source

**Files:**
- Create: `packages/app/src/native/process-client.ts`, `packages/app/src/sources/jpeg-splitter.ts`, `ffmpeg-replay-source.ts`
- Test: `packages/app/test/sources/jpeg-splitter.test.ts`, `ffmpeg-replay-source.test.ts`, `packages/app/test/native/ffmpeg-replay.integration.test.ts`

**Interfaces:**

```ts
export type ReplayOptions = { sessionId: SessionId; sourceId: SourceId; path: string; ffmpegPath: string; speed?: number; fps?: number };
export class FfmpegReplaySource implements FrameSource {
  static open(options: ReplayOptions): Promise<FfmpegReplaySource>;
  next(signal: AbortSignal): Promise<Frame | null>;
  close(): Promise<void>;
}
export class JpegSplitter { push(chunk: Uint8Array): Uint8Array[]; readonly bufferedBytes: number; }
```

- [ ] **Step 1: Write RED parser/process tests**

  Cover split/coalesced JPEGs, garbage prefix and marker-like bytes; bounded malformed stream, nonzero process exit, truncated stderr, EOF drain and idempotent close. `speed` is finite 0.25–4, `fps` integer 1–10. A late child event after close cannot publish a frame.

- [ ] **Step 2: Implement latest-wins replay**

  Spawn pinned executable with `shell:false`, argument array and no filter string containing the user path. Decode at most 1280 pixels wide and 10 fps into capacity-one mailbox; no frame files. `open` waits for first frame/process exit up to 15 seconds and cleans up on failure. `next` waits for new data, EOF or abort; it never hot-loops.

- [ ] **Step 3: Verify fake and real FFmpeg separately**

  Run source unit tests, then a real FFmpeg integration that creates a one-second `testsrc` clip in a temp directory and receives valid frames then EOF. Required release integration fails when the approved executable is missing; it is not silently skipped. Commit `feat: add bounded FFmpeg replay source`.

## Task 5: Real Windows Graphics Capture spike and consented window source

**Files:**
- Create: `docs/superpowers/spikes/2026-11-08-windows-wgc.md`, `packages/app/native/screen-capture/selection.lock.json`, `packages/app/src/native/windows-capture-client.ts`, `packages/app/src/sources/windows-screen-source.ts`, `packages/app/src/http/windows-capture-routes.ts`, `packages/app/scripts/smoke-screen-capture.ts`
- Test: `packages/app/test/native/windows-capture-client.test.ts`, `packages/app/test/sources/windows-screen-source.test.ts`

**Interfaces:**

```ts
export type CaptureTarget = { id: string; title: string; processName: string };
export interface WindowsCaptureBackend {
  listTargets(signal: AbortSignal): Promise<readonly CaptureTarget[]>;
  pickTarget(signal: AbortSignal): Promise<CaptureTarget | null>;
  preview(targetId: string, signal: AbortSignal): Promise<Uint8Array>;
  open(options: { sessionId: SessionId; sourceId: SourceId; targetId: string; fps?: number }): FrameSource;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write fake-native RED tests**

  Cover picker cancellation, preview target generation, malformed output, native hang/nonzero exit, timeout/kill, source sequence/timestamps, late frame after close and a malicious window title remaining a plain DTO string. No automatic full-desktop or GDI fallback.

- [ ] **Step 2: Run a real candidate-selection spike**

  On Windows x64/Node 24, test the shortlisted maintained Node-compatible WGC backend at an exact pinned version. Record artifact hash, supported Windows build, picker, two distinct authorized test-window frames, clean close, license and limitations in `selection.lock.json`. If no candidate passes, leave WGC unsupported and do not mark this task complete.

- [ ] **Step 3: Implement only the selected adapter**

  Require pick → preview → explicit Start. Target IDs are opaque and target titles never become paths/commands. Default 5 fps, cap 10 fps/5 MiB/12 MP, capacity-one mailbox. No promise about minimized/occluded/RDP behavior. Other call apps are just user-selected windows, not integrated audio APIs.

- [ ] **Step 4: Verify and commit**

  Run fake-native tests, then real picker/preview/capture/close smoke on reference Windows. Commit `feat: add consented Windows window capture` only if the spike passed; otherwise retain the failing native gate and the working webcam/replay path.

## Task 6: Minimal System.Speech output with cancellable queue

**Files:**
- Create: `packages/app/native/speech/SpeechHelper.csproj`, `Program.cs`, `README.md`, `packages/app/src/speech/system-speech-engine.ts`, `speech-sink.ts`, `packages/app/scripts/smoke-speech.ts`
- Test: `packages/app/test/speech/system-speech-engine.test.ts`, `speech-sink.test.ts`

**Interfaces:**

```ts
export type SpeechVoice = { id: string; name: string; locale: string };
export interface SpeechEngine {
  listVoices(signal: AbortSignal): Promise<readonly SpeechVoice[]>;
  speak(input: { text: string; voiceId: string | null; signal: AbortSignal }): Promise<void>;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write RED native/output tests**

  Assert text is bounded stdin JSON, not command-line content; malformed/oversized output, missing helper, nonzero exit and 20-second hang produce sanitized `speech_unavailable`. Abort/close kills only the owned helper. Queue cap four; stale `RequestContext` is discarded before speaking. Missing `vi-VN` leaves text/default installed voice available and never invokes online TTS.

- [ ] **Step 2: Implement helper and sink**

  Build a small .NET Framework 4.8 x64 helper referencing `System.Speech`, supporting only list-voices and speak with an installed voice ID. No PowerShell/WMI/arbitrary commands/network API. Use short-lived child processes so abort can kill active speech; a completed utterance is not falsely called cancelled. Text output remains independent of audio failure.

- [ ] **Step 3: Verify and commit**

  Run speech unit tests, build the helper and perform a real voice-list/audible smoke. Record whether Vietnamese is present rather than assuming it. Commit `feat: add cancellable Windows speech output`.

## Task 7: Official cloud vision adapters and model/pricing validation

**Files:**
- Create: `packages/perception/src/providers/openai-reader.ts`, `anthropic-reader.ts`, `provider-catalog.ts`, `packages/app/src/providers/provider-factory.ts`
- Test: `packages/perception/test/openai-reader.test.ts`, `anthropic-reader.test.ts`, `provider-catalog.test.ts`, `packages/app/test/providers/provider-factory.test.ts`

**Interfaces:**

```ts
export type ProviderName = "openai" | "anthropic";
export type ProviderSettings = { provider: ProviderName; model: string; cloudEnabled: boolean };
export function createBoardReader(settings: ProviderSettings, secret: string): BoardReader;
```

- [ ] **Step 1: Write RED provider contract tests**

  Mock the official SDK transport: assert image bytes, known position/reference, JSON schema, request timeout, cancellation and token usage are mapped into `BoardReader.read`. Test valid occupancy and piece-level mid-game answers, malformed/refused/incomplete responses, 401/403 non-retry, 429/5xx limited retry, no raw key in errors and unknown model price rejected rather than counted as zero.

- [ ] **Step 2: Verify current official SDK APIs before implementation**

  Use Context7 and the exact official OpenAI/Anthropic model documentation for the selected models. Confirm image input, structured output, effort, token fields, timeout/abort semantics and current pricing; record exact SDK/model IDs and date in `research/RESEARCH.md`. Do not rename unusual but officially documented model IDs based on stale knowledge.

- [ ] **Step 3: Implement narrow provider adapters**

  Only these files import provider SDKs. Translate to the shared `Observation`/`ReadFailure` and preserve `RequestContext`; do not expose provider tools, arbitrary function calls or raw response envelopes to the game. Cloud-disabled factory does not construct a network client. Real paid smoke is explicit and bounded, not a unit test.

- [ ] **Step 4: Verify and commit**

  Run provider tests/typecheck; then, with owner-approved key and fixture, run `CHESSONGLASS_CLOUD_SMOKE=1 npm run test:cloud-smoke --workspace=packages/app` once and record model, request count, cost and response validity. Do not claim real-model validation without that separate result. Commit `feat: add bounded cloud vision adapters` after unit tests; record real smoke separately.

## Task 8: Safe settings, native secrets and no-cost doctor

**Files:**
- Create: `packages/app/src/settings/settings.ts`, `packages/app/src/secrets/secret-service.ts`, `packages/app/src/doctor/doctor.ts`, `packages/app/src/cli.ts`
- Test: `packages/app/test/settings/settings.test.ts`, `secrets/secret-service.test.ts`, `doctor/doctor.test.ts`

**Interfaces:**

```ts
export type AppSettings = { provider: "openai" | "anthropic" | null; visionModel: string | null; cloudEnabled: boolean; speechEnabled: boolean; voiceId: string | null; browserFps: number; replayFps: number; maxCostUsd: number };
export class SecretService {
  status(provider: "openai" | "anthropic"): Promise<{ configured: boolean; source: "keyring" | "environment" | null }>;
  write(provider: "openai" | "anthropic", secret: string): Promise<void>;
}
export function runDoctor(options?: { cloudSmoke?: boolean }): Promise<readonly DoctorCheck[]>;
```

- [ ] **Step 1: Write RED settings/secret tests**

  Defaults are cloud off, provider null, speech on, browser 2 fps/replay 5 fps/$10 estimated budget. Malformed settings fail without silently overwriting the file. Secret write calls `PlatformServices.writeSecret` then exact readback; failure never creates plaintext. Status exposes only configured/source. No provider call in default doctor.

- [ ] **Step 2: Implement persistent configuration and capability checks**

  Store atomic `settings.json` in `PlatformServices.userDataDir()`, without API keys/tokens. Use the maintained native credential-store binding chosen by a Windows spike; no plaintext fallback. Environment keys are explicit overrides, not copied into the keyring. Doctor separately checks Node/OS/arch, user-data writes, FFmpeg, Stockfish, voices, WGC and credential store. Cloud check is `not-run` by default.

- [ ] **Step 3: Verify and commit**

  Run settings/secret/doctor tests and `chessonglass doctor` with no network credentials. On Windows, verify dedicated dummy credential readback after restart and remove that test credential via the OS UI. Commit `feat: add safe settings secrets and doctor`.

## Task 9: Compose single-source runtime and JSON-safe dashboard API

**Files:**
- Create: `packages/app/src/runtime/source-manager.ts`, `view-model.ts`, `windows-application.ts`, `packages/app/src/http/dashboard-routes.ts`, `packages/ui/src/api/dashboard-dto.ts`
- Test: `packages/app/test/runtime/source-manager.test.ts`, `view-model.test.ts`, `packages/app/test/http/dashboard-routes.test.ts`

**Interfaces:**

```ts
export class WindowsApplication {
  static start(options: WindowsApplicationOptions): Promise<WindowsApplication>;
  readonly launchUrl: string;
  snapshot(): DashboardSnapshot;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write lifecycle RED tests**

  Only one active source exists. Start replacement successfully before stopping old source; on start failure keep the old source. Old frame/result after `replaceSource` cannot reach coordinator/UI/speech. Pause/reset commands do not wait for cloud. Stale snapshot uses receipt freshness; cross-clock `latencyMs` is null. JSON contains decimal IDs, no bigint, secret, token or provider envelope.

- [ ] **Step 2: Implement runtime using actual core contracts**

  Pump `source.next(signal)` into `GameCoordinator`; use `dispatch` for commands and `replaceSource` for lifecycle changes. Do not add a second `command({type:"frame"})` game API. Generate one `newSessionId()` per source lifetime, pass it to the source constructor and to `GameCoordinator.start`/`replaceSource`, and keep source and local HTTP sessions as separate IDs/lifecycles. Implement snapshot/events/latest-frame/settings/secrets/doctor/source routes using Task 2 auth. Authorized SSE uses `fetch`, not `EventSource` with token query.

- [ ] **Step 3: Implement CLI and shutdown**

  `chessonglass run [--replay path]` opens dashboard with `PlatformServices.openExternal(launchUrl)`; CLI prints base URL, never launch token. Cloud remains off unless explicitly enabled. SIGINT/SIGTERM closes HTTP subscribers, source, speech, coordinator and engine with bounded/idempotent cleanup.

- [ ] **Step 4: Verify and commit**

  Run runtime/API tests, all app tests and typecheck; expect no open handles or provider calls. Commit `feat: compose Windows local game runtime`.

## Task 10: Accessible safe dashboard and position/promotion controls

**Files:**
- Create: `packages/ui/src/auth/session-token.ts`, `api/client.ts`, `api/event-stream.ts`, `dom.ts`, `components/board.ts`, `game-surface.ts`, `source-setup.ts`, `position-editor.ts`, `settings-dialog.ts`, `doctor-dialog.ts`
- Modify: `packages/ui/src/main.ts`, `styles.css`
- Test: `packages/ui/test/dashboard-browser.spec.ts`

**Interfaces:**
- `mountDashboard(root: HTMLElement): { close(): Promise<void> }`; `DashboardClient` wraps authorized snapshot/commands/settings/secrets/events.

- [ ] **Step 1: Write RED Playwright scenarios**

  Cover source-selection and needs-position empty states, denied camera, webcam/replay/window setup, pick-preview-confirm, ready/confirming/uncertain/lost/paused, manual move, undo/repeat/new-game, mid-game position confirmation and q/r/b/n promotion choices. Test disconnected SSE, stale frame, no TTS voice and empty history. At 390×844 and keyboard-only, all controls remain accessible and statuses are not color-only.

- [ ] **Step 2: Write injection/token tests**

  Put `<img src=x onerror="window.__xss=1">` in suggestion, move history, window title and provider error; assert it appears as text, no image/script executes and `window.__xss` is unset. Token moves from URL fragment to `sessionStorage`, fragment is removed with `history.replaceState`, and no token appears in request URLs/referrers.

- [ ] **Step 3: Implement one primary game surface**

  Use DOM `textContent`, safe attributes and `createElementNS` for board SVG; no dynamic `innerHTML`/`eval`/inline handlers. Show preview, board, status, suggestion, next action, freshness, connection, estimated spend and move history in one active surface; setup/diagnostics are separate dialogs. Secret input clears after save. Reconnect SSE with bounded backoff then fetch a fresh snapshot before applying events.

- [ ] **Step 4: Verify and commit**

  Run UI typecheck/build/Playwright using fake API/media; expect all golden/error/accessibility/injection cases to pass. This is not real webcam/provider evidence. Commit `feat: build the accessible ChessOnGlass dashboard`.

## Task 11: Full local golden path and explicit native/cloud gates

**Files:**
- Create: `packages/app/test/e2e/windows-golden-path.spec.ts`, `api-errors.spec.ts`, `support/test-application.ts`, `support/scripted-vision-reader.ts`, `packages/app/playwright.config.ts`, `packages/app/scripts/native-smoke.ts`, `docs/windows-user-journey.md`, `docs/windows-validation.md`

**Interfaces:**
- Add `test:e2e`, `test:native`, `test:cloud-smoke`, `start`; production has no remote fake-provider control.

- [ ] **Step 1: Write full-system RED tests**

  Start built app with scripted reader and real local Stockfish. Exercise authorized webcam upload, position confirmation, suggestion, manual move, pause/undo/repeat/new-game, stale-result suppression and replay EOF. API tests assert 401/403/409/411/413/415/503 and no fake secret/token in logs. Required Stockfish/FFmpeg checks fail rather than skip.

- [ ] **Step 2: Implement isolated E2E harness**

  Use ephemeral loopback port and complete teardown after each test. Scripted reader lives only in test support and returns typed observations with correct context. Fake TTS is explicitly labeled; it never proves native audio. Add native smoke subcommands `webcam`, `screen`, `speech`, `keyring`, `ffmpeg`, `stockfish` that record OS/tool/version/hash/tester evidence rather than self-certifying manual checks.

- [ ] **Step 3: Run automated and real-machine gates**

  Run `npm ci`, typecheck, build, unit tests, UI/app Playwright, `git diff --check`, then `chessonglass doctor` and `npm run test:native --workspace=packages/app` on clean reference Windows. Confirm Chrome/Edge webcam start/stop/freeze, WGC picker/two distinct frames/clean close, audible speech, persistent dummy credential and pinned executable installs. Run real cloud smoke only with explicit owner opt-in and bounded consented fixture.

- [ ] **Step 4: Document exact evidence and commit**

  `docs/windows-user-journey.md` documents setup/source/output/recovery/troubleshooting. `docs/windows-validation.md` separates mocked tests, real engine/FFmpeg, webcam, WGC, speech, keyring and optional paid provider. WGC unsupported if its spike failed; no Gate 1 validated claim until real model and native checks pass. Commit `test: verify Windows user journey` only for the work actually verified.

## Slice exit criteria

- [ ] Windows local webcam/replay → observation → legal move → Stockfish → dashboard/text/TTS path is implemented without mandatory call app/audio driver/pre-check service.
- [ ] Native screen capture has real spike evidence or is explicitly unsupported.
- [ ] Local auth, body limits, safe rendering, secret storage and late-result rejection have executable coverage.
- [ ] Real engine, browser, native integrations and optional real provider have separate results, not inferred from mocks.
- [ ] Continue to plan 03 only after shared contracts and Windows golden path pass.
