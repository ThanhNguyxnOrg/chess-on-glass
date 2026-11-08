import { describe, expect, it } from "vitest";
import {
  LatestFrameMailbox,
  newSessionId,
  newSourceId,
  type Frame,
  type SessionId,
  type SourceId
} from "@chessonglass/contracts";

function frame(
  sessionId: SessionId,
  sourceId: SourceId,
  sequence: bigint,
  byteLength = 4
): Frame {
  return {
    sessionId,
    sourceId,
    sequence,
    capturedAtMonotonicMs: null,
    capturedAtWallMs: 1_700_000_000_000,
    receivedAtMonotonicMs: 1_000,
    bytes: new Uint8Array(byteLength),
    mimeType: "image/jpeg"
  };
}

describe("LatestFrameMailbox ordering", () => {
  it("rejects duplicate and descending sequence per source", () => {
    const session = newSessionId();
    const source = newSourceId();
    const mailbox = new LatestFrameMailbox();

    expect(mailbox.offer(frame(session, source, 0n))).toBe("accepted");
    expect(mailbox.offer(frame(session, source, 1n))).toBe("accepted");
    expect(mailbox.offer(frame(session, source, 1n))).toBe("duplicate");
    expect(mailbox.offer(frame(session, source, 0n))).toBe("out-of-order");

    mailbox.close();
  });

  it("keeps ordering state independent across sources", () => {
    const session = newSessionId();
    const first = newSourceId();
    const second = newSourceId();
    const mailbox = new LatestFrameMailbox();

    expect(mailbox.offer(frame(session, first, 5n))).toBe("accepted");
    expect(mailbox.offer(frame(session, second, 2n))).toBe("accepted");
    expect(mailbox.offer(frame(session, first, 3n))).toBe("out-of-order");
    expect(mailbox.offer(frame(session, second, 3n))).toBe("accepted");

    mailbox.close();
  });

  it("treats a repeated frozen frame as stale even after delivery", async () => {
    const session = newSessionId();
    const source = newSourceId();
    const mailbox = new LatestFrameMailbox();
    const signal = new AbortController().signal;

    expect(mailbox.offer(frame(session, source, 7n))).toBe("accepted");
    const delivered = await mailbox.next(signal);
    expect(delivered?.sequence).toBe(7n);
    expect(mailbox.offer(frame(session, source, 7n))).toBe("duplicate");

    mailbox.close();
  });
});

describe("LatestFrameMailbox latest-wins delivery", () => {
  it("replaces an unread older frame with the newer one", async () => {
    const session = newSessionId();
    const source = newSourceId();
    const mailbox = new LatestFrameMailbox();

    mailbox.offer(frame(session, source, 0n));
    mailbox.offer(frame(session, source, 1n));

    const delivered = await mailbox.next(new AbortController().signal);
    expect(delivered?.sequence).toBe(1n);

    mailbox.close();
  });

  it("wakes exactly one waiter per offered frame", async () => {
    const session = newSessionId();
    const source = newSourceId();
    const mailbox = new LatestFrameMailbox();
    const controller = new AbortController();

    let secondSettled = false;
    const firstPromise = mailbox.next(controller.signal);
    const secondPromise = mailbox.next(controller.signal).then((value) => {
      secondSettled = true;
      return value;
    });

    mailbox.offer(frame(session, source, 1n));
    await expect(firstPromise).resolves.toMatchObject({ sequence: 1n });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    mailbox.close();
    await expect(secondPromise).resolves.toBeNull();
  });

  it("rejects frames larger than the configured byte ceiling", async () => {
    const session = newSessionId();
    const source = newSourceId();
    const mailbox = new LatestFrameMailbox();

    expect(mailbox.offer(frame(session, source, 0n, 1_048_577))).toBe("too-large");
    expect(mailbox.offer(frame(session, source, 0n, 1_048_576))).toBe("accepted");

    const delivered = await mailbox.next(new AbortController().signal);
    expect(delivered?.bytes.byteLength).toBe(1_048_576);

    mailbox.close();
  });
});

describe("LatestFrameMailbox shutdown", () => {
  it("returns null immediately when the signal is already aborted", async () => {
    const mailbox = new LatestFrameMailbox();
    const controller = new AbortController();
    controller.abort();

    await expect(mailbox.next(controller.signal)).resolves.toBeNull();
    mailbox.close();
  });

  it("aborts a pending next promptly", async () => {
    const mailbox = new LatestFrameMailbox();
    const controller = new AbortController();
    const pending = mailbox.next(controller.signal);

    controller.abort();
    await expect(pending).resolves.toBeNull();
    mailbox.close();
  });

  it("close wakes every waiter with null and refuses later offers", async () => {
    const mailbox = new LatestFrameMailbox();
    const controller = new AbortController();
    const first = mailbox.next(controller.signal);
    const second = mailbox.next(controller.signal);

    mailbox.close();

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(() => mailbox.offer(frame(newSessionId(), newSourceId(), 0n))).toThrow();
  });
});
