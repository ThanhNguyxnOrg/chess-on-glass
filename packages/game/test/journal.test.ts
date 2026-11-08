import { describe, expect, it } from "vitest";
import { ChessState } from "@chessonglass/chess";
import { newSessionId, type GamePosition, type SessionId } from "@chessonglass/contracts";
import {
  InvalidGameRecordError,
  markForResume,
  parseGameRecord,
  recordPgn,
  serializeGameRecord,
  type GameRecord
} from "@chessonglass/game";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function positionAfter(moves: readonly string[]): GamePosition {
  return ChessState.fromConfirmed({ fen: START_FEN, history: moves }).position();
}

function recordFor(
  sessionId: SessionId = newSessionId(),
  positionVersion = 1,
  moves: readonly string[] = ["e2e4"],
  createdAtWallMs = 1_000
): GameRecord {
  return {
    schemaVersion: 1,
    sessionId,
    position: positionAfter(moves),
    positionVersion,
    createdAtWallMs,
    updatedAtWallMs: createdAtWallMs + positionVersion
  };
}

describe("GameRecord serialization", () => {
  it("round-trips a committed move at the same version", () => {
    const original = recordFor(undefined, 2, ["e2e4", "e7e5"]);
    const parsed = parseGameRecord(JSON.parse(serializeGameRecord(original)));

    expect(parsed).toEqual(original);
    expect(parsed?.positionVersion).toBe(2);
    expect(parsed?.position.history).toEqual(["e2e4", "e7e5"]);
  });

  it("exports PGN from that same record history", () => {
    const first = recordFor(undefined, 1, ["e2e4"]);
    const second = recordFor(first.sessionId, 2, ["e2e4", "e7e5"]);

    expect(recordPgn(first)).toContain("1. e4");
    expect(recordPgn(first)).not.toContain("1. e4 e5");
    expect(recordPgn(second)).toContain("1. e4 e5");
  });

  it("marks a loaded record as requiring confirmation without persisting the marker", () => {
    const record = recordFor();
    const resumed = markForResume(record);

    expect(resumed.resumeRequiresConfirmation).toBe(true);
    expect(resumed.positionVersion).toBe(record.positionVersion);
    expect(serializeGameRecord(resumed)).not.toContain("resumeRequiresConfirmation");
  });
});

describe("GameRecord validation", () => {
  it("rejects a FEN that disagrees with its history", () => {
    const record = recordFor();
    const inconsistent: GameRecord = {
      ...record,
      position: { ...record.position, fen: START_FEN }
    };

    expect(() => serializeGameRecord(inconsistent)).toThrow(InvalidGameRecordError);
    expect(() => recordPgn(inconsistent)).toThrow(InvalidGameRecordError);
  });

  it("rejects invalid FEN, versions, timestamps and uncertainty", () => {
    const record = recordFor();

    expect(() =>
      serializeGameRecord({
        ...record,
        position: { ...record.position, initialFen: "not-a-fen", fen: "not-a-fen" }
      })
    ).toThrow(InvalidGameRecordError);

    expect(() => serializeGameRecord({ ...record, positionVersion: -1 })).toThrow(
      InvalidGameRecordError
    );
    expect(() => serializeGameRecord({ ...record, positionVersion: 1.5 })).toThrow(
      InvalidGameRecordError
    );
    expect(() => serializeGameRecord({ ...record, createdAtWallMs: Number.NaN })).toThrow(
      InvalidGameRecordError
    );
    expect(() => serializeGameRecord({ ...record, updatedAtWallMs: 999 })).toThrow(
      InvalidGameRecordError
    );
    expect(() =>
      serializeGameRecord({
        ...record,
        position: {
          ...record.position,
          uncertainty: {
            ...record.position.uncertainty,
            castlingRights: "yes" as unknown as boolean
          }
        }
      })
    ).toThrow(InvalidGameRecordError);
  });
});

describe("parseGameRecord untrusted input", () => {
  it("returns null for malformed, future or extra-field records", () => {
    const valid = JSON.parse(serializeGameRecord(recordFor())) as Record<string, unknown>;
    const position = valid.position as Record<string, unknown>;

    expect(parseGameRecord(null)).toBeNull();
    expect(parseGameRecord("record")).toBeNull();
    expect(parseGameRecord({})).toBeNull();
    expect(parseGameRecord({ ...valid, schemaVersion: 2 })).toBeNull();
    expect(parseGameRecord({ ...valid, extra: true })).toBeNull();
    expect(parseGameRecord({ ...valid, position: { ...position, extra: true } })).toBeNull();
    expect(parseGameRecord({ ...valid, sessionId: "" })).toBeNull();
  });

  it("returns null rather than a fabricated record for truncated JSON", () => {
    expect(parseGameRecord(JSON.parse("null"))).toBeNull();
    expect(() => JSON.parse('{"schemaVersion":1')).toThrow();
  });
});
