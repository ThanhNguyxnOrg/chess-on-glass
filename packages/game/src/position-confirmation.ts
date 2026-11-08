import { ChessState } from "@chessonglass/chess";
import type { PositionCandidate } from "@chessonglass/chess";
import type { GamePosition, PositionUncertainty } from "@chessonglass/contracts";

export interface PositionConfirmation {
  review(candidate: PositionCandidate): GamePosition | null;
  confirm(input: {
    fen: string;
    history: readonly string[];
    uncertainty: PositionUncertainty;
  }): GamePosition;
}

/**
 * The only transition from a camera-derived candidate to a playable position.
 * Review never guesses: unresolved cells or an illegal FEN return null, and
 * the caller must ask the user for the missing facts.
 */
export class PositionConfirmationService implements PositionConfirmation {
  review(candidate: PositionCandidate): GamePosition | null {
    if (candidate.unresolvedSquares.length > 0) {
      return null;
    }
    try {
      return ChessState.fromConfirmed({
        fen: candidate.fen,
        uncertainty: candidate.uncertainties
      }).position();
    } catch {
      return null;
    }
  }

  confirm(input: {
    fen: string;
    history: readonly string[];
    uncertainty: PositionUncertainty;
  }): GamePosition {
    return ChessState.fromConfirmed(input).position();
  }
}
