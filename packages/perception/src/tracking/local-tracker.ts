import type { Frame } from "@chessonglass/contracts";
import { validateGeometry } from "../geometry/board-projection.js";
import {
  fitBoardHomography,
  requireFiniteHomography
} from "../geometry/homography.js";
import { GeometryError } from "../geometry/types.js";
import type {
  BoardCorners,
  GeometryConfidence,
  GeometryValidationOptions,
  Homography
} from "../geometry/types.js";

/**
 * Absolute floor on board-plane correspondences that must corroborate one
 * tracked fit. A four-corner model cannot be corroborated by fewer points
 * than it has corners, so options below this are rejected at construction.
 */
export const MIN_TRACKING_INLIER_COUNT = 4;

/**
 * What an injected low-level flow/track provider reports for one frame pair.
 * Every field is typed data — corners, counts and quality scalars — so no
 * free-form provider output can cross this boundary. `inlierRatio` is not
 * reported: the tracker derives it from the counts, so a provider cannot
 * dress up weak matches with a generous ratio.
 */
export type LocalFlowObservation = Readonly<{
  /** Board corners tracked into the next frame's image space. */
  corners: BoardCorners;
  imageWidth: number;
  imageHeight: number;
  /** Board-plane points the provider attempted to track into the next frame. */
  trackedPoints: number;
  /** Tracked points that survived the provider's outlier rejection. */
  inlierCount: number;
  /** Provider-reported reprojection quality of the tracked fit, in pixels. */
  reprojectionErrorPx: number;
  /**
   * Median forward-backward round-trip error across tracked points, in
   * pixels: track next→previous and compare with previous→next. Large values
   * mean the motion estimate is unreliable regardless of how good the fit
   * looks.
   */
  forwardBackwardErrorPx: number;
  /**
   * True when the provider observed occlusion (a hand over the board, a
   * piece lifted towards the camera). Occlusion must drop tracking, never
   * guess through it.
   */
  occluded: boolean;
}>;

/**
 * The pluggable low-level flow/track provider behind the conservative
 * tracker. This is the ONLY place a future OpenCV-style implementation may
 * live, and it is always injected by the app — the perception package never
 * imports or constructs a concrete one, and the production locator-only path
 * never touches this interface at all.
 *
 * The call is synchronous on purpose: `LocalBoardTracker.track` is
 * synchronous, so a real provider must own its own worker/threading and its
 * own bounded decode/pixels/work budget (bounded frames/pixels/work is a
 * provider responsibility; the tracker itself is O(1) per call). Returning
 * null means tracking could not even be attempted (decode failure, no
 * trackable board-plane features).
 */
export interface LocalFlowProvider {
  track(input: {
    previous: { frame: Frame; transform: Homography };
    next: Frame;
  }): LocalFlowObservation | null;
}

/**
 * The optional local-tracking layer between locator observations. `track`
 * carries the previous observation in, so the tracker stays stateless except
 * for diagnostics and the app decides when to trust it.
 */
export interface LocalBoardTracker {
  track(
    previous: { frame: Frame; transform: Homography },
    next: Frame
  ): { transform: Homography; confidence: GeometryConfidence } | null;
}

/**
 * Why the most recent track returned null (null after a success).
 * Distinguishing these keeps "the overlay hid between locator observations"
 * diagnosable without exposing provider internals.
 */
export type LocalTrackRejectionCode =
  | "stream-changed"
  | "frozen-sequence"
  | "provider-failed"
  | "provider-null"
  | "occluded"
  | "too-few-inliers"
  | "forward-backward-error"
  | "invalid-geometry";

export type LocalTrackRejection = Readonly<{
  code: LocalTrackRejectionCode;
  message: string;
}>;

export type ConservativeLocalBoardTrackerOptions = Readonly<{
  /** Injected low-level flow provider; see `LocalFlowProvider`. */
  provider: LocalFlowProvider;
  /**
   * Minimum board-plane inliers that must corroborate one tracked fit.
   * Must be at least `MIN_TRACKING_INLIER_COUNT` (4).
   */
  minInlierCount: number;
  /** Ceiling on the provider's median forward-backward error, in pixels. */
  maxForwardBackwardErrorPx: number;
  /** Trust-policy overrides, forwarded to `validateGeometry`. */
  minInlierRatio?: number;
  maxReprojectionErrorPx?: number;
}>;

const SECRET_PATTERN = /sk-[A-Za-z0-9_-]+/g;

/** Strip credential-looking substrings before a provider message is stored. */
function safeMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(SECRET_PATTERN, "[REDACTED]");
  }
  return String(error);
}

/**
 * Guard the identity fields the tracker actually gates on. Like
 * `GeometryState`, the tracker never reads bytes or mime type — decoding is
 * the provider's job — so only identity and ordering are validated.
 */
function requireFrameIdentity(frame: Frame, label: string): void {
  if (typeof frame !== "object" || frame === null) {
    throw new RangeError(`${label} must be an object`);
  }
  if (typeof frame.sequence !== "bigint" || frame.sequence < 0n) {
    throw new RangeError(`${label}.sequence must be a non-negative bigint`);
  }
  if (!Number.isFinite(frame.receivedAtMonotonicMs)) {
    throw new RangeError(`${label}.receivedAtMonotonicMs must be a finite number`);
  }
  if (typeof frame.sessionId !== "string" || frame.sessionId === "") {
    throw new RangeError(`${label}.sessionId must be a non-empty string`);
  }
  if (typeof frame.sourceId !== "string" || frame.sourceId === "") {
    throw new RangeError(`${label}.sourceId must be a non-empty string`);
  }
}

/**
 * Structural guard on a provider observation. Malformed scalars are a
 * provider fault, not a caller bug, so they become a null result (never a
 * throw across the `track` boundary) — but they must be caught before any
 * arithmetic, because `NaN > bound` is silently false and would let a NaN
 * error estimate through the forward-backward gate.
 */
function isWellShapedObservation(observation: LocalFlowObservation): boolean {
  return (
    typeof observation === "object" &&
    observation !== null &&
    typeof observation.occluded === "boolean" &&
    Number.isFinite(observation.imageWidth) &&
    observation.imageWidth > 0 &&
    Number.isFinite(observation.imageHeight) &&
    observation.imageHeight > 0 &&
    Number.isSafeInteger(observation.trackedPoints) &&
    observation.trackedPoints >= 0 &&
    Number.isSafeInteger(observation.inlierCount) &&
    observation.inlierCount >= 0 &&
    observation.inlierCount <= observation.trackedPoints &&
    Number.isFinite(observation.reprojectionErrorPx) &&
    observation.reprojectionErrorPx >= 0 &&
    Number.isFinite(observation.forwardBackwardErrorPx) &&
    observation.forwardBackwardErrorPx >= 0
  );
}

/**
 * Conservative fallback tracker for the gap between locator observations.
 *
 * Every rule here exists so local tracking can never manufacture board
 * geometry the video does not support:
 *
 * - The low-level flow provider is injected (`LocalFlowProvider`); nothing
 *   in this package imports or constructs a concrete one, and the shipped
 *   locator-only configuration never reaches this class (see
 *   `resolveTrackingConfig` — `local-assisted` requires recorded spike
 *   evidence).
 * - Occlusion, too few inliers, an excessive forward-backward error, a
 *   malformed observation or geometry that fails `validateGeometry` all
 *   return null. Null means "hide the overlay until the locator sees the
 *   board again"; extrapolating a transform through any of those conditions
 *   is exactly the failure mode this tracker exists to prevent.
 * - Frames from a different session/source, or a sequence that does not
 *   advance, return null without touching the provider: a tracked motion
 *   estimate across a stream switch or a repeated frame describes nothing.
 * - The inlier ratio is derived from the reported counts, never taken on
 *   trust, and the final transform is re-fit by Task 1's `fitBoardHomography`
 *   and re-gated by `validateGeometry`, so one trust policy covers locator
 *   and tracker output alike.
 *
 * Malformed caller arguments (not objects, non-homography transforms,
 * malformed frames) throw — caller bug. Everything the provider produced is
 * rejected as null, never thrown.
 */
export class ConservativeLocalBoardTracker implements LocalBoardTracker {
  private readonly provider: LocalFlowProvider;
  private readonly minInlierCount: number;
  private readonly maxForwardBackwardErrorPx: number;
  private readonly policy: GeometryValidationOptions;
  private rejection: LocalTrackRejection | null = null;

  constructor(options: ConservativeLocalBoardTrackerOptions) {
    if (typeof options !== "object" || options === null) {
      throw new RangeError("tracker options must be an object");
    }
    const provider = options.provider;
    if (
      typeof provider !== "object" ||
      provider === null ||
      typeof provider.track !== "function"
    ) {
      throw new RangeError("a flow provider with a track function is required");
    }
    const minInlierCount = options.minInlierCount;
    if (!Number.isSafeInteger(minInlierCount) || minInlierCount < MIN_TRACKING_INLIER_COUNT) {
      throw new RangeError(
        `minInlierCount must be a safe integer of at least ${MIN_TRACKING_INLIER_COUNT}: ` +
          "fewer inliers cannot corroborate a four-corner homography fit"
      );
    }
    const maxForwardBackwardErrorPx = options.maxForwardBackwardErrorPx;
    if (
      typeof maxForwardBackwardErrorPx !== "number" ||
      !Number.isFinite(maxForwardBackwardErrorPx) ||
      maxForwardBackwardErrorPx <= 0
    ) {
      throw new RangeError("maxForwardBackwardErrorPx must be a finite number greater than zero");
    }
    const minInlierRatio = options.minInlierRatio;
    if (
      minInlierRatio !== undefined &&
      (!Number.isFinite(minInlierRatio) || minInlierRatio < 0 || minInlierRatio > 1)
    ) {
      throw new RangeError("minInlierRatio must be a finite number in [0,1]");
    }
    const maxReprojectionErrorPx = options.maxReprojectionErrorPx;
    if (
      maxReprojectionErrorPx !== undefined &&
      (!Number.isFinite(maxReprojectionErrorPx) || maxReprojectionErrorPx <= 0)
    ) {
      throw new RangeError("maxReprojectionErrorPx must be a finite number greater than zero");
    }
    this.provider = provider;
    this.minInlierCount = minInlierCount;
    this.maxForwardBackwardErrorPx = maxForwardBackwardErrorPx;
    this.policy = { minInlierRatio, maxReprojectionErrorPx };
  }

  /**
   * Track the board from `previous` into `next`, or return null — with
   * `lastRejection` recording why — whenever the tracked geometry could not
   * be trusted: a stream switch, a frozen sequence, a provider that failed
   * or could not attempt tracking, occlusion, too few inliers, an excessive
   * forward-backward error, or geometry that failed the trust policy.
   */
  track(
    previous: { frame: Frame; transform: Homography },
    next: Frame
  ): { transform: Homography; confidence: GeometryConfidence } | null {
    if (typeof previous !== "object" || previous === null) {
      throw new RangeError("previous must be an object");
    }
    requireFrameIdentity(previous.frame, "previous.frame");
    // Shape AND finiteness: a NaN entry must not be handed to the provider
    // as a tracking seed. The guard throws the same typed error the rest of
    // the geometry package uses for malformed transforms.
    requireFiniteHomography(previous.transform);
    requireFrameIdentity(next, "next");

    if (
      next.sessionId !== previous.frame.sessionId ||
      next.sourceId !== previous.frame.sourceId
    ) {
      // The previous transform describes the old stream's board; tracked
      // motion across a stream switch is fiction.
      return this.reject("stream-changed", "next frame comes from a different session or source");
    }
    if (next.sequence <= previous.frame.sequence) {
      // Tracking needs real forward motion; a repeated or regressed sequence
      // would only re-dress the previous geometry as a new observation.
      return this.reject(
        "frozen-sequence",
        "next frame sequence did not advance beyond the previous frame"
      );
    }

    let observed: LocalFlowObservation | null;
    try {
      observed = this.provider.track({
        previous: { frame: previous.frame, transform: previous.transform },
        next
      });
    } catch (error) {
      return this.reject("provider-failed", safeMessage(error));
    }
    if (observed === null) {
      return this.reject(
        "provider-null",
        "flow provider could not attempt tracking (decode failure or no trackable board-plane features)"
      );
    }
    if (!isWellShapedObservation(observed)) {
      return this.reject("invalid-geometry", "flow observation is malformed");
    }
    if (observed.occluded) {
      return this.reject("occluded", "flow provider reported board occlusion");
    }
    if (observed.inlierCount < this.minInlierCount) {
      return this.reject(
        "too-few-inliers",
        `${observed.inlierCount} inliers survived, below the required ${this.minInlierCount}`
      );
    }
    if (observed.forwardBackwardErrorPx > this.maxForwardBackwardErrorPx) {
      return this.reject(
        "forward-backward-error",
        `forward-backward error ${observed.forwardBackwardErrorPx}px exceeds the ` +
          `${this.maxForwardBackwardErrorPx}px allowance`
      );
    }

    // Derived, not reported: a provider cannot claim a high inlier ratio
    // that its own counts do not support.
    const confidence: GeometryConfidence = {
      inlierRatio: observed.inlierCount / observed.trackedPoints,
      reprojectionErrorPx: observed.reprojectionErrorPx,
      // The geometry was observed from exactly this frame; stamping the
      // frame's sequence keeps a stale transform from riding fresh numbers.
      observedSequence: next.sequence
    };
    let transform: Homography;
    try {
      transform = fitBoardHomography(observed.corners, observed.imageWidth, observed.imageHeight);
      if (!validateGeometry(transform, confidence, this.policy)) {
        // Well-shaped but untrusted: same outcome as untrustworthy corners.
        throw new GeometryError("invalid-confidence", "tracked geometry failed the trust policy");
      }
    } catch (error) {
      // A malformed or untrustworthy provider answer must surface as a null
      // result, never as a throw across the track boundary.
      return this.reject("invalid-geometry", safeMessage(error));
    }

    this.rejection = null;
    return { transform, confidence };
  }

  /** Why the most recent track returned null, or null when it succeeded. */
  lastRejection(): LocalTrackRejection | null {
    return this.rejection;
  }

  private reject(code: LocalTrackRejectionCode, message: string): null {
    this.rejection = { code, message };
    return null;
  }
}
