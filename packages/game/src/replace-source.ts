import type { FrameSource } from "@chessonglass/contracts";

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

/**
 * Await `operation`, but never longer than `timeoutMs`. Returns true when the
 * operation settled in time and false when the deadline won. The abandoned
 * operation keeps running, so callers must make it idempotent.
 */
export async function settleWithin(
  operation: () => Promise<void>,
  timeoutMs: number
): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a finite positive number");
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(value);
    };

    timer = setTimeout(() => finish(false), timeoutMs);
    try {
      operation().then(
        () => finish(true),
        () => finish(true)
      );
    } catch {
      finish(true);
    }
  });
}

/**
 * Holds the one active frame source. A replacement is activated before the
 * caller closes the previous source, so a slow or ignored close cannot take
 * the new session down with it. Closing is bounded and idempotent.
 */
export class SourceSlot {
  private source: FrameSource | null = null;
  private closeRequested = false;

  current(): FrameSource | null {
    return this.source;
  }

  activate(next: FrameSource): void {
    if (this.closeRequested) {
      throw new Error("source slot is already closed");
    }
    this.source = next;
  }

  detach(): FrameSource | null {
    const current = this.source;
    this.source = null;
    return current;
  }

  async closeWithin(
    timeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS
  ): Promise<boolean> {
    if (this.closeRequested) {
      return true;
    }
    this.closeRequested = true;
    const current = this.detach();
    if (current === null) {
      return true;
    }
    return settleWithin(() => current.close(), timeoutMs);
  }
}
