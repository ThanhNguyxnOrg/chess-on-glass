# Windows validation evidence

Recorded: 2026-11-09. Host: Windows 11 Enterprise 10.0.26300, x64, Node 26.3.0.

## Mocked tests (pass in CI)

| Area | Evidence |
|---|---|
| HTTP boundary | `local-http-security.test.ts` — 401/403/411/413/415/400 matrix, query-token rejection, no-route-when-unauthorized |
| Static files | `static-files.test.ts` — traversal, backslash, junction escape all 404 |
| Browser frames | `browser-frame-auth.test.ts` — 401/403/409/413/415, freshness (receipt clock), sequence per (session, source) |
| FFmpeg replay | `ffmpeg-replay-source.test.ts` — first-frame timeout, bound exceeded, nonzero exit, late events after close, speed/fps validation, path grammar |
| WGC source | `windows-screen-source.test.ts` — first frame gate, EOF, abort, close idempotent |
| WGC client | `windows-capture-client.test.ts` — list targets, picker cancellation, preview timeout/abort, start target validation |
| Speech engine | `system-speech-engine.test.ts` — bounded stdin JSON, malformed/oversized/failed → speech_unavailable, abort kills owned child, close kills active |
| Speech sink | `speech-sink.test.ts` — order, stale-context drop, backend failure tolerance |
| Providers | `openai-reader.test.ts` + `anthropic-reader.test.ts` — image bytes, reference FEN, schema, refusal/incomplete mapping, 401 no-retry, 429 retry-once, timeout → unavailable, no key leak |
| Provider factory | `provider-factory.test.ts` — disabled cloud throws, unknown model throws, missing credential throws, exact prices |
| Settings | `settings.test.ts` — defaults, round-trip, malformed rejection, unknown fields |
| Secrets | `secret-service.test.ts` — keyring primary, env override, write/readback, no plaintext on failure |
| Doctor | `doctor.test.ts` — runtime, user-data writes, credential-store round-trip, FFmpeg/Stockfish presence, WGC/speech support, cloud not-run |
| Source manager | `source-manager.test.ts` — start/replace/close lifecycle, replacement failure keeps old source, close idempotent |
| View model | `view-model.test.ts` — JSON-safe, no secrets/tokens/bigint |
| Chess core | Plan 01 tests — state, PGN, matching, coordinator races, journal, budget, evaluation |

## Real-machine checks (owner-run on reference Windows)

| Check | Status | Evidence needed |
|---|---|---|
| WGC spike | **PASSED** | 2 distinct frames 1477×977, clean close, 798 ms — `selection.lock.json` |
| Speech smoke | **PASSED** | 2 en-US voices listed, speak OK, no vi-VN — `smoke-speech.ts` output |
| Audible speech | **Open** | Human: confirm sound is audible from the speaker |
| Keyring persistence | **Open** | Write dummy credential, restart, read back, remove via OS UI |
| Stockfish engine | **Open** | Set `CHESSONGLASS_STOCKFISH`, run `npm run test:engine` |
| FFmpeg replay | **Open** | Set `CHESSONGLASS_FFMPEG`, run `npm run test:native` |
| Browser webcam | **Open** | Chrome/Edge: start/stop/freeze/restart webcam in dashboard |
| Paid cloud smoke | **Open** | Owner opt-in + bounded fixture + cost limit; `CHESSONGLASS_CLOUD_SMOKE=1` |

## Build toolchain

| Tool | Version | Evidence |
|---|---|---|
| Node.js | 26.3.0 | `node --version` |
| TypeScript | 7.0.2 | `npx tsc --version` |
| Vitest | 4.1.12 | `npx vitest --version` |
| Vite | 8.3.6 | `npx vite --version` |
| Sharp | 0.35.5 | `package-lock.json` |
| @screen-capture/node | 1.1.0 | `selection.lock.json` (sha256 in lock) |
| openai | 7.55.0 | `package-lock.json` |
| @anthropic-ai/sdk | 1.7.0 | `package-lock.json` |
| chess.js | 1.4.0 | `package-lock.json` |
