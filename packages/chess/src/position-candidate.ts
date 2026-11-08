import type {
  PieceKind,
  PieceObservation,
  PositionUncertainty
} from "@chessonglass/contracts";

/**
 * A reviewable reconstruction from one board image. It is not a trusted game:
 * unknown squares, castling/en-passant rights and promotion history still
 * require explicit confirmation.
 */
export type PositionCandidate = {
  fen: string;
  uncertainties: PositionUncertainty;
  unresolvedSquares: readonly number[];
};

const KIND_CHAR: Readonly<Record<Exclude<PieceKind, "unknown">, string>> = {
  pawn: "p",
  knight: "n",
  bishop: "b",
  rook: "r",
  queen: "q",
  king: "k"
};

const ALL_UNCERTAIN: PositionUncertainty = Object.freeze({
  castlingRights: true,
  enPassant: true,
  promotion: true
});

/**
 * Build a FEN from piece-level observations. Square 0 is a8 and square 63 is
 * h1 (row-major from the top of the board image). Unknown cells are written as
 * empty in the FEN but remain listed in `unresolvedSquares`, so callers cannot
 * mistake the candidate for a confirmed position.
 */
export function candidateFromPieces(
  pieces: readonly PieceObservation[],
  sideToMove: "w" | "b"
): PositionCandidate {
  if (sideToMove !== "w" && sideToMove !== "b") {
    throw new Error('side to move must be "w" or "b"');
  }

  const board = new Array<string>(64).fill("");
  const unresolved = new Set<number>();
  const seen = new Set<number>();

  for (const piece of pieces) {
    if (
      !Number.isSafeInteger(piece.square) ||
      piece.square < 0 ||
      piece.square > 63
    ) {
      throw new Error(`square index must be an integer in [0,63], received ${String(piece.square)}`);
    }
    if (seen.has(piece.square)) {
      throw new Error(`duplicate square ${piece.square}`);
    }
    seen.add(piece.square);

    if (piece.color === "empty") {
      board[piece.square] = "";
      continue;
    }
    if (piece.color === "unknown" || piece.kind === "unknown") {
      unresolved.add(piece.square);
      continue;
    }

    const char = KIND_CHAR[piece.kind];
    board[piece.square] = piece.color === "white" ? char.toUpperCase() : char;
  }

  for (let square = 0; square < 64; square += 1) {
    if (!seen.has(square)) {
      unresolved.add(square);
    }
  }

  let placement = "";
  for (let rank = 0; rank < 8; rank += 1) {
    let empty = 0;
    for (let file = 0; file < 8; file += 1) {
      const char = board[rank * 8 + file]!;
      if (char === "") {
        empty += 1;
      } else {
        if (empty > 0) {
          placement += String(empty);
          empty = 0;
        }
        placement += char;
      }
    }
    if (empty > 0) {
      placement += String(empty);
    }
    if (rank < 7) {
      placement += "/";
    }
  }

  return {
    fen: `${placement} ${sideToMove} - - 0 1`,
    uncertainties: { ...ALL_UNCERTAIN },
    unresolvedSquares: [...unresolved].sort((left, right) => left - right)
  };
}
