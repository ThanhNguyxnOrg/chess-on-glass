import { Chess } from "chess.js";
import { describe, expect, test } from "vitest";

import { SQUARE_NAMES, copyBoard, movesText, occupancy, spoken, squareIndex, toPgn } from "../src/game.js";
import { OPERA, boardAfter } from "./games.js";

const PROMOTION = "8/4P3/8/8/8/8/k7/4K3 w - - 0 1";
const ROOKS = "4k3/8/8/8/8/R7/8/R3K3 w - - 0 1";

function say(setup: string | string[], san: string): string {
  const board = typeof setup === "string" ? new Chess(setup) : boardAfter(...setup);
  return spoken(board.move(san));
}

const operaUntil = (san: string) => OPERA.slice(0, OPERA.indexOf(san));

describe("spoken", () => {
  test.each([
    [[], "e4", "Pawn to e4"],
    [[], "Nf3", "Knight to f3"],
    [["e4", "d5"], "exd5", "Pawn e takes d5"],
    [operaUntil("Bxf3"), "Bxf3", "Bishop takes f3"],
    [operaUntil("Bxb5+"), "Bxb5+", "Bishop takes b5, check"],
    [operaUntil("Nbd7"), "Nbd7", "Knight b to d7"],
    [operaUntil("O-O-O"), "O-O-O", "Castle queenside"],
    [operaUntil("Rd8#"), "Rd8#", "Rook to d8, checkmate"],
    [["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"], "O-O", "Castle kingside"],
    [["e4", "a6", "e5", "d5"], "exd6", "Pawn e takes d6, en passant"],
    [PROMOTION, "e8=Q", "Pawn to e8, promote to queen"],
    [PROMOTION, "e8=N", "Pawn to e8, promote to knight"],
    [ROOKS, "R1a2", "Rook 1 to a2"],
  ] as [string | string[], string, string][])("%j %s", (setup, san, expected) => {
    expect(say(setup, san)).toBe(expected);
  });
});

test("the Opera Game fixture is the real game", () => {
  expect(OPERA).toHaveLength(33);
  expect(OPERA.slice(-3)).toEqual(["Qb8+", "Nxb8", "Rd8#"]);
});

test("move text is numbered like python-chess", () => {
  expect(movesText(new Chess().fen(), ["e4", "e5", "Nf3"])).toBe("1. e4 e5 2. Nf3");
  expect(movesText("8/8/8/8/8/8/k7/4K3 b - - 0 12", ["Kb2", "Ke2"])).toBe("12...Kb2 13. Ke2");
  expect(movesText(new Chess().fen(), [])).toBe("");
});

test("squares are numbered a1 = 0 to h8 = 63", () => {
  expect([squareIndex("a1"), squareIndex("h1"), squareIndex("e4"), squareIndex("h8")]).toEqual([0, 7, 28, 63]);
  expect(SQUARE_NAMES[28]).toBe("e4");
  expect(() => squareIndex("i9")).toThrow();
});

test("occupancy reads a FEN", () => {
  const cells = occupancy(new Chess().fen());
  expect([cells[0], cells[15], cells[16], cells[48], cells[63]]).toEqual([1, 1, 0, 2, 2]);
});

test("copies keep the move history, and PGN keeps the starting position", () => {
  const start = "2b5/1p3k1p/8/ppB5/8/8/PPP3PP/3RR1K1 w - - 0 1";
  const board = new Chess(start);
  board.move("Rf1+");
  expect(copyBoard(board).history()).toEqual(["Rf1+"]);
  const pgn = toPgn(board, "Opponent", "You");
  expect(pgn).toContain(`[FEN "${start}"]`);
  expect(pgn).toContain('[White "Opponent"]');
  expect(pgn.trim().endsWith("1. Rf1+ *")).toBe(true);
});
