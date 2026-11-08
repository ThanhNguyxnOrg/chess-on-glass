import { describe, expect, it } from "vitest";
import {
  newSessionId,
  newSourceId,
  type Frame,
  type GamePosition,
  type SessionId,
  type SourceId
} from "@chessonglass/contracts";
import {
  CorpusManifestError,
  evaluateRecording,
  validateCorpusManifest,
  type CorpusManifest,
  type RecordingOutcome,
  type RecordingRunner,
  type TruthMove
} from "@chessonglass/game";
import { runEvaluationCli } from "../src/cli-evaluate.js";
import { makeFrame } from "./support/coordinator-fakes.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const TRUTH: readonly TruthMove[] = [
  { observedAtMonotonicMs: 1_000, uci: "e2e4" },
  { observedAtMonotonicMs: 2_000, uci: "e7e5" }
];

function frames(): readonly Frame[] {
  const sessionId = newSessionId();
  const sourceId = newSourceId();
  return [
    makeFrame(sessionId, sourceId, 1n),
    makeFrame(sessionId, sourceId, 2n),
    makeFrame(sessionId, sourceId, 3n)
  ];
}

function outcome(
  committed: readonly string[],
  resultTimesMs: readonly number[],
  extra: Partial<RecordingOutcome> = {}
): RecordingOutcome {
  return {
    committed,
    resultTimesMs,
    manualInterventions: extra.manualInterventions ?? 0,
    recoveryMs: extra.recoveryMs ?? []
  };
}

class FakeRunner implements RecordingRunner {
  readonly channels: Array<readonly TruthMove[] | undefined> = [];

  constructor(private readonly result: RecordingOutcome) {}

  async run(
    _frames: Parameters<RecordingRunner["run"]>[0],
    _initial: GamePosition | null,
    diagnosticTruth?: readonly TruthMove[]
  ): Promise<RecordingOutcome> {
    this.channels.push(diagnosticTruth);
    return this.result;
  }
}

describe("evaluateRecording oracle isolation", () => {
  it("never gives a free-running runner the answer key", async () => {
    const runner = new FakeRunner(outcome(["e2e4", "e7e5"], [1_050, 2_100]));
    const report = await evaluateRecording({
      frames: frames(),
      truth: TRUTH,
      initial: null,
      mode: "free-running",
      runner
    });

    expect(runner.channels).toEqual([undefined]);
    expect(report.mode).toBe("free-running");
    expect(report.falseCommits).toBe(0);
    expect(report.missedMoves).toBe(0);
  });

  it("passes truth to an explicitly labelled oracle-assisted run", async () => {
    const runner = new FakeRunner(outcome(["e2e4", "e7e5"], [1_050, 2_100]));
    const report = await evaluateRecording({
      frames: frames(),
      truth: TRUTH,
      initial: null,
      mode: "oracle-assisted",
      runner
    });

    expect(runner.channels).toEqual([TRUTH]);
    expect(report.mode).toBe("oracle-assisted");
  });

  it("keeps oracle-assisted diagnostics out of free-running metrics", async () => {
    // A runner that reads the answer key when it is handed one. In
    // free-running it recovers from a wrong observation on its own.
    class ResettingRunner implements RecordingRunner {
      async run(
        _frames: Parameters<RecordingRunner["run"]>[0],
        _initial: GamePosition | null,
        diagnosticTruth?: readonly TruthMove[]
      ): Promise<RecordingOutcome> {
        if (diagnosticTruth !== undefined) {
          return outcome(
            diagnosticTruth.map((move) => move.uci),
            diagnosticTruth.map((move) => move.observedAtMonotonicMs + 10)
          );
        }
        return outcome(["d2d4", "e7e5"], [1_100, 2_100]);
      }
    }
    const runner = new ResettingRunner();

    const free = await evaluateRecording({
      frames: frames(),
      truth: TRUTH,
      initial: null,
      mode: "free-running",
      runner
    });
    const assisted = await evaluateRecording({
      frames: frames(),
      truth: TRUTH,
      initial: null,
      mode: "oracle-assisted",
      runner
    });

    expect(free.mode).toBe("free-running");
    expect(free.falseCommits).toBe(1);
    expect(free.missedMoves).toBe(1);
    expect(free.committed).toEqual(["d2d4", "e7e5"]);

    expect(assisted.mode).toBe("oracle-assisted");
    expect(assisted.falseCommits).toBe(0);
    expect(assisted.missedMoves).toBe(0);
    expect(assisted.latencyMs).toEqual([10, 10]);
  });
});

describe("evaluateRecording scoring", () => {
  it("reports a wrong observation followed by a correct board as false and missed", async () => {
    const runner = new FakeRunner(outcome(["d2d4", "e7e5"], [1_100, 2_100]));
    const report = await evaluateRecording({
      frames: frames(),
      truth: TRUTH,
      initial: null,
      mode: "free-running",
      runner
    });

    expect(report.committed).toEqual(["d2d4", "e7e5"]);
    expect(report.falseCommits).toBe(1);
    expect(report.missedMoves).toBe(1);
    expect(report.duplicateMoves).toBe(0);
  });

  it("reports duplicate and missed commits separately", async () => {
    const duplicate = await evaluateRecording({
      frames: frames(),
      truth: [{ observedAtMonotonicMs: 1_000, uci: "e2e4" }],
      initial: null,
      mode: "free-running",
      runner: new FakeRunner(outcome(["e2e4", "e2e4"], [1_050, 1_100]))
    });
    expect(duplicate.duplicateMoves).toBe(1);
    expect(duplicate.falseCommits).toBe(0);
    expect(duplicate.missedMoves).toBe(0);

    const missing = await evaluateRecording({
      frames: frames(),
      truth: TRUTH,
      initial: null,
      mode: "free-running",
      runner: new FakeRunner(outcome(["e2e4"], [1_050]))
    });
    expect(missing.missedMoves).toBe(1);
    expect(missing.falseCommits).toBe(0);
  });

  it("reports latency percentiles and passes through recovery data", async () => {
    const truth: readonly TruthMove[] = [
      { observedAtMonotonicMs: 1_000, uci: "e2e4" },
      { observedAtMonotonicMs: 2_000, uci: "e7e5" },
      { observedAtMonotonicMs: 3_000, uci: "g1f3" }
    ];
    const report = await evaluateRecording({
      frames: frames(),
      truth,
      initial: null,
      mode: "free-running",
      runner: new FakeRunner(
        outcome(["e2e4", "e7e5", "g1f3"], [1_100, 2_200, 3_300], {
          manualInterventions: 2,
          recoveryMs: [500, 1_200]
        })
      )
    });

    expect(report.latencyMs).toEqual([100, 200, 300]);
    expect(report.p50LatencyMs).toBe(200);
    expect(report.p95LatencyMs).toBe(300);
    expect(report.manualInterventions).toBe(2);
    expect(report.recoveryMs).toEqual([500, 1_200]);
  });

  it("reports empty latency statistics when nothing was committed", async () => {
    const report = await evaluateRecording({
      frames: frames(),
      truth: TRUTH,
      initial: null,
      mode: "free-running",
      runner: new FakeRunner(outcome([], []))
    });

    expect(report.missedMoves).toBe(2);
    expect(report.latencyMs).toEqual([]);
    expect(report.p50LatencyMs).toBeNull();
    expect(report.p95LatencyMs).toBeNull();
  });

  it("is deterministic for the same recording", async () => {
    const runner = new FakeRunner(outcome(["e2e4", "e7e5"], [1_050, 2_100]));
    const first = await evaluateRecording({
      frames: frames(),
      truth: TRUTH,
      initial: null,
      mode: "free-running",
      runner
    });
    const second = await evaluateRecording({
      frames: frames(),
      truth: TRUTH,
      initial: null,
      mode: "free-running",
      runner
    });

    expect(second).toEqual(first);
  });

  it("rejects malformed truth and misaligned result times", async () => {
    const base = {
      frames: frames(),
      initial: null,
      mode: "free-running" as const
    };
    const runner = new FakeRunner(outcome(["e2e4"], [1_050]));

    await expect(
      evaluateRecording({
        ...base,
        truth: [
          { observedAtMonotonicMs: 2_000, uci: "e2e4" },
          { observedAtMonotonicMs: 1_000, uci: "e7e5" }
        ],
        runner
      })
    ).rejects.toThrow(/monotonic/i);
    await expect(
      evaluateRecording({
        ...base,
        truth: [{ observedAtMonotonicMs: -1, uci: "e2e4" }],
        runner
      })
    ).rejects.toThrow(TypeError);
    await expect(
      evaluateRecording({
        ...base,
        truth: [{ observedAtMonotonicMs: Number.NaN, uci: "e2e4" }],
        runner
      })
    ).rejects.toThrow(TypeError);
    await expect(
      evaluateRecording({
        ...base,
        truth: [{ observedAtMonotonicMs: 1_000, uci: "not-a-move" }],
        runner
      })
    ).rejects.toThrow(TypeError);
    await expect(
      evaluateRecording({
        ...base,
        truth: TRUTH,
        runner: new FakeRunner(outcome(["e2e4", "e7e5"], [1_050]))
      })
    ).rejects.toThrow(/resultTimesMs/i);
  });
});

describe("corpus manifest", () => {
  function recording(
    recordingId: string,
    sessionId: SessionId,
    sourceId: SourceId,
    split: "train" | "holdout"
  ) {
    return {
      recordingId,
      sessionId,
      split,
      frames: [makeFrame(sessionId, sourceId, 1n)]
    };
  }

  it("accepts disjoint sessions across train and holdout", () => {
    const manifest: CorpusManifest = {
      recordings: [
        recording("rec-train", newSessionId(), newSourceId(), "train"),
        recording("rec-holdout", newSessionId(), newSourceId(), "holdout")
      ]
    };
    expect(() => validateCorpusManifest(manifest)).not.toThrow();
  });

  it("rejects the same session or frame in both splits", () => {
    const sessionId = newSessionId();
    const sourceId = newSourceId();
    const manifest: CorpusManifest = {
      recordings: [
        recording("rec-train", sessionId, sourceId, "train"),
        recording("rec-holdout", sessionId, sourceId, "holdout")
      ]
    };
    expect(() => validateCorpusManifest(manifest)).toThrow(CorpusManifestError);

    const duplicateId: CorpusManifest = {
      recordings: [
        recording("rec-a", newSessionId(), newSourceId(), "train"),
        recording("rec-a", newSessionId(), newSourceId(), "holdout")
      ]
    };
    expect(() => validateCorpusManifest(duplicateId)).toThrow(CorpusManifestError);
  });

  it("rejects frames that do not belong to the recording session", () => {
    const sessionId = newSessionId();
    const manifest: CorpusManifest = {
      recordings: [
        {
          recordingId: "rec-a",
          sessionId,
          split: "train",
          frames: [makeFrame(newSessionId(), newSourceId(), 1n)]
        }
      ]
    };
    expect(() => validateCorpusManifest(manifest)).toThrow(CorpusManifestError);
  });
});

describe("evaluation CLI", () => {
  it("runs the deterministic free-running fixture with --simulate", async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await runEvaluationCli({
      argv: ["--simulate"],
      stdout: (line) => lines.push(line),
      stderr: (line) => errors.push(line)
    });

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    const report = JSON.parse(lines.join("\n")) as {
      mode: string;
      falseCommits: number;
      missedMoves: number;
      duplicateMoves: number;
    };
    expect(report.mode).toBe("free-running");
    expect(report.falseCommits).toBe(0);
    expect(report.missedMoves).toBe(0);
    expect(report.duplicateMoves).toBe(0);
  });

  it("refuses to run a real recording without an explicit flag", async () => {
    const errors: string[] = [];
    const code = await runEvaluationCli({
      argv: [],
      stdout: () => undefined,
      stderr: (line) => errors.push(line)
    });

    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/simulate/i);
  });
});
