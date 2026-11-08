import { describe, expect, it } from "vitest";
import {
  newSessionId,
  newSourceId,
  type Frame,
  type SessionId,
  type SourceId
} from "@chessonglass/contracts";
import {
  PeriodicFullReadFilter,
  inspectWithPreFilter,
  type PreFilter
} from "@chessonglass/perception";

function frame(
  sessionId: SessionId,
  sourceId: SourceId,
  sequence: bigint,
  bytes: Uint8Array = new Uint8Array([1, 2, 3])
): Frame {
  return {
    sessionId,
    sourceId,
    sequence,
    capturedAtMonotonicMs: null,
    capturedAtWallMs: 1_700_000_000_000,
    receivedAtMonotonicMs: Number(sequence),
    bytes,
    mimeType: "image/jpeg"
  };
}

describe("optional pre-filter gate", () => {
  it("reads when no local gate is configured", async () => {
    const session = newSessionId();
    const source = newSourceId();

    await expect(inspectWithPreFilter(null, frame(session, source, 0n), null)).resolves.toBe(
      "read"
    );
    await expect(
      inspectWithPreFilter(undefined, frame(session, source, 0n), null)
    ).resolves.toBe("read");
  });

  it("falls back to a full read when the local gate fails", async () => {
    const broken: PreFilter = {
      async inspect() {
        throw new Error("local detector failed");
      }
    };

    await expect(
      inspectWithPreFilter(
        broken,
        frame(newSessionId(), newSourceId(), 0n),
        null
      )
    ).resolves.toBe("read");
  });
});

describe("PeriodicFullReadFilter", () => {
  it("reads the first frame and any frame whose bytes changed", async () => {
    const filter = new PeriodicFullReadFilter(2);
    const session = newSessionId();
    const source = newSourceId();
    const reference = frame(session, source, 1n, new Uint8Array([1, 2, 3]));

    await expect(
      filter.inspect(frame(session, source, 2n, new Uint8Array([1, 2, 3])), reference)
    ).resolves.toBe("wait");

    const changed = frame(session, source, 3n, new Uint8Array([1, 2, 4]));
    await expect(filter.inspect(changed, reference)).resolves.toBe("read");

    // A changed frame resets the consecutive-wait counter.
    await expect(
      filter.inspect(frame(session, source, 4n, new Uint8Array([1, 2, 4])), changed)
    ).resolves.toBe("wait");
  });

  it("forces a full read after the configured number of consecutive waits", async () => {
    const filter = new PeriodicFullReadFilter(2);
    const session = newSessionId();
    const source = newSourceId();
    const reference = frame(session, source, 1n, new Uint8Array([9, 9, 9]));
    const same = frame(session, source, 2n, new Uint8Array([9, 9, 9]));

    await expect(filter.inspect(same, reference)).resolves.toBe("wait");
    await expect(filter.inspect(same, reference)).resolves.toBe("wait");
    await expect(filter.inspect(same, reference)).resolves.toBe("read");

    // The forced read resets the counter.
    await expect(filter.inspect(same, reference)).resolves.toBe("wait");
  });

  it("reads when the session or source identity changed", async () => {
    const filter = new PeriodicFullReadFilter(2);
    const session = newSessionId();
    const source = newSourceId();
    const bytes = new Uint8Array([5, 5, 5]);
    const reference = frame(session, source, 1n, bytes);

    await expect(
      filter.inspect(frame(session, newSourceId(), 2n, bytes), reference)
    ).resolves.toBe("read");
    await expect(
      filter.inspect(frame(newSessionId(), source, 2n, bytes), reference)
    ).resolves.toBe("read");
  });

  it("surfaces a pending confirmation instead of skipping it", async () => {
    const filter = new PeriodicFullReadFilter(3);
    const session = newSessionId();
    const source = newSourceId();
    const reference = frame(session, source, 1n, new Uint8Array([7, 7, 7]));
    const same = frame(session, source, 2n, new Uint8Array([7, 7, 7]));

    filter.setPendingConfirmation(true);
    await expect(filter.inspect(same, reference)).resolves.toBe("uncertain");
    // Even an otherwise-"first read" call cannot skip the prompt.
    await expect(filter.inspect(same, null)).resolves.toBe("uncertain");

    filter.setPendingConfirmation(false);
    await expect(filter.inspect(same, reference)).resolves.toBe("wait");
  });

  it("rejects invalid wait settings", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => new PeriodicFullReadFilter(value)).toThrow();
    }
  });
});
