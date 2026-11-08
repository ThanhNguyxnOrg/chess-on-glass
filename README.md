# chesshacker

Video-call a Mac on WhatsApp from Meta glasses, look at a chess game, and hear the best move.
The Mac reads the board with a vision model, picks the move with Stockfish, and says it into
the call. See [DESIGN.md](DESIGN.md) for the design and test results.

It's meant for friendly games where everyone at the board knows about it, not for rated or
tournament play.

## Set up a Mac

You need [Node.js](https://nodejs.org) 22 or newer (`brew install node`). Clone or download
this repo, then from its folder:

```sh
npm install              # 1. install and build
npx chesshacker setup    # 2. downloads Stockfish, asks for keys, checks everything
```

You'll need an OpenAI API key (the default model is `gpt-6.1-sol`). A Jev key from TypeSafe is
optional and makes games cheaper. Also install WhatsApp from the Mac App Store and
[BlackHole 2ch](https://existential.audio/blackhole/) (`brew install blackhole-2ch`), and give
your terminal app Screen Recording permission: `setup` opens the setting and `doctor` says
exactly what's still missing.

Keys are kept in your login Keychain. If you saved them with the earlier Python version, macOS
asks once whether `security` may read them: click Always Allow.

Then check a real call once:

```sh
npx chesshacker test-call
```

## Play

1. From the glasses, video-call this Mac's WhatsApp, answer it here, and double-tap the
   glasses' capture button to share their view. In the call's ⋯ menu, set the microphone to
   BlackHole 2ch.
2. Start chesshacker with your color:

   ```sh
   npx chesshacker run --color white
   npx chesshacker run --color black --fen "<position>"   # joining a game in progress
   ```

3. Look at the board. You'll hear "Ready", then the best move after each of your opponent's
   moves. The command center opens in your browser.

Useful options: `--model claude-opus-5-5`, `--no-gate` (skip the Jev pre-check),
`--max-cost 5`, `--speak speakers` (out of the Mac instead of into the call), and
`--video FILE` to play a recording through the whole loop without a call.
`npx chesshacker windows` lists WhatsApp's windows if it watches the wrong one, or can't find
the call because WhatsApp shows it inside its main window: pass the right one with `--window ID`.

## Overlay video (for OBS)

While a game runs, `http://127.0.0.1:8000/overlay` shows the call's video with an overlay: a
"tactical map" of the position in the corner, and the suggested move drawn onto the real board
(outline, highlighted squares, arrow, label). In OBS, add a **Browser Source** with that URL and
the video's size (e.g. 1080×1440). The command center links to it too.

To record or stream it, add `--overlay-out`: a file (`overlay.mp4`) or a stream URL
(`rtmp://…/live/KEY`, or `udp://127.0.0.1:1234` for an OBS Media Source).

The board is found by asking the vision model for its corners every `--locate-every` seconds
(5), only while the overlay is watched or recorded. That counts toward `--max-cost`, and each
answer takes 10–20 s, so the overlay lags when the head moves. `--locate-model` picks another
model for it.

## Develop

```sh
npm test                 # vitest
npm run typecheck        # tsc, strict, over src, tests and evals
npm run build            # dist/ (npm install runs this too)
npm run eval -- --simulate                                           # the matcher, free
npm run eval -- fixtures/example2-black.mov --pgn fixtures/example2.pgn --color black --every 1
```

`npm run eval -- --help` lists the options (strategy, model, `--gate`, frame spacing,
`--max-cost`). Model answers are cached in `evals/.cache`, so re-scoring is free. Recordings
go in `fixtures/` next to their PGN (a `[FEN]` header for games joined midway); videos are
gitignored. After changing `src/`, run `npm run build` before using `npx chesshacker`.
