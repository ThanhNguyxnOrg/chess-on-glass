import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Chess } from "chess.js";

export const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

export function sans(pgn: string): string[] {
  const game = new Chess();
  game.loadPgn(readFileSync(FIXTURES + pgn, "utf8"));
  return game.history();
}

export const OPERA = sans("opera.pgn");

export function boardAfter(...moves: string[]): Chess {
  return boardFrom(new Chess().fen(), ...moves);
}

export function boardFrom(fen: string, ...moves: string[]): Chess {
  const board = new Chess(fen);
  for (const move of moves) board.move(move);
  return board;
}
