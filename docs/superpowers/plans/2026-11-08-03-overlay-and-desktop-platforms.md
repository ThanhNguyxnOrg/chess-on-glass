# ChessOnGlass Overlay and Desktop Platforms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver fresh, confidence-aware overlay on the dashboard and exported video, then add verified macOS/Linux native services without contaminating the shared game core or overstating platform support.

**Architecture:** Geometry/tracking/rendering live in `packages/perception`; native OS integrations live behind `packages/platform`; application composition supplies authenticated frame/result contexts. Preview tracking and cloud board reading are independent workloads. Invalid or stale geometry hides the overlay instead of drawing at an outdated location.

**Tech Stack:** Node.js 24 LTS, TypeScript strict ESM, Sharp, pinned FFmpeg, current official OpenCV documentation for an optional measured spike, macOS ScreenCaptureKit/native speech, Linux X11/Wayland portal/PipeWire and available local speech services, Vitest, Playwright and three-OS CI.

**Spec:** `docs/superpowers/specs/2026-11-07-cross-platform-rewrite-design.md`

## Global Constraints

- Finish plans 01–02 first. Use the same `Frame`, `RequestContext`, `GamePosition`, `BoardReader`, `GameCoordinator`, `PlatformServices`, budget ledger and result lifecycle.
- Gate 2 must provide overlay on dashboard preview **and** an exported overlay video; an always-on-top desktop window or world-locked glasses AR is out of scope.
- Geometry may model the board plane, not piece depth/occlusion. Reject non-finite, degenerate, self-intersecting or low-confidence transforms.
- Stale/frozen video or expired geometry cannot display a “live” board overlay. Text status remains visible and says why the overlay is hidden.
- A local optical-flow/change-detection optimizer is optional and must be enabled only after a measured spike. OpenCV is not a baseline dependency.
- Locator calls share request identity, cancellation and the same estimated cost ledger as board reading; no hidden second budget.
- Dynamic SVG content is escaped/validated; media inputs have byte/pixel/time limits; export paths are explicit operator choices.
- FFmpeg/Stockfish/native helpers use immutable per-OS/per-arch artifacts with SHA-256, license, build provenance and corresponding-source evidence.
- macOS and Linux are marked supported only after actual clean-machine integration evidence. Linux X11 and Wayland are separate support cases.
- Direct text/audio output does not require virtual audio routing. No mandatory BlackHole, PipeWire migration, driver installation or OS security bypass.
- Preserve `asset/logo.png` byte-for-byte. No package publication, push, merge or legacy deletion.
- Each task writes a failing test, runs it, implements the smallest passing change, reruns focused tests/typecheck and commits locally.

## Review Focus

1. Degenerate/NaN corners or incorrect board orientation must not create absurd geometry — Task 1.
2. Head movement, blur, occlusion or expired tracking must hide the overlay rather than mislead — Tasks 2–4.
3. A late locator/engine response after reset cannot consume the new position’s budget or render — Tasks 2 and 4.
4. Malformed media/FFmpeg failure/slow export cannot grow unbounded memory or leave processes running — Task 5.
5. Linux Wayland/X11 confusion, unavailable native speech or missing secret persistence must produce an honest capability result — Tasks 7–9.

---

## Task 1: Validated board geometry and coordinate transforms

**Files:**
- Create: `packages/perception/src/geometry/types.ts`, `homography.ts`, `board-projection.ts`
- Test: `packages/perception/test/homography.test.ts`, `board-projection.test.ts`

**Interfaces:**

```ts
export type Point = readonly [x: number, y: number];
export type BoardCorners = { nearLeft: Point; nearRight: Point; farRight: Point; farLeft: Point };
export type GeometryConfidence = { inlierRatio: number; reprojectionErrorPx: number; observedSequence: Sequence };
export function fitBoardHomography(corners: BoardCorners, width: number, height: number): Homography;
export function projectSquare(transform: Homography, square: number, side: "w" | "b"): readonly Point[];
export function validateGeometry(transform: Homography, confidence: GeometryConfidence): boolean;
```

- [ ] **Step 1: Write RED numerical/shape tests**

  Cover white/black orientation, perspective board, square centers, boundary squares and round-trip projection. Reject repeated/collinear/crossed corners, NaN/Infinity, zero denominator, zero-sized image and extreme off-image transforms that fail the confidence policy. Assert invalid input throws a typed geometry error rather than producing SVG coordinates.

- [ ] **Step 2: Implement small deterministic geometry module**

  Use four-point homography with partial pivoting and explicit finite checks. Normalize image coordinates once and document orientation `near → far`, `left → right`. Validate convex corner order and configurable reprojection/inlier bounds. Do not infer 3D pose, camera intrinsics or eye display calibration from a single homography.

- [ ] **Step 3: Verify and commit**

  Run geometry tests/typecheck and include perspective fixtures with no dependency on a vision model. Commit `feat: add validated board projection`.

## Task 2: Freshness-aware board locator and bounded geometry state

**Files:**
- Create: `packages/perception/src/tracking/board-locator.ts`, `geometry-state.ts`
- Test: `packages/perception/test/board-locator.test.ts`, `geometry-state.test.ts`

**Interfaces:**

```ts
export interface BoardLocator {
  locate(input: { frame: Frame; context: RequestContext; signal: AbortSignal }): Promise<{ transform: Homography; confidence: GeometryConfidence } | null>;
}
export class GeometryState {
  update(frame: Frame, transform: Homography, confidence: GeometryConfidence): void;
  current(nowMonotonicMs: number): { transform: Homography; sequence: Sequence } | null;
  invalidate(reason: string): void;
}
```

- [ ] **Step 1: Write RED lifecycle tests**

  Locator result with wrong request/session/position/reference is dropped. Result older than its allowed lifetime, invalid geometry, frozen repeated sequence, board leaving view or lost tracking calls `invalidate` and returns null. Fresh geometry can render until its documented expiry, never indefinitely.

- [ ] **Step 2: Implement locator adapter and state**

  Provider locator is optional and returns typed coordinates/confidence only. It uses `RequestContext` and `CostLedger.reserve/settle/release` through the same injected ledger as the board reader. No free-form model output becomes executable or markup. Set explicit max in-flight locator calls to one and drop obsolete answers after reset.

- [ ] **Step 3: Verify and commit**

  Run tests for late result, budget exhaustion, cancellation, invalid coordinates, expiry and frame identity. Commit `feat: track board geometry with freshness`.

## Task 3: Measured local tracking spike and conservative fallback

**Files:**
- Create: `docs/superpowers/spikes/2026-11-08-board-tracking.md`, `packages/perception/src/tracking/local-tracker.ts`, `tracking-config.ts`
- Test: `packages/perception/test/local-tracker.test.ts`, `tracking-config.test.ts`

**Interfaces:**

```ts
export interface LocalBoardTracker {
  track(previous: { frame: Frame; transform: Homography }, next: Frame): { transform: Homography; confidence: GeometryConfidence } | null;
}
export type TrackingMode = "locator-only" | "local-assisted";
```

- [ ] **Step 1: Write RED configuration/fallback tests**

  Default is `locator-only`; local-assisted cannot be enabled without a recorded successful spike. When local flow fails forward/backward validation, has too few inliers or encounters occlusion, it returns null rather than extrapolating. Verify no OpenCV/native module is imported in locator-only mode.

- [ ] **Step 2: Run a bounded real-video spike**

  Evaluate a current official OpenCV LK optical-flow/homography sample against consented moving-camera recordings. Track board-plane features, not hands/piece tops; measure reprojection error, drift, latency and memory. Record dataset consent, hardware, versions, success/failure and when re-location is required. Do not claim success from a still image.

- [ ] **Step 3: Implement only if spike passes**

  Add a narrow tracker behind the interface, bounded frames/pixels/work and local full re-location on confidence loss. If it fails, keep the dependency out and continue locator-only with overlay hidden between valid observations. A locator-only configuration can satisfy correctness but not a promise of perfectly smooth AR.

- [ ] **Step 4: Verify and commit**

  Run unit tests and record the measured result. Commit `test: evaluate local board tracking` for the spike; add implementation separately only when accepted.

## Task 4: Safe overlay SVG, renderer and dashboard preview

**Files:**
- Create: `packages/perception/src/overlay/overlay-svg.ts`, `render-overlay.ts`, `overlay-state.ts`, `packages/app/src/http/overlay-routes.ts`, `packages/ui/src/components/overlay-preview.ts`
- Test: `packages/perception/test/overlay-svg.test.ts`, `render-overlay.test.ts`, `packages/app/test/overlay-routes.test.ts`, `packages/ui/tests/overlay-preview.spec.ts`

**Interfaces:**

```ts
export type OverlayInput = { frame: Frame; position: GamePosition; result: Result | null; geometry: GeometryState };
export function renderOverlay(input: OverlayInput): Promise<Uint8Array>;
```

- [ ] **Step 1: Write RED visual/security tests**

  Assert cyan board outline, green from/to squares/arrow, piece/move label and hidden state when geometry is absent/stale. Put markup in status/provider/move metadata and verify it is escaped. Invalid geometry returns a clearly labeled status-only frame, not an exception or stale drawing.

- [ ] **Step 2: Implement bounded renderer**

  Use Sharp with input/pixel ceilings and deterministic SVG dimensions. Escape every dynamic string, validate numerical coordinates and never use model-provided SVG/HTML. Compose on the source frame for dashboard/export; no desktop-window/AR claim. Keep full frame and optional aligned crop for future reader use rather than assuming 2D warp removes 3D piece ambiguity.

- [ ] **Step 3: Implement authorized preview**

  Latest-frame/overlay endpoints use the plan 02 local authorization and `no-store`; the browser updates only for a new sequence and revokes old object URLs. Slow viewers drop frames instead of accumulating. UI displays tracking/freshness/result status and keeps board/history accessible without overlay.

- [ ] **Step 4: Verify and commit**

  Run renderer/API/browser tests including frozen source and reset during locator call; expect overlay hidden appropriately. Commit `feat: render fresh overlay in dashboard`.

## Task 5: Bounded overlay video export and real-media validation

**Files:**
- Create: `packages/perception/src/overlay/overlay-exporter.ts`, `packages/app/src/native/ffmpeg-overlay-writer.ts`, `packages/app/src/http/export-routes.ts`
- Test: `packages/perception/test/overlay-exporter.test.ts`, `packages/app/test/ffmpeg-overlay-writer.test.ts`, `packages/app/test/overlay-export.integration.test.ts`

**Interfaces:**

```ts
export interface OverlayExporter {
  start(options: { outputPath: string; fps: number; signal: AbortSignal }): Promise<void>;
  write(frame: Uint8Array): Promise<void>;
  close(): Promise<{ outputPath: string; framesWritten: number }>;
}
```

- [ ] **Step 1: Write RED export/process tests**

  Require explicit output path within an operator-selected export directory; do not overwrite by default. Reject invalid fps, malformed JPEG, unauthorized path, FFmpeg nonzero exit and late close. Backpressure pauses upstream or drops whole frames by a stated policy; memory never grows per exported frame. Shutdown closes stdin and waits with a bounded kill fallback.

- [ ] **Step 2: Implement exporter**

  Feed bounded JPEG frames to a pinned FFmpeg process using argument arrays, `shell:false`, H.264/yuv420p and explicit frame rate. No RTMP/public streaming in this task. Reuse the exact same renderer as dashboard so preview/export have consistent state. Expose progress/error without leaking filesystem paths or secrets to unauthorized clients.

- [ ] **Step 3: Verify real video and resource cleanup**

  Generate a short consented replay, export it, inspect dimensions/frame count/decodability and compare key frames with the preview state. Test freeze/reset during export and process cleanup. Real FFmpeg is required for this integration gate; mocks do not prove exported video.

- [ ] **Step 4: Commit**

  Commit `feat: export bounded overlay video` after unit and real-media integration pass.

## Task 6: Native credential-store implementation and per-OS executable installation

**Files:**
- Create: `packages/platform/src/secrets/native-keyring.ts`, `artifacts/install-artifact.ts`, `artifacts/manifest.ts`, `packages/app/src/setup/install-tools.ts`
- Test: `packages/platform/test/native-keyring.test.ts`, `install-artifact.test.ts`, `manifest.test.ts`

**Interfaces:**

```ts
export interface NativeSecretStore {
  read(account: string): Promise<string | null>;
  write(account: string, secret: string): Promise<void>;
  remove(account: string): Promise<void>;
}
export function installVerifiedArtifact(record: VerifiedArtifact, destinationDirectory: string, signal: AbortSignal): Promise<string>;
```

- [ ] **Step 1: Write RED storage/artifact tests**

  Windows Credential Manager/macOS Keychain/Linux Secret Service are selected only on their native OS. Readback mismatch/failure returns an error with no plaintext fallback; Linux RAM-only keyutils is not marked persistent. Artifact tests reject wrong OS/arch/hash, unsafe archive member, symlink escape and partial install.

- [ ] **Step 2: Implement maintained native secret adapter**

  Evaluate and pin the maintained native keyring binding after current Node/OS compatibility checks. `PlatformServices` delegates to this implementation; environment overrides never get silently copied to OS storage. Dedicated test credentials are used and removed after each OS smoke.

- [ ] **Step 3: Implement verified tool installer**

  Explicit setup downloads only reviewed immutable artifacts, streams hash checks, extracts allowlisted members without traversal/links, writes a sibling temporary file and atomically renames it. No download on npm install and no arbitrary global executable fallback. Record version/build flags/source/license for every Stockfish/FFmpeg/native helper artifact.

- [ ] **Step 4: Verify and commit**

  Run unit tests plus real keyring and UCI/media startup smoke per available OS. Required release integration cannot silently skip missing native tools. Commit `feat: install verified native tools and secret storage`.

## Task 7: macOS native capture, speech and desktop integration

**Files:**
- Create: `packages/platform/src/macos/capture.ts`, `speech.ts`, `permissions.ts`, `packages/app/src/sources/macos-screen-source.ts`, `docs/platform-macos.md`
- Test: `packages/platform/test/macos-capture.test.ts`, `macos-speech.test.ts`, `packages/app/test/macos-screen-source.test.ts`

**Interfaces:**
- `MacCaptureBackend.listTargets/pickTarget/open` follows the same consented shape as Windows; `MacSpeechEngine` implements the shared speech interface.

- [ ] **Step 1: Write RED fake-native tests**

  Cover permission denied, picker cancel, malformed helper output, timeout, invalid frames, late frames after source close and unavailable voices. No `osascript` command built from untrusted strings and no WhatsApp window-title assumption in the generic source.

- [ ] **Step 2: Implement ScreenCaptureKit/native speech adapters**

  Use a maintained supported ScreenCaptureKit binding or a narrow reviewed helper, pinned for macOS version/arch. Capture only user-selected window after preview/consent; preserve `Frame` identity and receipt timestamps. Use `say` through argument arrays or native speech APIs, never BlackHole for ordinary local playback.

- [ ] **Step 3: Verify on clean macOS**

  Record Screen Recording permission flow, selected-window preview, two distinct frames, stop/close, audible speech and credential persistence. Test Intel/Apple Silicon separately if advertised. WhatsApp/BlackHole remains optional and outside this native baseline.

- [ ] **Step 4: Commit and update support matrix**

  Commit `feat: add macOS native capture and speech` only with real evidence; otherwise document unsupported cases and do not mark macOS supported.

## Task 8: Linux X11/Wayland capture and capability-aware desktop integration

**Files:**
- Create: `packages/platform/src/linux/session.ts`, `capture-x11.ts`, `capture-wayland.ts`, `permissions.ts`, `packages/app/src/sources/linux-screen-source.ts`, `docs/platform-linux.md`
- Test: `packages/platform/test/linux-session.test.ts`, `linux-capture.test.ts`, `packages/app/test/linux-screen-source.test.ts`

**Interfaces:**
- `detectLinuxSession(): { kind:"x11"|"wayland"|"unknown"; available:boolean; reason:string|null }`; selected backend implements the common `FrameSource` lifecycle.

- [ ] **Step 1: Write RED session/fallback tests**

  Explicit X11 selects the X11 backend; Wayland requires portal/PipeWire and never silently uses an X11-only path. Unknown/headless session returns unsupported with actionable reason. Permission denial/cancel, malformed frames, timeout and reconnect clean up without hot-looping.

- [ ] **Step 2: Implement session-specific adapters**

  Use reviewed maintained native libraries/helpers. X11 captures an explicitly selected region/window within documented limitations; Wayland uses the system portal and PipeWire stream with user consent. No silent whole-desktop recording or fallback to an incompatible capture API. Assign backend receipt timestamps and capacity-one mailbox.

- [ ] **Step 3: Verify on named distributions/desktops**

  Test Ubuntu/X11 and Ubuntu/Wayland reference images or available real machines: portal/permission, preview, two distinct frames, stop/reconnect, logs and cleanup. Record distro, desktop, session type and exact library versions. Missing either path does not block truthful support for the other.

- [ ] **Step 4: Commit and update support matrix**

  Commit `feat: add Linux session-aware capture` only for verified session paths; document unsupported configurations.

## Task 9: Linux local speech and optional audio-route capability

**Files:**
- Create: `packages/platform/src/linux/speech.ts`, `audio-capabilities.ts`, `docs/linux-audio.md`
- Test: `packages/platform/test/linux-speech.test.ts`, `linux-audio-capabilities.test.ts`

**Interfaces:**
- `LinuxSpeechEngine implements SpeechEngine`; `AudioCapabilities` reports direct playback, available speech provider and optional virtual routing separately.

- [ ] **Step 1: Write RED speech/capability tests**

  Test installed speech-dispatcher/espeak-ng availability, missing voice, timeout, malformed output and shutdown. No silent network TTS fallback. PipeWire/PulseAudio virtual route is reported only when the existing stack supports it; ALSA-only/unknown keeps text/direct output and does not modify the audio stack.

- [ ] **Step 2: Implement narrow speech adapters**

  Probe available providers once, spawn with argument arrays and bounded output, and keep text results independent of speech failure. Local playback does not require virtual mic. Virtual routing remains a separate optional capability subject to the release/license gates in plan 04.

- [ ] **Step 3: Verify and commit**

  Run fake tests and actual voice-list/audible playback on the named Linux reference. Document locale/voice limits and direct output success independently of virtual route. Commit `feat: add Linux capability-aware speech`.

## Task 10: Three-OS integration matrix and support documentation

**Files:**
- Modify: `.github/workflows/ci.yml`, `README.md`, `DESIGN.md`, `docs/architecture.md`
- Create: `docs/support-matrix.md`, `docs/overlay-validation.md`, `scripts/verify-platform-matrix.mjs`
- Test: `packages/app/test/platform-matrix.test.ts`

**Interfaces:**
- Add `test:overlay`, `test:native:macos`, `test:native:linux`, `verify:platform-matrix`; support records distinguish unit, CI, real-machine and unavailable evidence.

- [ ] **Step 1: Write RED support-matrix validation**

  Reject `supported` status without OS version/arch/test evidence, Linux session type or actual native results. Preview and export must both have validation records. Simulator/fake process cannot promote native support. Missing required test is failure, not skipped success.

- [ ] **Step 2: Implement CI and verification reports**

  Three-OS jobs run clean `npm ci`, typecheck/build/unit and real applicable native/media checks. Separate manual hardware/desktop/cloud jobs record versions and evidence. Run dashboard/export overlay golden path on Windows and applicable desktop paths on macOS/Linux. Report measured p50/p95 locator/render latency and memory without inventing targets after results.

- [ ] **Step 3: Synchronize documentation and verify boundaries**

  README/DESIGN describe actual setup, supported sources, overlay limits, export and platform matrix; no stale macOS-only/WhatsApp-default instructions or universal Linux/Wayland/AR claims. Include rights/provenance status and unfinished hardware/security validation.

- [ ] **Step 4: Final verification and commit**

  Run all overlay tests, real export, platform matrix and three-OS CI. Commit `test: verify overlay and desktop platform matrix` for actual evidence; leave unsupported paths explicit.

## Slice exit criteria

- [ ] Dashboard and exported video use the same safe overlay state and hide stale/invalid geometry.
- [ ] Local tracking optimization is backed by a measured spike or remains disabled without blocking baseline use.
- [ ] macOS/Linux integrations have actual native evidence per advertised OS/session, or are explicitly unsupported.
- [ ] Native secret storage, executable provenance, TTS fallbacks and real media export are verified independently.
- [ ] Support matrix contains no unverified cross-platform, hardware or AR claims; plan 04 can now add authenticated device sources without changing the core.
