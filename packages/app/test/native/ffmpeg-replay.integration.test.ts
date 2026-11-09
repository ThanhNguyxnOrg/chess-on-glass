import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newSessionId, newSourceId } from "@chessonglass/contracts";
import { FfmpegReplaySource } from "../../src/sources/ffmpeg-replay-source.js";

const FFMPEG = process.env["CHESSONGLASS_FFMPEG"];

/**
 * Required native gate. It fails closed when no approved executable is
 * configured; it is never skipped. Run with `npm run test:native`.
 */
describe("ffmpeg replay integration", () => {
  it("replays a one-second testsrc clip to bounded frames and EOF", async () => {
    if (FFMPEG === undefined || FFMPEG === "") {
      throw new Error(
        "approved FFmpeg executable missing: set CHESSONGLASS_FFMPEG to run this required native gate"
      );
    }

    const directory = await mkdtemp(join(tmpdir(), "cog-ffmpeg-"));
    try {
      const clip = join(directory, "testsrc.mp4");
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
          "testsrc=size=320x240:rate=10",
          "-t",
          "1",
          "-pix_fmt",
          "yuv420p",
          clip
        ],
        { stdio: "pipe" }
      );

      const source = await FfmpegReplaySource.open({
        sessionId: newSessionId(),
        sourceId: newSourceId(),
        path: clip,
        ffmpegPath: FFMPEG,
        speed: 4,
        fps: 10
      });

      const controller = new AbortController();
      const frames: Array<{ bytes: Uint8Array }> = [];
      for (let index = 0; index < 10; index += 1) {
        const frame = await source.next(controller.signal);
        if (frame === null) {
          break;
        }
        frames.push(frame);
      }

      expect(frames.length).toBeGreaterThanOrEqual(3);
      for (const frame of frames) {
        const bytes = frame.bytes;
        expect(bytes[0]).toBe(0xff);
        expect(bytes[1]).toBe(0xd8);
        expect(bytes[bytes.byteLength - 2]).toBe(0xff);
        expect(bytes[bytes.byteLength - 1]).toBe(0xd9);
        expect(bytes.byteLength).toBeLessThanOrEqual(5 * 1024 * 1024);
      }

      await source.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
