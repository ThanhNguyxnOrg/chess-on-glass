import type { Frame, RequestContext, Sequence } from "@chessonglass/contracts";
import { fitBoardHomography } from "../geometry/homography.js";
import { validateGeometry } from "../geometry/board-projection.js";
import { GeometryError } from "../geometry/types.js";
import type {
  BoardCorners,
  GeometryConfidence,
  GeometryValidationOptions,
  Homography
} from "../geometry/types.js";
import type { GeometryState } from "./geometry-state.js";

/**
 * Hard cap on concurrently running locator calls. The locator is a paid,
 * latency-bound detector: overlapping calls double-spend budget and race
 * stale answers into fresh state, so a second call is dropped, not queued.
 */
export const MAX_IN_FLIGHT_LOCATOR_CALLS = 1;

/**
 * Minimal structural budget interface for the locator. Perception never
 * imports the game package (spec dependency rule); the app injects the very
 * `CostLedger` instance the board reader path uses, which satisfies this
 * shape. No hidden second budget.
 */
export type LocatorPrice = Readonly<{
  inputPerMillion: number;
  outputPerMillion: number;
  effectiveAt: string;
}>;

export interface LocatorLedger {
  reserve(requestId: string, price: LocatorPrice): { allowed: boolean; reason: string | null };
  settle(requestId: string, inputTokens: number, outputTokens: number, price: LocatorPrice): void;
  release(requestId: string): void;
}

/**
 * What an optional provider locator reports: typed board corners in image
 * pixels plus detector confidence and the image size they were observed in.
 * No free-form model output ever crosses this boundary, so nothing here can
 * become executable content or markup.
 */
export type LocatedBoard = Readonly<{
  corners: BoardCorners;
  imageWidth: number;
  imageHeight: number;
  inlierRatio: number;
  reprojectionErrorPx: number;
  /**
   * Token usage a model-backed provider must report so its reservation can
   * be settled. Local detectors omit it (nothing was charged) and the
   * reservation is released instead.
   */
  usage?: Readonly<{ inputTokens: number; outputTokens: number }>;
}>;

/** The optional detector the adapter wraps; null answers mean "no board seen". */
export interface BoardLocatorProvider {
  locate(input: { frame: Frame; signal: AbortSignal }): Promise<LocatedBoard | null>;
}

/** A located, validated result: the fitted transform and the confidence it passed. */
export type LocatorResult = Readonly<{
  transform: Homography;
  confidence: GeometryConfidence;
}>;

export interface BoardLocator {
  locate(input: {
    frame: Frame;
    context: RequestContext;
    signal: AbortSignal;
  }): Promise<LocatorResult | null>;
}

export type LocatorRejectionCode =
  | "no-provider"
  | "busy"
  | "budget-denied"
  | "cancelled"
  | "provider-failed"
  | "no-board"
  | "context-mismatch"
  | "answer-expired"
  | "source-changed"
  | "frozen-sequence"
  | "invalid-geometry";

/**
 * Why the most recent locate returned null (or null when it succeeded).
 * Distinguishing these keeps "the overlay hid" diagnosable without exposing
 * provider internals.
 */
export type LocatorRejection = Readonly<{
  code: LocatorRejectionCode;
  message: string;
}>;

export type FreshnessAwareBoardLocatorOptions = Readonly<{
  /** Detector adapter. Omitted/null keeps the locator permanently without answers. */
  provider?: BoardLocatorProvider | null;
  /** Shared estimated-cost ledger; omit for free local-only setups. */
  ledger?: LocatorLedger | null;
  /** Required whenever `ledger` is set: an unknown price is never free. */
  price?: LocatorPrice;
  /** Optional wired state; when present the locator drives its lifecycle. */
  state?: GeometryState | null;
  /** Maximum age of an answer (relative to the frame's monotonic receipt) still worth applying. */
  maxAnswerAgeMs: number;
  minInlierRatio?: number;
  maxReprojectionErrorPx?: number;
  /** Monotonic clock shared with `frame.receivedAtMonotonicMs`; injectable for tests. */
  nowMs?: () => number;
}>;

const SECRET_PATTERN = /sk-[A-Za-z0-9_-]+/g;

/** Strip credential-looking substrings before a provider message is stored. */
function safeMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(SECRET_PATTERN, "[REDACTED]");
  }
  return String(error);
}

function isKnownLocatorPrice(price: LocatorPrice): boolean {
  return (
    Number.isFinite(price.inputPerMillion) &&
    price.inputPerMillion >= 0 &&
    Number.isFinite(price.outputPerMillion) &&
    price.outputPerMillion >= 0 &&
    typeof price.effectiveAt === "string" &&
    price.effectiveAt.trim() !== "" &&
    !Number.isNaN(Date.parse(price.effectiveAt))
  );
}

function requireFrameShape(frame: Frame): void {
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

function requireContextShape(context: RequestContext): void {
  if (typeof context !== "object" || context === null) {
    throw new RangeError("context must be an object");
  }
  if (typeof context.requestId !== "string" || context.requestId.trim() === "") {
    throw new RangeError("context.requestId must be a non-empty string");
  }
  if (typeof context.sessionId !== "string" || context.sessionId === "") {
    throw new RangeError("context.sessionId must be a non-empty string");
  }
  if (!Number.isSafeInteger(context.positionVersion)) {
    throw new RangeError("context.positionVersion must be a safe integer");
  }
  if (context.referenceSequence !== null && typeof context.referenceSequence !== "bigint") {
    throw new RangeError("context.referenceSequence must be null or a bigint");
  }
}

/**
 * All four identity fields must still describe the active request for an
 * answer to be applicable; a difference in any one of them makes it obsolete.
 */
function sameRequestContext(left: RequestContext, right: RequestContext): boolean {
  return (
    left.requestId === right.requestId &&
    left.sessionId === right.sessionId &&
    left.positionVersion === right.positionVersion &&
    left.referenceSequence === right.referenceSequence
  );
}

/**
 * Freshness-aware adapter between an optional provider locator and the
 * overlay's bounded geometry state.
 *
 * - At most `MAX_IN_FLIGHT_LOCATOR_CALLS` call runs at a time; overlapping
 *   calls are dropped, not queued, so detector work cannot pile up.
 * - `reset(context)` marks the app's active request. An answer produced for a
 *   different request id/session/position/reference is dropped when it
 *   arrives — never rendered, never settled as new work (its incurred cost is
 *   still reconciled against its own request id, because the provider charge
 *   did happen).
 * - Answers older than `maxAnswerAgeMs`, frames whose sequence did not
 *   advance and coordinates that cannot fit a trusted homography invalidate
 *   held geometry instead of extending its life: tracking can no longer be
 *   confirmed, so the overlay must hide rather than project a
 *   possibly-stale transform. A frame from another session/source also
 *   invalidates held geometry and is rejected, but adopts the new stream
 *   identity at rejection time so a camera reconnect or session restart
 *   reacquires on the following frame instead of being rejected forever.
 * - A null provider answer means the board left view or tracking was lost;
 *   that also invalidates held geometry.
 * - Budget follows the board reader's ledger: reserve before the detector
 *   runs, settle against reported usage, release when no charge happened.
 */
export class FreshnessAwareBoardLocator implements BoardLocator {
  private readonly provider: BoardLocatorProvider | null;
  private readonly ledger: LocatorLedger | null;
  private readonly price: LocatorPrice | null;
  private readonly state: GeometryState | null;
  private readonly maxAnswerAgeMs: number;
  private readonly policy: GeometryValidationOptions;
  private readonly nowMs: () => number;
  private inFlightCalls = 0;
  private activeContext: RequestContext | null = null;
  private lastApplied: Readonly<{
    sessionId: string;
    sourceId: string;
    sequence: Sequence;
  }> | null = null;
  private rejection: LocatorRejection | null = null;

  constructor(options: FreshnessAwareBoardLocatorOptions) {
    if (typeof options !== "object" || options === null) {
      throw new RangeError("locator options must be an object");
    }
    const ledger = options.ledger ?? null;
    const price = options.price ?? null;
    if (ledger !== null) {
      if (price === null) {
        throw new RangeError(
          "a locator price is required when a ledger is injected; unknown prices are never free"
        );
      }
      if (!isKnownLocatorPrice(price)) {
        throw new RangeError(
          "locator price must carry finite non-negative rates and a parseable effectiveAt"
        );
      }
    }
    const maxAnswerAgeMs = options.maxAnswerAgeMs;
    if (typeof maxAnswerAgeMs !== "number" || !Number.isFinite(maxAnswerAgeMs) || maxAnswerAgeMs <= 0) {
      throw new RangeError("maxAnswerAgeMs must be a finite number greater than zero");
    }
    const minInlierRatio = options.minInlierRatio;
    const maxReprojectionErrorPx = options.maxReprojectionErrorPx;
    if (minInlierRatio !== undefined && (!Number.isFinite(minInlierRatio) || minInlierRatio < 0 || minInlierRatio > 1)) {
      throw new RangeError("minInlierRatio must be a finite number in [0,1]");
    }
    if (
      maxReprojectionErrorPx !== undefined &&
      (!Number.isFinite(maxReprojectionErrorPx) || maxReprojectionErrorPx <= 0)
    ) {
      throw new RangeError("maxReprojectionErrorPx must be a finite number greater than zero");
    }
    this.provider = options.provider ?? null;
    this.ledger = ledger;
    this.price = price;
    this.state = options.state ?? null;
    this.maxAnswerAgeMs = maxAnswerAgeMs;
    this.policy = { minInlierRatio, maxReprojectionErrorPx };
    this.nowMs = options.nowMs ?? (() => performance.now());
  }

  /**
   * Locate the board on `frame` for `context`. Resolves null — with
   * `lastRejection` recording why — whenever the answer would not be safe to
   * render: no provider, another call in flight, no budget, cancellation,
   * provider failure, no board, an obsolete request, a late answer, a broken
   * observation stream, or untrusted geometry.
   */
  async locate(input: {
    frame: Frame;
    context: RequestContext;
    signal: AbortSignal;
  }): Promise<LocatorResult | null> {
    if (input.signal.aborted) {
      return this.reject("cancelled", "locate was cancelled before it started");
    }
    requireFrameShape(input.frame);
    requireContextShape(input.context);
    if (this.provider === null) {
      return this.reject("no-provider", "no locator provider is configured");
    }
    if (this.inFlightCalls >= MAX_IN_FLIGHT_LOCATOR_CALLS) {
      return this.reject(
        "busy",
        `at most ${MAX_IN_FLIGHT_LOCATOR_CALLS} locator call may be in flight`
      );
    }
    const requestId = input.context.requestId;
    if (this.ledger !== null && this.price !== null) {
      const decision = this.ledger.reserve(requestId, this.price);
      if (!decision.allowed) {
        return this.reject("budget-denied", decision.reason ?? "budget reservation was denied");
      }
    }
    this.inFlightCalls += 1;
    try {
      return await this.applyAnswer(input, requestId);
    } finally {
      this.inFlightCalls -= 1;
    }
  }

  /**
   * Record the app's active request. Must be called whenever it changes
   * (new position version, new reference frame, new session): answers
   * captured under an older context are dropped when they arrive.
   */
  reset(context: RequestContext): void {
    requireContextShape(context);
    this.activeContext = context;
  }

  /** Why the most recent locate returned null, or null when it succeeded. */
  lastRejection(): LocatorRejection | null {
    return this.rejection;
  }

  private async applyAnswer(
    input: {
      frame: Frame;
      context: RequestContext;
      signal: AbortSignal;
    },
    requestId: string
  ): Promise<LocatorResult | null> {
    const provider = this.provider;
    if (provider === null) {
      return null; // Unreachable: checked before the in-flight guard.
    }
    let located: LocatedBoard | null;
    try {
      located = await provider.locate({ frame: input.frame, signal: input.signal });
    } catch (error) {
      this.ledger?.release(requestId);
      if (input.signal.aborted) {
        return this.reject("cancelled", "locate was cancelled while the detector ran");
      }
      return this.reject("provider-failed", safeMessage(error));
    }

    if (input.signal.aborted) {
      this.ledger?.release(requestId);
      return this.reject("cancelled", "locate was cancelled before the answer was applied");
    }
    if (located === null) {
      this.ledger?.release(requestId);
      // Board left view or tracking lost: held geometry describes a board the
      // locator can no longer see, so the overlay hides instead of projecting.
      this.state?.invalidate("board-not-visible");
      return this.reject("no-board", "locator reported no visible board");
    }
    if (located.usage !== undefined) {
      const usage = located.usage;
      const ledger = this.ledger;
      const price = this.price;
      if (
        !Number.isSafeInteger(usage.inputTokens) ||
        usage.inputTokens < 0 ||
        !Number.isSafeInteger(usage.outputTokens) ||
        usage.outputTokens < 0
      ) {
        ledger?.release(requestId);
        return this.reject("provider-failed", "locator usage report is malformed");
      }
      // The constructor guarantees a price whenever a ledger is injected.
      if (ledger !== null && price !== null) {
        ledger.settle(requestId, usage.inputTokens, usage.outputTokens, price);
      }
    } else {
      // No usage reported: a local detector ran, nothing was charged.
      this.ledger?.release(requestId);
    }

    // Obsolete request: a reset since the call started makes this answer
    // worthless for rendering, however good its numbers are.
    if (this.activeContext !== null && !sameRequestContext(this.activeContext, input.context)) {
      return this.reject("context-mismatch", "locator answer does not match the active request after reset");
    }

    // Late answer: the frame it describes is too old to matter any more.
    const answerAgeMs = this.nowMs() - input.frame.receivedAtMonotonicMs;
    if (answerAgeMs > this.maxAnswerAgeMs) {
      this.state?.invalidate("locator-answer-expired");
      return this.reject(
        "answer-expired",
        `locator answer is ${answerAgeMs}ms old, beyond the ${this.maxAnswerAgeMs}ms allowance`
      );
    }

    if (this.lastApplied !== null) {
      if (
        this.lastApplied.sessionId !== input.frame.sessionId ||
        this.lastApplied.sourceId !== input.frame.sourceId
      ) {
        // The old stream's held geometry says nothing about the new stream:
        // drop it and reject this frame so no answer crossing the switch can
        // render. Adopt the new stream identity here so a camera reconnect or
        // session restart recovers on the next frame instead of every later
        // frame being rejected `source-changed` forever.
        this.lastApplied = {
          sessionId: input.frame.sessionId,
          sourceId: input.frame.sourceId,
          sequence: input.frame.sequence
        };
        this.state?.invalidate("observation-source-changed");
        return this.reject("source-changed", "locator frame comes from a different session or source");
      }
      if (input.frame.sequence <= this.lastApplied.sequence) {
        // Repeated or regressed sequence: the detector is re-reporting an old
        // observation instead of observing, so held geometry is not extended.
        this.state?.invalidate("frozen-observation-sequence");
        return this.reject(
          "frozen-sequence",
          "locator frame sequence did not advance beyond the last applied answer"
        );
      }
    }

    const confidence: GeometryConfidence = {
      inlierRatio: located.inlierRatio,
      reprojectionErrorPx: located.reprojectionErrorPx,
      // The answer was observed from exactly this frame; stamping the frame's
      // sequence keeps a stale transform from riding fresh-looking numbers.
      observedSequence: input.frame.sequence
    };
    let transform: Homography;
    try {
      transform = fitBoardHomography(located.corners, located.imageWidth, located.imageHeight);
      if (!validateGeometry(transform, confidence, this.policy)) {
        // Well-shaped but untrusted: same outcome as untrustworthy coordinates.
        throw new GeometryError("invalid-confidence", "locator geometry failed the trust policy");
      }
    } catch (error) {
      // A malformed or untrustworthy provider answer must surface as a
      // rejection, never as a throw across the locate boundary.
      this.state?.invalidate("locator-geometry-invalid");
      return this.reject("invalid-geometry", safeMessage(error));
    }

    this.lastApplied = {
      sessionId: input.frame.sessionId,
      sourceId: input.frame.sourceId,
      sequence: input.frame.sequence
    };
    this.state?.update(input.frame, transform, confidence);
    this.rejection = null;
    return { transform, confidence };
  }

  private reject(code: LocatorRejectionCode, message: string): null {
    this.rejection = { code, message };
    return null;
  }
}
