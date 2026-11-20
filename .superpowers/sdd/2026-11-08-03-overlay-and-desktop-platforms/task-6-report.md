# Task 6 Report — Native credential-store implementation and per-OS executable installation

**Status:** DONE_WITH_CONCERNS
**Commit:** `b2f5292` — `feat: install verified native tools and secret storage`
**Host evidence:** Windows 11 Enterprise 10.0.26300 (win32/x64), Node v26.3.0, repo on Node 24+ workspaces, TS 7 strict ESM.

---

## 1. TDD evidence

**RED.** Wrote the brief's Step-1 tests first: `packages/platform/test/native-keyring.test.ts`,
`manifest.test.ts`, `install-artifact.test.ts`, `node-platform-services.test.ts`,
`packages/app/test/setup/install-tools.test.ts`. First run (all modules absent):

```
Test Files  5 failed (5)
     Tests  50 failed (50)        (Duration 630ms)
```

Failures were missing exports/constructors (`NodePlatformServices is not a constructor`, missing
`createNativeSecretStore`, `parseArtifactManifest`, `installVerifiedArtifact`, `installTool`).

**GREEN.** After implementing:

```
npm run typecheck        → tsc -b clean (emits dist)
npm run test:unit        → Test Files 66 passed (66), Tests 528 passed (528)
Focused: platform 50/50 + app setup 3/3 (53 new tests)
```

Two mid-green fixes found by the tests themselves (recorded for honesty):
- Windows keeps a file locked while a stream holds it → the download error path now **awaits the
  stream `close` event** before the `finally` cleanup `rm()`, so failed installs truly leave the
  destination empty (covered by "leaves nothing behind" assertions).
- `mode << 16` overflows int32 in the test zip builder (JS `<<` is signed) → `(mode << 16) >>> 0`.

### What the RED suite pins down

- **Wrong-OS rejection:** `createNativeSecretStore` on `sunos|freebsd|openbsd|aix|android` throws
  `NativeSecretStoreError("unsupported-os")` naming the platform and the three supported stores —
  never a store, never a fallback. `NodePlatformServices.readSecret/writeSecret` surface the same
  typed error lazily (construction on an exotic OS does not throw; first secret use does).
- **Readback/failure → typed error, no plaintext fallback:** locked store on read/write/remove
  rejects with `NativeSecretStoreError("store-unavailable")`; the store never consults
  environment variables (separate test asserts an env override is *not* copied into OS storage —
  overrides remain SecretService's (app) concern).
- **Linux honesty:** the entry factory always receives
  `{ linux: { store: "secret-service" } }` — the binding throws when the Secret Service is
  unavailable instead of silently degrading to the RAM-only keyutils keyring (which "will not
  persist across reboots" per the binding's own docs). `backend` is exposed
  (`windows-credential-manager` / `macos-keychain` / `linux-secret-service`) for honest diagnostics.
- **Account hygiene:** empty/whitespace/control-char/>512-char accounts reject with
  `invalid-account` before the store is touched; error messages never echo the secret (asserted).
- **Manifest:** schema/id/os/arch/url/digest-shape/license/source/buildFlags/executable validated;
  duplicate `(id, os, arch)` rejected; unsafe executable member names (`..`, absolute, drive
  letter, backslash, `.`/empty segments, control chars) rejected at parse time. A record with
  `"unverified"` digest parses (so release engineering can see the TODO) but `selectArtifact`
  fails closed on it — trust gating stays in selection, structure in parsing.
- **Installer (`installVerifiedArtifact`):** digest mismatch during download → `digest`, **no
  executable at the destination** (destination asserted empty); oversize download → `size-cap`
  + empty; pre-aborted signal → `aborted` before any request; abort during a stalled download →
  `aborted` + temp cleaned; non-https or malformed digest → `invalid-record` without fetching;
  HTTP 404 → `http`; traversal/absolute/backslash member names → `unsafe-member`; zip symlink
  members (POSIX mode in external attrs), tar symlinks/hardlinks/char/block devices →
  `unsafe-member`; encrypted entries, data descriptors, zip64 markers → `unsupported-archive`;
  xz/zstd/unknown magic → `unsupported-archive` with an actionable message; member absent →
  `member-missing`; corrupt deflate / CRC-32 mismatch / truncated tar → `corrupt-member`;
  decompressed member over cap → `size-cap`. Happy paths: zip (deflate) and tar.gz extract
  **only** the allowlisted executable member, companions are not extracted, no temp files remain,
  missing destination directory is created, an existing executable is replaced atomically,
  POSIX exec bits set (skipped on Windows).

---

## 2. Keyring binding evaluation (ruling 2)

Research date: 2026-11-20 (npm registry + published `index.d.ts` + README).

**Selected: `@napi-rs/keyring` `2.1.2`, pinned `--save-exact` in `packages/platform/package.json`.**

| Criterion | Evidence |
|---|---|
| Maintained | npm `modified: 2026-10-19`; latest 2.1.2; Node.js binding of `keyring-rs` (hwchen/keyring-rs) via napi-rs; CI on GitHub Actions |
| Node 24 compatibility | `engines: node >= 10`; NAPI (ABI-stable), no compile step |
| Prebuilt binaries | optionalDeps: `win32-x64-msvc`, `win32-ia32-msvc`, `win32-arm64-msvc`, `darwin-x64`, `darwin-arm64`, `linux-x64-gnu/musl`, `linux-arm64-gnu/musl`, `linux-arm-gnueabihf`, `linux-riscv64-gnu`, `freebsd-x64` — covers Windows (x64+arm64) now, macOS and Linux natively |
| License | MIT (binding). Per-platform `LICENSE.third-party.md` shipped; note: Linux `.node` binaries statically link libdbus (AFL-2.1 OR GPL-2.0-or-later) — recorded here for release compliance |
| API fit | `AsyncEntry.getPassword(): Promise<string \| null>` (null = absent; rejects when store locked/inaccessible), `setPassword(): Promise<void>`, `deleteCredential(): Promise<boolean>` (false = absent; rejects on real failure) — maps 1:1 onto `NativeSecretStore` |
| Linux honesty | `EntryOptions.linux.store = "secret-service" \| "keyutils"`; pinning **throws** when the required store is unavailable — no silent fallback. We always pin `secret-service`; keyutils is RAM-only and never selected |
| No install-time side effects | no node-gyp/prebuild-install; prebuilt `.node` from optionalDeps |

**Candidates considered and rejected:**
- `keytar` 7.9.0 — archived/deprecated by GitHub (Atom sunset); depends on `node-addon-api ^4`
  and `prebuild-install`, no prebuilds for current Node ABIs (compiles from source at install
  time); upstream recommends migration.
- `keyring` 1.1.0 — last publish 2022, deps `winston 0.7`/`minimist 0.0.8`; not a native binding.
- `confidential` 0.3.0 — 2022, not a native keyring binding.
- DPAPI addons (`win-dpapi`, `dpapi-addon` family) — Windows-only, protect blobs but are not the
  Credential Manager and serve no macOS/Linux path.
- Electron `safeStorage` — Electron-only; `PlatformServices` must work under plain Node.
- Shell-outs (`cmdkey`, PowerShell CredMan scripts, `security`, `secret-tool`) — `cmdkey` cannot
  read secrets back; PowerShell CredMan helpers are third-party scripts that persist plaintext on
  disk; explicitly forbidden by the controller ruling.

---

## 3. Implementation map

- `packages/platform/src/secrets/native-keyring.ts` — `NativeSecretStore` interface,
  `NativeSecretStoreError` (codes `unsupported-os | invalid-account | store-unavailable`),
  `KeyringSecretStore` (AsyncEntry-backed; typed error wrapping; no secret in messages),
  `createNativeSecretStore(platform, { service?, entryFactory? })` — per-OS selection, Linux
  pinned to Secret Service, lazy dynamic import of the binding (injectable factory for tests).
- `packages/platform/src/services/node-platform-services.ts` — `NodePlatformServices implements
  PlatformServices`: `userDataDir` delegates to `paths.ts` (env override lives there);
  `readSecret/writeSecret` delegate to the native store; `openExternal` per-OS
  (`rundll32 url.dll,FileProtocolHandler` via absolute System32 path on win32, `open` on darwin,
  `xdg-open` on linux) through the existing bounded `runProcess` (no shell, 10 s deadline, 64 KiB
  output cap); **http/https URLs only** — `file:`/`javascript:`/unparseable fail closed.
- `packages/platform/src/artifacts/manifest.ts` — `VerifiedArtifact` (= `Artifact` + `buildFlags`
  + `executable`), `parseArtifactManifest`, `assertSafeMemberName`. Extends the existing
  `Artifact`/`selectArtifact` rather than replacing them; `selectArtifact` became generic
  (`<T extends Artifact>`) so extended records pass through without being narrowed (non-breaking).
- `packages/platform/src/artifacts/install-artifact.ts` — `installVerifiedArtifact(record,
  destinationDirectory, signal, options?)` + `InstallFailure` (10 typed codes). Streamed download
  with SHA-256 **during** download and a byte cap (fail before any executable exists), magic-byte
  format sniff (zip / tar.gz; xz and zstd rejected with actionable messages), strict central-
  directory/tar-header validation of **every** member (names, symlink/device/hardlink types,
  encryption, data descriptors, zip64, pax/GNU extension headers), extraction of **only** the
  allowlisted `record.executable` member with size cap + CRC-32 (zip) verification, write to a
  sibling temp file (`wx`) then atomic rename in the same directory (same volume), executable
  bits on POSIX, temp cleanup on every path including abort. `installVerifiedArtifact` is the
  only downloader: no npm-install hook, no PATH/global fallback.
- `packages/app/src/setup/tool-manifest.ts` — reviewed manifest records (version, url, sha256,
  license, sourceUrl, buildFlags, executable per OS/arch).
- `packages/app/src/setup/install-tools.ts` — explicit setup command: parse manifest →
  `selectArtifact(records, id, platform, arch)` → `installVerifiedArtifact` into
  `<userDataDir>/tools/<id>`; missing/unpinned tools are loud errors (release integration never
  silently skips a native tool).
- `packages/app/scripts/native-smoke.ts` — `keyring` subcommand now performs the real OS
  round-trip (below). `packages/app/scripts/smoke-install-tools.ts` — real installer + UCI smoke.
- `packages/platform/src/index.ts` — exports added in the existing style.

---

## 4. Real-machine smoke evidence (Windows, ruling 5)

**Credential Manager round-trip** (`node packages/app/scripts/native-smoke.ts keyring`):

```json
{
  "command": "keyring",
  "ok": true,
  "backend": "windows-credential-manager",
  "account": "ChessOnGlass-Task6Smoke-01c426b5-7e29-4e5c-9bb5-085b49d3467c",
  "roundTrip": true,
  "removed": true,
  "secretValueLogged": false,
  "date": "2026-11-20T07:37:35.626Z",
  "platform": "win32", "arch": "x64", "node": "v26.3.0"
}
```

Dedicated throwaway account: write → exact readback (`roundTrip: true`) → remove → read returns
null (`removed: true`). Cleanup runs even on the failure path (catch → `remove`). No real secret
was ever stored; the random smoke secret is not logged.

**Installer + UCI startup** (`node packages/app/scripts/smoke-install-tools.ts` — real 81,431,614-byte
download from the official Stockfish GitHub release, streamed digest check, allowlisted
extraction, atomic rename, then `uci` handshake over stdin):

```json
{
  "command": "install-tools",
  "ok": true,
  "installedPath": "C:\\Users\\Admin\\AppData\\Roaming\\ChessOnGlass\\tools\\stockfish\\stockfish-windows-x86-64-universal.exe",
  "installedSha256": "45bc8e4969147db9c2eb533810637994619bff0eacc81ccfd9854394901bcbd0",
  "uciId": "id name Stockfish 19",
  "uciHandshake": true,
  "date": "2026-11-20T07:44:59.126Z",
  "platform": "win32", "arch": "x64", "node": "v26.3.0"
}
```

The real archive also validated the strictness rules against reality: it contains members with
interior spaces (`stockfish/Top CPU Contributors.txt`), which surfaced as an over-strict
printable-ASCII check during the smoke; the rule was corrected to reject control characters while
allowing interior spaces (leading/trailing whitespace still rejected), and the full suite was
re-run green afterwards.

---

## 5. Pinned artifact evidence (manifest data)

Verified today (downloaded from `https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-windows-x86-64-universal.zip`,
size 81,431,614 bytes — matches the GitHub release asset listing):

- `stockfish` / win32 / x64 / version 19 / sha256 `3c8bf1f9ea66a09350a40df4f632288285ac206d99f33ab5842c408fc30b48a7`
  / buildFlags `["universal"]` / executable `stockfish/stockfish-windows-x86-64-universal.exe` (verified by listing the archive).

All other records (stockfish win32-arm64, linux-x64, darwin-x64/arm64; ffmpeg win32-x64 from the
version-pinned GyanD/codexffmpeg 7.1.1 release) carry real release URLs, licenses, sources and
build flags but `sha256: "unverified"` — they parse but **fail closed at selection** until release
engineering downloads each once and pins the digest (the same one-command procedure used above).

---

## 6. Concerns / limitations

1. **Only one record is digest-pinned** (stockfish win32/x64). Every other OS/arch fails closed
   with `no verified artifact`/`sha256 is not a verified digest` until pinned. Honest, but it
   means non-Windows installs and ffmpeg are not yet installable in production.
2. **Archive formats:** zip (stored+deflate) and tar.gz (ustar) only. xz/zstd, zip64, encrypted
   entries, data descriptors, pax/GNU long-name headers are rejected with actionable messages.
   Some Linux ffmpeg distributions ship `.tar.xz`; a release pin must choose a zip/tar.gz source
   or the installer needs an xz backend (deliberately not hand-rolled in this task).
3. **Single-member extraction:** the installer extracts exactly the allowlisted executable.
   License texts shipped inside archives (e.g. Stockfish `Copying.txt`) are not copied next to
   the binary; GPL compliance must be handled at packaging/distribution level (license and
   sourceUrl are recorded per artifact). The official stockfish/ffmpeg binaries used here are
   static, so no DLL companions are required.
4. **macOS/Linux secret paths are untested on real hardware** (this task's host is Windows).
   Unit tests cover the delegation, Linux pinning and error mapping; the binding ships prebuilt
   binaries for both platforms. A darwin/linux smoke should ride along with the next real-host
   verification (the `keyring` smoke command is OS-agnostic already).
5. **libdbus license note:** Linux `.node` binaries of `@napi-rs/keyring` statically link libdbus
   (AFL-2.1 OR GPL-2.0-or-later); the binding itself is MIT. Recorded for release compliance.
6. Pre-existing bugs in unrelated `native-smoke.ts` commands (`require()` in `fileSha256`,
   `webcam`/`screen` cases) were left untouched — out of scope for this task.

## 7. Files

Commit `b2f5292` (17 files, +3048/−6): platform `secrets/native-keyring.ts`,
`services/node-platform-services.ts`, `artifacts/manifest.ts`, `artifacts/install-artifact.ts`,
generic `selectArtifact`, index exports, 4 platform test files, app `setup/tool-manifest.ts`,
`setup/install-tools.ts`, app setup test, `native-smoke.ts` keyring command,
`smoke-install-tools.ts`, platform package.json (+ pinned dep), lockfile. Staged files only;
`.gitignore`, `research/RESEARCH.md`, `.taste-skill/`, `asset/SocialPewiew.png`, `shots/` untouched.

---

## 8. Fix round 1 — archive hardening and available-OS media smoke

**Status:** DONE. Only the eight Important review findings were addressed; all six controller-deferred
Minors were left unchanged.

### RED feedback loop

Added regression coverage at the real `installVerifiedArtifact` / manifest-parser seams before changing
the implementation:

```
npx vitest run packages/platform/test/manifest.test.ts packages/platform/test/install-artifact.test.ts

Test Files  2 failed (2)
     Tests  10 failed | 29 passed (39)
```

The ten failures were the uppercase drive path plus nine new installer tests. The archive failures had
the reviewed symptoms: trailing/malformed ZIP structures and duplicate/overflowing tar inputs installed
successfully, the 64 MiB deflate bomb returned `corrupt-member` only after inflation, cleanup injection
returned `size-cap` instead of `cleanup`, and no injectable tar input stream was closed.

### Finding fixes and covering tests

1. **Uppercase/drive-relative Windows paths.** Drive detection is now `/^[a-z]:/i`. The existing unsafe
   executable test now explicitly covers `C:/stockfish.exe`, `C:stockfish.exe`, `z:/stockfish.exe`, and
   `Z:stockfish.exe`, rather than relying on a backslash case that failed earlier for another reason.
2. **Deflate bomb memory cap.** Replaced `inflateRawSync` with streaming `createInflateRaw`. Output chunks
   are bounded (at most cap+1 for small caps), retained output never exceeds `maxMemberBytes`, and the
   inflater is destroyed immediately when the next chunk crosses the cap. A declared size already above
   the cap is rejected before reading member data. Regression: a <256 KiB ZIP containing 64 MiB of
   deflate-compressed zeroes, with declared size and cap both 1024, must return `size-cap` and leave the
   destination empty. RED returned `corrupt-member` after full inflation; GREEN is `size-cap` through the
   streaming guard.
3. **Tar alignment overflow.** Replaced signed 32-bit bitwise alignment with exact Number arithmetic
   (`size + padding`, valid for the 11-digit octal ustar field) and check every member against the size cap
   before alignment/discard. Regression places a non-target member declaring 2 GiB+512 before a valid
   target. RED skipped a negative amount and installed the target; GREEN fails closed with `size-cap` and
   no output.
4. **Duplicate tar executable.** A second allowlisted member now throws `corrupt-member` with the same
   duplicate-member semantics as ZIP. Regression uses two copies and a one-payload member cap: RED
   concatenated both and succeeded; GREEN rejects and cleans the temporary output.
5. **Close/removal races and suppressed cleanup errors.** Added shared `destroyAndClose` and
   `removeTemporaryFile` helpers. Download and tar failure paths await the actual `close` event (never
   `destroyed && !writable`) before removal; successful `closeWrite` also waits for `close`. Download,
   member-extraction, and rename-failure removals no longer suppress errors. A real removal failure now
   surfaces `InstallFailure("cleanup")`. The injected-removal regression changed from RED `size-cap` to
   GREEN `cleanup`; existing digest/download-cap/abort/truncation tests still assert empty destinations.
6. **Tar input descriptor lifetime.** The decoded tar object now exposes both input and gunzip streams.
   A `finally` on every tar installation destroys gunzip, explicitly destroys the `autoClose: false` input,
   and awaits its real close. Instead of a platform-fragile fd-count test, the requested explicit
   assertions use a tracked real `ReadStream`: `destroy` is called and `closed === true` after successful
   extraction, truncated-stream failure, and abort.
7. **Fail-closed ZIP directory parsing.** EOCD search now requires comment length to end exactly at the
   file boundary; validates single-disk fields, matching entry counts, and zip64 markers; and requires
   the central directory to end exactly at EOCD. Every central record now has fixed-header and declared
   name/extra/comment bounds checks, parsing consumes the entire directory, and parsed records must match
   the EOCD count. Four regressions cover trailing bytes after EOCD, invalid disk/count fields, a
   truncated record via an oversized name length, and one trailing garbage byte inside the directory.
   RED accepted these archives; GREEN returns `corrupt-member` (or `unsupported-archive` for multi-disk)
   and leaves no executable.
8. **Verified installed FFmpeg smoke.** Pinned the existing supported ZIP record (no URL/format change was
   needed), and rewrote the installed-tool smoke to select both records directly from `TOOL_MANIFEST`.
   It installs Stockfish and FFmpeg through `installVerifiedArtifact`, checks the installed Stockfish UCI
   handshake, runs the installed FFmpeg `-version`, encodes one second of `testsrc2` to FFV1/Matroska,
   verifies non-empty EBML output, and removes the temporary movie in `finally`.

### FFmpeg pin evidence (Windows x64)

The one-command download/hash procedure (PowerShell) was:

```
New-Item -ItemType Directory -Force .task6-tmp | Out-Null
curl.exe -L --fail --retry 2 --output .task6-tmp/ffmpeg-7.1.1-essentials_build.zip `
  https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-essentials_build.zip
$f = Get-Item .task6-tmp/ffmpeg-7.1.1-essentials_build.zip
$h = Get-FileHash -Algorithm SHA256 $f.FullName
[pscustomobject]@{Length=$f.Length;Sha256=$h.Hash.ToLowerInvariant()} | ConvertTo-Json -Compress

{"Length":92234348,"Sha256":"04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4"}
```

- URL: `https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-essentials_build.zip`
- Archive size: **92,234,348 bytes**; archive SHA-256:
  **`04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4`**.
- `tar -tf .task6-tmp/ffmpeg-7.1.1-essentials_build.zip | Select-String 'ffmpeg.exe$'` listed
  `ffmpeg-7.1.1-essentials_build/bin/ffmpeg.exe`, matching the allowlisted member.
- Installed executable SHA-256 (different from the archive digest, as expected):
  `b90225987bdd042cca09a1efb5e34e9848f2d1dbf5fbcd388753a44145522997`.
- The downloaded pin scratch directory was removed after verification.

### Verification commands and output

Post-fix focused regression run:

```
npx vitest run packages/platform/test/manifest.test.ts packages/platform/test/install-artifact.test.ts
Test Files  2 passed (2)
     Tests  39 passed (39)
```

An intermediate compile probe caught a concise-arrow return type (`TS2322: InflateRaw is not assignable
to type void` at the inflater abort callback); changing it to a block body fixed it. Required final
verification then passed in the requested order:

```
npx vitest run packages/platform packages/app
Test Files  30 passed (30)
     Tests  203 passed (203)

npm run test:unit
Test Files  66 passed (66)
     Tests  537 passed (537)

npm run typecheck
tsc -b tsconfig.build.json --pretty false
(exit 0, no diagnostics)

npm run build
node scripts/build-workspaces.mjs
(exit 0, no diagnostics)
```

Real installer/UCI/installed-media smoke (`node packages/app/scripts/smoke-install-tools.ts`):

```json
{
  "command": "install-tools",
  "ok": true,
  "installedPath": "C:\\Users\\Admin\\AppData\\Roaming\\ChessOnGlass\\tools\\stockfish\\stockfish-windows-x86-64-universal.exe",
  "installedSha256": "45bc8e4969147db9c2eb533810637994619bff0eacc81ccfd9854394901bcbd0",
  "uciId": "id name Stockfish 19",
  "uciHandshake": true,
  "ffmpegInstalledPath": "C:\\Users\\Admin\\AppData\\Roaming\\ChessOnGlass\\tools\\ffmpeg\\ffmpeg.exe",
  "ffmpegInstalledSha256": "b90225987bdd042cca09a1efb5e34e9848f2d1dbf5fbcd388753a44145522997",
  "ffmpegVersion": "ffmpeg version 7.1.1-essentials_build-www.gyan.dev Copyright (c) 2000-2025 the FFmpeg developers",
  "ffmpegEncode": true,
  "ffmpegEncodedBytes": 57446,
  "ffmpegTemporaryMediaRemoved": true,
  "date": "2026-11-20T11:19:46.595Z",
  "platform": "win32",
  "arch": "x64",
  "node": "v26.3.0"
}
```

This reran the real Stockfish download/install after the download/close changes and verified the new
FFmpeg pin in the same run. Credential-store regression smoke (`node packages/app/scripts/native-smoke.ts
keyring`) also passed on Windows Credential Manager:

```json
{
  "command": "keyring",
  "ok": true,
  "backend": "windows-credential-manager",
  "roundTrip": true,
  "removed": true,
  "secretValueLogged": false,
  "date": "2026-11-20T11:20:42.821Z",
  "platform": "win32",
  "arch": "x64",
  "node": "v26.3.0"
}
```

The random dedicated account name is omitted here; the smoke created it, verified exact readback, removed
it, and confirmed absence. No secret value was logged.

---

## 9. Fix round 2 — bounded cleanup close waits

**Status:** DONE. Only the new close-wait finding was addressed; the six deferred Minors and all round-1
fixes were left unchanged.

### Implementation and outcome decision

- `destroyAndClose` now listens for both `close` and `error`, removes both listeners when settling, and
  races either terminal event against an explicit 2,000 ms deadline. A missing `close` therefore cannot
  leave an installation (including an aborted installation) pending. After the deadline the existing
  caller still attempts temporary-file removal; `removeTemporaryFile` still converts a removal rejection
  to `InstallFailure("cleanup")` rather than pretending cleanup succeeded.
- A close-time stream `error` resolves the best-effort close wait and is consumed by the attached listener,
  so it cannot become an unhandled error. That stream error alone deliberately does not replace the
  install's existing outcome; subsequent removal is still attempted, and a removal failure is surfaced as
  typed `cleanup`. `end`/`finish` are not treated as descriptor-close substitutes.
- `closeWrite` retains its existing `close`, `error`, and abort handling and now has the same 2,000 ms
  deadline. Its timeout rejects with `InstallFailure("cleanup")`; the existing callers then run their
  bounded destruction/removal path. All close-wait timers are cleared on every settled path.

### Regression tests

Two tests use a real `Readable` feeding the production tar decoder with `autoDestroy: false` and an
injected `destroy` implementation:

1. A stream that never emits `close` now settles at the deadline (asserted under 5 s), attempts and
   completes download-temp removal, and preserves the successful extraction outcome.
2. A stream that emits `error` at destroy time settles without an unhandled error; the still-rejecting
   injected removal produces `InstallFailure("cleanup")` naming the removal failure.

RED feedback before the implementation:

```
npx vitest run packages/platform/test/install-artifact.test.ts -t "bounds a close wait|handles a close-time" --testTimeout=5000
Test Files  1 failed (1)
     Tests  2 failed | 29 skipped (31)
```

Both tests timed out after 5 s on the old helper. The same command after the fix passed both tests in
2.08 s of test time. Required final verification, in the requested order:

```
npx vitest run packages/platform/test/install-artifact.test.ts
Test Files  1 passed (1)
     Tests  31 passed (31)

npm run test:unit
Test Files  66 passed (66)
     Tests  539 passed (539)

npm run typecheck
tsc -b tsconfig.build.json --pretty false
(exit 0, no diagnostics)
```
