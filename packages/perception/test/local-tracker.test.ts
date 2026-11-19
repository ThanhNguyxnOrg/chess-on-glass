import { describe, expect, it } from "vitest";
import {
  ConservativeLocalBoardTracker,
  GeometryError,
  GeometryState,
  fitBoardHomography,
  type ConservativeLocalBoardTrackerOptions,
  type LocalFlowObservation,
  type LocalFlowProvider
} from "@chessonglass/perception";
import { newSessionId, newSourceId, type Frame } from "@chessonglass/contracts";

const SESSION = newSessionId();
const OTHER_SESSION = newSessionId();
const SOURCE = newSourceId();
const OTHER_SOURCE = newSourceId();

/** Axis-aligned board inside an 800x800 image; the locator's previous fit. */
const PREVIOUS_CORNERS = {
  nearLeft: [100, 700],
  nearRight: [700, 700],
  farRight: [700, 100],
  farLeft: [100, 100]
} as const;
/** The same board tracked 12 px to the right on the next frame. */
const TRACKED_CORNERS = {
  nearLeft: [112, 700],
  nearRight: [712, 700],
  farRight: [712, 100],
  farLeft: [112, 100]
} as const;
const PREVIOUS_TRANSFORM = fitBoardHomography(PREVIOUS_CORNERS, 800, 800);
const TRACKED_TRANSFORM = fitBoardHomography(TRACKED_CORNERS, 800, 800);

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

function observation(overrides: Partial<LocalFlowObservation> = {}): LocalFlowObservation {
  return {
    corners: TRACKED_CORNERS,
    imageWidth: 800,
    imageHeight: 800,
    trackedPoints: 20,
    inlierCount: 18,
    reprojectionErrorPx: 1.5,
    forwardBackwardErrorPx: 0.8,
    occluded: false,
    ...overrides
  };
}

type ProviderCall = Readonly<{
  previous: Readonly<{ frame: Frame; transform: unknown }>;
  next: Frame;
}>;

function fakeProvider(
  result: LocalFlowObservation | null,
  error: unknown = null
): { provider: LocalFlowProvider; calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  return {
    calls,
    provider: {
      track(input: { previous: { frame: Frame; transform: unknown }; next: Frame }) {
        calls.push(input);
        if (error !== null) {
          throw error;
        }
        return result;
      }
    }
  };
}

function tracker(
  result: LocalFlowObservation | null,
  error: unknown = null,
  overrides: Partial<ConservativeLocalBoardTrackerOptions> = {}
): { instance: ConservativeLocalBoardTracker; calls: ProviderCall[] } {
  const fake = fakeProvider(result, error);
  const instance = new ConservativeLocalBoardTracker({
    provider: fake.provider,
    minInlierCount: 4,
    maxForwardBackwardErrorPx: 2,
    ...overrides
  });
  return { instance, calls: fake.calls };
}

describe("ConservativeLocalBoardTracker success path", () => {
  it("tracks the board into the next frame and stamps confidence with that frame's sequence", () => {
    const { instance } = tracker(observation());
    const previous = { frame: frame(40n, 1000), transform: PREVIOUS_TRANSFORM };
    const next = frame(41n, 1033);
    const result = instance.track(previous, next);
    expect(result).toEqual({
      transform: TRACKED_TRANSFORM,
      confidence: {
        inlierRatio: 18 / 20,
        reprojectionErrorPx: 1.5,
        observedSequence: 41n
      }
    });
    expect(instance.lastRejection()).toBeNull();
  });

  it("derives the inlier ratio from the reported counts instead of trusting a reported ratio", () => {
    const { instance } = tracker(observation({ trackedPoints: 20, inlierCount: 16 }));
    const result = instance.track(
      { frame: frame(40n, 1000), transform: PREVIOUS_TRANSFORM },
      frame(41n, 1033)
    );
    expect(result?.confidence.inlierRatio).toBe(16 / 20);
  });

  it("hands the previous frame and transform to the provider untouched", () => {
    const { instance, calls } = tracker(observation());
    const previousFrame = frame(40n, 1000);
    const next = frame(41n, 1033);
    instance.track({ frame: previousFrame, transform: PREVIOUS_TRANSFORM }, next);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.previous.frame).toBe(previousFrame);
    expect(calls[0]?.previous.transform).toBe(PREVIOUS_TRANSFORM);
    expect(calls[0]?.next).toBe(next);
  });

  it("produces results GeometryState accepts and renders", () => {
    const state = new GeometryState({ lifetimeMs: 250 });
    const { instance } = tracker(observation());
    const next = frame(41n, 1033);
    const result = instance.track(
      { frame: frame(40n, 1000), transform: PREVIOUS_TRANSFORM },
      next
    );
    expect(result).not.toBeNull();
    if (result !== null) {
      state.update(next, result.transform, result.confidence);
    }
    expect(state.current(1033)).toEqual({ transform: TRACKED_TRANSFORM, sequence: 41n });
  });
});

describe("conservative fallback: failures return null, never extrapolated geometry", () => {
  it("returns null when the provider reports occlusion", () => {
    const { instance } = tracker(observation({ occluded: true }));
    const result = instance.track(
      { frame: frame(40n, 1000), transform: PREVIOUS_TRANSFORM },
      frame(41n, 1033)
    );
    expect(result).toBeNull();
    expect(instance.lastRejection()).toMatchObject({ code: "occluded" });
  });

  it("returns null when too few inliers survive tracking", () => {
    const { instance } = tracker(observation({ trackedPoints: 20, inlierCount: 3 }));
    const result = instance.track(
      { frame: frame(40n, 1000), transform: PREVIOUS_TRANSFORM },
      frame(41n, 1033)
    );
    expect(result).toBeNull();
    expect(instance.lastRejection()).toMatchObject({ code: "too-few-inliers" });
  });

  it("returns null when the forward-backward error exceeds the configured bound", () => {
    const { instance } = tracker(observation({ forwardBackwardErrorPx: 2.1 }));
    const result = instance.track(
      { frame: frame(40n, 1000), transform: PREVIOUS_TRANSFORM },
      frame(41n, 1033)
    );
    expect(result).toBeNull();
    expect(instance.lastRejection()).toMatchObject({ code: "forward-backward-error" });
  });

  it("returns null when the provider cannot attempt tracking", () => {
    const { instance } = tracker(null);
    const result = instance.track(
      { frame: frame(40n, 1000), transform: PREVIOUS_TRANSFORM },
      frame(41n, 1033)
    );
    expect(result).toBeNull();
    expect(instance.lastRejection()).toMatchObject({ code: "provider-null" });
  });

  it("returns null when the provider throws, with credential-looking text redacted", () => {
    const { instance } = tracker(undefined, new Error("decode failed for sk-abc123def"));
    const result = instance.track(
      { frame: frame(40n, 1000), transform: PREVIOUS_TRANSFORM },
      frame(41n, 1033)
    );
    expect(result).toBeNull();
    expect(instance.lastRejection()).toMatchObject({ code: "provider-failed" });
    expect(instance.lastRejection()?.message).toContain("[REDACTED]");
    expect(instance.lastRejection()?.message).not.toContain("sk-abc123def");
  });

  it("returns null when the provider reports malformed scalars instead of throwing across track", () => {
    const { instance } = tracker(observation({ forwardBackwardErrorPx: Number.NaN }));
    const result = instance.track(
      { frame: frame(40n, 1000), transform: PREVIOUS_TRANSFORM },
      frame(41n, 1033)
    );
    expect(result).toBeNull();
    expect(instance.lastRejection()).toMatchObject({ code: "invalid-geometry" });
  });

  it("returns null when the provider reports impossible inlier counts", () => {
    const { instance } = tracker(observation({ trackedPoints: 10, inlierCount: 11 }));
    const result = instance.track(
      { frame: frame(40n, 1000), transform: PREVIOUS_TRANSFORM },
      frame(41n, 1033)
    );
    expect(result).toBeNull();
    expect(instance.lastRejection()).toMatchObject({ code: "invalid-geometry" });
  });

  it("returns null rather than junk geometry when tracked corners are degenerate", () => {
    const collapsed = {
      nearLeft: [100, 100],
      nearRight: [100, 100],
      farRight: [100, 100],
      farLeft: [100, 100]
    } as const;
    const { instance } = tracker(observation({ corners: collapsed }));
    let raised: unknown = null;
    let result: unknown = "not-run";
    try {
      result = instance.track(
        { frame: frame(40n, 1000), transform: PREVIOUS_TRANSFORM },
        frame(41n, 1033)
      );
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeNull();
    expect(result).toBeNull();
    expect(instance.lastRejection()).toMatchObject({ code: "invalid-geometry" });
  });

  it("returns null when tracked confidence fails the trust policy", () => {
    // 5 of 10 clears the absolute inlier floor but yields a 0.5 ratio,
    // below the default 0.8 policy in validateGeometry.
    const { instance } = tracker(observation({ trackedPoints: 10, inlierCount: 5 }));
    const result = instance.track(
      { frame: frame(40n, 1000), transform: PREVIOUS_TRANSFORM },
      frame(41n, 1033)
    );
    expect(result).toBeNull();
    expect(instance.lastRejection()).toMatchObject({ code: "invalid-geometry" });
  });
});

describe("stream identity gates", () => {
  it("returns null without calling the provider when the next frame changes session or source", () => {
    const acrossSessions = tracker(observation());
    let result = acrossSessions.instance.track(
      { frame: frame(40n, 1000), transform: PREVIOUS_TRANSFORM },
      frame(41n, 1033, { sessionId: OTHER_SESSION })
    );
    expect(result).toBeNull();
    expect(acrossSessions.instance.lastRejection()).toMatchObject({ code: "stream-changed" });
    expect(acrossSessions.calls).toHaveLength(0);

    const acrossSources = tracker(observation());
    result = acrossSources.instance.track(
      { frame: frame(40n, 1000), transform: PREVIOUS_TRANSFORM },
      frame(41n, 1033, { sourceId: OTHER_SOURCE })
    );
    expect(result).toBeNull();
    expect(acrossSources.instance.lastRejection()).toMatchObject({ code: "stream-changed" });
    expect(acrossSources.calls).toHaveLength(0);
  });

  it("returns null without calling the provider when the next frame sequence does not advance", () => {
    const { instance, calls } = tracker(observation());
    const previous = { frame: frame(40n, 1000), transform: PREVIOUS_TRANSFORM };
    expect(instance.track(previous, frame(40n, 1033))).toBeNull();
    expect(instance.track(previous, frame(39n, 1033))).toBeNull();
    expect(instance.lastRejection()).toMatchObject({ code: "frozen-sequence" });
    expect(calls).toHaveLength(0);
  });
});

describe("caller-bug validation", () => {
  it("throws typed errors on malformed previous geometry or malformed frames", () => {
    const { instance } = tracker(observation());
    const next = frame(41n, 1033);
    expect(() => instance.track(null as never, next)).toThrow(RangeError);
    expect(() =>
      instance.track(
        { frame: frame(40n, 1000), transform: { nope: 1 } as never },
        next
      )
    ).toThrow(GeometryError);
    expect(() =>
      instance.track(
        {
          frame: frame(40n, 1000),
          transform: { matrix: [Number.NaN, 0, 0, 0, 1, 0, 0, 0, 1] } as never
        },
        next
      )
    ).toThrow(GeometryError);
    expect(() =>
      instance.track(
        { frame: { ...frame(40n, 1000), sequence: 40 } as never, transform: PREVIOUS_TRANSFORM },
        next
      )
    ).toThrow(RangeError);
    expect(() =>
      instance.track(
        { frame: { ...frame(40n, 1000), sessionId: "" } as never, transform: PREVIOUS_TRANSFORM },
        next
      )
    ).toThrow(RangeError);
    expect(() =>
      instance.track({ frame: frame(40n, 1000), transform: PREVIOUS_TRANSFORM }, null as never)
    ).toThrow(RangeError);
  });

  it("rejects nonsensical construction options", () => {
    const base = { minInlierCount: 4, maxForwardBackwardErrorPx: 2 };
    expect(() => new ConservativeLocalBoardTracker(undefined as never)).toThrow(RangeError);
    expect(() =>
      new ConservativeLocalBoardTracker({ ...base, provider: undefined as never })
    ).toThrow(RangeError);
    expect(() =>
      new ConservativeLocalBoardTracker({ ...base, provider: {} as never })
    ).toThrow(RangeError);
    expect(() =>
      new ConservativeLocalBoardTracker({ ...base, minInlierCount: 3 })
    ).toThrow(RangeError);
    expect(() =>
      new ConservativeLocalBoardTracker({ ...base, minInlierCount: 4.5 })
    ).toThrow(RangeError);
    expect(() =>
      new ConservativeLocalBoardTracker({ ...base, maxForwardBackwardErrorPx: 0 })
    ).toThrow(RangeError);
    expect(() =>
      new ConservativeLocalBoardTracker({ ...base, minInlierRatio: 1.5 })
    ).toThrow(RangeError);
    expect(() =>
      new ConservativeLocalBoardTracker({ ...base, maxReprojectionErrorPx: -1 })
    ).toThrow(RangeError);
  });
});
