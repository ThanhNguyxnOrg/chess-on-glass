/**
 * Session-aware game coordination for ChessOnGlass.
 *
 * A single writer owns the live game; asynchronous work is accepted only when
 * its request/session/position identity still matches.
 */
export const PACKAGE_NAME = "@chessonglass/game";

export { PositionConfirmationService } from "./position-confirmation.js";
export type { PositionConfirmation } from "./position-confirmation.js";
