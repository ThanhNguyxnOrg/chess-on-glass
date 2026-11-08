import { describe, expect, it } from "vitest";
import { ChessState, IllegalMoveError } from "@chessonglass/chess";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const PROMOTION_FEN = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";

describe("ChessState basic legality", () => {
  it("starts at the standard position", () => {
    const state = ChessState.initial();
    expect(state.position()).toEqual({
      initialFen: START_FEN,
      fen: START_FEN,
      history: [],
      uncertainty: { castlingRights: false, enPassant: false, promotion: false }
    });
  });

  it("applies a legal move and changes the side to move", () => {
    const state = ChessState.initial();
    const position = state.apply("e2e4");
    expect(position.history).toEqual(["e2e4"]);
    expect(position.fen.split(" ")[1]).toBe("b");
  });

  it("rejects an illegal move without mutating the previous state", () => {
    const state = ChessState.initial();
    const before = state.position();
    expect(() => state.apply("e2e5")).toThrow(IllegalMoveError);
    expect(state.position()).toEqual(before);
  });

  it("undoes moves and returns null when no move remains", () => {
    const state = ChessState.initial();
    state.apply("e2e4");
    const undone = state.undo();
    expect(undone?.fen).toBe(START_FEN);
    expect(undone?.history).toEqual([]);
    expect(state.undo()).toBeNull();
  });

  it("clones without sharing mutable chess state", () => {
    const state = ChessState.initial();
    state.apply("e2e4");
    const clone = state.clone();
    clone.apply("e7e5");

    expect(state.position().history).toEqual(["e2e4"]);
    expect(clone.position().history).toEqual(["e2e4", "e7e5"]);
  });
});

describe("ChessState special rules", () => {
  it("supports castling", () => {
    const state = ChessState.initial();
    for (const move of ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6"]) {
      state.apply(move);
    }
    const position = state.apply("e1g1");
    expect(position.fen).toContain("RNBQ1RK1");
  });

  it("supports en passant capture", () => {
    const state = ChessState.initial();
    for (const move of ["e2e4", "a7a6", "e4e5", "d7d5"]) {
      state.apply(move);
    }
    expect(state.legalMoves().map((move) => move.uci)).toContain("e5d6");
    const position = state.apply("e5d6");
    expect(position.fen).toBe("rnbqkbnr/1pp1pppp/p2P4/8/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3");
  });

  it("keeps all four promotion choices distinguishable", () => {
    const legal = ChessState.fromConfirmed({ fen: PROMOTION_FEN }).legalMoves();
    const promotions = legal.filter((move) => move.uci.startsWith("a7a8"));
    expect(new Set(promotions.map((move) => move.promotion))).toEqual(new Set(["q", "r", "b", "n"]));

    const fenByPromotion = new Map<string, string>();
    for (const promotion of ["q", "r", "b", "n"] as const) {
      const state = ChessState.fromConfirmed({ fen: PROMOTION_FEN });
      fenByPromotion.set(promotion, state.apply(`a7a8${promotion}`).fen);
    }
    expect(new Set(fenByPromotion.values()).size).toBe(4);
  });

  it("recognises checkmate and stalemate explicitly", () => {
    const mate = ChessState.initial();
    for (const move of ["f2f3", "e7e5", "g2g4", "d8h4"]) {
      mate.apply(move);
    }
    expect(mate.legalMoves()).toEqual([]);
    expect(mate.isCheckmate()).toBe(true);
    expect(mate.isStalemate()).toBe(false);
    expect(mate.isGameOver()).toBe(true);

    const stalemate = ChessState.fromConfirmed({ fen: "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1" });
    expect(stalemate.legalMoves()).toEqual([]);
    expect(stalemate.isCheckmate()).toBe(false);
    expect(stalemate.isStalemate()).toBe(true);
    expect(stalemate.isGameOver()).toBe(true);
  });
});

describe("ChessState confirmed mid-game positions", () => {
  it("preserves explicit uncertainty and empty history for a camera-derived FEN", () => {
    const fen = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 1";
    const state = ChessState.fromConfirmed({
      fen,
      uncertainty: { castlingRights: true, enPassant: true, promotion: true }
    });
    expect(state.position().initialFen).toBe(fen);
    expect(state.position().history).toEqual([]);
    expect(state.position().uncertainty).toEqual({
      castlingRights: true,
      enPassant: true,
      promotion: true
    });
  });

  it("replays a supplied verified history from the confirmed starting FEN", () => {
    const state = ChessState.fromConfirmed({
      fen: START_FEN,
      history: ["e2e4", "e7e5", "g1f3"]
    });
    expect(state.position().history).toEqual(["e2e4", "e7e5", "g1f3"]);
    expect(state.position().fen).toContain(" b ");
  });

  it("rejects invalid FEN and illegal history at confirmation", () => {
    expect(() => ChessState.fromConfirmed({ fen: "not-a-fen" })).toThrow(/FEN/i);
    expect(() =>
      ChessState.fromConfirmed({ fen: START_FEN, history: ["e2e5"] })
    ).toThrow(IllegalMoveError);
  });
});
