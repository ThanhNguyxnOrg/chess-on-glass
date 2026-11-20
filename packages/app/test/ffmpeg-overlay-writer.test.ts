import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OverlayExportError } from "@chessonglass/perception";
import type { HelperProcessHandle } from "../src/native/process-client.js";
import {
  FfmpegOverlayWriter,
  type OverlayWriterSpawn
} from "../src/native/ffmpeg-overlay-writer.js";

const SOI = [0xff, 0xd8, 0xff, 0xe0];
const EOI = [0xff, 0xd9];

function jpegBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 4));
  bytes[0] = SOI[0];
  bytes[1] = SOI[1];
  bytes[bytes.byteLength - 2] = EOI[0];
  bytes[bytes.byteLength - 1] = EOI[1];
  return bytes;
}

/**
 * A stdin stand-in whose write callbacks are held until the test releases
 * them, simulating an OS pipe nobody is draining (the freeze case) while
 * keeping real stream semantics (false return value, automatic drain).
 */
class HeldWritable extends Writable {
  readonly held: Array<(error?: Error | null) => void> = [];

  constructor(highWaterMark: number) {
    super({ highWaterMark });
    this.on("error", () => undefined);
  }

  _write(
    _chunk: unknown,
    _encoding: unknown,
    callback: (error?: Error | null) => void
  ): void {
    this.held.push(callback);
  }

  releaseNext(): void {
    this.held.shift()?.(null);
  }

  get heldCount(): number {
    return this.held.length;
  }
}

class FakeFfmpeg implements HelperProcessHandle {
  readonly stdin: Writable;
  readonly stdout: PassThrough = new PassThrough();
  killCalls = 0;
  stderrStored = "";

  private resolveClosed!: (value: { code: number | null }) => void;
  readonly closed: Promise<{ code: number | null }>;

  constructor(stdin: Writable) {
    this.stdin = stdin;
    let settle!: (value: { code: number | null }) => void;
    this.closed = new Promise<{ code: number | null }>((resolve) => {
      settle = resolve;
    });
    this.resolveClosed = settle;
  }

  exit(code: number): void {
    this.resolveClosed({ code });
  }

  kill(): void {
    this.killCalls += 1;
    this.stdin.destroy();
    this.resolveClosed({ code: null });
  }

  stderrText(): string {
    return this.stderrStored;
  }
}

type Harness = {
  writer: FfmpegOverlayWriter;
  child: FakeFfmpeg;
  spawnCalls: Array<{ executable: string; args: readonly string[] }>;
  exportDirectory: string;
};

function harness(
  exportDirectory: string,
  options: {
    holdStdin?: boolean;
    highWaterMark?: number;
    gracefulCloseTimeoutMs?: number;
    killTimeoutMs?: number;
    overwrite?: boolean;
    maxFrameBytes?: number;
  } = {}
): Harness {
  const stdin =
    options.holdStdin === true
      ? new HeldWritable(options.highWaterMark ?? 1024)
      : new Writable({
          highWaterMark: options.highWaterMark ?? 16 * 1024,
          write: (_chunk, _encoding, callback) => callback()
        });
  stdin.on("error", () => undefined);
  const child = new FakeFfmpeg(stdin);
  const spawnCalls: Array<{ executable: string; args: readonly string[] }> = [];
  const spawn: OverlayWriterSpawn = (spawnOptions) => {
    spawnCalls.push({
      executable: spawnOptions.executable,
      args: [...spawnOptions.args]
    });
    return child;
  };
  const writer = new FfmpegOverlayWriter({
    ffmpegPath: "C:\\tools\\ffmpeg.exe",
    exportDirectory,
    spawn,
    ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
    ...(options.gracefulCloseTimeoutMs === undefined
      ? {}
      : { gracefulCloseTimeoutMs: options.gracefulCloseTimeoutMs }),
    ...(options.killTimeoutMs === undefined
      ? {}
      : { killTimeoutMs: options.killTimeoutMs }),
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes })
  });
  return { writer, child, spawnCalls, exportDirectory };
}

function startOptions(exportDirectory: string, fileName = "out.mp4"): {
  outputPath: string;
  fps: number;
  signal: AbortSignal;
} {
  return {
    outputPath: join(exportDirectory, fileName),
    fps: 10,
    signal: new AbortController().signal
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<OverlayExportError> {
  try {
    await promise;
  } catch (error) {
    return error as OverlayExportError;
  }
  throw new Error("expected the promise to reject");
}

describe("FfmpegOverlayWriter", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cog-exporter-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("spawns the pinned ffmpeg with pipe input and h264 mp4 output", async () => {
    const h = harness(directory);
    const outputPath = join(directory, "out.mp4");
    await h.writer.start({
      outputPath,
      fps: 10,
      signal: new AbortController().signal
    });

    expect(h.spawnCalls).toHaveLength(1);
    const spawn = h.spawnCalls[0]!;
    expect(spawn.executable).toBe("C:\\tools\\ffmpeg.exe");
    expect(spawn.args[0]).toBe("-nostdin");
    expect(spawn.args).toContain("-i");
    expect(spawn.args[spawn.args.indexOf("-i") + 1]).toBe("-");
    expect(spawn.args).toContain("image2pipe");
    expect(spawn.args).toContain("libx264");
    expect(spawn.args).toContain("yuv420p");
    expect(spawn.args[spawn.args.indexOf("-framerate") + 1]).toBe("10");
    expect(spawn.args[spawn.args.indexOf("-r") + 1]).toBe("10");
    const whitelist = spawn.args.indexOf("-protocol_whitelist");
    expect(whitelist).toBeGreaterThan(-1);
    expect(spawn.args[whitelist + 1]).toBe("pipe,fd");
    expect(spawn.args).toContain("-n");
    expect(spawn.args[spawn.args.length - 1]).toBe(outputPath);
  });

  it("allows overwrite only through the explicit flag", async () => {
    const h = harness(directory);
    await h.writer.start(startOptions(directory));
    expect(h.spawnCalls[0]!.args).not.toContain("-y");

    const forced = harness(directory, { overwrite: true });
    await forced.writer.start(startOptions(directory, "forced.mp4"));
    expect(forced.spawnCalls[0]!.args).toContain("-y");
    expect(forced.spawnCalls[0]!.args).not.toContain("-n");
  });

  it("writes bounded jpeg frames and closes with a graceful exit", async () => {
    const h = harness(directory);
    await h.writer.start(startOptions(directory));

    for (let index = 0; index < 3; index += 1) {
      await h.writer.write(jpegBytes(64));
    }
    expect(h.child.stdin.writableEnded).toBe(false);

    const closing = h.writer.close();
    h.child.exit(0);
    await expect(closing).resolves.toEqual({
      outputPath: join(directory, "out.mp4"),
      framesWritten: 3
    });
    expect(h.child.stdin.writableEnded).toBe(true);
    // A clean exit needs no kill: the process was allowed to finalize.
    expect(h.child.killCalls).toBe(0);
  });

  it("rejects a second start, close before start, and double close", async () => {
    const h = harness(directory);
    await h.writer.start(startOptions(directory));
    const second = await rejectionOf(
      h.writer.start(startOptions(directory, "second.mp4"))
    );
    expect(second.code).toBe("invalid-state");

    const closing = h.writer.close();
    h.child.exit(0);
    await closing;

    const late = await rejectionOf(h.writer.close());
    expect(late.code).toBe("invalid-state");
  });

  it("rejects writes before start and after close (late write)", async () => {
    const h = harness(directory);
    const before = await rejectionOf(h.writer.write(jpegBytes(32)));
    expect(before.code).toBe("invalid-state");

    await h.writer.start(startOptions(directory));
    const closing = h.writer.close();
    h.child.exit(0);
    await closing;

    const after = await rejectionOf(h.writer.write(jpegBytes(32)));
    expect(after.code).toBe("invalid-state");
  });

  it("validates fps, target path and directory before spawning", async () => {
    const h = harness(directory);
    const base = startOptions(directory);

    expect((await rejectionOf(h.writer.start({ ...base, fps: 0 }))).code).toBe(
      "invalid-fps"
    );
    expect((await rejectionOf(h.writer.start({ ...base, outputPath: "out.mp4" }))).code).toBe(
      "invalid-output-path"
    );
    const outside = resolve(directory, "..", "elsewhere.mp4");
    expect((await rejectionOf(h.writer.start({ ...base, outputPath: outside }))).code).toBe(
      "output-outside-directory"
    );

    const missing = harness(join(directory, "nope"));
    expect(
      (await rejectionOf(missing.writer.start(startOptions(join(directory, "nope")))))
        .code
    ).toBe("output-directory-missing");

    expect(h.spawnCalls).toHaveLength(0);
    expect(missing.spawnCalls).toHaveLength(0);
  });

  it("refuses to overwrite an existing export unless overwrite is set", async () => {
    const outputPath = join(directory, "existing.mp4");
    await writeFile(outputPath, Uint8Array.from([0x00]));

    const h = harness(directory);
    const refused = await rejectionOf(
      h.writer.start({ outputPath, fps: 10, signal: new AbortController().signal })
    );
    expect(refused.code).toBe("output-exists");
    expect(h.spawnCalls).toHaveLength(0);

    const forced = harness(directory, { overwrite: true });
    await forced.writer.start({ outputPath, fps: 10, signal: new AbortController().signal });
    expect(forced.spawnCalls).toHaveLength(1);
  });

  it("rejects malformed and oversized frames without counting them", async () => {
    const h = harness(directory, { maxFrameBytes: 16 });
    await h.writer.start(startOptions(directory));

    const badSoi = jpegBytes(8);
    badSoi[0] = 0x00;
    expect((await rejectionOf(h.writer.write(badSoi))).code).toBe("invalid-frame");

    const badEoi = jpegBytes(8);
    badEoi[badEoi.byteLength - 1] = 0x00;
    expect((await rejectionOf(h.writer.write(badEoi))).code).toBe("invalid-frame");

    expect((await rejectionOf(h.writer.write(jpegBytes(64)))).code).toBe(
      "frame-too-large"
    );

    await h.writer.write(jpegBytes(8));
    const closing = h.writer.close();
    h.child.exit(0);
    const result = await closing;
    expect(result.framesWritten).toBe(1);
  });

  it("serializes writes: a concurrent write is rejected", async () => {
    const h = harness(directory, { holdStdin: true });
    await h.writer.start(startOptions(directory));
    const stdin = h.child.stdin as HeldWritable;

    let firstSettled = false;
    const first = h.writer.write(jpegBytes(2048)).then(() => {
      firstSettled = true;
    });
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    const concurrent = await rejectionOf(h.writer.write(jpegBytes(8)));
    expect(concurrent.code).toBe("invalid-state");

    stdin.releaseNext();
    await first;
  });

  it("keeps stream memory bounded while frames are written", async () => {
    const h = harness(directory, { holdStdin: true, highWaterMark: 1024 });
    await h.writer.start(startOptions(directory));
    const stdin = h.child.stdin as HeldWritable;

    let peak = 0;
    for (let index = 0; index < 24; index += 1) {
      const written = h.writer.write(jpegBytes(2048));
      peak = Math.max(peak, stdin.writableLength);
      stdin.releaseNext();
      await written;
      // Every accepted frame is fully flushed before the next one is offered.
      expect(stdin.writableLength).toBe(0);
    }
    // One frame in flight plus the stream's own buffer: never per-frame growth.
    expect(peak).toBeLessThanOrEqual(2048 + 1024);
    expect(stdin.heldCount).toBe(0);

    const closing = h.writer.close();
    h.child.exit(0);
    await closing;
  });

  it("fails the in-flight write when ffmpeg exits mid-export", async () => {
    const h = harness(directory, { holdStdin: true });
    await h.writer.start(startOptions(directory));

    const pending = h.writer.write(jpegBytes(2048));
    h.child.exit(1);

    const failure = await rejectionOf(pending);
    expect(failure.code).toBe("process-failed");
  });

  it("reports a nonzero exit at close as a process failure", async () => {
    const h = harness(directory);
    h.child.stderrStored = "encoder failed";
    await h.writer.start(startOptions(directory));
    await h.writer.write(jpegBytes(32));

    const closing = h.writer.close();
    h.child.exit(1);
    const failure = await rejectionOf(closing);
    expect(failure.code).toBe("process-failed");
    expect(failure.message).toContain("code 1");
  });

  it("kills ffmpeg when it never finalizes and reports the shutdown", async () => {
    const h = harness(directory, {
      holdStdin: true,
      gracefulCloseTimeoutMs: 25,
      killTimeoutMs: 25
    });
    await h.writer.start(startOptions(directory));

    const written = h.writer.write(jpegBytes(2048));
    (h.child.stdin as HeldWritable).releaseNext();
    await written;

    // Freeze: the child consumes nothing and never exits on its own, so the
    // bounded shutdown must kill it instead of waiting forever.
    const failure = await rejectionOf(h.writer.close());
    expect(failure.code).toBe("process-failed");
    expect(h.child.killCalls).toBe(1);
  }, 15_000);

  it("aborts the export, kills the process and rejects late writes", async () => {
    const h = harness(directory, { holdStdin: true });
    const controller = new AbortController();
    await h.writer.start({
      ...startOptions(directory),
      signal: controller.signal
    });

    const pending = h.writer.write(jpegBytes(2048));
    controller.abort();

    const failure = await rejectionOf(pending);
    expect(failure.code).toBe("aborted");
    expect(h.child.killCalls).toBe(1);

    const late = await rejectionOf(h.writer.write(jpegBytes(8)));
    expect(late.code).toBe("aborted");

    const closed = await rejectionOf(h.writer.close());
    expect(closed.code).toBe("aborted");
    expect(h.child.killCalls).toBe(1);
  });

  it("starts a fresh export on a new writer after a completed one", async () => {
    const first = harness(directory);
    await first.writer.start(startOptions(directory, "one.mp4"));
    await first.writer.write(jpegBytes(32));
    const closing = first.writer.close();
    first.child.exit(0);
    await closing;

    const second = harness(directory);
    await second.writer.start(startOptions(directory, "two.mp4"));
    await second.writer.write(jpegBytes(32));
    const secondClose = second.writer.close();
    second.child.exit(0);
    await expect(secondClose).resolves.toMatchObject({ framesWritten: 1 });
  });
});
