import type { Frame } from "./frames.js";

const DEFAULT_LIMIT_BYTES = 1_048_576;

type Waiter = {
  readonly signal: AbortSignal;
  readonly resolve: (frame: Frame | null) => void;
  readonly onAbort: () => void;
};

/**
 * A bounded latest-frame mailbox. Producers offer frames; consumers await one
 * fresh frame. At most one frame is retained, so slow consumers never grow an
 * unbounded backlog. Sequence ordering is tracked per (session, source).
 */
export class LatestFrameMailbox {
  private readonly limitBytes: number;
  private readonly lastSequences = new Map<string, bigint>();
  private readonly waiters: Waiter[] = [];
  private pending: Frame | null = null;
  private closed = false;

  constructor(limitBytes: number = DEFAULT_LIMIT_BYTES) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
      throw new TypeError("mailbox limit must be a positive safe integer");
    }
    this.limitBytes = limitBytes;
  }

  offer(frame: Frame): "accepted" | "duplicate" | "out-of-order" | "too-large" {
    if (this.closed) {
      throw new Error("mailbox is closed");
    }
    if (frame.bytes.byteLength > this.limitBytes) {
      return "too-large";
    }

    const key = `${frame.sessionId}\u0000${frame.sourceId}`;
    const last = this.lastSequences.get(key);
    if (last !== undefined) {
      if (frame.sequence === last) {
        return "duplicate";
      }
      if (frame.sequence < last) {
        return "out-of-order";
      }
    }
    this.lastSequences.set(key, frame.sequence);

    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(frame);
    } else {
      this.pending = frame;
    }
    return "accepted";
  }

  next(signal: AbortSignal): Promise<Frame | null> {
    if (signal.aborted || this.closed) {
      return Promise.resolve(null);
    }
    if (this.pending !== null) {
      const frame = this.pending;
      this.pending = null;
      return Promise.resolve(frame);
    }

    return new Promise<Frame | null>((resolve) => {
      const onAbort = (): void => {
        this.removeWaiter(waiter);
        resolve(null);
      };
      const waiter: Waiter = { signal, resolve, onAbort };
      this.waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.pending = null;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(null);
    }
  }

  private removeWaiter(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) {
      this.waiters.splice(index, 1);
    }
  }
}
