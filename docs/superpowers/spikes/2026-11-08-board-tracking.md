# Local board tracking spike (plan 03, Task 3)

Date: 2026-11-08. Status: **inconclusive — the spike could not be run.**

## Why inconclusive (honest record)

- **No consented moving-camera board dataset exists on this machine.** The
  brief requires evaluating optical-flow board tracking against consented
  moving-camera recordings of a real physical board. No such recording is
  available here, and house rules forbid downloading a dataset: consent
  must be recorded before capture, not assumed after the fact.
- Because no real video was available, **no measurement run was performed**
  — not with OpenCV (not installed; see below) and not with any substitute.
  There are no numbers to report, so there is no success or failure claim
  to make.
- Synthetic/generated video or still images can at most prove that a
  *harness executes*; they say nothing about tracking quality on real
  footage and must never be cited as tracking success. None was generated.
- OpenCV was **not** added as a dependency (Global Constraints: OpenCV is
  not a baseline dependency; nothing was installed or downloaded for this
  spike). The `@chessonglass/perception` package manifest still declares
  only `@chessonglass/chess` and `@chessonglass/contracts`, and a unit test
  (`tracking-config.test.ts`, "imports no external module in any tracking
  module") keeps every tracking module free of npm/native imports.

## Consequence for shipped configuration

`local-assisted` is **not reachable**. The default and shipped tracking
configuration is `locator-only`:

- `packages/perception/src/tracking/tracking-config.ts` rejects
  `mode: "local-assisted"` with a typed `TrackingConfigError` unless a
  recorded `TrackingSpikeVerdict` with `status: "pass"` citing an evidence
  document is supplied (`resolveTrackingConfig`). An `inconclusive` or
  `fail` verdict — and this document — enables nothing.
- The conservative tracker
  (`packages/perception/src/tracking/local-tracker.ts`) is the narrow
  contract behind the optional layer: an injected `LocalFlowProvider`
  supplies low-level flow data, and the tracker returns **null** (never
  extrapolated geometry) on occlusion, too few inliers, excessive
  forward-backward error, malformed observations or geometry that fails
  `validateGeometry`. It is dead code under `locator-only`: the
  locator-only production path (`board-locator.ts`, `geometry-state.ts`,
  `tracking-config.ts`) never imports it (asserted by test).
- Per the brief: a locator-only configuration satisfies correctness, not a
  promise of perfectly smooth AR — the overlay hides between valid locator
  observations (see `GeometryState` lifetime/invalidation).

## What a passing spike must measure (protocol for a future run)

Run this protocol only when a consented dataset exists; record the result
in a new dated spike document in this directory.

### Preconditions

1. **Dataset consent record (committed with the spike):** who/whose camera
   consented, to what use, recording date(s), retention/deletion date, and
   the storage location of the raw clips. No consent record, no run.
2. **Dataset content:** moving-camera recordings of a real physical chess
   board from gameplay-like viewpoints, including hand occlusion, motion
   blur and varied lighting. Multiple sessions; at least one clip with
   deliberate camera shake and one slow pan.
3. **Environment record:** CPU/GPU, OS build, Node version, OpenCV version
   and binding (e.g. official OpenCV.js or a native binding), video decode
   path, and the exact sample/script revision. Pin versions.
4. **Candidate:** a current official OpenCV LK optical-flow + homography
   sample, adapted to seed from a locator-produced `BoardCorners`
   observation and to track **board-plane features only** — never hands,
   never piece tops. Feature sampling must be restricted to the board
   quadrilateral implied by the previous transform.

### Measurements (per clip and aggregated)

| # | Metric | Method |
|---|--------|--------|
| 1 | Reprojection error (px) | compare the tracked fit against locator re-fits sampled through the clip (ground-truth proxy); record median and p95 |
| 2 | Drift (px) | accumulated corner deviation over time without re-location; report worst 2 s window |
| 3 | Latency (ms/frame) | p50/p95 decode+track cost at the production frame size |
| 4 | Memory | peak RSS and heap at start vs end of each clip; flag any growth over a 10-minute run |
| 5 | Forward-backward error (px) | distribution across tracked points per frame |
| 6 | Inlier yield | tracked vs inlier board-plane points per frame |
| 7 | Re-location triggers | after what forward-backward error / inlier ratio / occlusion duration tracking was dropped to the locator, and how often |

### Pass thresholds (proposed; confirm or tighten in the run report)

- median reprojection error ≤ 2 px, p95 ≤ 6 px (the locator's
  `DEFAULT_MAX_REPROJECTION_ERROR_PX`);
- inlier ratio ≥ 0.8 over ≥ 4 board-plane correspondences (the
  `validateGeometry` default floor and `MIN_TRACKING_INLIER_COUNT`);
- median forward-backward error ≤ 2 px;
- drift ≤ 2 px accumulated over any 2 s window without re-location;
- latency ≤ 8 ms/frame p95 at 640×480 on the reference laptop, so tracking
  never becomes the frame budget;
- memory: no growth across a 10-minute clip (bounded frames/pixels/work);
- occlusion: any detected occlusion drops tracking (returns null) — never
  extrapolate through an occlusion.

### Run steps

1. Commit the dataset consent record and environment record.
2. Run the harness clip by clip; log the metrics above per frame.
3. Compare tracked corners against locator re-fits sampled through the
   clip; report the comparison, not a subjective impression.
4. Record when re-location was required and how often the tracker returned
   null.
5. Record success/failure honestly — including negative results — and
   commit the raw log next to the spike document.

### If the spike fails or stays inconclusive

Keep `locator-only` with the overlay hidden between valid observations;
the tracker contract stays behind the config gate. Retry only with new
consented data or a materially changed approach, as a new spike.
