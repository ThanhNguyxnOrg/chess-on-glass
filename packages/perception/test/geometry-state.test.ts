import { describe, expect, it } from "vitest";
import {
  GeometryError,
  GeometryState,
  fitBoardHomography,
  type GeometryConfidence,
  type Homography
} from "@chessonglass/perception";
import {
  newSessionId,
  newSourceId,
  type Frame
} from "@chessonglass/contracts";

const SESSION = newSessionId();
const OTHER_SESSION = newSessionId();
const SOURCE = newSourceId();
const OTHER_SOURCE = newSourceId();

/** Axis-aligned board inside an 800x800 image; fits a valid homography. */
const CORNERS = {
  nearLeft: [100, 700],
  nearRight: [700, 700],
  farRight: [700, 100],
  farLeft: [100, 100]
} as const;
const TRANSFORM: Homography = fitBoardHomography(CORNERS, 800, 800);

function confidence(overrides: Partial<GeometryConfidence> = {}): GeometryConfidence {
  return { inlierRatio: 0.95, reprojectionErrorPx: 1.5, observedSequence: 5n, ...overrides };
}

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

describe("GeometryState freshness", () => {
  it("stores fresh geometry and returns it with its frame sequence", () => {
    const state = new GeometryState({ lifetimeMs: 250 });
    state.update(frame(5n, 1000), TRANSFORM, confidence());
    expect(state.current(1000)).toEqual({ transform: TRANSFORM, sequence: 5n });
    expect(state.current(1249)).toEqual({ transform: TRANSFORM, sequence: 5n });
    expect(state.lastInvalidation()).toBeNull();
  });

  it("stops returning geometry once its configured lifetime has passed, never indefinitely", () => {
    const state = new GeometryState({ lifetimeMs: 250 });
    state.update(frame(5n, 1000), TRANSFORM, confidence());
    expect(state.current(1250)).toEqual({ transform: TRANSFORM, sequence: 5n });
    expect(state.current(1251)).toBeNull();
    // The expiry read that discovers the age also records why the state emptied.
    expect(state.lastInvalidation()).toMatchObject({
      reason: "geometry-expired",
      clearedSequence: 5n
    });
    // It stays expired: a later read cannot resurrect stale geometry.
    expect(state.current(99999)).toBeNull();
  });
});

describe("GeometryState staleness gates", () => {
  it("rejects a frozen repeated observation sequence and clears held geometry", () => {
    const state = new GeometryState({ lifetimeMs: 250 });
    state.update(frame(5n, 1000), TRANSFORM, confidence());
    state.update(frame(5n, 1100), TRANSFORM, confidence());
    expect(state.current(1100)).toBeNull();
    expect(state.lastInvalidation()).toMatchObject({
      reason: "frozen-observation-sequence",
      clearedSequence: 5n
    });
  });

  it("rejects an update whose confidence belongs to a different frame", () => {
    const state = new GeometryState({ lifetimeMs: 250 });
    state.update(frame(6n, 1000), TRANSFORM, confidence({ observedSequence: 5n }));
    expect(state.current(1000)).toBeNull();
    expect(state.lastInvalidation()).toMatchObject({ reason: "incoherent-observation-sequence" });
  });

  it("rejects geometry that fails the trust policy", () => {
    const state = new GeometryState({ lifetimeMs: 250 });
    state.update(frame(5n, 1000), TRANSFORM, confidence({ inlierRatio: 0.2 }));
    expect(state.current(1000)).toBeNull();
    expect(state.lastInvalidation()).toMatchObject({ reason: "invalid-geometry" });
  });

  it("rejects frames from a different session or source", () => {
    const acrossSessions = new GeometryState({ lifetimeMs: 250 });
    acrossSessions.update(frame(5n, 1000), TRANSFORM, confidence());
    acrossSessions.update(
      frame(6n, 1100, { sessionId: OTHER_SESSION }),
      TRANSFORM,
      confidence({ observedSequence: 6n })
    );
    expect(acrossSessions.current(1100)).toBeNull();
    expect(acrossSessions.lastInvalidation()).toMatchObject({
      reason: "observation-source-changed"
    });

    const acrossSources = new GeometryState({ lifetimeMs: 250 });
    acrossSources.update(frame(5n, 1000), TRANSFORM, confidence());
    acrossSources.update(
      frame(6n, 1100, { sourceId: OTHER_SOURCE }),
      TRANSFORM,
      confidence({ observedSequence: 6n })
    );
    expect(acrossSources.current(1100)).toBeNull();
    expect(acrossSources.lastInvalidation()).toMatchObject({
      reason: "observation-source-changed"
    });
  });

  it("advances when a newer observation arrives from the same source", () => {
    const state = new GeometryState({ lifetimeMs: 250 });
    state.update(frame(5n, 1000), TRANSFORM, confidence());
    state.update(frame(6n, 1100), TRANSFORM, confidence({ observedSequence: 6n }));
    expect(state.current(1100)).toEqual({ transform: TRANSFORM, sequence: 6n });
    expect(state.lastInvalidation()).toBeNull();
  });
});

describe("GeometryState malformed input", () => {
  it("throws typed geometry errors for malformed transforms and confidence", () => {
    const state = new GeometryState({ lifetimeMs: 250 });
    const malformedTransform = { matrix: [1, 0, 0, 0, 1, 0] } as unknown as Homography;
    expect(() => state.update(frame(5n, 1000), malformedTransform, confidence())).toThrow(
      GeometryError
    );
    const malformedConfidence = {
      inlierRatio: 0.95,
      reprojectionErrorPx: 1.5,
      observedSequence: 5
    } as unknown as GeometryConfidence;
    expect(() => state.update(frame(5n, 1000), TRANSFORM, malformedConfidence)).toThrow(
      GeometryError
    );
  });

  it("throws RangeError for frames or arguments outside their domain", () => {
    const state = new GeometryState({ lifetimeMs: 250 });
    expect(() => new GeometryState({ lifetimeMs: 0 })).toThrow(RangeError);
    expect(() => new GeometryState({ lifetimeMs: Number.NaN })).toThrow(RangeError);
    expect(() => state.current(Number.NaN)).toThrow(RangeError);
    expect(() => state.invalidate(" ")).toThrow(RangeError);
    expect(() => state.update(null as unknown as Frame, TRANSFORM, confidence())).toThrow(
      RangeError
    );
    expect(() =>
      state.update({ ...frame(5n, 1000), sequence: 5 as unknown as bigint }, TRANSFORM, confidence())
    ).toThrow(RangeError);
    expect(() => state.update(frame(5n, Number.NaN), TRANSFORM, confidence())).toThrow(RangeError);
  });
});

describe("GeometryState invalidation", () => {
  it("clears state and records the reason with the cleared sequence", () => {
    const state = new GeometryState({ lifetimeMs: 250 });
    state.update(frame(5n, 1000), TRANSFORM, confidence());
    state.invalidate("overlay hidden by user");
    expect(state.current(1000)).toBeNull();
    expect(state.lastInvalidation()).toEqual({
      reason: "overlay hidden by user",
      clearedSequence: 5n
    });
    // Invalidating an empty state still records the reason.
    state.invalidate("second clear");
    expect(state.lastInvalidation()).toEqual({ reason: "second clear", clearedSequence: null });
  });
});
