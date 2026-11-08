import { pathToFileURL } from "node:url";
import { ChessState } from "@chessonglass/chess";
import type { Frame, SessionId, SourceId } from "@chessonglass/contracts";
import {
  evaluateRecording,
  type RecordingRunner,
  type TruthMove
} from "./evaluation.js";

const SIMULATED_SESSION =
  "00000000-0000-4000-8000-000000000001" as SessionId;
const SIMULATED_SOURCE = "00000000-0000-4000-8000-000000000002" as SourceId;

export const SIMULATED_TRUTH: readonly TruthMove[] = [
  { observedAtMonotonicMs: 1_000, uci: "e2e4" },
  { observedAtMonotonicMs: 2_000, uci: "e7e5" }
];

export function simulatedFrames(): readonly Frame[] {
  return [1n, 2n, 3n].map((sequence) => ({
    sessionId: SIMULATED_SESSION,
    sourceId: SIMULATED_SOURCE,
    sequence,
    capturedAtMonotonicMs: Number(sequence) * 1_000 - 100,
    capturedAtWallMs: 1_700_000_000_000 + Number(sequence) * 1_000,
    receivedAtMonotonicMs: Number(sequence) * 1_000 - 90,
    bytes: new Uint8Array([Number(sequence), 2, 3]),
    mimeType: "image/jpeg" as const
  }));
}

/**
 * The deterministic local fixture is free-running only: it must never be
 * handed an answer key, and it makes no paid provider call.
 */
const simulatedRunner: RecordingRunner = {
  async run(_frames, _initial, diagnosticTruth) {
    if (diagnosticTruth !== undefined) {
      throw new Error("the simulated recording is free-running only");
    }
    return {
      committed: ["e2e4", "e7e5"],
      manualInterventions: 0,
      recoveryMs: [40],
      resultTimesMs: [1_050, 2_100]
    };
  }
};

export type EvaluationCliOptions = {
  readonly argv: readonly string[];
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
};

/**
 * `eval --simulate` prints one deterministic, oracle-free report. Real
 * recordings need a separately approved model/hardware run and are never
 * started from normal CI.
 */
export async function runEvaluationCli(
  options: EvaluationCliOptions
): Promise<number> {
  const stdout =
    options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr =
    options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  if (!options.argv.includes("--simulate")) {
    stderr(
      "eval: a real recording needs an approved model and hardware run; use --simulate for the deterministic local fixture"
    );
    return 2;
  }

  const report = await evaluateRecording({
    frames: simulatedFrames(),
    truth: SIMULATED_TRUTH,
    initial: ChessState.initial().position(),
    mode: "free-running",
    runner: simulatedRunner
  });
  stdout(JSON.stringify(report, null, 2));
  return 0;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  runEvaluationCli({ argv: process.argv.slice(2) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `eval failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    });
}
