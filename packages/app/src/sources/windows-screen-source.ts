import type {
  Capabilities,
  Frame,
  FrameSource,
  SessionId,
  SourceId
} from "@chessonglass/contracts";

/** The subset of a native capture frame this source depends on. */
export type NativeCaptureFrame = {
  readonly width: number;
  readonly height: number;
  encode(format: unknown): Buffer;
};

/** A started-or-startable native capture session (one target). */
export type NativeCaptureSession = {
  start(): Promise<void>;
  nextFrame(): Promise<NativeCaptureFrame | undefined>;
  stop(): Promise<void>;
};

export type WindowsScreenSourceOptions = {
  sessionId: SessionId;
  sourceId: SourceId;
  session: NativeCaptureSession;
  /** Encode one native frame into a bounded JPEG. Always provided by the client. */
  encodeJpeg(frame: NativeCaptureFrame): Promise<Uint8Array>;
  now?(): number;
  firstFrameTimeoutMs?: number;
};

const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 15_000;

function abortPromise(signal: AbortSignal): Promise<undefined> {
  if (signal.aborted) {
    return Promise.resolve(undefined);
  }
  return new Promise<undefined>((resolve) => {
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
}

/**
 * Adapts one native capture session into a FrameSource. Freshness uses the
 * backend receipt clock; the native capture clock is not exposed. A frame
 * produced before close is still deliverable, later native events are not.
 */
export class WindowsScreenSource implements FrameSource {
  readonly capabilities: Capabilities = Object.freeze({
    video: true,
    microphone: false,
    audioOutput: false,
    display: false
  });

  private readonly sessionId: SessionId;
  private readonly sourceId: SourceId;
  private readonly session: NativeCaptureSession;
  private readonly encodeJpeg: (frame: NativeCaptureFrame) => Promise<Uint8Array>;
  private readonly now: () => number;
  private readonly firstFrameTimeoutMs: number;

  private sequence = 0n;
  private closed = false;
  private pending: NativeCaptureFrame | null = null;

  private constructor(options: WindowsScreenSourceOptions) {
    this.sessionId = options.sessionId;
    this.sourceId = options.sourceId;
    this.session = options.session;
    this.encodeJpeg = options.encodeJpeg;
    this.now = options.now ?? (() => performance.now());
    this.firstFrameTimeoutMs =
      options.firstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS;
  }

  static async open(options: WindowsScreenSourceOptions): Promise<WindowsScreenSource> {
    const source = new WindowsScreenSource(options);
    await source.session.start();
    const first = await Promise.race([
      source.session.nextFrame(),
      timeoutValue(source.firstFrameTimeoutMs)
    ]);
    if (first === undefined) {
      await source.session.stop().catch(() => undefined);
      throw new Error(
        `window capture produced no first frame within ${source.firstFrameTimeoutMs}ms`
      );
    }
    source.pending = first;
    return source;
  }

  async next(signal: AbortSignal): Promise<Frame | null> {
    if (this.closed) {
      return null;
    }
    let frame: NativeCaptureFrame | null | undefined = this.pending;
    this.pending = null;
    if (frame === null) {
      frame = await Promise.race([
        this.session.nextFrame(),
        abortPromise(signal)
      ]);
    }
    if (frame === undefined || frame === null) {
      return null;
    }

    const bytes = await this.encodeJpeg(frame);
    this.sequence += 1n;
    return {
      sessionId: this.sessionId,
      sourceId: this.sourceId,
      sequence: this.sequence,
      capturedAtMonotonicMs: null,
      capturedAtWallMs: Date.now(),
      receivedAtMonotonicMs: this.now(),
      bytes,
      mimeType: "image/jpeg"
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.session.stop().catch(() => undefined);
  }
}

function timeoutValue(milliseconds: number): Promise<undefined> {
  return new Promise<undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), milliseconds);
    timer.unref?.();
  });
}
