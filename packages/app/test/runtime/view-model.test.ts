import { describe, expect, it } from "vitest";
import { newSessionId, type RequestContext } from "@chessonglass/contracts";
import type { GameSnapshot, Result } from "@chessonglass/game";
import { toDashboardSnapshot } from "../../src/runtime/view-model.js";

function resultContext(positionVersion = 0): RequestContext {
  return {
    requestId: "req-1",
    sessionId: newSessionId(),
    positionVersion,
    referenceSequence: 7n
  };
}

function snapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    sessionId: newSessionId(),
    positionVersion: 1,
    status: "ready",
    position: {
      initialFen: "start",
      fen: "after e4",
      history: ["e2e4"],
      uncertainty: { castlingRights: false, enPassant: false, promotion: false }
    },
    suggestion: {
      context: resultContext(1),
      moveUci: "e7e5",
      spokenText: "Suggested e5",
      status: "ready",
      reason: "engine suggestion"
    },
    frameAgeMs: 120,
    error: null,
    ...overrides
  };
}

describe("toDashboardSnapshot", () => {
  it("produces JSON-safe output with decimal IDs and no bigint", () => {
    const json = JSON.parse(JSON.stringify(toDashboardSnapshot(snapshot())));
    expect(json.sessionId).toEqual(expect.any(String));
    expect(json.positionVersion).toBe(1);
    expect(json.suggestion?.moveUci).toBe("e7e5");
    const raw = JSON.stringify(toDashboardSnapshot(snapshot()));
    expect(raw).not.toMatch(/\d+n/);
  });

  it("never includes secrets, tokens or provider envelopes", () => {
    const raw = JSON.stringify(toDashboardSnapshot(snapshot()));
    expect(raw).not.toContain("sk-");
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("apiKey");
  });

  it("reports null suggestion and null position independently", () => {
    const noSuggestion = toDashboardSnapshot(snapshot({ suggestion: null }));
    expect(noSuggestion.suggestion).toBeNull();
    const noPosition = toDashboardSnapshot(snapshot({ position: null }));
    expect(noPosition.position).toBeNull();
  });

  it("preserves error and frameAgeMs", () => {
    const withError = toDashboardSnapshot(
      snapshot({ error: "frame source ended", frameAgeMs: null })
    );
    expect(withError.error).toBe("frame source ended");
    expect(withError.frameAgeMs).toBeNull();
  });
});
