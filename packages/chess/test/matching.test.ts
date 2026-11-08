import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { ChessState, decideMove, rankMoves } from "@chessonglass/chess";
import {
  newSessionId,
  type GamePosition,
  type Observation,
  type PieceObservation,
  type RequestContext,
  type SessionId
} from "@chessonglass/contracts";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const PROMOTION_FEN = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";

const KIND: Record<string, PieceObservation["kind"]> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king"
};

function context(
  sessionId: SessionId = newSessionId(),
  requestId = "request-1",
  referenceSequence: bigint | null = 1n
): RequestContext {
  return { requestId, sessionId, positionVersion: 1, referenceSequence };
}

function observationForFen(
  fen: string,
  options: {
    context?: RequestContext;
    confidence?: number | null;
    boardVisible?: boolean;
    handOverBoard?: boolean;
    hideKinds?: boolean;
  } = {}
): Observation {
  const chess = new Chess(fen);
  const squares: PieceObservation[] = chess.board().flat().map((cell, square) =>
    cell === null
      ? { square, color: "empty", kind: "unknown", confidence: null }
      : {
          square,
          color: cell.color === "w" ? "white" : "black",
          kind: options.hideKinds === true ? "unknown" : KIND[cell.type]!,
          confidence: options.confidence === undefined ? 0.99 : options.confidence
        }
  );

  return {
    context: options.context ?? context(),
    boardVisible: options.boardVisible ?? true,
    handOverBoard: options.handOverBoard ?? false,
    squares,
    provider: "test",
    model: "test",
    inputTokens: 10,
    outputTokens: 2
  };
}

function positionAfter(moves: readonly string[], start = START_FEN): GamePosition {
  return ChessState.fromConfirmed({ fen: start, history: moves }).position();
}

function readingsFor(position: GamePosition, observation: Observation) {
  return [{ observation, candidate: rankMoves(position, observation)[0]! }];
}

describe("rankMoves", () => {
  it("identifies the legal move that explains the observed board", () => {
    const position = ChessState.initial().position();
    const observation = observationForFen(
      positionAfter(["e2e4"]).fen
    );

    const ranked = rankMoves(position, observation);

    expect(ranked[0]?.uci).toBe("e2e4");
    expect(ranked[0]?.mismatch).toBe(0);
    expect(ranked[0]?.margin).toBeGreaterThan(0);
  });

  it("does not count hidden cells as known disagreements", () => {
    const position = ChessState.initial().position();
    const observation = observationForFen(positionAfter(["e2e4"]).fen);
    const hidden = {
      ...observation,
      squares: observation.squares.map((square) =>
        square.color === "black" || square.square < 16
          ? { ...square, color: "unknown" as const, kind: "unknown" as const, confidence: null }
          : square
      )
    };

    const ranked = rankMoves(position, hidden);
    expect(ranked[0]?.uci).toBe("e2e4");
    expect(ranked[0]?.mismatch).toBe(0);
  });

  it("marks a move as requiring a reply when the opponent answer is already visible", () => {
    const position = ChessState.initial().position();
    const observation = observationForFen(positionAfter(["e2e4", "e7e5"]).fen);

    const ranked = rankMoves(position, observation);

    expect(ranked[0]?.uci).toBe("e2e4");
    expect(ranked[0]?.requiresReply).toBe(true);
  });

  it("keeps all four promotions tied when the promoted piece kind is hidden", () => {
    const position = ChessState.fromConfirmed({ fen: PROMOTION_FEN }).position();
    const observation = observationForFen(
      positionAfter(["a7a8q"], PROMOTION_FEN).fen,
      { hideKinds: true }
    );

    const ranked = rankMoves(position, observation);
    const promotions = ranked.filter((candidate) => candidate.uci?.startsWith("a7a8"));

    expect(promotions).toHaveLength(4);
    expect(new Set(promotions.map((candidate) => candidate.mismatch))).toEqual(new Set([0]));
    expect(promotions[0]?.margin).toBe(0);
  });

  it("returns no candidates when the position is already game over", () => {
    const state = ChessState.initial();
    for (const move of ["f2f3", "e7e5", "g2g4", "d8h4"]) {
      state.apply(move);
    }
    expect(rankMoves(state.position(), observationForFen(state.position().fen))).toEqual([]);
  });
});

describe("decideMove evidence policy", () => {
  it("commits only after two distinct fresh frames agree", () => {
    const position = ChessState.initial().position();
    const first = observationForFen(positionAfter(["e2e4"]).fen, {
      context: context(newSessionId(), "request-1", 1n)
    });
    const second = observationForFen(positionAfter(["e2e4"]).fen, {
      context: context(first.context.sessionId, "request-2", 2n)
    });

    const decision = decideMove(position, [
      ...readingsFor(position, first),
      ...readingsFor(position, second)
    ]);

    expect(decision).toMatchObject({ kind: "commit", uci: "e2e4" });
  });

  it("waits when the second reading is a duplicate of the same frame/request", () => {
    const position = ChessState.initial().position();
    const observation = observationForFen(positionAfter(["e2e4"]).fen);

    const decision = decideMove(position, [
      ...readingsFor(position, observation),
      ...readingsFor(position, observation)
    ]);

    expect(decision.kind).toBe("wait");
  });

  it("rejects corroboration from a different session", () => {
    const position = ChessState.initial().position();
    const first = observationForFen(positionAfter(["e2e4"]).fen, {
      context: context(newSessionId(), "request-1", 1n)
    });
    const second = observationForFen(positionAfter(["e2e4"]).fen, {
      context: context(newSessionId(), "request-2", 2n)
    });

    const decision = decideMove(position, [
      ...readingsFor(position, first),
      ...readingsFor(position, second)
    ]);

    expect(decision.kind).toBe("uncertain");
    expect(decision.reason).toMatch(/session|context/i);
  });

  it("does not commit on a single frame", () => {
    const position = ChessState.initial().position();
    const observation = observationForFen(positionAfter(["e2e4"]).fen);
    expect(decideMove(position, readingsFor(position, observation)).kind).toBe("wait");
  });

  it("does not commit when the board is covered by a hand", () => {
    const position = ChessState.initial().position();
    const first = observationForFen(positionAfter(["e2e4"]).fen, {
      context: context(newSessionId(), "request-1", 1n),
      handOverBoard: true
    });
    const second = observationForFen(positionAfter(["e2e4"]).fen, {
      context: context(first.context.sessionId, "request-2", 2n),
      handOverBoard: true
    });

    const decision = decideMove(position, [
      ...readingsFor(position, first),
      ...readingsFor(position, second)
    ]);
    expect(decision.kind).toBe("wait");
  });

  it("does not commit without usable confidence", () => {
    const position = ChessState.initial().position();
    const first = observationForFen(positionAfter(["e2e4"]).fen, {
      context: context(newSessionId(), "request-1", 1n),
      confidence: 0
    });
    const second = observationForFen(positionAfter(["e2e4"]).fen, {
      context: context(first.context.sessionId, "request-2", 2n),
      confidence: null
    });

    const decision = decideMove(position, [
      ...readingsFor(position, first),
      ...readingsFor(position, second)
    ]);
    expect(decision.kind).toBe("uncertain");
  });

  it("asks for confirmation on an indistinguishable promotion", () => {
    const position = ChessState.fromConfirmed({ fen: PROMOTION_FEN }).position();
    const first = observationForFen(positionAfter(["a7a8q"], PROMOTION_FEN).fen, {
      context: context(newSessionId(), "request-1", 1n),
      hideKinds: true
    });
    const second = observationForFen(positionAfter(["a7a8q"], PROMOTION_FEN).fen, {
      context: context(first.context.sessionId, "request-2", 2n),
      hideKinds: true
    });

    const decision = decideMove(position, [
      ...readingsFor(position, first),
      ...readingsFor(position, second)
    ]);
    expect(decision.kind).toBe("confirm");
    expect(decision.uci).toBeNull();
  });

  it("returns no-change when the board still matches the current position", () => {
    const position = positionAfter(["e2e4"]);
    const first = observationForFen(position.fen, {
      context: context(newSessionId(), "request-1", 1n)
    });
    const second = observationForFen(position.fen, {
      context: context(first.context.sessionId, "request-2", 2n)
    });

    const decision = decideMove(position, [
      ...readingsFor(position, first),
      ...readingsFor(position, second)
    ]);
    expect(decision.kind).toBe("no-change");
  });

  it("commits only the current legal move when an opponent reply is already visible", () => {
    const position = ChessState.initial().position();
    const first = observationForFen(positionAfter(["e2e4", "e7e5"]).fen, {
      context: context(newSessionId(), "request-1", 1n)
    });
    const second = observationForFen(positionAfter(["e2e4", "e7e5"]).fen, {
      context: context(first.context.sessionId, "request-2", 2n)
    });

    const decision = decideMove(position, [
      ...readingsFor(position, first),
      ...readingsFor(position, second)
    ]);

    expect(decision.kind).toBe("commit");
    expect(decision.uci).toBe("e2e4");
  });

  it("asks for confirmation when fresh frames support different moves", () => {
    const position = ChessState.initial().position();
    const first = observationForFen(positionAfter(["e2e4"]).fen, {
      context: context(newSessionId(), "request-1", 1n)
    });
    const second = observationForFen(positionAfter(["d2d4"]).fen, {
      context: context(first.context.sessionId, "request-2", 2n)
    });

    const decision = decideMove(position, [
      ...readingsFor(position, first),
      ...readingsFor(position, second)
    ]);
    expect(decision.kind).toBe("confirm");
  });

  it("reports uncertainty for a board that matches no legal move", () => {
    const position = ChessState.initial().position();
    const strange = observationForFen("4k3/8/8/8/8/8/8/4K3 w - - 0 1", {
      context: context(newSessionId(), "request-1", 1n)
    });
    const second = observationForFen("4k3/8/8/8/8/8/8/4K3 w - - 0 1", {
      context: context(strange.context.sessionId, "request-2", 2n)
    });

    const decision = decideMove(position, [
      ...readingsFor(position, strange),
      ...readingsFor(position, second)
    ]);
    expect(decision.kind).toBe("uncertain");
  });

  it("never commits a null candidate", () => {
    const position = ChessState.initial().position();
    const observation = observationForFen(positionAfter(["e2e4"]).fen);
    const candidate = { uci: null, mismatch: 99, margin: 0, requiresReply: false };

    const decision = decideMove(position, [
      { observation, candidate },
      { observation: { ...observation, context: context(observation.context.sessionId, "r2", 2n) }, candidate }
    ]);
    expect(decision.kind).toBe("uncertain");
    expect(decision.uci).toBeNull();
  });
});
