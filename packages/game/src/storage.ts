import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GamePosition, SessionId } from "@chessonglass/contracts";
import {
  InvalidGameRecordError,
  isCanonicalSessionId,
  markForResume,
  parseGameRecord,
  recordPgn,
  serializeGameRecord,
  type GameRecord,
  type ResumableGameRecord
} from "./journal.js";

export class GameNotFoundError extends Error {
  readonly sessionId: SessionId;

  constructor(sessionId: SessionId) {
    super(`no stored game for session ${sessionId}`);
    this.name = "GameNotFoundError";
    this.sessionId = sessionId;
  }
}

export class GameRecordConflictError extends Error {
  readonly sessionId: SessionId;

  constructor(sessionId: SessionId, detail: string) {
    super(`conflicting game record for session ${sessionId}: ${detail}`);
    this.name = "GameRecordConflictError";
    this.sessionId = sessionId;
  }
}

export interface GameStore {
  load(sessionId: SessionId): Promise<ResumableGameRecord | null>;
  append(record: GameRecord): Promise<void>;
  exportPgn(sessionId: SessionId): Promise<string>;
  delete(sessionId: SessionId): Promise<void>;
}

export type FileGameStoreOptions = {
  /**
   * Test seam for simulating an interrupted atomic replace. Production callers
   * omit this and use the platform rename.
   */
  renameFile?: (from: string, to: string) => Promise<void>;
};

const SESSION_DIRECTORY = "sessions";
const RECORD_SUFFIX = ".game.json";
const TEMP_SUFFIX = ".tmp";

function requireSessionId(value: unknown): SessionId {
  if (!isCanonicalSessionId(value)) {
    throw new TypeError("sessionId must be a canonical lowercase UUID");
  }
  return value;
}

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function sameGameState(left: GamePosition, right: GamePosition): boolean {
  return (
    left.initialFen === right.initialFen &&
    left.fen === right.fen &&
    left.history.length === right.history.length &&
    left.history.every((move, index) => move === right.history[index]) &&
    left.uncertainty.castlingRights === right.uncertainty.castlingRights &&
    left.uncertainty.enPassant === right.uncertainty.enPassant &&
    left.uncertainty.promotion === right.uncertainty.promotion
  );
}

/**
 * Confined, atomic game-record storage. Session IDs are canonical UUIDs and
 * are mapped to fixed SHA-256 filenames; no caller string is ever used as a
 * path component. A record is written to a sibling temporary file, synced,
 * closed, then renamed over the previous version, so a crash or a failed
 * replace can only leave the old valid record behind.
 */
export class FileGameStore implements GameStore {
  private readonly sessionsDirectory: string;
  private readonly renameFile: (from: string, to: string) => Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(rootDirectory: string, options: FileGameStoreOptions = {}) {
    if (typeof rootDirectory !== "string" || rootDirectory.trim() === "") {
      throw new TypeError("rootDirectory must be a non-empty path");
    }
    this.sessionsDirectory = join(resolve(rootDirectory), SESSION_DIRECTORY);
    this.renameFile = options.renameFile ?? rename;
  }

  async load(sessionId: SessionId): Promise<ResumableGameRecord | null> {
    const id = requireSessionId(sessionId);
    const record = await this.readStoredRecord(id);
    return record === null ? null : markForResume(record);
  }

  async append(record: GameRecord): Promise<void> {
    const sessionId = requireSessionId(record.sessionId);
    const payload = serializeGameRecord({ ...record, sessionId });
    const normalized = parseGameRecord(JSON.parse(payload));
    if (normalized === null) {
      throw new InvalidGameRecordError("serialized record failed validation");
    }
    await this.enqueue(() => this.appendExclusive(sessionId, normalized, payload));
  }

  async exportPgn(sessionId: SessionId): Promise<string> {
    const id = requireSessionId(sessionId);
    const record = await this.readStoredRecord(id);
    if (record === null) {
      throw new GameNotFoundError(id);
    }
    return recordPgn(record);
  }

  async delete(sessionId: SessionId): Promise<void> {
    const id = requireSessionId(sessionId);
    await this.enqueue(() => this.deleteExclusive(id));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async appendExclusive(
    sessionId: SessionId,
    record: GameRecord,
    payload: string
  ): Promise<void> {
    const existing = await this.readStoredRecord(sessionId);
    if (existing !== null) {
      if (record.positionVersion < existing.positionVersion) {
        throw new GameRecordConflictError(
          sessionId,
          `stored version ${existing.positionVersion} is newer than ${record.positionVersion}`
        );
      }
      if (record.positionVersion === existing.positionVersion) {
        if (sameGameState(existing.position, record.position)) {
          // Retrying the same commit is idempotent; keep the original record.
          return;
        }
        throw new GameRecordConflictError(
          sessionId,
          `version ${record.positionVersion} already describes another position`
        );
      }
    }

    await this.atomicWrite(sessionId, payload);
  }

  private async deleteExclusive(sessionId: SessionId): Promise<void> {
    const base = this.recordFileName(sessionId);
    let entries: string[];
    try {
      entries = await readdir(this.sessionsDirectory);
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }

    const targets = entries.filter(
      (entry) =>
        entry === base ||
        (entry.startsWith(`${base}.`) && entry.endsWith(TEMP_SUFFIX))
    );
    await Promise.all(
      targets.map((entry) =>
        rm(join(this.sessionsDirectory, entry), { force: true })
      )
    );
  }

  private async readStoredRecord(
    sessionId: SessionId
  ): Promise<GameRecord | null> {
    const path = this.recordPath(sessionId);

    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
    // `lstat` does not follow links: a symlink, directory or device at the
    // record path is never loaded as a game.
    if (!stats.isFile()) {
      return null;
    }

    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }

    const record = parseGameRecord(value);
    if (record === null || record.sessionId !== sessionId) {
      return null;
    }
    return record;
  }

  private async atomicWrite(
    sessionId: SessionId,
    payload: string
  ): Promise<void> {
    await mkdir(this.sessionsDirectory, { recursive: true });

    const destination = this.recordPath(sessionId);
    const temporary = join(
      this.sessionsDirectory,
      `${this.recordFileName(sessionId)}.${randomUUID()}${TEMP_SUFFIX}`
    );

    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }

    try {
      await this.renameFile(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private recordFileName(sessionId: SessionId): string {
    const digest = createHash("sha256").update(sessionId, "utf8").digest("hex");
    return `${digest}${RECORD_SUFFIX}`;
  }

  private recordPath(sessionId: SessionId): string {
    return join(this.sessionsDirectory, this.recordFileName(sessionId));
  }
}
