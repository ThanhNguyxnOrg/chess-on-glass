import type {
  Frame,
  GamePosition,
  SessionId
} from "@chessonglass/contracts";

/** One verified physical move on the recorder/backend monotonic clock. */
export type TruthMove = {
  observedAtMonotonicMs: number;
  uci: string;
};

export type EvaluationMode = "free-running" | "oracle-assisted";

export type RecordingOutcome = {
  committed: readonly string[];
  manualInterventions: number;
  recoveryMs: readonly number[];
  resultTimesMs: readonly number[];
};

/**
 * A runner executes one recording. In free-running evaluation it never
 * receives an answer-key channel; the oracle-assisted mode is an explicitly
 * labelled diagnostic that may receive truth for a reset.
 */
export interface RecordingRunner {
  run(
    frames: readonly Frame[],
    initial: GamePosition | null,
    diagnosticTruth?: readonly TruthMove[]
  ): Promise<RecordingOutcome>;
}

export type EvaluationReport = {
  mode: EvaluationMode;
  committed: readonly string[];
  falseCommits: number;
  missedMoves: number;
  duplicateMoves: number;
  latencyMs: readonly number[];
  manualInterventions: number;
  recoveryMs: readonly number[];
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
};

export type CorpusSplit = "train" | "holdout";

export type CorpusRecording = {
  recordingId: string;
  sessionId: SessionId;
  split: CorpusSplit;
  frames: readonly Frame[];
};

export type CorpusManifest = {
  recordings: readonly CorpusRecording[];
};

export class CorpusManifestError extends Error {
  constructor(detail: string) {
    super(`invalid evaluation corpus: ${detail}`);
    this.name = "CorpusManifestError";
  }
}

const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

type Score = {
  falseCommits: number;
  missedMoves: number;
  duplicateMoves: number;
  latencyMs: readonly number[];
};

function requireMode(value: unknown): EvaluationMode {
  if (value !== "free-running" && value !== "oracle-assisted") {
    throw new TypeError('evaluation mode must be "free-running" or "oracle-assisted"');
  }
  return value;
}

/**
 * Truth timestamps must live in the same recorder/backend monotonic clock
 * domain as frames and must be ordered; a foreign device clock is a data
 * error, not a latency measurement.
 */
function validateTruth(truth: readonly TruthMove[]): void {
  let previous = Number.NEGATIVE_INFINITY;
  for (const entry of truth) {
    if (typeof entry.uci !== "string" || !UCI_PATTERN.test(entry.uci)) {
      throw new TypeError("truth move must be a UCI coordinate move");
    }
    if (
      typeof entry.observedAtMonotonicMs !== "number" ||
      !Number.isFinite(entry.observedAtMonotonicMs) ||
      entry.observedAtMonotonicMs < 0
    ) {
      throw new TypeError(
        "truth observedAtMonotonicMs must be a finite non-negative number"
      );
    }
    if (entry.observedAtMonotonicMs < previous) {
      throw new TypeError("truth timestamps must be non-decreasing (monotonic)");
    }
    previous = entry.observedAtMonotonicMs;
  }
}

function validateOutcome(outcome: RecordingOutcome): void {
  if (
    !Array.isArray(outcome.committed) ||
    outcome.committed.some(
      (move) => typeof move !== "string" || !UCI_PATTERN.test(move)
    )
  ) {
    throw new TypeError("recording outcome committed moves must be UCI strings");
  }
  if (
    !Array.isArray(outcome.resultTimesMs) ||
    outcome.resultTimesMs.length !== outcome.committed.length
  ) {
    throw new TypeError(
      "recording outcome resultTimesMs must align with committed moves"
    );
  }
  if (
    outcome.resultTimesMs.some(
      (time) => typeof time !== "number" || !Number.isFinite(time) || time < 0
    )
  ) {
    throw new TypeError("recording outcome result times must be finite and non-negative");
  }
  if (
    !Number.isSafeInteger(outcome.manualInterventions) ||
    outcome.manualInterventions < 0
  ) {
    throw new TypeError("recording outcome manualInterventions must be a non-negative integer");
  }
  if (
    !Array.isArray(outcome.recoveryMs) ||
    outcome.recoveryMs.some(
      (time) => typeof time !== "number" || !Number.isFinite(time) || time < 0
    )
  ) {
    throw new TypeError("recording outcome recoveryMs must be finite and non-negative");
  }
}

/**
 * Align committed moves with truth in order. A committed move matching a
 * later truth entry marks the skipped truth moves as missed; an unmatched
 * commit is false; an immediately repeated commit is a duplicate. Latency is
 * measured per matched move from the physical observation time.
 */
function scoreOutcome(
  outcome: RecordingOutcome,
  truth: readonly TruthMove[]
): Score {
  const committed = outcome.committed;
  const matchedTruthIndex = new Array<number | null>(committed.length).fill(null);
  let truthIndex = 0;
  let falseCommits = 0;
  let duplicateMoves = 0;

  for (let index = 0; index < committed.length; index += 1) {
    const move = committed[index]!;
    if (index > 0 && move === committed[index - 1]) {
      duplicateMoves += 1;
      continue;
    }
    if (truthIndex < truth.length && truth[truthIndex]!.uci === move) {
      matchedTruthIndex[index] = truthIndex;
      truthIndex += 1;
      continue;
    }
    const later = truth.findIndex(
      (entry, entryIndex) => entryIndex >= truthIndex && entry.uci === move
    );
    if (later > truthIndex) {
      matchedTruthIndex[index] = later;
      truthIndex = later + 1;
      continue;
    }
    falseCommits += 1;
  }

  const matchedTruth = new Set(
    matchedTruthIndex.filter((entry): entry is number => entry !== null)
  );
  const latencyMs: number[] = [];
  for (let index = 0; index < committed.length; index += 1) {
    const truthMoveIndex = matchedTruthIndex[index];
    if (truthMoveIndex === null || truthMoveIndex === undefined) {
      continue;
    }
    latencyMs.push(
      Math.max(
        0,
        outcome.resultTimesMs[index]! -
          truth[truthMoveIndex]!.observedAtMonotonicMs
      )
    );
  }

  return {
    falseCommits,
    missedMoves: truth.length - matchedTruth.size,
    duplicateMoves,
    latencyMs
  };
}

/** Nearest-rank percentile; null for an empty sample. */
function percentile(values: readonly number[], percent: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percent / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index]!;
}

/**
 * Score one recording. The outer scorer retains truth; the runner only sees
 * it in the explicitly labelled oracle-assisted diagnostic mode.
 */
export async function evaluateRecording(input: {
  frames: readonly Frame[];
  truth: readonly TruthMove[];
  initial: GamePosition | null;
  mode: EvaluationMode;
  runner: RecordingRunner;
}): Promise<EvaluationReport> {
  const mode = requireMode(input.mode);
  validateTruth(input.truth);

  const outcome = await input.runner.run(
    input.frames,
    input.initial,
    mode === "oracle-assisted" ? input.truth : undefined
  );
  validateOutcome(outcome);
  const score = scoreOutcome(outcome, input.truth);

  return {
    mode,
    committed: [...outcome.committed],
    falseCommits: score.falseCommits,
    missedMoves: score.missedMoves,
    duplicateMoves: score.duplicateMoves,
    latencyMs: score.latencyMs,
    manualInterventions: outcome.manualInterventions,
    recoveryMs: [...outcome.recoveryMs],
    p50LatencyMs: percentile(score.latencyMs, 50),
    p95LatencyMs: percentile(score.latencyMs, 95)
  };
}

/**
 * Reject a corpus that leaks one recording into both splits. Full games and
 * sessions stay together, and a frame identity can appear only once.
 */
export function validateCorpusManifest(manifest: CorpusManifest): void {
  if (!Array.isArray(manifest.recordings)) {
    throw new CorpusManifestError("recordings must be an array");
  }

  const recordingIds = new Set<string>();
  const sessionSplits = new Map<SessionId, CorpusSplit>();
  const frameSplits = new Map<string, CorpusSplit>();

  for (const recording of manifest.recordings) {
    if (
      typeof recording.recordingId !== "string" ||
      recording.recordingId.trim() === ""
    ) {
      throw new CorpusManifestError("every recording needs a non-empty recordingId");
    }
    if (recordingIds.has(recording.recordingId)) {
      throw new CorpusManifestError(
        `recording ${recording.recordingId} appears more than once`
      );
    }
    recordingIds.add(recording.recordingId);

    if (recording.split !== "train" && recording.split !== "holdout") {
      throw new CorpusManifestError(
        `recording ${recording.recordingId} has an invalid split`
      );
    }

    const sessionSplit = sessionSplits.get(recording.sessionId);
    if (sessionSplit !== undefined && sessionSplit !== recording.split) {
      throw new CorpusManifestError(
        `session ${recording.sessionId} appears in both ${sessionSplit} and ${recording.split} splits`
      );
    }
    sessionSplits.set(recording.sessionId, recording.split);

    for (const frame of recording.frames) {
      if (frame.sessionId !== recording.sessionId) {
        throw new CorpusManifestError(
          `recording ${recording.recordingId} contains a frame from another session`
        );
      }
      const key = `${frame.sessionId}\u0000${frame.sourceId}\u0000${String(
        frame.sequence
      )}`;
      const existingSplit = frameSplits.get(key);
      if (existingSplit !== undefined) {
        if (existingSplit !== recording.split) {
          throw new CorpusManifestError(
            `frame ${key} appears in both ${existingSplit} and ${recording.split} splits`
          );
        }
        throw new CorpusManifestError(`frame ${key} appears more than once`);
      }
      frameSplits.set(key, recording.split);
    }
  }
}
