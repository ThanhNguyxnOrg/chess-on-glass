import { readFile } from "node:fs/promises";
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { ChessState, toPgn } from "@chessonglass/chess";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("toPgn", () => {
  it("is deterministic and contains the played SAN moves", () => {
    const state = ChessState.initial();
    for (const move of ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"]) {
      state.apply(move);
    }

    const first = toPgn(state);
    const second = toPgn(state);

    expect(first).toBe(second);
    expect(first).toContain("1. e4 e5 2. Nf3 Nc6 3. Bb5");
    expect(first).not.toContain("SetUp");
  });

  it("records a non-standard starting FEN and optional player names", () => {
    const fen = "4k3/8/8/8/8/8/8/4K2R w K - 0 1";
    const state = ChessState.fromConfirmed({ fen });
    state.apply("e1g1");

    const pgn = toPgn(state, { white: "Alice", black: "Bob" });

    expect(pgn).toContain('[SetUp "1"]');
    expect(pgn).toContain(`[FEN "${fen}"]`);
    expect(pgn).toContain('[White "Alice"]');
    expect(pgn).toContain('[Black "Bob"]');
    expect(pgn).toContain("O-O");
  });

  it("uses the Opera Game fixture as data and round-trips a citable game", async () => {
    const fixture = await readFile(new URL("../../../fixtures/opera.pgn", import.meta.url), "utf8");
    const parsed = new Chess();
    parsed.loadPgn(fixture);
    const history = parsed.history({ verbose: true }).map((move) => move.lan);

    const state = ChessState.fromConfirmed({ fen: START_FEN, history });
    expect(state.position().fen).toBe(parsed.fen());

    const pgn = toPgn(state, { white: "Paul Morphy", black: "Duke Karl and Count Isouard" });
    const reparsed = new Chess();
    reparsed.loadPgn(pgn);
    expect(reparsed.history()).toEqual(parsed.history());
    expect(pgn).toContain("17. Rd8#");
  });
});
