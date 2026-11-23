# Setup & Usage Guide

This guide covers installing, configuring, and running **ChessOnGlass** end-to-end with smart glasses, a webcam, desktop window capture, or video replay.

## Prerequisites

- **Node.js 24 LTS** or newer
- **OS:** Windows 10/11 x64 (native WGC capture + `System.Speech` TTS + Windows Credential Manager support); macOS & Linux support the portable core, browser webcam, and replay with manually supplied tools (see below). Native WGC capture and speech are Windows-only. Key storage requires an available OS keyring (Linux Secret Service).
- **Vision AI API Key:** an **OpenAI** or **Anthropic** API key for live board reading

## Installation

```sh
git clone https://github.com/ThanhNguyxnOrg/chess-on-glass.git
cd chess-on-glass
npm ci
npm run build
```

## Diagnostics & Native Tools

Run the built-in diagnostics check to inspect Node version, user-data storage, OS keyring, Stockfish, FFmpeg, Window Capture (WGC), and speech synthesis:

```sh
node packages/app/dist/cli.js doctor
```

On Windows x64, install missing SHA-256 verified binaries into your user data directory (`%APPDATA%\ChessOnGlass\tools` on Windows):

```sh
node packages/app/dist/cli.js install-tools
```

| Platform | Key | Stockfish via `install-tools` | FFmpeg via `install-tools` |
|---|---|---|---|
| Windows x64 | `win32/x64` | Verified download | Verified download |
| Windows ARM64 | `win32/arm64` | Unverified; refused | No artifact |
| macOS x64 | `darwin/x64` | Unverified; refused | No artifact |
| macOS ARM64 | `darwin/arm64` | Unverified; refused | No artifact |
| Linux x64 | `linux/x64` | Unverified; refused | No artifact |
| Linux ARM64 / other OS/architectures | All other keys | No artifact | No artifact |

Keys are Node.js OS/architecture pairs. Unverified manifest entries fail closed; missing entries have no download fallback. `install-tools` defaults to Stockfish then FFmpeg and stops on the first failure. Nothing is downloaded during `npm ci` or startup.

On macOS/Linux and Windows ARM64, supply both tools yourself. Other OS/architectures have no tool artifacts; this table does not imply application support there. Point to existing local binaries using environment variables:
- `CHESSONGLASS_STOCKFISH` — absolute path to a Stockfish executable
- `CHESSONGLASS_FFMPEG` — absolute path to an FFmpeg executable

The app resolves these overrides, then executables in the user-data `tools/<tool>` directories. `doctor` additionally searches `PATH`; a successful PATH check alone does not configure the app, so set the overrides even when your tools are on `PATH`. On macOS/Linux, `doctor` still reports unavailable WGC and the Windows speech helper; those checks do not mean the portable features are unavailable.

### Windows Speech Helper (Optional Rebuild)

On Windows, native voice output uses a lightweight `System.Speech` C# helper (`packages/app/native/speech`). If `doctor` reports `SpeechHelper.exe is not built`, build it with .NET SDK:

```sh
node packages/app/scripts/build-speech-helper.mjs
```

## Running ChessOnGlass

Start the local dashboard server and open it in your default browser:

```sh
node packages/app/dist/cli.js run
```

Or launch directly with a local video recording:

```sh
node packages/app/dist/cli.js run --replay C:\path\to\game.mp4
```

The server binds to `http://127.0.0.1:<port>` and passes a one-time 256-bit launch token in the URL fragment (`#token=...`). The dashboard reads the token into memory and immediately strips it from the browser address bar.

## Configuring AI Vision & Voice

1. Open the **AI Vision, Voice & Engine** panel on the right side of the dashboard.
2. Select your **Provider** (`OpenAI` or `Anthropic`) and **Model**.
3. Paste your **API Key** and click **Save Key** (saved directly to your OS keyring; environment variables `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` are also supported).
4. Check **Enable AI Vision** and **Voice Readout**, set your **Max Budget (USD)**, and click **Save Settings**.

## Choosing a Board Feed

### 1. Smart Glasses / Webcam Feed
- Click **Start Camera / Glasses** and grant camera permission in your browser.
- Works with USB/UVC smart glasses cameras, phone-as-webcam apps, or built-in webcams.

### 2. Window Capture (Glasses Cast / Online Chess)
- Ideal when casting smart glasses (e.g., Meta View / phone screen mirror) to your PC or watching a desktop chess window.
- Click **Refresh**, choose the target window from the dropdown, and click **Capture Window**.

### 3. Video Replay
- Enter the path to a local `.mp4` file in **Video Replay** and click **Start Replay** (or pass `--replay` to the CLI).

## Controls During Play

- **Pause / Resume:** immediately aborts any in-flight vision read and pauses paid calls.
- **Undo:** reverts the last committed move in the active game.
- **Repeat voice:** re-speaks the latest Stockfish move suggestion.
- **New game:** resets the board to the starting position while keeping active camera/window feeds running.
- **Manual move:** enter a UCI move (e.g. `e2e4`, `e7e8q`) to commit or correct a move manually.

## Troubleshooting

| Issue | Resolution |
|---|---|
| **Camera denied** | Allow camera permission in browser and in Windows *Settings → Privacy & security → Camera*. |
| **No voice output** | Verify `SpeechHelper.exe` via `doctor`, check **Voice Readout** is enabled, and confirm system volume. |
| **Stockfish or FFmpeg missing** | On Windows x64, run `node packages/app/dist/cli.js install-tools`; otherwise install the tools yourself. Set `CHESSONGLASS_STOCKFISH` / `CHESSONGLASS_FFMPEG` to existing executable paths. |
| **Budget exhausted** | Paid vision reads pause automatically at `maxCostUsd`. Increase **Max Budget (USD)** in Settings and restart to raise the session limit. |
| **Missing launch token** | Always open the dashboard via `node packages/app/dist/cli.js run` rather than bookmarking a bare port URL. |
