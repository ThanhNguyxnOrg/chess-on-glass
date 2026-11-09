import { describe, expect, it } from "vitest";
import { newSessionId, newSourceId } from "@chessonglass/contracts";
import {
  WindowsScreenSource,
  type NativeCaptureFrame,
  type NativeCaptureSession
} from "../../src/sources/windows-screen-source.js";

class ManualSession implements NativeCaptureSession {
  started = 0;
  stopped = 0;
  private readonly queue: NativeCaptureFrame[] = [];
  private readonly waiters: Array<(frame: NativeCaptureFrame | undefined) => void> = [];
  private ended = false;

  async start(): Promise<void> {
    this.started += 1;
  }

  push(frame: NativeCaptureFrame): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(frame);
      return;
    }
    this.queue.push(frame);
  }

  nextFrame(): Promise<NativeCaptureFrame | undefined> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.ended) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(undefined);
    }
  }
}

function frame(width = 640, height = 480): NativeCaptureFrame {
  return { width, height, encode: () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

describe("WindowsScreenSource", () => {
  it("starts the native session and delivers frames in order", async () => {
    const session = new ManualSession();
    const sessionId = newSessionId();
    const sourceId = newSourceId();
    const opening = WindowsScreenSource.open({
      sessionId,
      sourceId,
      session,
      encodeJpeg: async () => JPEG,
      now: () => 5_000
    });

    session.push(frame());
    const source = await opening;
    expect(session.started).toBe(1);

    const first = await source.next(new AbortController().signal);
    expect(first?.sessionId).toBe(sessionId);
    expect(first?.sourceId).toBe(sourceId);
    expect(first?.sequence).toBe(1n);
    expect(first?.capturedAtMonotonicMs).toBeNull();
    expect(first?.receivedAtMonotonicMs).toBe(5_000);
    expect(first?.mimeType).toBe("image/jpeg");

    session.push(frame());
    const second = await source.next(new AbortController().signal);
    expect(second?.sequence).toBe(2n);

    await source.close();
    expect(session.stopped).toBe(1);
  });

  it("returns null at stream end and after close", async () => {
    const session = new ManualSession();
    const opening = WindowsScreenSource.open({
      sessionId: newSessionId(),
      sourceId: newSourceId(),
      session,
      encodeJpeg: async () => JPEG
    });
    session.push(frame());
    const source = await opening;

    // The frame produced before the stream ends is still deliverable.
    await expect(source.next(new AbortController().signal)).resolves.not.toBeNull();
    await session.stop();
    await expect(source.next(new AbortController().signal)).resolves.toBeNull();

    await source.close();
    await source.close();
    expect(session.stopped).toBe(2);
  });

  it("fails closed when the first frame never arrives", async () => {
    const session = new ManualSession();
    await expect(
      WindowsScreenSource.open({
        sessionId: newSessionId(),
        sourceId: newSourceId(),
        session,
        encodeJpeg: async () => JPEG,
        firstFrameTimeoutMs: 20
      })
    ).rejects.toThrow(/first frame/i);
    expect(session.stopped).toBe(1);
  });

  it("resolves null when the consumer aborts", async () => {
    const session = new ManualSession();
    const opening = WindowsScreenSource.open({
      sessionId: newSessionId(),
      sourceId: newSourceId(),
      session,
      encodeJpeg: async () => JPEG
    });
    session.push(frame());
    const source = await opening;
    await source.next(new AbortController().signal);

    const controller = new AbortController();
    controller.abort();
    await expect(source.next(controller.signal)).resolves.toBeNull();

    await source.close();
  });
});
