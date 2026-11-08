import type { GamePosition, Promotion } from "@chessonglass/contracts";

/**
 * User intent for the single-writer game. Commands are accepted independently
 * of slow provider work and applied at defined boundaries; every command that
 * changes the position invalidates pending results for the old one.
 */
export type GameCommand =
  | { type: "pause" | "resume" | "undo" | "repeat" }
  | { type: "new-game"; initial: GamePosition | null }
  | { type: "manual-move"; uci: string }
  | { type: "choose-promotion"; promotion: Promotion }
  | { type: "confirm-position"; position: GamePosition };
