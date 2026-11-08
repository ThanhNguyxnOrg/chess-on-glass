import { expect, test } from "vitest";

import { EngineError, type EngineLike, SteadyEngine } from "../src/engine.js";
import type { Suggestion } from "../src/engine.js";

class Fake implements EngineLike {
  closed = false;
  constructor(readonly failure: Error | null = null) {}
  async best(): Promise<Suggestion> {
    if (this.failure) throw this.failure;
    return { move: "e2e4", score: { cp: 20 } };
  }
  close(): void {
    this.closed = true;
  }
}

/** Engines that fail with `failures`, in order, then work. */
function launcher(...failures: Error[]) {
  const started: Fake[] = [];
  const launch = async () => {
    const engine = new Fake(failures[started.length] ?? null);
    started.push(engine);
    return engine;
  };
  return { started, launch };
}

test("a Stockfish that quit is replaced, and the position asked again", async () => {
  const { started, launch } = launcher(new EngineError("Stockfish quit unexpectedly."));
  const engine = await SteadyEngine.start(launch);
  expect((await engine.best("fen")).move).toBe("e2e4");
  expect(started).toHaveLength(2);
  expect(started[0]!.closed).toBe(true);
});

test("only Stockfish failures are retried", async () => {
  const { started, launch } = launcher(new Error("The game is over; there is no move to suggest."));
  const engine = await SteadyEngine.start(launch);
  await expect(engine.best("fen")).rejects.toThrow("The game is over");
  expect(started).toHaveLength(1);
});

test("nothing is restarted once it's closed", async () => {
  const { started, launch } = launcher(new EngineError("Stockfish quit unexpectedly."));
  const engine = await SteadyEngine.start(launch);
  engine.close();
  await expect(engine.best("fen")).rejects.toThrow(EngineError);
  expect(started).toHaveLength(1);
});
