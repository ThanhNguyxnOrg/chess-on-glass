/**
 * Session-aware game coordination for ChessOnGlass.
 *
 * A single writer owns the live game; asynchronous work is accepted only when
 * its request/session/position identity still matches.
 */
export const PACKAGE_NAME = "@chessonglass/game";

export { PositionConfirmationService } from "./position-confirmation.js";
export type { PositionConfirmation } from "./position-confirmation.js";
export { CostLedger } from "./budget.js";
export type { LedgerSnapshot, Price, ReservationDecision } from "./budget.js";
export {
  InvalidGameRecordError,
  isCanonicalSessionId,
  markForResume,
  parseGameRecord,
  recordPgn,
  serializeGameRecord
} from "./journal.js";
export type { GameRecord, ResumableGameRecord } from "./journal.js";
export {
  FileGameStore,
  GameNotFoundError,
  GameRecordConflictError
} from "./storage.js";
export type { FileGameStoreOptions, GameStore } from "./storage.js";
