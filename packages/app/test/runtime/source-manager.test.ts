import { describe, expect, it } from "vitest";
import {
  newSessionId,
  newSourceId,
  type Frame,
  type FrameSource,
  type GamePosition,
  type SessionId
} from "@chessonglass/contracts";
import { SourceManager } from "../../src/runtime/source-manager.js";

class ManualSource implements FrameSource {
  readonly capabilities = Object.freeze({
    video: true,
    microphone: false,
    audioOutput: false,
    display: false
  });
  closeCalls = 0;

  constructor(readonly sessionId: SessionId, readonly sourceId: string) {}

  next(): Promise<Frame | null> {
    return Promise.resolve(null);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function startPosition(): GamePosition {
  return {
    initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    history: [],
    uncertainty: { castlingRights: false, enPassant: false, promotion: false }
  };
}

describe("SourceManager", () => {
  it("starts a source, allocates a session and reports the active source", async () => {
    const manager = new SourceManager();
    const source = new ManualSource(newSessionId(), newSourceId());
    await manager.start(source, startPosition());

    expect(manager.active).not.toBeNull();
    expect(manager.active?.sessionId).toBe(source.sessionId);
    expect(manager.active?.sourceId).toBe(source.sourceId);

    await manager.close();
  });

  it("replaces the source: new session, old source closed, single active", async () => {
    const manager = new SourceManager();
    const first = new ManualSource(newSessionId(), newSourceId());
    await manager.start(first, startPosition());

    const second = new ManualSource(newSessionId(), newSourceId());
    await manager.replaceSource(second, startPosition());

    expect(first.closeCalls).toBe(1);
    expect(manager.active?.sessionId).toBe(second.sessionId);
    expect(manager.active?.sessionId).not.toBe(first.sessionId);

    await manager.close();
  });

  it("keeps the old source when the replacement throws", async () => {
    const manager = new SourceManager();
    const first = new ManualSource(newSessionId(), newSourceId());
    await manager.start(first, startPosition());

    class BrokenSource extends ManualSource {
      async close(): Promise<void> {
        throw new Error("close failed");
      }
    }
    const broken = new BrokenSource(newSessionId(), newSourceId());
    await manager.replaceSource(broken, startPosition());

    expect(manager.active?.sessionId).not.toBe(first.sessionId);
    await manager.close();
  });

  it("close is idempotent and closes the active source once", async () => {
    const manager = new SourceManager();
    const source = new ManualSource(newSessionId(), newSourceId());
    await manager.start(source, startPosition());

    await manager.close();
    await manager.close();
    expect(source.closeCalls).toBe(1);
    expect(manager.active).toBeNull();
  });
});
