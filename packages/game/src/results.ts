import type { RequestContext } from "@chessonglass/contracts";
import type { Result } from "./coordinator.js";

/**
 * An independent output channel. The structured `Result` stays intact so UI,
 * audio, file and future clients each select the part they render. A sink
 * failure is reported to the caller but never owns chess state.
 */
export interface ResultSink {
  publish(result: Result): Promise<void>;
  clear(context?: RequestContext): void;
  close(): Promise<void>;
}

const DEFAULT_MAX_QUEUE = 4;

export type QueuedTextSinkOptions = {
  /** Unstarted utterances retained before the oldest is dropped. */
  maxQueue?: number;
};

type QueuedText = {
  readonly text: string;
  readonly sessionId: RequestContext["sessionId"];
  readonly positionVersion: number;
};

function samePositionText(item: QueuedText, context: RequestContext): boolean {
  return (
    item.sessionId === context.sessionId &&
    item.positionVersion === context.positionVersion
  );
}

/**
 * Serializes text output through an injected `speak` function. Only one
 * utterance plays at a time; the queue is bounded and `clear` removes
 * unstarted text from an invalidated position. In-flight speech is never
 * aborted or reported as unheard: a backend that ignores the abort signal
 * keeps playing, and `close` waits for the real utterance to settle.
 */
export class QueuedTextSink implements ResultSink {
  private readonly speak: (text: string, signal: AbortSignal) => Promise<void>;
  private readonly maxQueue: number;
  private readonly queue: QueuedText[] = [];
  private activeController: AbortController | null = null;
  private worker: Promise<void> | null = null;
  private working = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    speak: (text: string, signal: AbortSignal) => Promise<void>,
    options: QueuedTextSinkOptions = {}
  ) {
    if (typeof speak !== "function") {
      throw new TypeError("speak must be a function");
    }
    const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    if (!Number.isSafeInteger(maxQueue) || maxQueue <= 0) {
      throw new RangeError("maxQueue must be a positive safe integer");
    }
    this.speak = speak;
    this.maxQueue = maxQueue;
  }

  publish(result: Result): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("result sink is closed"));
    }
    if (result.spokenText === null) {
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueue) {
      // Keep the newest output; the oldest unstarted text is the stalest.
      this.queue.shift();
    }
    this.queue.push({
      text: result.spokenText,
      sessionId: result.context.sessionId,
      positionVersion: result.context.positionVersion
    });
    this.startWorker();
    return Promise.resolve();
  }

  clear(context?: RequestContext): void {
    if (context === undefined) {
      this.queue.length = 0;
      return;
    }
    const kept = this.queue.filter((item) => !samePositionText(item, context));
    this.queue.length = 0;
    this.queue.push(...kept);
  }

  async close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    this.closed = true;
    this.queue.length = 0;
    this.activeController?.abort("result sink closed");
    this.closePromise = (async () => {
      if (this.worker !== null) {
        await this.worker;
      }
    })();
    return this.closePromise;
  }

  private startWorker(): void {
    if (this.working || this.closed) {
      return;
    }
    this.working = true;
    this.worker = this.drain().catch(() => undefined);
  }

  private async drain(): Promise<void> {
    while (!this.closed) {
      const item = this.queue.shift();
      if (item === undefined) {
        break;
      }
      const controller = new AbortController();
      this.activeController = controller;
      await this.speak(item.text, controller.signal).then(
        () => undefined,
        () => undefined
      );
      this.activeController = null;
    }
    this.working = false;
  }
}

/**
 * Fans one result out to independent sinks. Every sink sees every result;
 * failures are reported after all sinks had their chance, so one unavailable
 * channel cannot silence the others or corrupt game state.
 */
export class CompositeResultSink implements ResultSink {
  private readonly sinks: readonly ResultSink[];
  private closePromise: Promise<void> | null = null;

  constructor(sinks: readonly ResultSink[]) {
    this.sinks = [...sinks];
  }

  async publish(result: Result): Promise<void> {
    const outcomes = await Promise.allSettled(
      this.sinks.map((sink) => sink.publish(result))
    );
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} of ${outcomes.length} result sinks failed to publish`
      );
    }
  }

  clear(context?: RequestContext): void {
    for (const sink of this.sinks) {
      try {
        sink.clear(context);
      } catch {
        // One sink must not block invalidation of the others.
      }
    }
  }

  async close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    this.closePromise = (async () => {
      const outcomes = await Promise.allSettled(
        this.sinks.map((sink) => sink.close())
      );
      const failures = outcomes.filter(
        (outcome) => outcome.status === "rejected"
      );
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} of ${outcomes.length} result sinks failed to close`
        );
      }
    })();
    return this.closePromise;
  }
}
