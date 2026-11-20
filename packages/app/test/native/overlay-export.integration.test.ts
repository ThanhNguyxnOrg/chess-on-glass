import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  newSessionId,
  newSourceId,
  type Frame,
  type GamePosition
} from "@chessonglass/contracts";
import {
  fitBoardHomography,
  GeometryState,
  OverlayExportError,
  renderOverlay,
  resolveOverlayDisplay,
  type GeometryConfidence,
  type Homography,
  type OverlayResult
} from "@chessonglass/perception";
import { FfmpegOverlayWriter } from "../../src/native/ffmpeg-overlay-writer.js";
import { FfmpegReplaySource } from "../../src/sources/ffmpeg-replay-source.js";

const FFMPEG = process.env["CHESSONGLASS_FFMPEG"];
const WIDTH = 320;
const HEIGHT = 240;
const CLIP_FPS = 10;
const BOARD_CORNERS = {
  nearLeft: [2, 238],
  nearRight: [318, 238],
  farRight: [318, 2],
  farLeft: [2, 2]
} as const;
const TRANSFORM: Homography = fitBoardHomography(BOARD_CORNERS, WIDTH, HEIGHT);

/**
 * Required native gate. It fails closed when no approved FFmpeg is
 * configured; it is never skipped. Run with `npm run test:native`.
 */
describe("overlay export integration", () => {
  it("round-trips a rendered replay into a decodable h264 overlay video", async () => {
    if (FFMPEG === undefined || FFMPEG === "") {
      throw new Error(
        "approved FFmpeg executable missing: set CHESSONGLASS_FFMPEG to run this required native gate"
      );
    }
    const ffprobe = join(dirname(FFMPEG), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
    if (!existsSync(ffprobe)) {
      throw new Error(`ffprobe must sit next to the approved FFmpeg (looked for ${ffprobe})`);
    }

    const directory = await mkdtemp(join(tmpdir(), "cog-export-gate-"));
    let source: FfmpegReplaySource | null = null;
    try {
      // Synthetic consented replay: our own generated media, produced by the
      // same approved FFmpeg binary the exporter is gated on.
      const clip = join(directory, "replay.mp4");
      execFileSync(
        FFMPEG,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          `testsrc=size=${WIDTH}x${HEIGHT}:rate=${CLIP_FPS}`,
          "-t",
          "1",
          "-pix_fmt",
          "yuv420p",
          clip
        ],
        { stdio: "pipe" }
      );

      source = await FfmpegReplaySource.open({
        sessionId: newSessionId(),
        sourceId: newSourceId(),
        path: clip,
        ffmpegPath: FFMPEG,
        speed: 4,
        fps: CLIP_FPS
      });

      const geometryState = new GeometryState({ lifetimeMs: 60_000 });
      const position = startPosition();
      const result: OverlayResult = { moveUci: "e2e4", status: "ready", reason: null };
      const signal = new AbortController().signal;

      // Drain the replay source first: it is a live, capacity-one source
      // (keep-newest), so rendering between pulls would legitimately drop
          // frames. Collecting, then rendering, keeps the gate lossless.
      const frames: Frame[] = [];
      for (let index = 0; index < 24; index += 1) {
        const frame = await source.next(signal);
        if (frame === null) {
          break;
        }
        frames.push(frame);
      }
      expect(frames.length).toBeGreaterThanOrEqual(3);

      const outputPath = join(directory, "overlay-export.mp4");
      const writer = new FfmpegOverlayWriter({ ffmpegPath: FFMPEG, exportDirectory: directory });
      await writer.start({ outputPath, fps: CLIP_FPS, signal });

      const previewFrames: Uint8Array[] = [];
      const sourceFrames: Uint8Array[] = [];
      let displayKind: string | null = null;

      for (const [index, frame] of frames.entries()) {
        if (index === 0) {
          geometryState.update(frame, TRANSFORM, confidenceFor(frame));
        }
        // Resolve freshness exactly once per frame and feed the SAME resolved
        // state to the decision and the renderer, so the exported stream is
        // the exact bytes the dashboard preview would serve.
        const geometry = geometryState.current(performance.now());
        const display = resolveOverlayDisplay({
          geometry,
          frame,
          result,
          invalidation: geometryState.lastInvalidation(),
          position,
          note: null
        });
        displayKind ??= display.kind;
        const rendered = await renderOverlay({ frame, position, result, geometry, note: null });
        if (index === 0) {
          sourceFrames.push(frame.bytes);
          previewFrames.push(rendered);
        }
        await writer.write(rendered);
      }

      const closed = await writer.close();
      expect(closed.outputPath).toBe(outputPath);
      expect(closed.framesWritten).toBeGreaterThanOrEqual(3);
      expect(displayKind).toBe("move");

      // --- ffprobe: container, codec, pixel format, explicit frame rate ---
      const probe = JSON.parse(
        execFileSync(
          ffprobe,
          [
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-count_frames",
            outputPath
          ],
          { encoding: "utf8" }
        )
      ) as { streams: Array<Record<string, unknown>> };
      const video = probe.streams.find((stream) => stream["codec_type"] === "video");
      expect(video).toBeDefined();
      expect(video?.["codec_name"]).toBe("h264");
      expect(video?.["pix_fmt"]).toBe("yuv420p");
      expect(video?.["width"]).toBe(WIDTH);
      expect(video?.["height"]).toBe(HEIGHT);
      expect(video?.["avg_frame_rate"]).toBe(`${CLIP_FPS}/1`);
      expect(Number(video?.["nb_read_frames"])).toBe(closed.framesWritten);

      // --- decodability: a full decode pass with error loglevel stays quiet ---
      const decode = spawnSync(
        FFMPEG,
        ["-hide_banner", "-loglevel", "error", "-i", outputPath, "-f", "null", "-"],
        { encoding: "utf8" }
      );
      expect(decode.status).toBe(0);
      expect(decode.stderr.trim()).toBe("");

      // --- key-frame comparison against the preview state ---
      const exportFrame0 = await decodeToRaw(FFMPEG, outputPath, "export0", directory, {
        videoFrame: "first"
      });
      const previewFrame0 = await decodeToRaw(
        FFMPEG,
        await writeJpeg(directory, "preview0.jpg", previewFrames[0]!),
        "preview0",
        directory
      );
      const sourceFrame0 = await decodeToRaw(
        FFMPEG,
        await writeJpeg(directory, "source0.jpg", sourceFrames[0]!),
        "source0",
        directory
      );

      const overlayMatchError = meanAbsoluteError(exportFrame0, previewFrame0);
      const sourceDifference = meanAbsoluteError(exportFrame0, sourceFrame0);
      // The exported key frame is the preview composition up to codec noise…
      expect(overlayMatchError).toBeLessThan(16);
      // …and it is provably NOT the raw source frame: the overlay is burned in.
      expect(overlayMatchError).toBeLessThan(sourceDifference);

      // --- no-overwrite policy against the real filesystem ---
      const refused = new FfmpegOverlayWriter({ ffmpegPath: FFMPEG, exportDirectory: directory });
      await expect(
        refused.start({ outputPath, fps: CLIP_FPS, signal })
      ).rejects.toMatchObject({ code: "output-exists" });

      const overwrite = new FfmpegOverlayWriter({
        ffmpegPath: FFMPEG,
        exportDirectory: directory,
        overwrite: true
      });
      await overwrite.start({ outputPath, fps: CLIP_FPS, signal });
      for (const frame of previewFrames) {
        await overwrite.write(frame);
      }
      const overwriteClosed = await overwrite.close();
      expect(overwriteClosed.framesWritten).toBe(previewFrames.length);
      const probeAgain = JSON.parse(
        execFileSync(
          ffprobe,
          ["-v", "error", "-print_format", "json", "-show_streams", "-count_frames", outputPath],
          { encoding: "utf8" }
        )
      ) as { streams: Array<Record<string, unknown>> };
      const videoAgain = probeAgain.streams.find((stream) => stream["codec_type"] === "video");
      expect(Number(videoAgain?.["nb_read_frames"])).toBe(previewFrames.length);

      // --- freeze/reset: an aborted export cleans up its process ---
      const abortController = new AbortController();
      const abortedPath = join(directory, "aborted.mp4");
      const abortedWriter = new FfmpegOverlayWriter({
        ffmpegPath: FFMPEG,
        exportDirectory: directory
      });
      await abortedWriter.start({
        outputPath: abortedPath,
        fps: CLIP_FPS,
        signal: abortController.signal
      });
      await abortedWriter.write(previewFrames[0]!);
      abortController.abort();
      await expect(abortedWriter.close()).rejects.toMatchObject({
        code: "aborted"
      } satisfies Partial<OverlayExportError>);
      // The exporter stayed consistent: a fresh writer can export again.
      const resetWriter = new FfmpegOverlayWriter({
        ffmpegPath: FFMPEG,
        exportDirectory: directory
      });
      await resetWriter.start({
        outputPath: join(directory, "after-reset.mp4"),
        fps: CLIP_FPS,
        signal
      });
      await resetWriter.write(previewFrames[0]!);
      const resetClosed = await resetWriter.close();
      expect(resetClosed.framesWritten).toBe(1);
    } finally {
      await source?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});

function startPosition(): GamePosition {
  const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  return {
    initialFen: fen,
    fen,
    history: [],
    uncertainty: { castlingRights: true, enPassant: false, promotion: false }
  };
}

function confidenceFor(frame: Frame): GeometryConfidence {
  return { inlierRatio: 0.95, reprojectionErrorPx: 1.5, observedSequence: frame.sequence };
}

async function writeJpeg(
  directory: string,
  fileName: string,
  bytes: Uint8Array
): Promise<string> {
  const path = join(directory, fileName);
  await writeFile(path, bytes);
  return path;
}

/**
 * Decode one image (or the first video frame) to raw RGB24 bytes with the
 * approved FFmpeg, so the comparison needs no image library in the test.
 */
async function decodeToRaw(
  ffmpegPath: string,
  mediaPath: string,
  tag: string,
  directory: string,
  options: { videoFrame?: "first" } = {}
): Promise<Uint8Array> {
  const rawPath = join(directory, `${tag}.raw`);
  const args = ["-hide_banner", "-loglevel", "error", "-i", mediaPath];
  if (options.videoFrame === "first") {
    args.push("-frames:v", "1");
  }
  args.push("-f", "rawvideo", "-pix_fmt", "rgb24", rawPath);
  execFileSync(ffmpegPath, args, { stdio: "pipe" });
  const bytes = await readFile(rawPath);
  expect(bytes.byteLength).toBe(WIDTH * HEIGHT * 3);
  return bytes;
}

function meanAbsoluteError(a: Uint8Array, b: Uint8Array): number {
  expect(a.byteLength).toBe(b.byteLength);
  let total = 0;
  for (let index = 0; index < a.byteLength; index += 1) {
    total += Math.abs((a[index] ?? 0) - (b[index] ?? 0));
  }
  return total / a.byteLength;
}
