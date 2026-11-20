import { stat } from "node:fs/promises";
import {
  MAX_EXPORT_FRAME_BYTES,
  OverlayExportError,
  assertExportOutputPath,
  validateExportFps,
  validateExportFrame,
  type OverlayExporter,
  type OverlayExporterStartOptions
} from "@chessonglass/perception";
import {
  spawnHelperProcess,
  type BoundedProcessOptions,
  type HelperProcessHandle
} from "./process-client.js";

/**
 * Injectable spawn seam, mirroring the replay source: unit tests supply a
 * fake child and never touch a real binary; production always passes the
 * pinned FFmpeg path with an argument array and `shell:false` (enforced in
 * `spawnHelperProcess`).
 */
export type OverlayWriterSpawn = (options: BoundedProcessOptions) => HelperProcessHandle;

export type FfmpegOverlayWriterOptions = {
  /** Pinned, approved FFmpeg executable (resolved behind CHESSONGLASS_FFMPEG). */
  ffmpegPath: string;
  /** Absolute, operator-selected directory that bounds every export. */
  exportDirectory: string;
  /** Explicit overwrite permission; the default refuses existing outputs. */
  overwrite?: boolean;
  /** Injectable for tests; defaults to the bounded helper spawner. */
  spawn?: OverlayWriterSpawn;
  /** How long `close` waits for FFmpeg to finalize after stdin EOF. */
  gracefulCloseTimeoutMs?: number;
  /** How long the kill fallback waits before the last-resort kill. */
  killTimeoutMs?: number;
  /** Per-frame byte ceiling; defaults to the shared export ceiling. */
  maxFrameBytes?: number;
};

const DEFAULT_GRACEFUL_CLOSE_MS = 10_000;
const DEFAULT_KILL_TIMEOUT_MS = 5_000;
const STDERR_LIMIT_BYTES = 8 * 1024;
const STDERR_TAIL_CHARS = 200;

/**
 * FFmpeg argument array for the overlay recording. The frame stream arrives
 * on stdin as bounded JPEGs (image2pipe), so `-nostdin` keeps the
 * interactive command reader off the same pipe, the input whitelist names
 * exactly the protocols a stdin input can use (`pipe` on POSIX, `fd` for
 * `-i -` on Windows), and `-y`/`-n` makes the overwrite decision explicit
 * instead of prompting (a prompt would eat frame bytes and hang the export).
 * The output is pinned to limited-range H.264 yuv420p: JPEG input is
 * full-range, and without the explicit `format` + `-color_range tv` pin
 * ffmpeg negotiates the deprecated full-range `yuvj420p` variant instead.
 */
function overlayWriterArgs(options: {
  fps: number;
  outputPath: string;
  overwrite: boolean;
}): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-protocol_whitelist",
    "pipe,fd",
    "-f",
    "image2pipe",
    "-framerate",
    String(options.fps),
    "-i",
    "-",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-vf",
    "format=yuv420p",
    "-color_range",
    "tv",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(options.fps),
    options.overwrite ? "-y" : "-n",
    options.outputPath
  ];
}

type WriterState = "idle" | "running" | "closed";

/**
 * Records rendered overlay JPEG frames into an H.264/yuv420p MP4 with a
 * pinned FFmpeg process. The process is owned from `start` until `close`:
 * shutdown closes stdin, waits a bounded time for FFmpeg to finalize the
 * file, and only then falls back to killing the child — and a killed run is
 * always reported as a failure, never as a finished export.
 *
 * Backpressure policy (enforced, see `OverlayExporter`): pause the upstream.
 * `write` awaits the flush of its chunk — and the stream's drain signal when
 * the high-water mark was hit — before resolving, and concurrent writes are
 * rejected, so at most one frame is ever in flight and writer memory does
 * not grow with the number of exported frames. Frames are never dropped.
 */
export class FfmpegOverlayWriter implements OverlayExporter {
  private readonly options: Required<
    Pick<
      FfmpegOverlayWriterOptions,
      "ffmpegPath" | "exportDirectory" | "overwrite" | "gracefulCloseTimeoutMs" | "killTimeoutMs" | "maxFrameBytes"
    >
  >;
  private readonly spawn: OverlayWriterSpawn;
  private state: WriterState = "idle";
  private closing = false;
  private handle: HelperProcessHandle | null = null;
  private outputPath: string | null = null;
  private writtenCount = 0;
  private failure: OverlayExportError | null = null;
  private exitObserved = false;
  private onAbort: (() => void) | null = null;
  private signal: AbortSignal | null = null;
  private exitPromise: Promise<{ code: number | null }> = Promise.resolve({ code: null });
  private failPendingWrite: ((error: OverlayExportError) => void) | null = null;
  private writeInFlight = false;

  constructor(options: FfmpegOverlayWriterOptions) {
    if (typeof options.ffmpegPath !== "string" || options.ffmpegPath.trim() === "") {
      throw new TypeError("ffmpeg path must be a non-empty string");
    }
    if (typeof options.exportDirectory !== "string" || options.exportDirectory.trim() === "") {
      throw new TypeError("export directory must be a non-empty string");
    }
    this.options = {
      ffmpegPath: options.ffmpegPath,
      exportDirectory: options.exportDirectory,
      overwrite: options.overwrite ?? false,
      gracefulCloseTimeoutMs: options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_MS,
      killTimeoutMs: options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS,
      maxFrameBytes: options.maxFrameBytes ?? MAX_EXPORT_FRAME_BYTES
    };
    this.spawn = options.spawn ?? ((spawnOptions) => spawnHelperProcess(spawnOptions));
  }

  /** Frames accepted so far, for progress surfaces. */
  get framesWritten(): number {
    return this.writtenCount;
  }

  async start(options: OverlayExporterStartOptions): Promise<void> {
    if (this.state !== "idle") {
      throw new OverlayExportError(
        "invalid-state",
        "the export has already been started on this writer"
      );
    }
    const fps = validateExportFps(options.fps);
    const outputPath = assertExportOutputPath(options.outputPath, this.options.exportDirectory);

    const directoryStat = await stat(this.options.exportDirectory).catch(() => null);
    if (directoryStat === null || !directoryStat.isDirectory()) {
      throw new OverlayExportError(
        "output-directory-missing",
        "the export directory does not exist"
      );
    }
    const targetStat = await stat(outputPath).catch(() => null);
    if (targetStat !== null && !this.options.overwrite) {
      throw new OverlayExportError(
        "output-exists",
        "refusing to overwrite an existing export without the overwrite flag"
      );
    }

    this.signal = options.signal;
    this.onAbort = (): void => {
      this.fail(new OverlayExportError("aborted", "the overlay export was aborted"));
    };
    options.signal.addEventListener("abort", this.onAbort, { once: true });

    const handle = this.spawn({
      executable: this.options.ffmpegPath,
      args: overlayWriterArgs({ fps, outputPath, overwrite: this.options.overwrite }),
      stderrLimitBytes: STDERR_LIMIT_BYTES
    });
    this.handle = handle;
    this.outputPath = outputPath;
    this.exitPromise = handle.closed;
    void this.exitPromise.then(({ code }) => this.onExit(code));
    this.state = "running";
  }

  async write(frame: Uint8Array): Promise<void> {
    if (this.state === "idle") {
      throw new OverlayExportError("invalid-state", "the export has not been started");
    }
    if (this.state === "closed" || this.closing) {
      throw new OverlayExportError(
        "invalid-state",
        "the export already closed (late write rejected)"
      );
    }
    if (this.failure !== null) {
      throw this.failure;
    }
    if (this.writeInFlight) {
      // The pause-upstream contract: the caller must await the previous
      // write before offering the next frame. Allowing overlap would buffer
      // per frame, which is exactly the growth this writer forbids.
      throw new OverlayExportError(
        "invalid-state",
        "the previous frame write has not settled; await write before the next frame"
      );
    }
    validateExportFrame(frame, this.options.maxFrameBytes);
    this.writeInFlight = true;
    try {
      await this.writeChunk(frame);
    } finally {
      this.writeInFlight = false;
    }
    this.writtenCount += 1;
  }

  async close(): Promise<{ outputPath: string; framesWritten: number }> {
    if (this.state === "idle") {
      throw new OverlayExportError("invalid-state", "the export was never started");
    }
    if (this.state === "closed" || this.closing) {
      throw new OverlayExportError("invalid-state", "the export already closed");
    }
    this.closing = true;
    const handle = this.handle!;
    const outputPath = this.outputPath!;
    try {
      if (this.signal?.aborted || this.failure?.code === "aborted") {
        if (!this.exitObserved) {
          handle.kill();
        }
        await this.exitPromise;
        throw new OverlayExportError("aborted", "the overlay export was aborted");
      }

      this.endStdin();
      const graceful = await this.waitForExit(this.options.gracefulCloseTimeoutMs);
      if (graceful.timedOut) {
        handle.kill();
        const killed = await this.waitForExit(this.options.killTimeoutMs);
        if (killed.timedOut) {
          handle.kill();
          await this.exitPromise;
        }
        throw new OverlayExportError(
          "process-failed",
          "ffmpeg did not finalize the export within the shutdown window; the process was killed"
        );
      }
      if (graceful.code !== 0) {
        throw new OverlayExportError(
          "process-failed",
          `ffmpeg exited with code ${String(graceful.code)}${this.stderrTail()}`
        );
      }
      return { outputPath, framesWritten: this.writtenCount };
    } finally {
      this.state = "closed";
      this.signal?.removeEventListener("abort", this.onAbort!);
      this.onAbort = null;
      this.handle = null;
    }
  }

  private async writeChunk(bytes: Uint8Array): Promise<void> {
    const stdin = this.handle!.stdin;
    return new Promise<void>((resolve, reject) => {
      if (this.failure !== null) {
        reject(this.failure);
        return;
      }
      let settled = false;
      let onDrain: (() => void) | null = null;
      const finish = (error?: OverlayExportError): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (onDrain !== null) {
          stdin.off("drain", onDrain);
        }
        if (this.failPendingWrite === failFromOutside) {
          this.failPendingWrite = null;
        }
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };
      const failFromOutside = (error: OverlayExportError): void => {
        finish(error);
      };
      this.failPendingWrite = failFromOutside;

      const accepted = stdin.write(bytes, (error) => {
        if (error !== null && error !== undefined) {
          finish(
            new OverlayExportError(
              "process-failed",
              `ffmpeg did not accept an overlay frame: ${error.message}`
            )
          );
          return;
        }
        // When the high-water mark was hit, the flush alone is not enough:
        // wait for the buffer to drain before the next frame is offered.
        if (!settled && onDrain !== null) {
          return;
        }
        finish();
      });
      if (!accepted) {
        onDrain = (): void => finish();
        stdin.once("drain", onDrain);
      }
    });
  }

  private endStdin(): void {
    try {
      this.handle?.stdin.end();
    } catch {
      // The pipe may already be gone with a crashed child; the exit wait
      // below reports the real failure.
    }
  }

  private waitForExit(
    timeoutMs: number
  ): Promise<{ timedOut: boolean; code: number | null }> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({ timedOut: true, code: null });
      }, timeoutMs);
      timer.unref?.();
      void this.exitPromise.then(({ code }) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, code });
      });
    });
  }

  private onExit(code: number | null): void {
    this.exitObserved = true;
    if (this.failure === null && !this.closing) {
      this.failure = new OverlayExportError(
        "process-failed",
        `ffmpeg exited before the export finished (code ${String(code)})`
      );
    }
    this.failPendingWrite?.(
      this.failure ??
        new OverlayExportError("process-failed", "ffmpeg exited during the export")
    );
  }

  private fail(error: OverlayExportError): void {
    if (this.failure !== null) {
      return;
    }
    this.failure = error;
    if (!this.exitObserved && this.handle !== null) {
      this.handle.kill();
    }
    this.failPendingWrite?.(error);
  }

  private stderrTail(): string {
    const text = this.handle?.stderrText().trim() ?? "";
    if (text === "") {
      return "";
    }
    const tail = text.length > STDERR_TAIL_CHARS ? `…${text.slice(-STDERR_TAIL_CHARS)}` : text;
    return `: ${tail}`;
  }
}
