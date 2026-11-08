/**
 * Where frames come from: the WhatsApp call window, or a recording.
 *
 * Live sources have `grab()`, which returns the newest frame right now (or null), and
 * `finished`, which turns true when a recording runs out. VideoFile is for the eval: it steps
 * through a recording at fixed intervals instead of in real time.
 */

import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";

import { callWindow, capture } from "./macos.js";

export const MAX_EDGE = 2576; // longest image edge the vision models read at full detail

export interface Frame {
  jpeg: Buffer;
  t: number; // seconds since the source started
}

export interface Source {
  grab(): Promise<Frame | null>;
  readonly finished: boolean;
}

/** An image as JPEG, upright and shrunk to fit `maxEdge` (never enlarged). */
export async function toJpeg(image: Buffer, maxEdge = MAX_EDGE): Promise<Buffer> {
  return sharp(image)
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** Frames from the WhatsApp call window. `windowId` overrides finding it automatically. */
export class CallWindow implements Source {
  readonly finished = false;
  private readonly started = performance.now();

  constructor(readonly windowId?: number) {}

  async grab(): Promise<Frame | null> {
    const window = await callWindow(this.windowId);
    if (window === null) return null;
    const data = await capture(window.id);
    if (data === null) return null;
    return { jpeg: await toJpeg(data), t: (performance.now() - this.started) / 1000 };
  }
}

function ffmpeg(): string {
  if (!ffmpegPath) throw new Error("ffmpeg isn't available for this Mac (the ffmpeg-static package has no build for it).");
  return ffmpegPath as unknown as string;
}

/** Splits a stream of back-to-back JPEGs (what ffmpeg's image2pipe writes) into images. */
export class JpegSplitter {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const images: Buffer[] = [];
    for (;;) {
      const start = this.pending.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) break;
      const end = this.pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) break;
      images.push(this.pending.subarray(start, end + 2));
      this.pending = this.pending.subarray(end + 2);
    }
    return images;
  }
}

/** A recording played back in real time (or `speed` times faster), as if it were the call. */
export class Replay implements Source {
  finished = false;
  private latest: Frame | null = null;
  private readonly process: ChildProcessWithoutNullStreams;
  private count = 0;

  private constructor(readonly path: string, readonly speed: number, readonly fps: number) {
    this.process = spawn(ffmpeg(), [
      ...["-hide_banner", "-loglevel", "error", "-readrate", String(speed), "-i", path],
      ...["-vf", `fps=${fps}`, "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "3", "-"],
    ]);
    const splitter = new JpegSplitter();
    this.process.stdout.on("data", (chunk: Buffer) => {
      for (const jpeg of splitter.push(chunk)) this.latest = { jpeg, t: this.count++ / fps };
    });
    this.process.on("close", () => (this.finished = true));
  }

  /** Start playing; resolves once the first frame is ready. */
  static async open(path: string, speed = 1.0, fps = 10): Promise<Replay> {
    const replay = new Replay(path, speed, fps);
    const deadline = performance.now() + 15_000;
    while (replay.latest === null) {
      if (replay.finished) throw new Error(`Couldn't play ${path}: ffmpeg stopped before the first frame.`);
      if (performance.now() > deadline) throw new Error(`Couldn't play ${path}: no frame after 15 seconds.`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return replay;
  }

  async grab(): Promise<Frame | null> {
    if (this.finished || this.latest === null) return null;
    return { jpeg: await toJpeg(this.latest.jpeg), t: this.latest.t };
  }

  close(): void {
    this.process.kill();
  }
}

/** One frame every `every` seconds of a recording, starting `start` seconds in. */
export class VideoFile {
  constructor(readonly path: string, readonly every = 2.0, readonly start = 0.0) {}

  async duration(): Promise<number> {
    // `ffmpeg -i` with no output exits with an error after printing the input's details.
    const details = await promisify(execFile)(ffmpeg(), ["-hide_banner", "-i", this.path]).catch(
      (error: { stderr?: string }) => ({ stderr: error.stderr ?? "" }),
    );
    const found = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(details.stderr);
    return found ? Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3]) : 0;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Frame> {
    const child = spawn(ffmpeg(), [
      ...["-hide_banner", "-loglevel", "error", "-ss", String(this.start), "-i", this.path],
      ...["-vf", `fps=1/${this.every}`, "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "2", "-"],
    ]);
    const splitter = new JpegSplitter();
    let index = 0;
    try {
      for await (const chunk of child.stdout) {
        for (const image of splitter.push(chunk as Buffer)) {
          yield { jpeg: await toJpeg(image), t: this.start + index++ * this.every };
        }
      }
    } finally {
      child.kill();
    }
  }
}
