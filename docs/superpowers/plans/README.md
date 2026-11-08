# ChessOnGlass implementation-plan set

Approved design: `../specs/2026-11-07-cross-platform-rewrite-design.md`.

Status 2026-11-08: all four slices drafted, 45 tasks total; cross-plan review is in progress. This is a four-slice replacement program, not a claim that the rewrite has already been implemented or validated. Execute in order using the shared contracts in the approved design and slice 01. Each task is a small reviewed local commit; no push, merge, npm publication, history rewrite or deletion of legacy source is implied by a task’s commit step.

| Order | Plan | Deliverable | Entry gate |
|---|---|---|---|
| 01 | `2026-11-08-01-foundation-and-game-core.md` | Portable workspace, chess/history, observation contracts, cancellable game coordinator, budget, persistence and free-running evaluation | Approved design; record rights baseline |
| 02 | `2026-11-08-02-windows-user-journey.md` | Branded Windows webcam/replay/dashboard/provider/TTS application with tested local controls | Slice 01 interfaces and tests pass |
| 03 | `2026-11-08-03-overlay-and-desktop-platforms.md` | Safe dashboard/exported overlay plus macOS/Linux native integrations and support matrix | Slice 02 local user journey works; measured platform spikes |
| 04 | `2026-11-08-04-devices-and-release.md` | Authenticated device adapters, optional integrations, secure packaging/pilot and reviewed legacy removal | Slices 01–03 pass; rights/provenance evidence before external release |

## Non-negotiable cross-slice rules

- `asset/logo.png` remains unchanged byte-for-byte.
- `Frame`, `RequestContext`, `GamePosition`, `FrameSource`, `BoardReader`, `Advisor`, `GameCoordinator` and `PlatformServices` are shared contracts. Any signature change requires updating all plans and dependent tests in the same reviewed change.
- Only `GameCoordinator` authoritatively mutates the live game. All async work carries session/position/request identity and is rejected when stale.
- Camera, microphone, audio output and display are independent capabilities; unsupported hardware is not silently emulated.
- No mandatory WhatsApp, BlackHole, Jev, Docker Desktop, media server or public backend.
- No “all OS/glasses/apps supported” statement without an OS/browser/device-specific integration result.
- No mock, simulator or replay result is presented as live model/hardware evidence.
- External distribution waits for permission, attribution, license, binary provenance, notices and release security checks.
- The earlier audit was incomplete and is not a security clearance. Re-audit new HTTP, device, credential and media paths after implementation.
- Current local `.git` metadata was unexpectedly reinitialized during planning; inspect/recover it deliberately before executing commit steps. Never reset or force-push over the existing GitHub history.
