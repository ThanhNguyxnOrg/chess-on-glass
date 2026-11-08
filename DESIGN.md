# chesshacker — design

The person wearing Meta glasses video-calls a Mac on WhatsApp and shares the
glasses' view of an over-the-board chess game. The Mac watches the call, works out when the
opponent has moved, finds the best reply with Stockfish, and speaks it back into the call, so
the glasses play it in the wearer's ear.

It's built to be easy to run on any Mac: one setup command, and plain-English fixes when
something is missing or the wrong version.

TypeScript on Node 22+, with 110 tests. Recordings play through the real loop end to end
(`run --video`): it finds the board, reads the opponent's move, speaks the reply, and shows it
all in the command center. On a new Mac, `npx chesshacker test-call` checks a live call's
video and speech.

## Decisions

| Area | Decision |
|---|---|
| Platform | macOS only |
| Install & run | Node.js 22+: get the repo → `npm install` (builds it) → `npx chesshacker setup`. An older Node gets a clear message from both `npm install` and the command |
| Self-checks | `doctor`: checklist with exact fixes. `test-call`: a live check of video and speech. Every dependency gets a doctor check the day it's added |
| Video in | WhatsApp video call from the glasses (double-tap the capture button to share the view) to WhatsApp on the Mac. Frames come from the call window (`screencapture -l`) |
| Moves out | Spoken into the call: macOS `say` → BlackHole 2ch → WhatsApp's microphone |
| WhatsApp account | Whatever account is logged into WhatsApp on that Mac; the glasses call it. chesshacker never logs into WhatsApp |
| WhatsApp version | The current native app. The discontinued Electron app is rejected (spotted by its `Electron Framework.framework`). A version that hasn't passed `test-call` on this Mac is flagged, not blocked |
| Answering calls | By hand on the Mac |
| Vision model | **`gpt-6.1-sol`, "changes" strategy, effort low.** Opus 5.5 is switchable (`--model claude-opus-5-5` or `CHESSHACKER_MODEL`). Chosen on the vision test below |
| Pre-check | Jev (TypeSafe) looks at each frame first and skips the ones with a hand over the board, a blurry board, or nothing moved. Optional: without a Jev key every frame goes to the vision model |
| Keys | OpenAI (required for the default model), Anthropic (only for Claude models), Jev (optional). Saved in the Keychain by setup (sent to `security -i` on stdin in hex, never on a command line, then read back to check); environment variables override |
| Stockfish | One on PATH, otherwise the pinned official sf_19 build, downloaded and checksum-verified |
| Board | Physical board, no markers. Starts from the opening position, or from a FEN (`--fen`) when joining a game midway |
| Perception | The model reports what it **sees**; code matches that to a legal move (`match.ts`) |
| Move choice | Stockfish over UCI, never the LLM. Chess rules from chess.js |
| Spoken moves | My move only: "Knight to f3", "Bishop takes e5", "Knight b to d7", "Castle kingside", "Pawn to e8, promote to queen", "… check". The a-file goes to `say` as "ay", which otherwise reads it as "uh" |
| Spoken status | "Ready. You're black. Waiting for white.", "Lost track of the board.", "Spending limit reached. Paused.", "Something went wrong. Still trying.", game result |
| Talk back | None. The Mac ignores the call's incoming audio |
| Command center | Local page (127.0.0.1, port 8000 or the next free one): live frame, board with the suggestion arrow, console, moves, controls |
| Overlay video | `/overlay` (an OBS Browser Source) and `--overlay-out` (file, RTMP, UDP): a tactical map plus the suggestion drawn on the real board. The board's corners come from the vision model every few seconds; between answers the drawing stays where it was |
| Language | TypeScript (strict, ESM) on Node.js 22+. Was Python 3.13 up to commit fbca3d1 |

## Pipeline

```
Glasses → WhatsApp video call (sharing the glasses' view) → call window on the Mac
  → newest frame of the call window (screencapture -l)
  → Jev: readable? hand over the board? changed since the last confirmed frame?  → skip, or…
  → vision model: which squares changed since the last confirmed frame?
  → code matches that to a legal move; commits it once frames add up to enough evidence
  → chess.js plays the move → Stockfish best move → spoken text
  → say → BlackHole 2ch → WhatsApp microphone → call → glasses speakers
  → every step is an event → command center + runs/<ts>/events.jsonl
```

## Game loop (`main.ts`)

- **Looking for the board** until the model confirms the starting position, then "Ready…".
  As white, the first move comes right away.
- **Waiting for opponent:** a frame about every second. Once the opponent's move is
  committed, Stockfish's reply is spoken.
- **Your move:** a frame about every 3 seconds. Any legal move of yours is accepted, not only
  the suggestion; the console notes when they differ.
- **Lost track:** spoken once. Fix it from the command center (undo, enter a move, or a new
  game from a FEN).
- **Can't see the call:** no frames, no API calls; it picks up again when the window is back.
  The call window is WhatsApp's largest window other than the main one, never the chat list
  itself (`--window ID` picks one by hand).
- **Game over:** the result is spoken and API calls stop.
- **Spend cap** (default $10): pauses and says so.
- **Something fails** (capture, Jev, the vision model, Stockfish): logged, said once ("Something
  went wrong. Still trying."), and the loop carries on, backing off while it repeats. A
  Stockfish that quits is restarted; a suggestion it couldn't give is asked again on the next
  frame. Model calls give up after 45 s (one retry), Jev after 5 s. A line `say` couldn't play
  is logged as an error, not as spoken.

Matching rules (`match.ts`):
- The model never chooses the move. Code compares what it saw with the position after each
  legal move, and after each move plus a reply (costing 1 extra square), in case the reply
  happened before the move was confirmed. Only one move is ever committed at a time.
- Each usable frame is evidence for its best fit: how many squares better it fits than the
  runner-up. A move is committed once it's been the best fit on 2+ frames in a row, adding up
  to 3+ squares. A tie, a hand, or looking away pauses the count; a different best fit
  restarts it.
- A frame whose best fit is still more than 5 squares off fits nothing: it can't confirm a
  move. Lost: 6 such frames in a row. Promotions are assumed to be to a queen.
- When a move only fits together with a reply, the reply isn't announced as a suggestion if it
  was the wearer's: they've already played it. It's committed on its own next.

Reading frames (`watch.ts`): the changes strategy compares each frame with the last confirmed
one, described as the position that frame shows. That is usually the tracked position, but one
move ahead after a commit that needed the reply, so the reply still shows up as a change. With
nothing to compare (the start, after a fix by hand, a new game), the frame is read on its own
with the occupancy question, so the board is really checked against the tracked position.

Jev pre-check (`gate.ts`, `watch.ts`): skip when readable < 0.8 or hand > 0.5, or when changed
< 0.1 since the last confirmed frame. Never skips while a move is pending or being confirmed,
and forces a full read after 3 "unchanged" skips in a row. If Jev fails, the frame goes to the
model; a rejected key turns the pre-check off for the rest of the run.

## Vision test results

Two glasses recordings (`fixtures/example*`): 1. c3 e5 from the opening, and Rf1+ in a game
joined midway. One frame per second, scored against the known moves by the eval
(`evals/score.ts`; these runs were made with the Python version).

| Model · strategy | Moves | Squares wrong per frame (clip 2) | Cost per frame | Typical latency |
|---|---|---|---|---|
| **gpt-6.1-sol · changes** (default) | 3/3 | 0.2 | 1.4¢ | 4–4.6 s |
| gpt-6.1-sol · pick | 3/3 | 0.0 | 0.9¢ | 3.5–6.3 s |
| gpt-6.1-sol · occupancy | 3/3 | 0.5 | 1.1¢ | 14–18 s |
| gpt-6-astra · pick | 3/3 | 0.0 | 3.7–4.2¢ | 2.6–3.6 s |
| claude-opus-5-5 · changes | 3/3 | 0.1 | 4¢ | 3.6–6.3 s |
| claude-opus-5-5 · occupancy | 1/3 | 8.7 | 2.4–2.8¢ | 4.6–5.7 s |
| Sonnet 5.5, Haiku 5.5, gpt-6-luna · occupancy | failed on clip 1 | – | – | – |

No run committed a wrong move. Jev skipped 9 of 12 frames on clip 1 and 9 of 27 on clip 2 for
about a cent per clip. Replaying clip 2 through the live loop cost $0.07 and spoke the reply
about 10 s after the move. "Pick" scored perfectly but is the strategy most open to guessing
the likely move, so "changes" is the default.

After the rewrite, the TypeScript eval with the default model and strategy scored clip 1 2/2
($0.165 for 12 frames) and clip 2 1/1. Replaying clip 2 through the live loop committed Rf1+
and spoke "King to e6" for $0.08.

These results come from glasses recordings (3 moves); call video can be softer (see
Limitations).

## Running it on a new Mac

```
brew install node                                    # 1. Node.js 22 or newer (or nodejs.org)
cd chesshacker                                       # 2. this repo, cloned or unzipped
npm install                                          # 3. dependencies, then builds dist/
npx chesshacker setup                                # 4. Stockfish, keys, Screen Recording, checks
npx chesshacker test-call                            # 5. a real call: video in, speech out
npx chesshacker run --color white                    # a game (add --fen to join one midway)
```

`doctor` checks: macOS; Stockfish (UCI handshake); the vision model's key (a free model
lookup); Jev (optional); WhatsApp installed, not the Electron app, and whether this version has
passed `test-call`; BlackHole 2ch among `say`'s audio outputs; Screen Recording permission for
the app chesshacker runs in (named: Terminal, iTerm, Warp…). Each failure prints its fix.

`test-call`: waits for the call window; captures a frame and rejects a black one; opens it in
Preview; asks the vision model whether a board is in view; says "chesshacker test, knight to
f3" into the call and asks whether the glasses played it (if not: pick BlackHole 2ch as the
call's microphone); records the WhatsApp version that passed.

`windows` lists WhatsApp's windows and marks the one `run` would watch (`--window ID` picks
another). `run --video FILE --speak speakers` plays a recording through the whole loop, for
testing without a call.

## Command center

The game loop owns the state and publishes a snapshot after every change; the page gets it
over Server-Sent Events, along with every event (frames, Jev verdicts, commits, speech,
errors). The board is an SVG drawn by `board-svg.ts` (python-chess's look), so the page has
no chess logic. Controls (pause,
undo, enter a move, say it again, new game from a FEN) are queued and applied by the loop
between frames. The server only listens on 127.0.0.1 and only accepts JSON from its own page.

## Layout

```
chesshacker/
  package.json             # Node 22+, the `chesshacker` command (dist/bin.js); .npmrc enforces the Node version
  tsconfig.json            # strict; type-checks src, tests and evals (tsconfig.build.json builds src)
  README.md
  src/
    bin.ts                 # checks the Node version, then loads cli.ts
    cli.ts                 # setup | doctor | test-call | run | windows
    config.ts              # data folder, default model, keys (env or Keychain), API clients
    keychain.ts            # the `security` command
    doctor.ts              # each check returns ok, or the problem + exact fix
    engine.ts              # Stockfish: find or download, best move
    capture.ts             # Frame; CallWindow (live), Replay (recording in real time), VideoFile (eval)
    macos.ts               # WhatsApp app + windows, screencapture, permissions, audio outputs, caffeinate
    gate.ts                # Jev pre-check
    vision.ts              # the questions; ClaudeVision and GptVision send them
    match.ts               # Grid, matching, Tracker
    watch.ts               # one frame: pre-check → vision → tracker
    main.ts                # the game loop
    speak.ts               # say → BlackHole
    events.ts, web.ts, static/index.html   # the command center
    board-svg.ts           # the board picture
    overlay.ts, feed.ts    # the video overlay: drawing it, and the live feed / recorder
    locate.ts, geometry.ts # where the board is in a frame; squares from its corners
    game.ts, pricing.ts    # spoken move text, PGN, game over; model prices
  evals/score.ts           # score a recording against its PGN (or --simulate)
  tests/                   # vitest
  fixtures/                # PGNs + recordings (videos gitignored)
```

Per-user data is in `~/Library/Application Support/chesshacker/`: Stockfish, `tested.json`,
and `runs/<ts>/` (events.jsonl, game.pgn, the frames behind each decision).

## Ideas

- Overlap the two confirming reads to roughly halve the delay.
- Resync on its own after "lost track".
- Detect frozen call video.
- Answer calls automatically.

## Limitations

- **Call video quality:** WhatsApp lowers resolution on weak connections, which can blur the
  board. All results so far are from the glasses' own recordings.
- **Glasses battery and heat** during a long video call.
- **Dropped calls** have to be re-answered at the Mac. The game state carries over.
- **WhatsApp updates** can change the call window. `windows`, `--window` and `test-call` show
  what broke.
- **Synthetic speech** could be clipped by WhatsApp's noise suppression.
- **Latency:** about 10 s from the move to the spoken reply, mostly two model reads.
- **The opponent may hear** spoken moves from the open-ear speakers.
