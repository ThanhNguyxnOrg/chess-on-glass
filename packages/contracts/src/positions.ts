export type Promotion = "q" | "r" | "b" | "n";

/**
 * Facts a single board image cannot establish. They stay explicitly unknown
 * until the user or verified history supplies them.
 */
export type PositionUncertainty = Readonly<{
  castlingRights: boolean;
  enPassant: boolean;
  promotion: boolean;
}>;

export type GamePosition = Readonly<{
  initialFen: string;
  fen: string;
  history: readonly string[];
  uncertainty: PositionUncertainty;
}>;

export type GameStatus =
  | "needs-position"
  | "ready"
  | "waiting"
  | "confirming"
  | "uncertain"
  | "lost"
  | "paused"
  | "finished";
