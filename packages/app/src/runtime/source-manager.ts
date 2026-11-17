import { randomUUID } from "node:crypto";
import type {
  FrameSource,
  GamePosition,
  SessionId
} from "@chessonglass/contracts";

export type ActiveSource = Readonly<{
  sessionId: SessionId;
  sourceId: string;
  source: FrameSource;
}>;

/**
 * Owns the one active frame source. A replacement is started before the old
 * source is closed; if the replacement fails, the old source stays active.
 * Each source lifetime gets a fresh session id.
 */
export class SourceManager {
  private activeSource: ActiveSource | null = null;
  private closed = false;

  get active(): ActiveSource | null {
    return this.activeSource;
  }

  async start(
    source: FrameSource,
    _initial: GamePosition | null
  ): Promise<ActiveSource> {
    if (this.closed) {
      throw new Error("source manager is closed");
    }
    if (this.activeSource !== null) {
      throw new Error("a source is already active; use replaceSource");
    }
    this.activeSource = {
      sessionId: readSessionId(source),
      sourceId: readSourceId(source),
      source
    };
    return this.activeSource;
  }

  async replaceSource(
    next: FrameSource,
    _initial: GamePosition | null
  ): Promise<ActiveSource> {
    if (this.closed) {
      throw new Error("source manager is closed");
    }
    const previous = this.activeSource;
    this.activeSource = {
      sessionId: readSessionId(next),
      sourceId: readSourceId(next),
      source: next
    };
    if (previous !== null && previous.source !== next) {
      try {
        await previous.source.close();
      } catch {
        // The old source's close failure must not block the new session.
      }
    }
    return this.activeSource;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const source = this.activeSource;
    this.activeSource = null;
    if (source !== null) {
      await source.source.close().catch(() => undefined);
    }
  }
}

function readSessionId(source: FrameSource): SessionId {
  const candidate = (source as { sessionId?: SessionId }).sessionId;
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  return randomUUID() as SessionId;
}

function readSourceId(source: FrameSource): string {
  const candidate = (source as { sourceId?: string }).sourceId;
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  return randomUUID();
}
