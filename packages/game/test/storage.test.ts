import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChessState } from "@chessonglass/chess";
import { newSessionId, type GamePosition, type SessionId } from "@chessonglass/contracts";
import {
  FileGameStore,
  GameNotFoundError,
  GameRecordConflictError,
  InvalidGameRecordError,
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

async function filesUnder(root: string): Promise<readonly string[]> {
  return readdir(root, { recursive: true });
}

async function recordFiles(root: string): Promise<readonly string[]> {
  return (await filesUnder(root)).filter((entry) => entry.endsWith(".game.json"));
}

async function onlyRecordFile(root: string): Promise<string> {
  const records = await recordFiles(root);
  expect(records).toHaveLength(1);
  return join(root, records[0]!);
}

describe("FileGameStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chessonglass-store-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a committed move and exports the same version as PGN", async () => {
    const store = new FileGameStore(root);
    const session = newSessionId();
    const record = recordFor(session, 2, ["e2e4", "e7e5"]);

    await store.append(record);

    const loaded = await store.load(session);
    expect(loaded).toMatchObject(record);
    expect(loaded?.positionVersion).toBe(2);
    expect(loaded?.resumeRequiresConfirmation).toBe(true);

    const pgn = await store.exportPgn(session);
    expect(pgn).toContain("1. e4 e5");
  });

  it("stores only the schema, ordered history and uncertainty", async () => {
    const store = new FileGameStore(root);
    const session = newSessionId();
    const record = recordFor(session, 3, ["e2e4", "e7e5", "g1f3"]);

    await store.append(record);

    const parsed = JSON.parse(
      await readFile(await onlyRecordFile(root), "utf8")
    ) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "schemaVersion",
        "sessionId",
        "position",
        "positionVersion",
        "createdAtWallMs",
        "updatedAtWallMs"
      ].sort()
    );
    expect((parsed.position as Record<string, unknown>).history).toEqual([
      "e2e4",
      "e7e5",
      "g1f3"
    ]);
  });

  it("never loads partially written or fabricated JSON as valid state", async () => {
    const store = new FileGameStore(root);
    const session = newSessionId();
    await store.append(recordFor(session));

    const path = await onlyRecordFile(root);
    await writeFile(path, '{"schemaVersion":1,"sessionId":', "utf8");

    await expect(store.load(session)).resolves.toBeNull();
    await expect(store.exportPgn(session)).rejects.toThrow(GameNotFoundError);

    // A syntactically valid but untrusted record is also not loaded.
    const forged = {
      ...JSON.parse(serializeGameRecord(recordFor(session))),
      resumeRequiresConfirmation: true
    };
    await writeFile(path, JSON.stringify(forged), "utf8");
    await expect(store.load(session)).resolves.toBeNull();
  });

  it("never loads a record stored under another session identity", async () => {
    const store = new FileGameStore(root);
    const session = newSessionId();
    const other = newSessionId();
    await store.append(recordFor(session));

    await writeFile(
      await onlyRecordFile(root),
      serializeGameRecord(recordFor(other)),
      "utf8"
    );

    await expect(store.load(session)).resolves.toBeNull();
  });

  it("retains the previous valid record when the atomic replace fails", async () => {
    let failRename = false;
    const store = new FileGameStore(root, {
      renameFile: async (from, to) => {
        if (failRename) {
          throw new Error("simulated rename failure");
        }
        await rename(from, to);
      }
    });
    const session = newSessionId();
    await store.append(recordFor(session, 1, ["e2e4"]));
    const before = await readFile(await onlyRecordFile(root), "utf8");

    failRename = true;
    await expect(
      store.append(recordFor(session, 2, ["e2e4", "e7e5"]))
    ).rejects.toThrow("simulated rename failure");

    await expect(store.load(session)).resolves.toMatchObject({
      positionVersion: 1
    });
    await expect(readFile(await onlyRecordFile(root), "utf8")).resolves.toBe(before);
    expect((await filesUnder(root)).some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("keeps duplicate commits idempotent, including concurrent retries", async () => {
    const store = new FileGameStore(root);
    const session = newSessionId();
    const record = recordFor(session, 1, ["e2e4"]);

    await store.append(record);
    const before = await readFile(await onlyRecordFile(root), "utf8");

    await store.append({ ...record, updatedAtWallMs: record.updatedAtWallMs + 50 });
    await Promise.all([store.append(record), store.append(record)]);

    await expect(readFile(await onlyRecordFile(root), "utf8")).resolves.toBe(before);
    expect(await recordFiles(root)).toHaveLength(1);
  });

  it("rejects stale and conflicting appends without replacing the newer record", async () => {
    const store = new FileGameStore(root);
    const session = newSessionId();
    await store.append(recordFor(session, 2, ["e2e4", "e7e5"]));

    await expect(
      store.append(recordFor(session, 1, ["e2e4"]))
    ).rejects.toThrow(GameRecordConflictError);
    await expect(
      store.append(recordFor(session, 2, ["d2d4", "d7d5"]))
    ).rejects.toThrow(GameRecordConflictError);

    const loaded = await store.load(session);
    expect(loaded?.positionVersion).toBe(2);
    expect(loaded?.position.history).toEqual(["e2e4", "e7e5"]);
  });

  it("rejects invalid records before writing anything", async () => {
    const store = new FileGameStore(root);
    const record = recordFor();
    const inconsistent: GameRecord = {
      ...record,
      position: { ...record.position, fen: START_FEN }
    };

    await expect(store.append(inconsistent)).rejects.toThrow(InvalidGameRecordError);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("deletes only the selected session and is idempotent", async () => {
    const store = new FileGameStore(root);
    const first = newSessionId();
    const second = newSessionId();
    await store.append(recordFor(first, 1, ["e2e4"]));
    await store.append(recordFor(second, 1, ["d2d4"]));

    await store.delete(first);

    await expect(store.load(first)).resolves.toBeNull();
    await expect(store.exportPgn(first)).rejects.toThrow(GameNotFoundError);
    expect((await store.load(second))?.position.history).toEqual(["d2d4"]);
    await expect(store.exportPgn(second)).resolves.toContain("1. d4");

    await expect(store.delete(first)).resolves.toBeUndefined();
    expect(await recordFiles(root)).toHaveLength(1);
  });

  it("handles a missing store and missing game without inventing data", async () => {
    const store = new FileGameStore(join(root, "nested", "games"));
    const session = newSessionId();

    await expect(store.load(session)).resolves.toBeNull();
    await expect(store.exportPgn(session)).rejects.toThrow(GameNotFoundError);
    await expect(store.delete(session)).resolves.toBeUndefined();
  });

  it("rejects path-like and non-canonical session IDs", async () => {
    const store = new FileGameStore(root);
    const record = recordFor();
    const invalid = [
      "",
      ".",
      "..",
      "../escape",
      "a/b",
      "a\\b",
      "C:\\escape",
      "session",
      "00000000-0000-0000-0000-00000000000Z"
    ];

    for (const id of invalid) {
      const session = id as SessionId;
      await expect(store.load(session)).rejects.toThrow(TypeError);
      await expect(store.append({ ...record, sessionId: session })).rejects.toThrow(
        TypeError
      );
      await expect(store.exportPgn(session)).rejects.toThrow(TypeError);
      await expect(store.delete(session)).rejects.toThrow(TypeError);
    }
  });

  it("does not retain frames, images, secrets or pairing values", async () => {
    const store = new FileGameStore(root);
    const session = newSessionId();
    const record = recordFor(session);
    const poisoned = {
      ...record,
      frames: ["data:image/jpeg;base64,/9j/FRAME-SECRET"],
      rawImage: "/9j/RAW-SECRET",
      apiKey: "sk-live-SECRET",
      pairing: "PAIRING-SECRET",
      position: {
        ...record.position,
        frames: ["/9j/FRAME-SECRET"]
      }
    } as unknown as GameRecord;

    await store.append(poisoned);

    const text = await readFile(await onlyRecordFile(root), "utf8");
    for (const forbidden of [
      "FRAME-SECRET",
      "RAW-SECRET",
      "sk-live",
      "PAIRING-SECRET",
      "data:image",
      "frames",
      "rawImage",
      "apiKey",
      "pairing"
    ]) {
      expect(text).not.toContain(forbidden);
    }

    const loaded = await store.load(session);
    expect(loaded).not.toHaveProperty("frames");
    expect(loaded).not.toHaveProperty("rawImage");
    expect(loaded).not.toHaveProperty("apiKey");
    expect(loaded).not.toHaveProperty("pairing");
  });
});
