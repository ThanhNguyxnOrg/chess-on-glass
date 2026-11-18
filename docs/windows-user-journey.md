# Windows user journey

ChessOnGlass on Windows x64: local dashboard, real board, real engine, no
WhatsApp / BlackHole / Jev / hosted backend.

## Setup

1. Install Node.js 24+ and npm.
2. Clone the repo, then `npm ci`.
3. Build: `npm run build`.
4. (Optional) Install Stockfish and FFmpeg, then set:
   - `CHESSONGLASS_STOCKFISH` → the Stockfish binary path
   - `CHESSONGLASS_FFMPEG` → the FFmpeg binary path
5. Run: `node packages/app/dist/cli.js run`

The dashboard opens in your default browser at `http://127.0.0.1:<port>`.
The launch token is in the URL fragment; it is never logged.

## Sources

| Source | How | Status |
|---|---|---|
| Browser webcam | Dashboard → Start webcam → allow camera | Fake-tested only |
| FFmpeg replay | `chessonglass run --replay path.mp4` | Code written; gate open (binary needed) |
| Window capture | Dashboard → Screen → Pick → Preview → Start | Real spike passed; adapter implemented |

## Output

| Channel | How | Status |
|---|---|---|
| Dashboard | Browser at 127.0.0.1 | Built; needs API wiring |
| Speech | System.Speech helper (short-lived process) | Real smoke: 2 en-US voices, no vi-VN |
| Text | Move history in dashboard | Built |

## Recovery

| Situation | Action |
|---|---|
| Camera denied | Dashboard shows the error; grant camera permission in browser |
| Frame frozen | Coordinator drops byte-identical frames; the next different frame is fresh |
| Source replaced | Old session is invalidated; new frames bind to a fresh session |
| Game over | Status "finished"; no new paid calls |
| Budget exhausted | Status "uncertain"; paid work paused until user acts |
| Helper crash | Mapped to `speech_unavailable` / `unavailable`; game state preserved |

## Troubleshooting

- **No camera**: check browser permission; on Windows, Settings → Privacy → Camera.
- **No speech**: run `node packages/app/scripts/build-speech-helper.mjs`; check volume.
- **No Vietnamese voice**: System.Speech lists installed voices; install a Vietnamese
  language pack from Windows Settings → Time & Language → Speech.
- **FFmpeg/Stockfish missing**: install them and set the environment variables,
  or run `chessonglass doctor` to see what's missing.
