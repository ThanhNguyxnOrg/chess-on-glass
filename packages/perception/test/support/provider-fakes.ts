import {
  newSessionId,
  type RequestContext,
  type Sequence
} from "@chessonglass/contracts";

export function observationContext(
  input: { referenceSequence?: Sequence } = {}
): RequestContext {
  return {
    requestId: "request-1",
    sessionId: newSessionId(),
    positionVersion: 1,
    referenceSequence: input.referenceSequence ?? null
  };
}

export type ObservationSquare = {
  square: number;
  color: string;
  kind: string;
  confidence: number | null;
};

export function emptySquares(): ObservationSquare[] {
  return Array.from({ length: 64 }, (_, square) => ({
    square,
    color: "empty",
    kind: "unknown",
    confidence: 0.99
  }));
}

export function midGameSquares(): ObservationSquare[] {
  const squares = emptySquares();
  squares[60] = { square: 60, color: "white", kind: "king", confidence: 0.97 };
  squares[4] = { square: 4, color: "black", kind: "king", confidence: 0.96 };
  squares[52] = { square: 52, color: "white", kind: "pawn", confidence: 0.9 };
  return squares;
}
