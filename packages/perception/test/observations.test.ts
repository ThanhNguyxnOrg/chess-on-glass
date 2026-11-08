import { describe, expect, it } from "vitest";
import { newSessionId, type RequestContext } from "@chessonglass/contracts";
import { parseObservation, type PieceObservation } from "@chessonglass/perception";

function context(): RequestContext {
  return {
    requestId: "req-1",
    sessionId: newSessionId(),
    positionVersion: 2,
    referenceSequence: 10n
  };
}

function squares(overrides: Partial<PieceObservation> = {}): PieceObservation[] {
  return Array.from({ length: 64 }, (_, square) => ({
    square,
    color: "empty" as const,
    kind: "unknown" as const,
    confidence: null,
    ...overrides
  }));
}

function observation(ctx: RequestContext): Record<string, unknown> {
  return {
    context: ctx,
    boardVisible: true,
    handOverBoard: false,
    squares: squares(),
    provider: "openai",
    model: "test-model",
    inputTokens: 100,
    outputTokens: 20
  };
}

describe("parseObservation", () => {
  it("accepts a complete 64-square observation and copies the request context", () => {
    const ctx = context();
    const parsed = parseObservation(observation(ctx), ctx);
    expect(parsed.context).toEqual(ctx);
    expect(parsed.squares).toHaveLength(64);
    expect(parsed.squares[0]).toEqual({
      square: 0,
      color: "empty",
      kind: "unknown",
      confidence: null
    });
  });

  it("preserves hand-over-board and hidden-board flags without inventing moves", () => {
    const ctx = context();
    const parsed = parseObservation(
      { ...observation(ctx), boardVisible: false, handOverBoard: true },
      ctx
    );
    expect(parsed.boardVisible).toBe(false);
    expect(parsed.handOverBoard).toBe(true);
  });

  it("accepts confidence only in [0,1] or null and every piece/color pair", () => {
    const ctx = context();
    const colored = squares();
    colored[0] = { square: 0, color: "white", kind: "king", confidence: 0 };
    colored[1] = { square: 1, color: "black", kind: "queen", confidence: 1 };
    colored[2] = { square: 2, color: "white", kind: "unknown", confidence: 0.5 };

    const parsed = parseObservation({ ...observation(ctx), squares: colored }, ctx);
    expect(parsed.squares[0]?.color).toBe("white");
    expect(parsed.squares[1]?.kind).toBe("queen");
    expect(parsed.squares[2]?.kind).toBe("unknown");
  });

  it("rejects malformed containers and wrong request context", () => {
    const ctx = context();
    const other = context();

    expect(() => parseObservation(null, ctx)).toThrow(/object/i);
    expect(() => parseObservation("observation", ctx)).toThrow(/object/i);
    expect(() => parseObservation([], ctx)).toThrow(/object/i);
    expect(() => parseObservation({ ...observation(ctx), context: other }, ctx)).toThrow(
      /context/i
    );
    expect(() => parseObservation({ ...observation(ctx), extra: true }, ctx)).toThrow(
      /unknown field/i
    );
  });

  it("rejects duplicate, missing and out-of-range squares", () => {
    const ctx = context();
    const duplicate = squares();
    duplicate[63] = { ...duplicate[63]!, square: 0 };
    expect(() => parseObservation({ ...observation(ctx), squares: duplicate }, ctx)).toThrow(
      /duplicate/i
    );

    expect(() =>
      parseObservation({ ...observation(ctx), squares: squares().slice(0, 63) }, ctx)
    ).toThrow(/64/i);

    const outOfRange = squares();
    outOfRange[0] = { ...outOfRange[0]!, square: 64 };
    expect(() => parseObservation({ ...observation(ctx), squares: outOfRange }, ctx)).toThrow(
      /square/i
    );
  });

  it("rejects invalid confidence, token counts and empty/unknown kind combinations", () => {
    const ctx = context();
    const badConfidence = squares();
    badConfidence[0] = { ...badConfidence[0]!, confidence: 1.1 };
    expect(() =>
      parseObservation({ ...observation(ctx), squares: badConfidence }, ctx)
    ).toThrow(/confidence/i);

    expect(() =>
      parseObservation({ ...observation(ctx), inputTokens: Number.NaN }, ctx)
    ).toThrow(/inputTokens/i);
    expect(() =>
      parseObservation({ ...observation(ctx), outputTokens: -1 }, ctx)
    ).toThrow(/outputTokens/i);

    const emptyWithPiece = squares();
    emptyWithPiece[0] = {
      square: 0,
      color: "empty",
      kind: "pawn",
      confidence: 0.9
    };
    expect(() =>
      parseObservation({ ...observation(ctx), squares: emptyWithPiece }, ctx)
    ).toThrow(/empty/i);
  });
});
