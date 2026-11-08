import { Chess, type PieceSymbol } from "chess.js";
import { describe, expect, it } from "vitest";
import {
  candidateFromPieces,
  type PositionCandidate
} from "@chessonglass/chess";
import type { PieceObservation } from "@chessonglass/contracts";

const MIDGAME_FEN =
  "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 1";

const KIND: Record<PieceSymbol, PieceObservation["kind"]> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king"
};

function piecesFromFen(fen: string): PieceObservation[] {
  const chess = new Chess(fen);
  return chess.board().flat().map((cell, square) =>
    cell === null
      ? { square, color: "empty", kind: "unknown", confidence: null }
      : {
          square,
          color: cell.color === "w" ? "white" : "black",
          kind: KIND[cell.type],
          confidence: 0.99
        }
  );
}

function findSquare(pieces: PieceObservation[], color: PieceObservation["color"], kind: PieceObservation["kind"]): number {
  const found = pieces.find((piece) => piece.color === color && piece.kind === kind);
  if (found === undefined) {
    throw new Error(`missing ${color} ${kind}`);
  }
  return found.square;
}

describe("candidateFromPieces", () => {
  it("builds a FEN from a fully known mid-game layout without inventing rights", () => {
    const candidate = candidateFromPieces(piecesFromFen(MIDGAME_FEN), "w");

    expect(candidate.fen).toBe(
      "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w - - 0 1"
    );
    expect(candidate.unresolvedSquares).toEqual([]);
    expect(candidate.uncertainties).toEqual({
      castlingRights: true,
      enPassant: true,
      promotion: true
    });
  });

  it("keeps an occluded king unresolved instead of filling it in", () => {
    const pieces = piecesFromFen(MIDGAME_FEN);
    const king = findSquare(pieces, "white", "king");
    pieces[king] = { square: king, color: "unknown", kind: "unknown", confidence: null };

    const candidate = candidateFromPieces(pieces, "w");
    expect(candidate.unresolvedSquares).toContain(king);
  });

  it("keeps an unknown piece type unresolved", () => {
    const pieces = piecesFromFen(MIDGAME_FEN);
    const knight = findSquare(pieces, "white", "knight");
    pieces[knight] = { square: knight, color: "white", kind: "unknown", confidence: null };

    const candidate = candidateFromPieces(pieces, "w");
    expect(candidate.unresolvedSquares).toContain(knight);
  });

  it("requires an explicit side to move and never guesses it", () => {
    const pieces = piecesFromFen(MIDGAME_FEN);
    expect(candidateFromPieces(pieces, "w").fen).toContain(" w ");
    expect(candidateFromPieces(pieces, "b").fen).toContain(" b ");
    expect(() => candidateFromPieces(pieces, "x" as "w")).toThrow(/side to move/i);
  });

  it("rejects duplicate or out-of-range square observations", () => {
    const pieces = piecesFromFen(MIDGAME_FEN);
    const duplicate = [...pieces];
    duplicate[1] = { ...duplicate[1]!, square: 0 };
    expect(() => candidateFromPieces(duplicate, "w")).toThrow(/duplicate/i);

    const outOfRange = [...pieces];
    outOfRange[0] = { ...outOfRange[0]!, square: 64 };
    expect(() => candidateFromPieces(outOfRange, "w")).toThrow(/square/i);
  });
});

describe("PositionCandidate shape", () => {
  it("is a reviewable candidate, not a trusted game", () => {
    const candidate: PositionCandidate = candidateFromPieces(piecesFromFen(MIDGAME_FEN), "w");
    expect(candidate.uncertainties.castlingRights).toBe(true);
    expect(candidate.unresolvedSquares).toEqual([]);
  });
});
