import { describe, expect, it } from "vitest";
import { candidateFromPieces } from "@chessonglass/chess";
import { PositionConfirmationService } from "@chessonglass/game";
import type { PieceObservation } from "@chessonglass/contracts";

function kingsOnly(): PieceObservation[] {
  const pieces: PieceObservation[] = Array.from({ length: 64 }, (_, square) => ({
    square,
    color: "empty" as const,
    kind: "unknown" as const,
    confidence: null
  }));
  pieces[4] = { square: 4, color: "black", kind: "king", confidence: 0.99 };
  pieces[60] = { square: 60, color: "white", kind: "king", confidence: 0.99 };
  return pieces;
}

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("PositionConfirmationService", () => {
  it("reviews a fully resolved legal candidate with explicit uncertainty", () => {
    const service = new PositionConfirmationService();
    const candidate = candidateFromPieces(kingsOnly(), "w");

    const reviewed = service.review(candidate);

    expect(reviewed).not.toBeNull();
    expect(reviewed?.fen).toBe("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    expect(reviewed?.history).toEqual([]);
    expect(reviewed?.uncertainty).toEqual({
      castlingRights: true,
      enPassant: true,
      promotion: true
    });
  });

  it("refuses to review a candidate with unresolved squares", () => {
    const service = new PositionConfirmationService();
    const pieces = kingsOnly();
    pieces[60] = { square: 60, color: "unknown", kind: "unknown", confidence: null };
    expect(service.review(candidateFromPieces(pieces, "w"))).toBeNull();
  });

  it("refuses an illegal candidate such as duplicate kings", () => {
    const service = new PositionConfirmationService();
    const pieces = kingsOnly();
    pieces[3] = { square: 3, color: "black", kind: "king", confidence: 0.99 };
    expect(service.review(candidateFromPieces(pieces, "w"))).toBeNull();
  });

  it("confirms a position once without appending phantom moves", () => {
    const service = new PositionConfirmationService();
    const input = {
      fen: "4k3/8/8/8/8/8/8/4K3 w - - 0 1",
      history: [],
      uncertainty: {
        castlingRights: false,
        enPassant: false,
        promotion: false
      }
    } as const;

    const first = service.confirm(input);
    const second = service.confirm(input);

    expect(first).toEqual(second);
    expect(first.history).toEqual([]);
    expect(first.uncertainty).toEqual({
      castlingRights: false,
      enPassant: false,
      promotion: false
    });
  });

  it("preserves verified history on confirmation", () => {
    const service = new PositionConfirmationService();
    const confirmed = service.confirm({
      fen: START_FEN,
      history: ["e2e4", "e7e5"],
      uncertainty: { castlingRights: false, enPassant: false, promotion: false }
    });
    expect(confirmed.history).toEqual(["e2e4", "e7e5"]);
    expect(confirmed.initialFen).toBe(START_FEN);
  });

  it("rejects an illegal confirmed FEN instead of starting a game from it", () => {
    const service = new PositionConfirmationService();
    expect(() =>
      service.confirm({
        fen: "not-a-fen",
        history: [],
        uncertainty: { castlingRights: false, enPassant: false, promotion: false }
      })
    ).toThrow(/FEN/i);
  });
});
