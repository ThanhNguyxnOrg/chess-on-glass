import type { RequestContext } from "./frames.js";

export type PieceColor = "white" | "black" | "empty" | "unknown";
export type PieceKind = "pawn" | "knight" | "bishop" | "rook" | "queen" | "king" | "unknown";

export type PieceObservation = {
  square: number;
  color: PieceColor;
  kind: PieceKind;
  confidence: number | null;
};

export type Observation = {
  context: RequestContext;
  boardVisible: boolean;
  handOverBoard: boolean;
  squares: readonly PieceObservation[];
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};
