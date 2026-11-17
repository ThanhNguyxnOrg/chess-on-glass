import type { GameSnapshot } from "@chessonglass/game";

export type DashboardSnapshot = {
  sessionId: string;
  positionVersion: number;
  status: string;
  position: {
    initialFen: string;
    fen: string;
    history: readonly string[];
    uncertainty: {
      castlingRights: boolean;
      enPassant: boolean;
      promotion: boolean;
    };
  } | null;
  suggestion: {
    moveUci: string | null;
    spokenText: string | null;
    status: string;
    reason: string | null;
  } | null;
  frameAgeMs: number | null;
  error: string | null;
};

/**
 * Converts a GameSnapshot to a JSON-safe DashboardSnapshot. Only the fields
 * the dashboard needs are included; no secrets, tokens, provider envelopes,
 * or bigint values.
 */
export function toDashboardSnapshot(snapshot: GameSnapshot): DashboardSnapshot {
  return {
    sessionId: snapshot.sessionId,
    positionVersion: snapshot.positionVersion,
    status: snapshot.status,
    position: snapshot.position
      ? {
          initialFen: snapshot.position.initialFen,
          fen: snapshot.position.fen,
          history: [...snapshot.position.history],
          uncertainty: { ...snapshot.position.uncertainty }
        }
      : null,
    suggestion: snapshot.suggestion
      ? {
          moveUci: snapshot.suggestion.moveUci,
          spokenText: snapshot.suggestion.spokenText,
          status: snapshot.suggestion.status,
          reason: snapshot.suggestion.reason
        }
      : null,
    frameAgeMs: snapshot.frameAgeMs,
    error: snapshot.error
  };
}
