import type { Frame, Sequence } from "@chessonglass/contracts";
import { validateGeometry } from "../geometry/board-projection.js";
import type { GeometryConfidence, Homography } from "../geometry/types.js";

/**
 * Bounded-lifetime policy for one piece of held board geometry. Required, not
 * defaulted: how long a projection may keep driving the overlay without a
 * fresher observation is capture-pipeline policy, not a library constant.
 */
export type GeometryStateOptions = Readonly<{
  lifetimeMs: number;
}>;

/** The geometry `current` hands to the overlay, tagged with its frame sequence. */
export type CurrentGeometry = Readonly<{
  transform: Homography;
  sequence: Sequence;
}>;

/**
 * Why the state last emptied, and which frame's geometry was cleared (null
 * when nothing was held). Surfacing the reason keeps "the overlay vanished"
 * diagnosable instead of a silent null.
 */
export type GeometryInvalidation = Readonly<{
  reason: string;
  clearedSequence: Sequence | null;
}>;

type StoredGeometry = Readonly<{
  transform: Homography;
  sequence: Sequence;
  observedSequence: Sequence;
  receivedAtMonotonicMs: number;
  sessionId: string;
  sourceId: string;
}>;

/**
 * Guard the fields the state actually consumes. The state is a geometry
 * holder, not a frame validator: bytes and mime type are never read here.
 */
function requireFrameIdentity(frame: Frame): void {
  if (typeof frame !== "object" || frame === null) {
    throw new RangeError("frame must be an object");
  }
  if (typeof frame.sequence !== "bigint" || frame.sequence < 0n) {
    throw new RangeError("frame.sequence must be a non-negative bigint");
  }
  if (!Number.isFinite(frame.receivedAtMonotonicMs)) {
    throw new RangeError("frame.receivedAtMonotonicMs must be a finite number");
  }
  if (typeof frame.sessionId !== "string" || frame.sessionId === "") {
    throw new RangeError("frame.sessionId must be a non-empty string");
  }
  if (typeof frame.sourceId !== "string" || frame.sourceId === "") {
    throw new RangeError("frame.sourceId must be a non-empty string");
  }
}

/**
 * Bounded holder for the board transform currently driving the overlay.
 *
 * Every rule here exists so the overlay can never render stale or untrusted
 * geometry "indefinitely":
 *
 * - `current` returns null once the geometry is older than the configured
 *   `lifetimeMs` ("never indefinitely"), and the read that discovers expiry
 *   also clears the state with a recorded reason so it cannot resurrect.
 * - `update` rejects frames from a different session/source, confidence that
 *   does not belong to the exact frame it arrives with, frozen/repeated
 *   observation sequences (same observedSequence as the previous update is
 *   stale — the detector is re-reporting instead of observing) and geometry
 *   that fails `validateGeometry`. A rejected update invalidates held
 *   geometry: a broken observation stream means tracking can no longer be
 *   confirmed, and projecting the previous transform as if it were live is
 *   the failure mode this state exists to prevent.
 * - `invalidate(reason)` clears immediately and records why, so a hidden
 *   overlay always has an answer for "what happened".
 */
export class GeometryState {
  private readonly lifetimeMs: number;
  private stored: StoredGeometry | null = null;
  private invalidation: GeometryInvalidation | null = null;

  constructor(options: GeometryStateOptions) {
    const lifetimeMs = options?.lifetimeMs;
    if (typeof lifetimeMs !== "number" || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
      throw new RangeError("lifetimeMs must be a finite number greater than zero");
    }
    this.lifetimeMs = lifetimeMs;
  }

  /**
   * Store geometry observed on `frame`, or invalidate with a recorded reason
   * when the update cannot be trusted. Malformed argument shapes throw
   * (caller bug); well-shaped but untrusted updates clear the state and
   * return quietly, because an async sink must never crash a render loop.
   */
  update(frame: Frame, transform: Homography, confidence: GeometryConfidence): void {
    requireFrameIdentity(frame);
    // validateGeometry throws typed GeometryError for malformed transform or
    // confidence shapes and returns false for untrusted-but-well-shaped
    // geometry; reusing it keeps one trust policy for the whole package.
    if (!validateGeometry(transform, confidence)) {
      this.clear("invalid-geometry", this.stored?.sequence ?? null);
      return;
    }
    if (
      this.stored !== null &&
      (frame.sessionId !== this.stored.sessionId || frame.sourceId !== this.stored.sourceId)
    ) {
      // Geometry from another stream says nothing about this stream's board.
      this.clear("observation-source-changed", this.stored.sequence);
      return;
    }
    if (confidence.observedSequence !== frame.sequence) {
      // A stale transform must not ride on fresh-looking numbers (see
      // GeometryConfidence): confidence has to belong to the exact frame.
      this.clear("incoherent-observation-sequence", this.stored?.sequence ?? null);
      return;
    }
    if (this.stored !== null && confidence.observedSequence <= this.stored.observedSequence) {
      // Frozen or regressed detector sequence: no new observation arrived, so
      // held geometry must not keep rendering as if tracking were alive.
      this.clear("frozen-observation-sequence", this.stored.sequence);
      return;
    }
    this.stored = {
      transform,
      sequence: frame.sequence,
      observedSequence: confidence.observedSequence,
      receivedAtMonotonicMs: frame.receivedAtMonotonicMs,
      sessionId: frame.sessionId,
      sourceId: frame.sourceId
    };
  }

  /**
   * The geometry to render at `nowMonotonicMs` (same monotonic clock as
   * `frame.receivedAtMonotonicMs`), or null when nothing is held or the held
   * geometry is older than `lifetimeMs`. At exactly the lifetime boundary the
   * geometry is not yet "older than" its allowance and still renders.
   */
  current(nowMonotonicMs: number): CurrentGeometry | null {
    if (!Number.isFinite(nowMonotonicMs)) {
      throw new RangeError("nowMonotonicMs must be a finite number");
    }
    const stored = this.stored;
    if (stored === null) {
      return null;
    }
    if (nowMonotonicMs - stored.receivedAtMonotonicMs > this.lifetimeMs) {
      this.clear("geometry-expired", stored.sequence);
      return null;
    }
    return { transform: stored.transform, sequence: stored.sequence };
  }

  /**
   * Drop held geometry immediately and record `reason` (with the sequence
   * that was cleared, null when nothing was held). Called by the app when the
   * board leaves view, tracking is lost or the overlay must hide for policy
   * reasons.
   */
  invalidate(reason: string): void {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new RangeError("reason must be a non-empty string");
    }
    this.clear(reason, this.stored?.sequence ?? null);
  }

  /** The most recent invalidation, or null while nothing has been cleared. */
  lastInvalidation(): GeometryInvalidation | null {
    return this.invalidation;
  }

  private clear(reason: string, clearedSequence: Sequence | null): void {
    this.stored = null;
    this.invalidation = { reason, clearedSequence };
  }
}
