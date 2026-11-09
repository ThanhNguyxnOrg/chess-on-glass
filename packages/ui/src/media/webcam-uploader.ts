/** Browser-side webcam capture boundary; the DOM implementation is separate. */
export type WebcamCapture = {
  start(deviceId: string | null): Promise<void>;
  stop(): void;
  /** Grab one JPEG, or null when the video is not ready yet. */
  grab(): Promise<Blob | null>;
};

export type WebcamFrameSender = (input: {
  jpeg: Blob;
  sequence: bigint;
  capturedAtWallMs: number;
  signal: AbortSignal;
}) => Promise<void>;

export type WebcamUploaderOptions = {
  capture: WebcamCapture;
  send: WebcamFrameSender;
  fps?: number;
  now?: () => number;
  setInterval?: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
};

const DEFAULT_FPS = 2;
const MIN_FPS = 1;
const MAX_FPS = 10;

/**
 * Captures at a bounded rate with at most one upload in flight. Stopping
 * aborts the active upload, clears the timer and releases the media tracks.
 */
export class WebcamUploader {
  private readonly capture: WebcamCapture;
  private readonly send: WebcamFrameSender;
  private readonly fps: number;
  private readonly now: () => number;
  private readonly setIntervalFn: (
    callback: () => void,
    milliseconds: number
  ) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private sequence = 0n;
  private error: string | null = null;

  constructor(options: WebcamUploaderOptions) {
    const fps = options.fps ?? DEFAULT_FPS;
    if (!Number.isSafeInteger(fps) || fps < MIN_FPS || fps > MAX_FPS) {
      throw new RangeError(`fps must be an integer between ${MIN_FPS} and ${MAX_FPS}`);
    }
    this.capture = options.capture;
    this.send = options.send;
    this.fps = fps;
    this.now = options.now ?? (() => Date.now());
    this.setIntervalFn = options.setInterval ?? setInterval;
    this.clearIntervalFn = options.clearInterval ?? clearInterval;
  }

  get lastError(): string | null {
    return this.error;
  }

  async start(deviceId: string | null): Promise<void> {
    if (this.running) {
      return;
    }
    await this.capture.start(deviceId);
    this.running = true;
    this.timer = this.setIntervalFn(
      () => {
        void this.captureOnce();
      },
      Math.round(1000 / this.fps)
    );
  }

  captureOnce(): Promise<void> {
    if (!this.running || this.inFlight !== null) {
      return Promise.resolve();
    }
    const controller = new AbortController();
    this.controller = controller;

    const task = (async () => {
      try {
        const jpeg = await this.capture.grab();
        if (jpeg === null) {
          return;
        }
        this.sequence += 1n;
        await this.send({
          jpeg,
          sequence: this.sequence,
          capturedAtWallMs: this.now(),
          signal: controller.signal
        });
        this.error = null;
      } catch (error) {
        if (!controller.signal.aborted) {
          this.error =
            error instanceof Error ? error.message : "webcam upload failed";
        }
      } finally {
        if (this.controller === controller) {
          this.controller = null;
        }
        this.inFlight = null;
      }
    })();

    this.inFlight = task;
    return task;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    this.controller?.abort();
    this.capture.stop();
    const pending = this.inFlight;
    if (pending !== null) {
      await pending;
    }
  }
}
