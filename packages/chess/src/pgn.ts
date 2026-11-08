import { Chess, DEFAULT_POSITION } from "chess.js";
import type { GamePosition } from "@chessonglass/contracts";
import type { ChessState } from "./state.js";

function replay(position: GamePosition): Chess {
  const chess = new Chess(position.initialFen);
  for (const uci of position.history) {
    const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci);
    if (match === null) {
      throw new Error(`cannot export PGN: invalid UCI history entry ${uci}`);
    }
    const descriptor: { from: string; to: string; promotion?: string } = {
      from: match[1]!,
      to: match[2]!
    };
    if (match[3] !== undefined) {
      descriptor.promotion = match[3];
    }
    chess.move(descriptor);
  }
  return chess;
}

/**
 * Deterministic PGN export. A non-standard confirmed FEN is recorded with
 * SetUp/FEN headers instead of pretending the game began at the initial
 * position. Names are optional and purely descriptive.
 */
export function toPgn(
  state: ChessState,
  names?: { white: string; black: string }
): string {
  const position = state.position();
  const chess = replay(position);

  const headers: string[] = [];
  if (position.initialFen !== DEFAULT_POSITION) {
    headers.push("SetUp", "1", "FEN", position.initialFen);
  }
  if (names !== undefined) {
    headers.push("White", names.white, "Black", names.black);
  }
  if (headers.length > 0) {
    chess.header(...headers);
  }

  return chess.pgn({ newline: "\n", maxWidth: 80 }).trimEnd();
}
