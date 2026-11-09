# Windows Graphics Capture spike (plan 02, Task 5)

Date: 2026-11-09. Status: **passed on the reference Windows machine.**

## Candidate

`@screen-capture/node@1.1.0` — MIT, napi-rs binding over the maintained
`windows-capture` 2.0.0 Rust crate (Windows Graphics Capture). It provides
per-window capture (`windowHandle`), window enumeration, capability checks and
a native picker option. Exact version, integrity and the platform binary hash
are recorded in `packages/app/native/screen-capture/selection.lock.json`.

Rejected for now: `@eisland/windows-screenshot-helper` (GPL-3.0, screenshot
helper rather than a capture stream) — GPL implications are not acceptable
while the project license is undecided.

## Host and result

- Windows 11 Enterprise 10.0.26300, x64; Node 26.3.0.
- `isSupported(): true`; `graphicsCapture: true`; all optional settings true.
- `node packages/app/scripts/smoke-screen-capture.ts` captured the foreground
  window (a normal visible application window) and produced **two distinct
  JPEG frames** (1477x977, ~117 KB each, different SHA-256) in 798 ms, then
  closed the native session cleanly.
- A window title is carried as an opaque DTO string only; it never becomes a
  path or a command.

## Limitations

- No claim is made for minimized, occluded or RDP windows; only a normally
  visible consented window was captured.
- The native `usePicker` flow needs a human; unattended verification covers
  enumeration plus explicit target selection and Start instead.
- Requires Windows 10 version 1903 or newer with the MSVC runtime.
- Other call applications are just user-selected windows; no call-app audio
  integration exists here.

## Reproduction

```sh
npm ci
node packages/app/scripts/smoke-screen-capture.ts ["title text"]
```

The script exits non-zero unless two distinct frames were captured and the
session closed cleanly.
