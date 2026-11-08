/**
 * Chess rules, history and observation matching for ChessOnGlass.
 *
 * chess.js stays behind this package; mutable board internals are never
 * exposed to callers.
 */
export const PACKAGE_NAME = "@chessonglass/chess";

export { ChessState, IllegalMoveError, InvalidPositionError } from "./state.js";
export type { BoardPiece } from "./state.js";
export { toPgn } from "./pgn.js";
export { candidateFromPieces } from "./position-candidate.js";
export type { PositionCandidate } from "./position-candidate.js";
export { decideMove, rankMoves } from "./matching.js";
export type { Evidence, MoveCandidate, MoveDecision } from "./matching.js";
