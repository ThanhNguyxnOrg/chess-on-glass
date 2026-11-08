# Evaluation fixtures

This directory documents how recordings are used to measure the ChessOnGlass
game loop. It contains no recording data yet; `eval --simulate` runs a
deterministic built-in fixture instead.

## Consent and provenance

- Every recording is made with the knowledge and consent of the players and
  anyone identifiable in the frame. No covert, corporate, school or tournament
  recording is accepted.
- Recordings may contain hands, faces, rooms or screens. Do not commit a
  recording unless every person involved approved ongoing local use, and
  never commit one that also captures private unrelated windows.
- Each corpus entry records its origin, consent statement and license. Data
  without a known origin is excluded.

## Splits

- Splits are by **full game or session**, never by frame. Every frame of one
  session lives in exactly one split.
- `train` is for threshold tuning; `holdout` is touched only after thresholds
  are frozen. `validateCorpusManifest` rejects a session or frame that appears
  in both splits.
- A recording that starts mid-game is still one session with a confirmed
  starting position recorded next to it.

## Timestamped moves

- Ground truth is a list of `TruthMove { observedAtMonotonicMs, uci }`.
- `observedAtMonotonicMs` is captured on the same recorder/backend monotonic
  clock as `Frame.capturedAtMonotonicMs` and `Frame.receivedAtMonotonicMs`.
  A phone, watch or camera clock is converted once at ingest, or the move is
  excluded; foreign clocks are never compared directly.
- Timestamps must be non-decreasing. Promotions are written as full UCI
  (`a7a8q`) and are part of the truth.

## Adverse cases

A useful corpus deliberately includes:

- hands over the board, glare, motion blur and a frozen/duplicate frame;
- a wrong model observation followed by a correct board (free-running
  recovery, no answer-key reset);
- missed moves, duplicate commits and illegal candidate observations;
- mid-game starts, both sides promoting, castling and en-passant;
- games that end in mate, stalemate and abandonment.

## Modes and reporting

- `free-running` never receives truth for recovery. The runner gets frames and
  the initial position only; the outer scorer compares committed moves with
  truth afterwards.
- `oracle-assisted` is an explicitly labelled diagnostic reset. Its numbers
  are reported separately and are never mixed into free-running metrics.
- Reports include the committed sequence, false/missed/duplicate moves,
  manual interventions, recovery time and p50/p95 latency. A three-move
  anecdote is not evidence.
- No paid or networked evaluation runs in normal CI. Real model and hardware
  results are labelled with the exact model, engine, OS, date and cost.

## Restrictions

- Do not use scraped tournament broadcasts, paid databases or any dataset
  whose license forbids this use. Prefer owner-recorded or clearly
  non-commercial, redistributable material.
- Do not commit personal data beyond what the consent covers. Frame images
  are excluded from this repository by default; only manifests and truth
  files are versioned.
