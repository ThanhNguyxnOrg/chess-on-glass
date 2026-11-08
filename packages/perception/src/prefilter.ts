import type { Frame } from "@chessonglass/contracts";

export type PreFilterDecision = "read" | "wait" | "uncertain";

/**
 * Optional local gate evaluated before a paid provider call. It is an
 * optimization only: a missing or failing gate must never block a full read.
 */
export interface PreFilter {
  inspect(frame: Frame, reference: Frame | null): Promise<PreFilterDecision>;
}

/** Baseline heuristic, not a calibrated cost or latency claim. */
const DEFAULT_MAX_CONSECUTIVE_WAITS = 3;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/**
 * A replaceable local heuristic: skip a paid read only when the frame is
 * byte-identical to the reference from the same session/source. Any byte
 * difference is treated as a possible board change and reads. After
 * `maxConsecutiveWaits` skipped frames, one full read is forced so a static or
 * frozen-looking source still refreshes.
 */
export class PeriodicFullReadFilter implements PreFilter {
  private readonly maxConsecutiveWaits: number;
  private consecutiveWaits = 0;
  private confirmationPending = false;

  constructor(maxConsecutiveWaits: number = DEFAULT_MAX_CONSECUTIVE_WAITS) {
    if (!Number.isSafeInteger(maxConsecutiveWaits) || maxConsecutiveWaits <= 0) {
      throw new RangeError("maxConsecutiveWaits must be a positive safe integer");
    }
    this.maxConsecutiveWaits = maxConsecutiveWaits;
  }

  /**
   * While a position/promotion confirmation is pending, the gate reports
   * `uncertain` instead of `wait`, so the prompt cannot be silently skipped by
   * the local optimization.
   */
  setPendingConfirmation(pending: boolean): void {
    this.confirmationPending = pending;
  }

  async inspect(frame: Frame, reference: Frame | null): Promise<PreFilterDecision> {
    if (this.confirmationPending) {
      return "uncertain";
    }
    if (reference === null) {
      this.consecutiveWaits = 0;
      return "read";
    }
    if (
      frame.sessionId !== reference.sessionId ||
      frame.sourceId !== reference.sourceId ||
      !sameBytes(frame.bytes, reference.bytes)
    ) {
      this.consecutiveWaits = 0;
      return "read";
    }

    if (this.consecutiveWaits >= this.maxConsecutiveWaits) {
      this.consecutiveWaits = 0;
      return "read";
    }
    this.consecutiveWaits += 1;
    return "wait";
  }
}

/**
 * Apply the optional gate with fail-open semantics: no gate means read, and a
 * gate that throws degrades to a full read rather than blocking the pipeline.
 */
export async function inspectWithPreFilter(
  filter: PreFilter | null | undefined,
  frame: Frame,
  reference: Frame | null
): Promise<PreFilterDecision> {
  if (filter === null || filter === undefined) {
    return "read";
  }
  try {
    return await filter.inspect(frame, reference);
  } catch {
    return "read";
  }
}
