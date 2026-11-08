# ChessOnGlass Devices, Integrations and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in authenticated device/companion path and optional integrations, then produce auditable pilot artifacts and reviewed legacy replacement evidence without claiming unsupported hardware or unresolved distribution rights.

**Architecture:** `packages/device` owns protocol, pairing, WebSocket sessions and explicit vendor scaffolds. `packages/app` bridges authenticated sources/results to the existing coordinator. Local dashboard remains loopback; a separate HTTPS/WSS server handles opted-in LAN access. No media server, public backend or driver is installed by default.

**Tech Stack:** Node.js 24 LTS, TypeScript strict ESM, `node:http`/`node:https`, current pinned `ws` 8.x and `@types/ws`, Vitest, Vite UI, GitHub Actions, SPDX 2.3 JSON, SHA-256.

**Spec:** `docs/superpowers/specs/2026-11-07-cross-platform-rewrite-design.md`

## Global Constraints

- Finish plans 01–03 first; consume shared domain contracts rather than redefining them.
- `Frame.sequence` is bigint in core and a decimal string on wire, bounded `0..9223372036854775807`; never use JSON numbers for it.
- Network mode defaults off. LAN requires explicit opt-in, HTTPS/WSS, one-time pairing, desktop confirmation, per-device revocable tokens and role/session scopes.
- Tokens never appear in query strings, logs or browser bundles. Native clients use `Authorization:Bearer`; browser companions use `Secure;HttpOnly;SameSite=Strict;Path=/v1` cookie plus exact configured Origin. Reject null/wildcard/cross-site origins.
- `ws` uses `noServer:true`; validate route, subprotocol, credentials, role, origin and quota in the HTTP upgrade handler before `handleUpgrade`. Do not hide authentication in a generic `verifyClient` callback.
- Current `ws` docs confirm `maxPayload`, `maxFragments`, `maxBufferedChunks`, UTF-8 validation and `perMessageDeflate` options. Use 1 MiB messages, 16 fragments, 64 buffered chunks, compression off and UTF-8 validation on.
- Limits: 32 total connections, 2/device, 8/remote address; pairing/control/metadata body 16 KiB; JPEG 1 MiB; hello 5 seconds; ping every 15 seconds and terminate after 30 seconds without pong; outgoing `bufferedAmount` limit 1 MiB with latest-result coalescing and termination after 5 seconds continuously over limit.
- One camera connection binds one `(sessionId,sourceId)`; sequence starts `0n` and increments exactly by one. Reconnect gets new epoch; duplicate/gap/wrong-session frames never reach the mailbox.
- Freshness uses backend receipt. Sender monotonic/wall time is not compared to backend time; one-way latency is unknown without explicit clock-offset estimation and uncertainty.
- Camera/microphone/audio/display are independent capabilities. JPEG v1 supplies no microphone, TTS or display transport.
- Meta DAT, Brilliant Frame and ESP32 are scaffolds until exact model/firmware/SDK and real hardware evidence exists. Simulator is loopback-only, opt-in and never hardware evidence.
- No default RTSP, WebRTC, MediaMTX, aiortc, WhatsApp integration, virtual audio driver, cloud relay or Docker Desktop.
- Keep `asset/logo.png` unchanged and packages private until owner approves name/publisher/license.
- No public release while rights, attribution, license, native artifact provenance or corresponding-source requirements are unresolved. Pilot self-signed/development packages require explicit warnings and no security bypass.
- Each task runs focused RED tests, implements the narrowest passing change, reruns tests/typecheck and creates a local commit. No push, merge, npm publish or history rewrite.

## Review Focus

1. Concurrent redeem/claim of one pairing code and wrong desktop fingerprint must yield only one authorized device — Task 2.
2. Revoking a token must close its live socket and reject cross-role use — Task 4.
3. Interleaved frames/reconnects cannot cross session/source identity or reuse sequence evidence — Task 5.
4. Sender clock jumps must not create negative/artificial latency or false freshness — Task 5.
5. A slow viewer must not grow memory; coalesce results and terminate under bounded backpressure — Task 6.

---

## Task 1: Device protocol, configuration and wire limits

**Files:**
- Create: `packages/device/package.json`, `src/protocol.ts`, `src/config.ts`, `src/index.ts`
- Modify: root `package.json`, `package-lock.json`
- Test: `packages/device/test/protocol.test.ts`, `config.test.ts`

**Interfaces:**

```ts
export type DeviceRole = "camera" | "viewer" | "controller";
export type ClientKind = "companion" | "simulator";
export function parseCameraHello(value: unknown): CameraHello;
export function parseOutputHello(value: unknown): OutputHello;
export function parseFrameMetadata(value: unknown): FrameMetadata;
export function parseNetworkConfig(value: unknown): NetworkConfig;
export const NETWORK_LIMITS: Readonly<NetworkLimits>;
```

- [ ] **Step 1: Write RED protocol tests**

  `parseFrameMetadataAcceptsCanonicalBigIntAndIndependentCapabilities` validates decimal sequence and independent capabilities. `parseFrameMetadataRejectsAmbiguousNumbersAndOversizeBodies` rejects number/exponent/negative/out-of-range sequences, invalid timestamps, unknown fields, MIME other than JPEG and >1 MiB byteLength. Verify hello/result/control schemas reject missing context and unknown roles.

- [ ] **Step 2: Write RED configuration tests**

  Default is `{kind:"off"}`; `local-dev` accepts only `127.0.0.1`/`::1`, simulator defaults false; LAN without TLS fails. Assert all documented `ws` limits are explicit and no media dependencies exist.

- [ ] **Step 3: Implement exact parsers/config**

  Use plain-object exact-key validation, bounded strings, canonical BigInt decimal, finite timestamps and discriminated `off | local-dev | lan` config. Pin the currently reviewed `ws` and `@types/ws` versions with `--save-exact`; record version/doc date. Do not invent unsupported `ws` options; `maxFragments:16` and `maxBufferedChunks:64` are supported by the current official docs.

- [ ] **Step 4: Verify and commit**

  Run both tests and typecheck; expect PASS. Commit `feat: define bounded device protocol`.

## Task 2: One-time pairing, desktop confirmation and revocable tokens

**Files:**
- Create: `packages/device/src/pairing/pairing-service.ts`, `device-registry.ts`, `pairing-http-api.ts`, `packages/platform/src/device-registry-store.ts`, `packages/app/src/local-device-api.ts`, `packages/ui/src/device-pairing.ts`
- Test: `packages/device/test/pairing-service.test.ts`, `pairing-http-api.test.ts`, `packages/ui/test/device-pairing.test.ts`

**Interfaces:**

```ts
export class PairingService {
  createCode(): PairingChallenge;
  redeem(code: string, request: PairingRequest, remoteAddress: string): Promise<PairingRedemption>;
  confirm(pairingId: string, fingerprint: string, sessionId: SessionId | null): Promise<void>;
  claim(pairingId: string, claimSecret: string): Promise<ClaimedDevice>;
  revoke(deviceId: string): Promise<void>;
}
export interface DeviceRegistry {
  authenticate(token: string, requiredRole: DeviceRole): Promise<DevicePrincipal>;
  onRevoke(listener: (deviceId: string) => void): () => void;
}
```

- [ ] **Step 1: Write RED lifecycle/concurrency tests**

  Use fake clock: 10-character Crockford Base32 code expires at 120 seconds and cannot be reused. Two concurrent redeem/claim attempts yield one success; wrong fingerprint cannot confirm; claim secret is one-use; revoke is immediate. Stored records contain SHA-256 token digest, never raw code/claim/token.

- [ ] **Step 2: Implement pairing/registry**

  Generate 50-bit code and 256-bit claim/device secrets with `crypto.randomBytes`; compare digests with `timingSafeEqual`. Serialize redeem/confirm/claim/revoke with a registry mutex. Rate-limit five failed attempts/code/address and twenty/address/ten minutes; responses do not reveal whether a code exists. Viewer/controller session scope is desktop-assigned; camera grant is created in Task 5.

- [ ] **Step 3: Implement separate network/local APIs**

  Only redeem/claim are network APIs, with bounded JSON and no-store. Create-code/confirm/list/revoke are local-only dashboard APIs behind local authorization. UI displays label/role/capabilities/fingerprint, requires exact confirmation and renders all dynamic strings with text APIs. Registry uses atomic file storage without raw secrets or a silent plaintext token fallback.

- [ ] **Step 4: Verify and commit**

  Run pairing/HTTP/UI tests and typecheck; expect concurrent/single-use/expiry/revoke cases PASS. Commit `feat: add confirmed revocable device pairing`.

## Task 3: Separate local development from trusted LAN HTTPS/WSS

**Files:**
- Create: `packages/platform/src/tls.ts`, `packages/app/src/network-server.ts`, `network-doctor.ts`, `docs/network-pairing.md`
- Test: `packages/app/test/network-transport.test.ts`, `packages/platform/test/tls.test.ts`

**Interfaces:**
- `loadTlsMaterial(config)`, `inspectTlsSetup(config)`, `createNetworkServer(options):Promise<RunningNetworkServer>`, `RunningNetworkServer.close():Promise<void>`.

- [ ] **Step 1: Write RED transport tests**

  Reject missing cert/key, LAN+HTTP, non-loopback local-dev and LAN simulator before listen. Temporary test certificate with correct SAN and explicit test trust succeeds; wrong hostname/untrusted cert fails without disabling verification. Oversized/chunked/slow pairing bodies are rejected/closed, not buffered indefinitely.

- [ ] **Step 2: Implement TLS/server lifecycle**

  Load operator-provided key/cert without silently installing a CA. Check readability, expiration, SAN and key-file permissions where the OS supports it. LAN uses `node:https`; local-dev uses `node:http` only on loopback; off creates no socket. Set 5-second header and 10-second request timeouts and close all registered connections on shutdown.

- [ ] **Step 3: Document trusted pilot setup**

  Explain DNS/IP SAN, private key staying on desktop, desktop certificate fingerprint, explicit per-device trust and self-signed warnings. No ignored warnings, disabled TLS verification, blanket firewall disablement or hidden CA installation. Phone browser still needs foreground testing and a deliberate native-companion decision if trust onboarding is too complex.

- [ ] **Step 4: Verify and commit**

  Run transport/TLS tests and typecheck; expect no insecure option in source. Commit `feat: separate trusted LAN transport from local development`.

## Task 4: Authenticated upgrade, connection quotas, heartbeat and safe logs

**Files:**
- Create: `packages/device/src/server/device-authenticator.ts`, `upgrade-gate.ts`, `connection-registry.ts`, `heartbeat.ts`, `log-redaction.ts`, `packages/app/src/network-upgrade.ts`
- Test: `packages/device/test/upgrade-gate.test.ts`, `connection-registry.test.ts`, `log-redaction.test.ts`

**Interfaces:**

```ts
export class DeviceAuthenticator { authenticate(request: IncomingMessage, role: DeviceRole): Promise<DevicePrincipal>; }
export class UpgradeGate { handle(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>; }
export class ConnectionRegistry { add(socket: WebSocket, principal: DevicePrincipal): ConnectionLease; revoke(deviceId: string): void; }
```

- [ ] **Step 1: Write RED upgrade tests**

  Wrong route/query credential/subprotocol `chessonglass.v1`/token/role/browser origin and exceeded quota must reject before `handleUpgrade`. Native bearer without Origin is allowed; browser cookie requires configured HTTPS Origin. Viewer token cannot open camera/controller; revoking a device terminates its live socket and drops subsequent messages.

- [ ] **Step 2: Implement pre-upgrade authorization**

  Parse pathname against a fixed base, reject all query parameters, authenticate role/scope, check origin/subprotocol/quota, then call `handleUpgrade` once. Use minimal 401/403/404/429 responses and destroy rejected sockets without echoing raw URLs/tokens. Only verified principal is stored in connection context; metadata cannot elevate it.

- [ ] **Step 3: Implement quotas/heartbeat/redaction**

  Enforce 32/2/8 limits with exactly-once cleanup on close/error/revoke. Ping every 15 seconds, terminate after 30 seconds without pong, clear all timers. Redact authorization/cookie/pairing/token/canary values recursively and never log JPEG bytes or raw URLs.

- [ ] **Step 4: Verify and commit**

  Run upgrade/quota/heartbeat/redaction tests and typecheck; expect all rejection paths and resource cleanup PASS. Commit `feat: authenticate and bound websocket connections`.

## Task 5: JPEG ingestion, session registry and receipt freshness

**Files:**
- Create: `packages/device/src/server/sequence-validator.ts`, `camera-socket.ts`, `packages/device/src/network-camera-source.ts`, `packages/app/src/network-session-registry.ts`, `mailbox-network-frame-sink.ts`
- Test: `packages/device/test/camera-socket.test.ts`, `packages/app/test/network-session-registry.test.ts`

**Interfaces:**

```ts
export class NetworkSessionRegistry {
  createCamera(deviceId: string, capabilities: Capabilities): CameraSessionGrant;
  bind(hello: CameraHello, deviceId: string): NetworkCameraSource;
}
export class SequenceValidator { accept(metadata: FrameMetadata): SequenceDisposition; }
export class CameraSocketHandler { attach(socket: WebSocket, principal: DevicePrincipal): void; }
```

- [ ] **Step 1: Write RED message/sequence tests**

  Valid text metadata followed by exactly one JPEG binary produces the exact frame with backend receipt time. Reject binary-first, repeated metadata, extra binary, malformed JSON/UTF-8, unknown fields, length mismatch, invalid JPEG markers and >1 MiB. Sequence starts zero then exactly increments; duplicates/gaps/wrong session/source and overflow are rejected without wrapping.

- [ ] **Step 2: Implement bounded camera handler**

  Keep only one pending metadata record. Receive complete binary, stamp `receivedAtMonotonicMs`, then offer to the shared `LatestFrameMailbox` using its actual `offer` method. Pause/resume socket around publish; no JPEG array or second queue. Close protocol violations with 1008/1009 and clear pending state. Do not decode or call cloud in the socket handler.

- [ ] **Step 3: Write and implement session/time/reconnect tests**

  Two interleaved cameras cannot mix frames; reconnect starts at zero in a new epoch and old evidence is rejected. Backward/far-future sender timestamps do not change receipt freshness or fabricate latency. Under load, only the latest pending frame survives. `POST /v1/camera/sessions` creates authenticated backend grant; stop/replace invalidates coordinator/source state.

- [ ] **Step 4: Verify and commit**

  Run camera/session tests and typecheck; expect exact session isolation and no queue growth. Commit `feat: ingest authenticated jpeg frames with session isolation`.

## Task 6: Capability-aware results and controller scopes

**Files:**
- Create: `packages/device/src/server/output-socket.ts`, `latest-result-writer.ts`, `packages/device/src/companion-result-sink.ts`, `packages/app/src/coordinator-companion-port.ts`, `companion-control-bridge.ts`
- Test: `packages/device/test/output-socket.test.ts`, `packages/app/test/companion-control-bridge.test.ts`

**Interfaces:**

```ts
export interface CoordinatorCompanionPort {
  subscribe(sessionId: SessionId, listener: (result: Result) => void): () => void;
  isCurrent(context: RequestContext): boolean;
  execute(context: RequestContext, command: GameCommand): Promise<void>;
}
export class LatestResultWriter { offer(result: Result): void; }
```

- [ ] **Step 1: Write RED role/capability/session tests**

  Camera cannot receive results/control; viewer commands close 1008; controller cannot send JPEG; output token joins only its granted session. Camera-only device requires no audio/display sink. Audio-only/display-only clients receive structured results independently. Late/mismatched context is never sent or executed.

- [ ] **Step 2: Implement output/control bridges**

  Viewer receives structured results; controller may also send allowlisted `GameCommand` with full context. Check current identity before dispatch and let coordinator perform the final single-writer check. Unsubscribe on close/session change/revoke. Do not add vendor-specific result shapes.

- [ ] **Step 3: Implement bounded latest-result writer**

  Maintain `sending + latestPending`, not an array. Use `bufferedAmount` and send callbacks; replace older pending results, never truncate context. Over 1 MiB queued output for a continuous five seconds terminates the socket. Test a slow viewer with many results shows bounded memory and eventual termination.

- [ ] **Step 4: Verify and commit**

  Run output/control tests and typecheck; expect role, context and backpressure cases PASS. Commit `feat: add scoped companion results and controls`.

## Task 7: Simulator, second-source proof and honest vendor scaffolds

**Files:**
- Create: `packages/device/src/simulator/simulated-camera-client.ts`, `adapters/vendor-adapter.ts`, `meta-dat.ts`, `brilliant-frame.ts`, `esp32.ts`, `capability-evidence.ts`, `docs/device-evidence.md`
- Test: `packages/device/test/vendor-adapters.test.ts`, `packages/app/test/second-source-contract.test.ts`, `network-security-regression.test.ts`

**Interfaces:**
- `VendorAdapterScaffold.probe():AdapterProbe` returns `status:"scaffold"` and actual supported capabilities false.
- `CapabilityEvidence` requires exact model/board, firmware, OS/companion, SDK/version, artifact hash, tested capabilities, limits, date/tester and class `simulator|bench|hardware`.

- [ ] **Step 1: Write RED evidence tests**

  Meta/Frame/ESP32 scaffolds reject start as not implemented; missing firmware/model/SDK/hash/limits invalidates evidence; simulator evidence cannot promote hardware support. Simulator hello explicitly says `clientKind:"simulator"` and only works on opted-in loopback.

- [ ] **Step 2: Implement scaffolds and simulator**

  Meta seam documents Android/iOS companion and distribution preview; Frame seam documents BLE camera/mic/display without assuming speakers; ESP32 requires exact board/sensor/PSRAM/firmware. No vendor SDK imports until an adapter task has hardware and approved versions. Simulator sends small JPEG fixtures only and is not in default source choices.

- [ ] **Step 3: Prove two source types share the coordinator**

  Feed replay and network simulator equivalent observations into fake reader/advisor and assert identical PGN/results with no vendor branch in chess logic. Run the consolidated Gate 4 security suite: pairing expiry/reuse/revoke, roles, payload/quota, reconnect, heartbeat and log canaries.

- [ ] **Step 4: Verify and commit**

  Run scaffold/second-source/security tests and typecheck; expect only “two source types” evidence, no hardware claim. Commit `test: prove second source without claiming hardware support`.

## Task 8: Optional call/audio/media gates without default dependencies

**Files:**
- Create: `packages/app/src/whatsapp-preset.ts`, `packages/platform/src/virtual-audio.ts`, `windows-virtual-audio.ts`, `macos-virtual-audio.ts`, `linux-virtual-audio.ts`, `packages/device/src/optional-media.ts`, `docs/optional-integrations.md`
- Test: corresponding `whatsapp-preset.test.ts`, `virtual-audio.test.ts`, `optional-media.test.ts`

**Interfaces:**
- `VirtualAudioCapabilityService.probe():Promise<VirtualAudioProbe>` and `createRoute():Promise<AudioRoute>` require license, signing and runtime evidence.
- `evaluateOptionalMediaRequirement(record):OptionalMediaDecision` handles RTSP and WebRTC as separate owner-approved requirements.

- [ ] **Step 1: Write RED optional-integration tests**

  Default direct text/audio never probes/install drivers or starts media services. Missing any license/signature/runtime gate fails closed. Windows never calls BlackHole/PipeWire; macOS does not bundle BlackHole installer by default; Linux does not migrate audio stacks. RTSP requirement does not enable WebRTC and vice versa.

- [ ] **Step 2: Implement decision gates, not a media stack**

  Windows requires exact INF/CAT/SYS/version/hash/arch, redistribution rights, appropriate kernel signature evidence and runtime with Secure Boot/Memory Integrity/test-signing expectations documented. macOS separately reviews source/binary/branding/signing. Linux only probes existing PipeWire/PulseAudio support. WhatsApp preset only selects an authorized capture window/output route; it does not assert audio injection compatibility.

- [ ] **Step 3: Document supported/unsupported states**

  Record evidence needed for every optional path and how to open an RTSP or duplex WebRTC requirement. Do not add MediaMTX/aiortc or a driver before that review. Direct text/audio remains available if optional gates fail.

- [ ] **Step 4: Verify and commit**

  Run optional tests and typecheck; expect no new default driver/media dependency. Commit `feat: gate optional audio and media integrations`.

## Task 9: Security regression, SBOM, immutable artifacts and release gates

**Files:**
- Create: `.github/workflows/package.yml`, `scripts/release/generate-sbom.mjs`, `verify-artifacts.mjs`, `check-security.mjs`, `release-gate.mjs`, `release/artifacts.lock.json`, `release/rights-register.json`, `release/source-offer.json`, `THIRD_PARTY_NOTICES.md`
- Modify: `.github/workflows/ci.yml`, root `package.json`, `package-lock.json`
- Test: `packages/app/test/release-artifacts.test.ts`, `security-scanner.test.ts`

**Interfaces:**
- Add `test:security`, `release:sbom`, `release:verify -- --channel pilot|external`, `release:gate -- --channel pilot|external`.

- [ ] **Step 1: Write RED artifact/security tests**

  Mutating one byte, unknown OS/arch/build flags/source URL/license/hash must fail. External release blocks unresolved rights, missing permission evidence, unapproved owner/publisher and unmet signing requirements. Pilot allows only explicitly warned development/self-signed mode. Scanner detects TLS bypass, query credentials and raw secret logging; safe fixtures do not false-positive.

- [ ] **Step 2: Implement SBOM/artifact verification**

  Generate SPDX 2.3 JSON from exact lockfile and native artifact lock. Distinguish wrapper license from downloaded executable license. Stockfish requires corresponding source/NNUE for the exact binary; FFmpeg requires actual flags/license/source offer and rejects unredistributable builds. Preserve notices and original attribution without inventing rights.

- [ ] **Step 3: Implement CI/package gates**

  CI runs Windows/macOS/Linux clean install, typecheck/build/unit/integration/free-running replay/local HTTP security/browser golden path/security regression. Pin actions by full commit SHA. Package workflow only builds/verifies, never publishes. Required native tests fail when skipped; cloud/hardware jobs are manual and separately labeled.

- [ ] **Step 4: Verify expected pass/block outcomes and commit**

  Run `test:security`, `release:sbom`, `release:verify --channel pilot`; pilot passes only with full artifact evidence and warnings. `release:verify --channel external` must return nonzero `BLOCKED: rights approval required` until evidence exists. Never weaken a gate to obtain green. Commit `build: add auditable release gates`.

## Task 10: Clean-machine pilot, documentation sync, parity and conditional legacy removal

**Files:**
- Create: `scripts/release/clean-machine-smoke.mjs`, `docs/clean-machine-pilot.md`, `docs/support-matrix.md`, `docs/legacy-parity.md`, `legacy-parity.json`
- Modify: `README.md`, `DESIGN.md`, `research/RESEARCH.md`, build/test configs when approved
- Test: `packages/app/test/legacy-parity.test.ts`

**Interfaces:**
- Add `test:clean-machine -- --channel pilot`, `parity:verify`; evidence distinguishes automated, clean-machine, simulator, real-device and external-user results.

- [ ] **Step 1: Write RED parity/support tests**

  Every legacy module/test/eval has replacement paths plus passing commands or a deliberate-removal rationale. Missing evidence/path/command fails. Simulator is never hardware pass; macOS/Linux cannot be marked supported without native clean-machine evidence; optional routes are not default requirements.

- [ ] **Step 2: Run clean-machine and pilot checks**

  On a clean Windows reference, run `npm ci`, build, typecheck, tests, security, clean-machine smoke and pilot release gate. Include install/setup, source selection, native audio/credential/executable checks, pairing/revoke, upgrade/uninstall and retention. Repeat for each OS to be advertised; unavailable evidence means unsupported. Pilot users complete a consented full game and recovery without developer intervention; record setup time/errors/interventions.

- [ ] **Step 3: Synchronize all documentation**

  README describes actual local-first setup, optional LAN, trusted certificates, capabilities and supported limits. DESIGN documents protocol/roles/auth ordering/sequence/receipt freshness/backpressure. RESEARCH records exact `ws` version/docs and remaining gaps. Plans remain implementation documents, not proof of completion. External release stays blocked if rights/owner/evidence is incomplete.

- [ ] **Step 4: Verify parity before any deletion**

  Run `parity:verify`, all tests/security and pilot verification. If any required check fails, stop, retain legacy and fix the underlying cause rather than bypassing it. Obtain a separate owner approval before deletion; do not infer it from this plan.

- [ ] **Step 5: Conditionally remove legacy and commit**

  Only after parity and explicit deletion approval, remove legacy `src`, `tests`, `evals` with `git rm -r src tests evals`; never touch `asset/`, research, rights register or user data. No filter-branch/filter-repo/reset/force push/history rewrite. If not approved, record “legacy retained pending deletion review”. Run final typecheck/tests/security/parity/pilot and external gate; external remains blocked when appropriate. Commit `docs: record pilot evidence and replacement parity` for reviewed work only.

## Slice exit criteria

- [ ] Two different source types use the same coordinator with session isolation and no vendor-specific chess logic.
- [ ] LAN pairing, role scope, revocation, TLS, payload/quota/backpressure and log redaction pass integration/security tests.
- [ ] Vendor simulator/scaffold results are never presented as hardware support.
- [ ] No optional paid driver/media service is added by default.
- [ ] Pilot artifacts have immutable versions/hashes/notices and a clean-machine result; external release remains blocked until rights/owner requirements pass.
- [ ] Legacy removal occurs only after explicit parity and separate owner approval.
