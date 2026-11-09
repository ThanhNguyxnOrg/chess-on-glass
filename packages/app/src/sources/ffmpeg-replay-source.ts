import type {
  Capabilities,
  Frame,
  FrameSource,
  SessionId,
  SourceId
} from "@chessonglass/contracts";
import {
  spawnBoundedProcess,
  type BoundedProcessHandle
} from "../native/process-client.js";
import { JpegSplitter } from "./jpeg-splitter.js";

export type ReplayOptions = {
  sessionId: SessionId;
  sourceId: SourceId;
  path: string;
  ffmpegPath: string;
  speed?: number;
  fps?: number;
};

export type FfmpegSpawn = (options: {
  executable: string;
  args: readonly string[];
  stderrLimitBytes?: number;
}) => BoundedProcessHandle;

export type ReplayDependencies = {
  spawn?: FfmpegSpawn;
  firstFrameTimeoutMs?: number;
  maxFrameBytes?: number;
};

const DEFAULT_SPEED = 1;
const DEFAULT_FPS = 5;
const MIN_SPEED = 0.25;
const MAX_SPEED = 4;
const MIN_FPS = 1;
const MAX_FPS = 10;
const FIRST_FRAME_TIMEOUT_MS = 15_000;
const MAX_FRAME_BYTES = 5 * 1024 * 1024;
const MAX_WIDTH = 1280;

type Waiter = {
  resolve: (frame: Frame | null) => void;
  signal: AbortSignal;
  onAbort: () => void;
};

/**
 * Capacity-one replay buffer with drain-on-EOF semantics: a frame already
 * produced stays deliverable after the process ends, and the next call after
 * the queue is empty returns null instead of waiting forever.
 */
class ReplaySlot {
  private pending: Frame | null = null;
  private waiters: Waiter[] = [];
  private ended = false;

  push(frame: Frame): void {
    if (this.ended) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(frame);
      return;
    }
    this.pending = frame;
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(null);
    }
  }

  next(signal: AbortSignal): Promise<Frame | null> {
    if (this.pending !== null) {
      const frame = this.pending;
      this.pending = null;
      return Promise.resolve(frame);
    }
    if (this.ended || signal.aborted) {
      return Promise.resolve(null);
    }
    return new Promise<Frame | null>((resolve) => {
      const waiter: Waiter = {
        resolve,
        signal,
        onAbort: (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          resolve(null);
        }
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal.aborted) {
        waiter.onAbort();
      }
    });
  }
}

function validateReplayOptions(options: ReplayOptions): Required<ReplayOptions> {
  if (typeof options.path !== "string" || options.path.trim() === "") {
    throw new TypeError("replay path must be a non-empty string");
  }
  if (typeof options.ffmpegPath !== "string" || options.ffmpegPath.trim() === "") {
    throw new TypeError("ffmpeg path must be a non-empty string");
  }
  const speed = options.speed ?? DEFAULT_SPEED;
  if (
    typeof speed !== "number" ||
    !Number.isFinite(speed) ||
    speed < MIN_SPEED ||
    speed > MAX_SPEED
  ) {
    throw new RangeError(
      `replay speed must be a finite number between ${MIN_SPEED} and ${MAX_SPEED}`
    );
  }
  const fps = options.fps ?? DEFAULT_FPS;
  if (!Number.isSafeInteger(fps) || fps < MIN_FPS || fps > MAX_FPS) {
    throw new RangeError(
      `replay fps must be an integer between ${MIN_FPS} and ${MAX_FPS}`
    );
  }
  return { ...options, speed, fps };
}

function replayArgs(options: Required<ReplayOptions>): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-readrate",
    String(options.speed),
    "-i",
    options.path,
    "-vf",
    `fps=${options.fps},scale='min(${MAX_WIDTH},iw)':-2`,
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-q:v",
    "3",
    "-"
  ];
}

/**
 * A bounded, cancellable FFmpeg replay source: frames stream out of
 * `image2pipe`, never through frame files, and the child is owned until
 * close. The executable is always passed as a pinned path with an argument
 * array; no shell string is built from the user's file path.
 */
export class FfmpegReplaySource implements FrameSource {
  readonly capabilities: Capabilities = Object.freeze({
    video: true,
    microphone: false,
    audioOutput: false,
    display: false
  });

  private readonly handle: BoundedProcessHandle;
  private readonly slot = new ReplaySlot();
  private readonly splitter: JpegSplitter;
  private readonly options: Required<ReplayOptions>;
  private closed = false;
  private sequence = 0n;
  private firstFrameSettled = false;
  private resolveFirstFrame: (() => void) | null = null;
  private rejectFirstFrame: ((error: Error) => void) | null = null;

  private constructor(
    options: Required<ReplayOptions>,
    handle: BoundedProcessHandle,
    splitter: JpegSplitter
  ) {
    this.options = options;
    this.handle = handle;
    this.splitter = splitter;

    handle.stdout.on("data", (chunk: Buffer) => this.onChunk(chunk));
    void handle.closed.then(({ code }) => this.onExit(code));
  }

  static async open(
    options: ReplayOptions,
    dependencies: ReplayDependencies = {}
  ): Promise<FfmpegReplaySource> {
    const valid = validateReplayOptions(options);
    const splitter = new JpegSplitter(
      dependencies.maxFrameBytes ?? MAX_FRAME_BYTES
    );
    const spawnFn =
      dependencies.spawn ??
      ((spawnOptions) => spawnBoundedProcess(spawnOptions));
    const handle = spawnFn({
      executable: valid.ffmpegPath,
      args: replayArgs(valid),
      stderrLimitBytes: 8 * 1024
    });

    const source = new FfmpegReplaySource(valid, handle, splitter);
    await source.waitForFirstFrame(
      dependencies.firstFrameTimeoutMs ?? FIRST_FRAME_TIMEOUT_MS
    );
    return source;
  }

  next(signal: AbortSignal): Promise<Frame | null> {
    return this.slot.next(signal);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.slot.end();
    this.handle.kill();
    await this.handle.closed;
  }

  private waitForFirstFrame(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.resolveFirstFrame = () => {
        this.firstFrameSettled = true;
        resolve();
      };
      this.rejectFirstFrame = (error: Error) => {
        this.firstFrameSettled = true;
        reject(error);
      };

      const timer = setTimeout(() => {
        if (!this.firstFrameSettled) {
          this.fail(
            new Error(`ffmpeg produced no frame within ${timeoutMs}ms`)
          );
        }
      }, timeoutMs);
      timer.unref?.();
    });
  }

  private onChunk(chunk: Buffer): void {
    if (this.closed) {
      return;
    }
    let frames: Uint8Array[];
    try {
      frames = this.splitter.push(new Uint8Array(chunk));
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new Error("malformed jpeg stream")
      );
      return;
    }

    if (frames.length === 0) {
      return;
    }
    for (const bytes of frames) {
      this.sequence += 1n;
      this.slot.push({
        sessionId: this.options.sessionId,
        sourceId: this.options.sourceId,
        sequence: this.sequence,
        capturedAtMonotonicMs: null,
        capturedAtWallMs: Date.now(),
        receivedAtMonotonicMs: performance.now(),
        bytes,
        mimeType: "image/jpeg"
      });
    }
    if (!this.firstFrameSettled) {
      this.resolveFirstFrame?.();
    }
  }

  private onExit(code: number | null): void {
    if (!this.firstFrameSettled) {
      this.rejectFirstFrame?.(
        new Error(`ffmpeg exited before the first frame (code ${String(code)})`)
      );
    }
    this.slot.end();
  }

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.slot.end();
    if (!this.firstFrameSettled) {
      this.rejectFirstFrame?.(error);
    }
    this.handle.kill();
  }
}
