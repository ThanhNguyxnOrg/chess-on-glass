import { describe, expect, it } from "vitest";
import {
  FreshnessAwareBoardLocator,
  GeometryState,
  type BoardLocatorProvider,
  type LocatedBoard,
  type LocatorLedger,
  type LocatorPrice
} from "@chessonglass/perception";
import {
  newSessionId,
  newSourceId,
  type Frame,
  type RequestContext
} from "@chessonglass/contracts";

const PRICE: LocatorPrice = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  effectiveAt: "2026-01-01T00:00:00.000Z"
};

const SESSION = newSessionId();
const SOURCE = newSourceId();

/** Axis-aligned board inside an 800x800 image; fits a valid homography. */
const VALID_BOARD: LocatedBoard = {
  corners: {
    nearLeft: [100, 700],
    nearRight: [700, 700],
    farRight: [700, 100],
    farLeft: [100, 100]
  },
  imageWidth: 800,
  imageHeight: 800,
  inlierRatio: 0.95,
  reprojectionErrorPx: 1.5,
  usage: { inputTokens: 120, outputTokens: 14 }
};

function frame(
  sequence: bigint,
  receivedAtMonotonicMs: number,
  overrides: Partial<Frame> = {}
): Frame {
  return {
    sessionId: SESSION,
    sourceId: SOURCE,
    sequence,
    capturedAtMonotonicMs: null,
    capturedAtWallMs: 0,
    receivedAtMonotonicMs,
    bytes: new Uint8Array([0]),
    mimeType: "image/jpeg",
    ...overrides
  };
}

function context(requestId: string, overrides: Partial<RequestContext> = {}): RequestContext {
  return { requestId, sessionId: SESSION, positionVersion: 1, referenceSequence: null, ...overrides };
}

class FakeLedger implements LocatorLedger {
  allowed = true;
  reason: string | null = null;
  readonly reserved: string[] = [];
  readonly settled: Array<Readonly<{ requestId: string; inputTokens: number; outputTokens: number }>> = [];
  readonly released: string[] = [];

  reserve(requestId: string): { allowed: boolean; reason: string | null } {
    if (!this.allowed) {
      return { allowed: false, reason: this.reason };
    }
    this.reserved.push(requestId);
    return { allowed: true, reason: null };
  }

  settle(requestId: string, inputTokens: number, outputTokens: number): void {
    this.settled.push({ requestId, inputTokens, outputTokens });
  }

  release(requestId: string): void {
    this.released.push(requestId);
  }
}

/** A provider whose answers are held back until the test releases them, in call order. */
type Gate = {
  provider: BoardLocatorProvider;
  calls: Frame[];
  resolve(board: LocatedBoard | null): void;
  fail(error: unknown): void;
};

function gatedProvider(): Gate {
  const calls: Frame[] = [];
  const queue: Array<{
    resolve: (board: LocatedBoard | null) => void;
    reject: (error: unknown) => void;
  }> = [];
  return {
    provider: {
      locate(input: { frame: Frame; signal: AbortSignal }): Promise<LocatedBoard | null> {
        calls.push(input.frame);
        return new Promise((resolve, reject) => {
          queue.push({ resolve, reject });
        });
      }
    },
    calls,
    resolve(board: LocatedBoard | null): void {
      const gate = queue.shift();
      if (gate === undefined) {
        throw new Error("no pending locator call to resolve");
      }
      gate.resolve(board);
    },
    fail(error: unknown): void {
      const gate = queue.shift();
      if (gate === undefined) {
        throw new Error("no pending locator call to fail");
      }
      gate.reject(error);
    }
  };
}

function staticProvider(
  board: LocatedBoard | null,
  error: Error | null = null
): BoardLocatorProvider & { calls: Frame[] } {
  const calls: Frame[] = [];
  return {
    calls,
    async locate(input: { frame: Frame; signal: AbortSignal }): Promise<LocatedBoard | null> {
      calls.push(input.frame);
      if (error !== null) {
        throw error;
      }
      return board;
    }
  };
}

function harness(options: {
  provider: BoardLocatorProvider;
  ledger?: FakeLedger | null;
  state?: GeometryState | null;
  maxAnswerAgeMs?: number;
  nowMs?: () => number;
}): { locator: FreshnessAwareBoardLocator; ledger: FakeLedger; state: GeometryState } {
  const ledger = options.ledger === undefined ? new FakeLedger() : options.ledger;
  const state = options.state === undefined ? new GeometryState({ lifetimeMs: 1000 }) : options.state;
  const locator = new FreshnessAwareBoardLocator({
    provider: options.provider,
    ledger,
    price: PRICE,
    state,
    maxAnswerAgeMs: options.maxAnswerAgeMs ?? 250,
    nowMs: options.nowMs ?? (() => 0)
  });
  return { locator, ledger, state };
}

describe("FreshnessAwareBoardLocator happy path", () => {
  it("returns fresh geometry for the active request and updates the wired state", async () => {
    const provider = staticProvider(VALID_BOARD);
    const { locator, ledger, state } = harness({ provider });
    const result = await locator.locate({
      frame: frame(5n, 0),
      context: context("req-1"),
      signal: new AbortController().signal
    });
    expect(result).not.toBeNull();
    expect(result?.confidence).toEqual({
      inlierRatio: 0.95,
      reprojectionErrorPx: 1.5,
      observedSequence: 5n
    });
    expect(state.current(0)).toEqual({ transform: result?.transform, sequence: 5n });
    expect(ledger.reserved).toEqual(["req-1"]);
    expect(ledger.settled).toEqual([{ requestId: "req-1", inputTokens: 120, outputTokens: 14 }]);
    expect(ledger.released).toEqual([]);
    expect(locator.lastRejection()).toBeNull();
  });

  it("keeps working without a ledger or state (locator-only mode)", async () => {
    const provider = staticProvider(VALID_BOARD);
    const locator = new FreshnessAwareBoardLocator({
      provider,
      maxAnswerAgeMs: 250,
      nowMs: () => 0
    });
    const result = await locator.locate({
      frame: frame(5n, 0),
      context: context("req-1"),
      signal: new AbortController().signal
    });
    expect(result).not.toBeNull();
  });

  it("returns null and records why when no provider is configured", async () => {
    const locator = new FreshnessAwareBoardLocator({ maxAnswerAgeMs: 250, nowMs: () => 0 });
    const result = await locator.locate({
      frame: frame(5n, 0),
      context: context("req-1"),
      signal: new AbortController().signal
    });
    expect(result).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "no-provider" });
  });

  it("lets fresh geometry render until the state's documented expiry", async () => {
    const provider = staticProvider(VALID_BOARD);
    const state = new GeometryState({ lifetimeMs: 100 });
    const locator = new FreshnessAwareBoardLocator({
      provider,
      state,
      maxAnswerAgeMs: 250,
      nowMs: () => 0
    });
    await locator.locate({
      frame: frame(5n, 0),
      context: context("req-1"),
      signal: new AbortController().signal
    });
    expect(state.current(50)).not.toBeNull();
    expect(state.current(100)).not.toBeNull();
    expect(state.current(101)).toBeNull();
  });
});

describe("FreshnessAwareBoardLocator request identity", () => {
  it("drops a late answer whose request was reset and leaves the state alone", async () => {
    const gate = gatedProvider();
    const { locator, ledger, state } = harness({ provider: gate.provider });
    const signal = new AbortController().signal;
    // Establish geometry for the original request first.
    const established = locator.locate({ frame: frame(1n, 0), context: context("req-1"), signal });
    gate.resolve(VALID_BOARD);
    await established;
    // The stale request's answer arrives after the app reset to a new context.
    const stale = locator.locate({ frame: frame(2n, 0), context: context("req-1"), signal });
    locator.reset(context("req-2"));
    gate.resolve(VALID_BOARD);
    expect(await stale).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "context-mismatch" });
    // Never rendered: the geometry from before the reset is still the current one.
    expect(state.current(0)).toEqual({ sequence: 1n, transform: expect.anything() });
    expect(state.lastInvalidation()).toBeNull();
    // Incurred cost is settled for its own request, never as new work for req-2.
    expect(ledger.settled.map((entry) => entry.requestId)).toEqual(["req-1", "req-1"]);
    // The locator still serves the new request once the stale answer drained.
    const fresh = locator.locate({ frame: frame(3n, 0), context: context("req-2"), signal });
    gate.resolve(VALID_BOARD);
    expect(await fresh).not.toBeNull();
    expect(state.current(0)).toEqual({ sequence: 3n, transform: expect.anything() });
  });

  const CONTEXT_FIELDS: Array<readonly [string, Partial<RequestContext>]> = [
    ["requestId", { requestId: "req-9" }],
    ["sessionId", { sessionId: newSessionId() }],
    ["positionVersion", { positionVersion: 2 }],
    ["referenceSequence", { referenceSequence: 7n }]
  ];
  CONTEXT_FIELDS.forEach(([field, override]) => {
    it(`drops the answer after reset changes the context's ${field}`, async () => {
      const gate = gatedProvider();
      const { locator, state } = harness({ provider: gate.provider });
      const signal = new AbortController().signal;
      const established = locator.locate({ frame: frame(1n, 0), context: context("req-1"), signal });
      gate.resolve(VALID_BOARD);
      await established;
      const stale = locator.locate({ frame: frame(2n, 0), context: context("req-1"), signal });
      locator.reset(context("req-2", override));
      gate.resolve(VALID_BOARD);
      expect(await stale).toBeNull();
      expect(locator.lastRejection()).toMatchObject({ code: "context-mismatch" });
      expect(state.lastInvalidation()).toBeNull();
    });
  });

  it("keeps the answer when reset re-states the same context", async () => {
    const gate = gatedProvider();
    const { locator, state } = harness({ provider: gate.provider });
    const signal = new AbortController().signal;
    const pending = locator.locate({ frame: frame(1n, 0), context: context("req-1"), signal });
    locator.reset(context("req-1"));
    gate.resolve(VALID_BOARD);
    expect(await pending).not.toBeNull();
    expect(state.current(0)).not.toBeNull();
  });

  it("enforces a single in-flight locator call", async () => {
    const gate = gatedProvider();
    const { locator, ledger } = harness({ provider: gate.provider });
    const signal = new AbortController().signal;
    const first = locator.locate({ frame: frame(1n, 0), context: context("req-1"), signal });
    const second = await locator.locate({ frame: frame(2n, 0), context: context("req-2"), signal });
    expect(second).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "busy" });
    expect(gate.calls).toHaveLength(1);
    expect(ledger.reserved).toEqual(["req-1"]);
    gate.resolve(VALID_BOARD);
    expect(await first).not.toBeNull();
  });
});

describe("FreshnessAwareBoardLocator budget and cancellation", () => {
  it("does not start provider work when the budget reservation is refused", async () => {
    const provider = staticProvider(VALID_BOARD);
    const ledger = new FakeLedger();
    ledger.allowed = false;
    ledger.reason = "estimated budget exhausted";
    const { locator, state } = harness({ provider, ledger });
    const result = await locator.locate({
      frame: frame(5n, 0),
      context: context("req-1"),
      signal: new AbortController().signal
    });
    expect(result).toBeNull();
    expect(locator.lastRejection()).toEqual({
      code: "budget-denied",
      message: "estimated budget exhausted"
    });
    expect(provider.calls).toHaveLength(0);
    expect(ledger.reserved).toHaveLength(0);
    expect(state.lastInvalidation()).toBeNull();
  });

  it("reports cancellation without reserving when the signal is already aborted", async () => {
    const provider = staticProvider(VALID_BOARD);
    const { locator, ledger } = harness({ provider });
    const controller = new AbortController();
    controller.abort();
    const result = await locator.locate({
      frame: frame(5n, 0),
      context: context("req-1"),
      signal: controller.signal
    });
    expect(result).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "cancelled" });
    expect(ledger.reserved).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("releases the reservation when cancelled mid-flight", async () => {
    const gate = gatedProvider();
    const { locator, ledger, state } = harness({ provider: gate.provider });
    const controller = new AbortController();
    const pending = locator.locate({
      frame: frame(1n, 0),
      context: context("req-1"),
      signal: controller.signal
    });
    controller.abort();
    gate.fail(new Error("aborted"));
    expect(await pending).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "cancelled" });
    expect(ledger.reserved).toEqual(["req-1"]);
    expect(ledger.released).toEqual(["req-1"]);
    expect(ledger.settled).toHaveLength(0);
    expect(state.lastInvalidation()).toBeNull();
  });

  it("releases the reservation and sanitizes provider failure messages", async () => {
    const provider = staticProvider(null, new Error("503 upstream at sk-live-SECRET"));
    const { locator, ledger, state } = harness({ provider });
    const result = await locator.locate({
      frame: frame(5n, 0),
      context: context("req-1"),
      signal: new AbortController().signal
    });
    expect(result).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "provider-failed" });
    expect(locator.lastRejection()?.message).not.toContain("sk-live-SECRET");
    expect(ledger.released).toEqual(["req-1"]);
    expect(state.lastInvalidation()).toBeNull();
  });

  it("voids an answer whose usage report is malformed instead of settling it", async () => {
    const badUsage: LocatedBoard = {
      ...VALID_BOARD,
      usage: { inputTokens: -1, outputTokens: 14 }
    };
    const provider = staticProvider(badUsage);
    const { locator, ledger } = harness({ provider });
    const result = await locator.locate({
      frame: frame(5n, 0),
      context: context("req-1"),
      signal: new AbortController().signal
    });
    expect(result).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "provider-failed" });
    expect(ledger.settled).toHaveLength(0);
    expect(ledger.released).toEqual(["req-1"]);
  });
});

describe("FreshnessAwareBoardLocator board visibility and answer freshness", () => {
  it("invalidates and returns null when the board leaves view or tracking is lost", async () => {
    const provider = staticProvider(null);
    const { locator, ledger, state } = harness({ provider });
    const result = await locator.locate({
      frame: frame(5n, 0),
      context: context("req-1"),
      signal: new AbortController().signal
    });
    expect(result).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "no-board" });
    expect(state.lastInvalidation()).toMatchObject({
      reason: "board-not-visible",
      clearedSequence: null
    });
    expect(state.current(0)).toBeNull();
    // No board means no provider charge to reconcile.
    expect(ledger.settled).toHaveLength(0);
    expect(ledger.released).toEqual(["req-1"]);
  });

  it("drops an answer older than its allowed lifetime and invalidates", async () => {
    const gate = gatedProvider();
    let now = 0;
    const { locator, ledger, state } = harness({ provider: gate.provider, nowMs: () => now });
    const pending = locator.locate({
      frame: frame(1n, 0),
      context: context("req-1"),
      signal: new AbortController().signal
    });
    now = 400; // beyond maxAnswerAgeMs = 250
    gate.resolve(VALID_BOARD);
    expect(await pending).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "answer-expired" });
    expect(state.lastInvalidation()).toMatchObject({
      reason: "locator-answer-expired",
      clearedSequence: null
    });
    // The provider call still cost money: settled honestly for its own request.
    expect(ledger.settled).toHaveLength(1);
  });

  it("accepts an answer exactly at its lifetime boundary", async () => {
    const gate = gatedProvider();
    let now = 0;
    const { locator, state } = harness({ provider: gate.provider, nowMs: () => now });
    const pending = locator.locate({
      frame: frame(1n, 0),
      context: context("req-1"),
      signal: new AbortController().signal
    });
    now = 250;
    gate.resolve(VALID_BOARD);
    expect(await pending).not.toBeNull();
    expect(state.current(250)).not.toBeNull();
  });
});

describe("FreshnessAwareBoardLocator geometry quality", () => {
  it("invalidates and returns null when the coordinates cannot fit a homography", async () => {
    const degenerate: LocatedBoard = {
      ...VALID_BOARD,
      corners: { ...VALID_BOARD.corners, nearRight: [100, 700] }
    };
    const provider = staticProvider(degenerate);
    const { locator, ledger, state } = harness({ provider });
    const result = await locator.locate({
      frame: frame(5n, 0),
      context: context("req-1"),
      signal: new AbortController().signal
    });
    expect(result).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "invalid-geometry" });
    expect(state.lastInvalidation()).toMatchObject({
      reason: "locator-geometry-invalid",
      clearedSequence: null
    });
    expect(ledger.settled).toHaveLength(1); // the detector call still cost money
  });

  it("invalidates and returns null when the coordinates are not finite", async () => {
    const nonFinite: LocatedBoard = {
      ...VALID_BOARD,
      corners: {
        nearLeft: [Number.NaN, 700],
        nearRight: [700, 700],
        farRight: [700, 100],
        farLeft: [100, 100]
      }
    };
    const provider = staticProvider(nonFinite);
    const { locator, state } = harness({ provider });
    const result = await locator.locate({
      frame: frame(5n, 0),
      context: context("req-1"),
      signal: new AbortController().signal
    });
    expect(result).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "invalid-geometry" });
    expect(state.lastInvalidation()).toMatchObject({ reason: "locator-geometry-invalid" });
  });

  it("invalidates and returns null when the answer fails the confidence policy", async () => {
    const weak: LocatedBoard = { ...VALID_BOARD, inlierRatio: 0.3 };
    const provider = staticProvider(weak);
    const { locator, state } = harness({ provider });
    const result = await locator.locate({
      frame: frame(5n, 0),
      context: context("req-1"),
      signal: new AbortController().signal
    });
    expect(result).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "invalid-geometry" });
    expect(state.lastInvalidation()).toMatchObject({ reason: "locator-geometry-invalid" });
  });

  it("rejects instead of throwing when the provider reports malformed scalars", async () => {
    const malformed = { ...VALID_BOARD, inlierRatio: "0.9" } as unknown as LocatedBoard;
    const provider = staticProvider(malformed);
    const { locator, state } = harness({ provider });
    const result = await locator.locate({
      frame: frame(5n, 0),
      context: context("req-1"),
      signal: new AbortController().signal
    });
    expect(result).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "invalid-geometry" });
    expect(state.lastInvalidation()).toMatchObject({ reason: "locator-geometry-invalid" });
  });

  it("treats a repeated frame sequence as a frozen observation and invalidates", async () => {
    const provider = staticProvider(VALID_BOARD);
    const { locator, state } = harness({ provider });
    const signal = new AbortController().signal;
    expect(
      await locator.locate({ frame: frame(5n, 0), context: context("req-1"), signal })
    ).not.toBeNull();
    const repeated = await locator.locate({
      frame: frame(5n, 50),
      context: context("req-2"),
      signal
    });
    expect(repeated).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "frozen-sequence" });
    expect(state.lastInvalidation()).toMatchObject({
      reason: "frozen-observation-sequence",
      clearedSequence: 5n
    });
    expect(state.current(50)).toBeNull();
  });

  it("treats a frame from a different session or source as a broken observation stream", async () => {
    const provider = staticProvider(VALID_BOARD);
    const { locator, state } = harness({ provider });
    const signal = new AbortController().signal;
    expect(
      await locator.locate({ frame: frame(5n, 0), context: context("req-1"), signal })
    ).not.toBeNull();
    const switched = await locator.locate({
      frame: frame(6n, 50, { sessionId: newSessionId() }),
      context: context("req-2"),
      signal
    });
    expect(switched).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "source-changed" });
    expect(state.lastInvalidation()).toMatchObject({ reason: "observation-source-changed" });
  });

  it("reacquires the new stream after a session restart: first frame rejected, second locates", async () => {
    const provider = staticProvider(VALID_BOARD);
    const { locator, state } = harness({ provider });
    const signal = new AbortController().signal;
    expect(
      await locator.locate({ frame: frame(5n, 0), context: context("req-1"), signal })
    ).not.toBeNull();
    expect(state.current(0)).not.toBeNull();

    // Session restart: the app resets to the new session, whose first frame arrives.
    const newSession = newSessionId();
    locator.reset(context("req-2", { sessionId: newSession }));
    const switched = await locator.locate({
      frame: frame(6n, 50, { sessionId: newSession }),
      context: context("req-2", { sessionId: newSession }),
      signal
    });
    // The old stream's geometry is invalidated — the overlay hides.
    expect(switched).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "source-changed" });
    expect(state.lastInvalidation()).toMatchObject({
      reason: "observation-source-changed",
      clearedSequence: 5n
    });
    expect(state.current(50)).toBeNull();

    // The second frame of the new stream locates normally again.
    const reacquired = await locator.locate({
      frame: frame(7n, 60, { sessionId: newSession }),
      context: context("req-2", { sessionId: newSession }),
      signal
    });
    expect(reacquired).not.toBeNull();
    expect(locator.lastRejection()).toBeNull();
    expect(state.current(60)).toEqual({ transform: reacquired?.transform, sequence: 7n });
  });

  it("reacquires after a camera reconnect on a changed source id", async () => {
    const provider = staticProvider(VALID_BOARD);
    const { locator, state } = harness({ provider });
    const signal = new AbortController().signal;
    expect(
      await locator.locate({ frame: frame(5n, 0), context: context("req-1"), signal })
    ).not.toBeNull();
    const newSource = newSourceId();
    const reconnected = await locator.locate({
      frame: frame(6n, 50, { sourceId: newSource }),
      context: context("req-2"),
      signal
    });
    // First frame of the reconnected camera: rejected, held geometry dropped.
    expect(reconnected).toBeNull();
    expect(locator.lastRejection()).toMatchObject({ code: "source-changed" });
    expect(state.lastInvalidation()).toMatchObject({ reason: "observation-source-changed" });
    expect(state.current(50)).toBeNull();
    // Second frame of the reconnected camera: locates normally, overlay recovers.
    const reacquired = await locator.locate({
      frame: frame(7n, 60, { sourceId: newSource }),
      context: context("req-2"),
      signal
    });
    expect(reacquired).not.toBeNull();
    expect(locator.lastRejection()).toBeNull();
    expect(state.current(60)).toEqual({ transform: reacquired?.transform, sequence: 7n });
  });
});

describe("FreshnessAwareBoardLocator configuration", () => {
  it("requires a known price with a ledger and a positive answer allowance", () => {
    expect(
      () =>
        new FreshnessAwareBoardLocator({
          provider: staticProvider(VALID_BOARD),
          ledger: new FakeLedger(),
          maxAnswerAgeMs: 250,
          nowMs: () => 0
        })
    ).toThrow(RangeError);
    expect(
      () =>
        new FreshnessAwareBoardLocator({
          provider: staticProvider(VALID_BOARD),
          ledger: new FakeLedger(),
          price: { inputPerMillion: -1, outputPerMillion: 1, effectiveAt: "2026-01-01" },
          maxAnswerAgeMs: 250,
          nowMs: () => 0
        })
    ).toThrow(RangeError);
    expect(
      () =>
        new FreshnessAwareBoardLocator({
          provider: staticProvider(VALID_BOARD),
          ledger: new FakeLedger(),
          price: PRICE,
          maxAnswerAgeMs: 0,
          nowMs: () => 0
        })
    ).toThrow(RangeError);
  });

  it("validates reset and locate argument shapes", async () => {
    const { locator } = harness({ provider: staticProvider(VALID_BOARD) });
    expect(() => locator.reset(context("req-1", { requestId: "" }))).toThrow(RangeError);
    await expect(
      locator.locate({
        frame: frame(5n, 0),
        context: context("req-1", { requestId: " " }),
        signal: new AbortController().signal
      })
    ).rejects.toThrow(RangeError);
  });
});
