import { describe, expect, it } from "vitest";
import {
  newSessionId,
  newSourceId,
  type Frame,
  type SessionId,
  type SourceId
} from "@chessonglass/contracts";
import {
  BrowserFrameSource,
  type BrowserFrameUpload
} from "../../src/sources/browser-frame-source.js";

function frame(
  sessionId: SessionId,
  sourceId: SourceId,
  sequence: bigint
): Frame {
  return {
    sessionId,
    sourceId,
    sequence,
    capturedAtMonotonicMs: null,
    capturedAtWallMs: 1_700_000_000_000 + Number(sequence),
    receivedAtMonotonicMs: 500 + Number(sequence),
    bytes: new Uint8Array([0xff, 0xd8, 0xff, Number(sequence)]),
    mimeType: "image/jpeg"
  };
}

function upload(frameValue: Frame): BrowserFrameUpload {
  return { frame: frameValue, clientCapturedAtMonotonicMs: 123 };
}

describe("BrowserFrameSource", () => {
  it("keeps only the newest offered frame (capacity one)", async () => {
    const sessionId = newSessionId();
    const sourceId = newSourceId();
    const source = new BrowserFrameSource(sessionId, sourceId);

    expect(source.accept(upload(frame(sessionId, sourceId, 1n)))).toBe("accepted");
    expect(source.accept(upload(frame(sessionId, sourceId, 2n)))).toBe("accepted");
    expect(source.accept(upload(frame(sessionId, sourceId, 3n)))).toBe("accepted");

    const next = await source.next(new AbortController().signal);
    expect(next?.sequence).toBe(3n);
    expect(source.capabilities.video).toBe(true);
    expect(source.capabilities.microphone).toBe(false);

    await source.close();
  });

  it("reports duplicate and out-of-order sequences", async () => {
    const sessionId = newSessionId();
    const sourceId = newSourceId();
    const source = new BrowserFrameSource(sessionId, sourceId);

    expect(source.accept(upload(frame(sessionId, sourceId, 2n)))).toBe("accepted");
    expect(source.accept(upload(frame(sessionId, sourceId, 2n)))).toBe("duplicate");
    expect(source.accept(upload(frame(sessionId, sourceId, 1n)))).toBe("out-of-order");

    await source.close();
  });

  it("releases waiting consumers on close and rejects later offers", async () => {
    const sessionId = newSessionId();
    const sourceId = newSourceId();
    const source = new BrowserFrameSource(sessionId, sourceId);

    const waiting = source.next(new AbortController().signal);
    await source.close();

    await expect(waiting).resolves.toBeNull();
    expect(source.accept(upload(frame(sessionId, sourceId, 1n)))).toBe("closed");
  });

  it("resolves null when the consumer signal is already aborted", async () => {
    const source = new BrowserFrameSource(newSessionId(), newSourceId());
    const controller = new AbortController();
    controller.abort();

    await expect(source.next(controller.signal)).resolves.toBeNull();
    await source.close();
  });
});
