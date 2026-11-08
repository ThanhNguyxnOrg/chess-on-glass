import { describe, expect, test } from "vitest";

import { Engine, findStockfish, parseScore, scoreFor } from "../src/engine.js";

describe("scores", () => {
  test("UCI info lines are parsed", () => {
    expect(parseScore("info depth 20 seldepth 30 multipv 1 score cp 34 nodes 1 pv e2e4 e7e5")).toEqual({ cp: 34 });
    expect(parseScore("info depth 5 score mate -2 pv d8h4")).toEqual({ mate: -2 });
    expect(parseScore("info depth 20 score cp -12 upperbound nodes 5")).toEqual({ cp: -12 });
    expect(parseScore("info string NNUE evaluation enabled")).toBeNull();
  });

  test("a score is turned to either side's point of view", () => {
    expect(scoreFor({ cp: 50 }, "w")).toEqual({ cp: 50 });
    expect(scoreFor({ cp: 50 }, "b")).toEqual({ cp: -50 });
    expect(scoreFor({ mate: 3 }, "b")).toEqual({ mate: -3 });
  });
});

describe.skipIf(findStockfish() === null)("Stockfish", () => {
  test("finds a back-rank mate, scored from White's side", async () => {
    const engine = await Engine.start(undefined, 200);
    try {
      const suggestion = await engine.best("6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1");
      expect(suggestion.move).toBe("d1d8");
      expect(suggestion.score).toEqual({ mate: 1 });
      // The same mate seen from the side that gets mated is still reported from White's side.
      const black = await engine.best("3r2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1");
      expect(black.move).toBe("d8d1");
      expect(black.score).toEqual({ mate: -1 });
      expect(engine.name).toMatch(/^Stockfish/);
    } finally {
      engine.close();
    }
  });

  test("won't suggest a move when the game is over", async () => {
    const engine = await Engine.start(undefined, 100);
    try {
      await expect(engine.best("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3")).rejects.toThrow(/over/);
    } finally {
      engine.close();
    }
  });
});
