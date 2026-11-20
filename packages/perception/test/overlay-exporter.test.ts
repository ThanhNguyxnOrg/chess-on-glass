import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  MAX_EXPORT_FRAME_BYTES,
  MIN_EXPORT_FPS,
  OverlayExportError,
  assertExportFileName,
  assertExportOutputPath,
  validateExportFps,
  validateExportFrame
} from "@chessonglass/perception";

const SOI = [0xff, 0xd8, 0xff, 0xe0];
const EOI = [0xff, 0xd9];

function tmpDirectory(): string {
  return tmpdir();
}

function jpegBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 4));
  bytes[0] = SOI[0];
  bytes[1] = SOI[1];
  bytes[bytes.byteLength - 2] = EOI[0];
  bytes[bytes.byteLength - 1] = EOI[1];
  return bytes;
}

function errorCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    if (error instanceof OverlayExportError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected the operation to reject with an OverlayExportError");
}

describe("overlay export policy", () => {
  it("bounds the frame ceiling at the app frame-body limit", () => {
    expect(MAX_EXPORT_FRAME_BYTES).toBe(5 * 1024 * 1024);
  });

  describe("validateExportFps", () => {
    it("accepts integers inside the export band", () => {
      expect(validateExportFps(MIN_EXPORT_FPS)).toBe(1);
      expect(validateExportFps(10)).toBe(10);
      expect(validateExportFps(60)).toBe(60);
    });

    it("rejects zero, negative, fractional and non-finite fps", () => {
      for (const fps of [0, -1, 61, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(errorCode(() => validateExportFps(fps))).toBe("invalid-fps");
      }
    });
  });

  describe("assertExportFileName", () => {
    it("accepts plain operator-chosen names", () => {
      expect(assertExportFileName("export.mp4")).toBe("export.mp4");
      expect(assertExportFileName("game-2026-11-19_01.mp4")).toBe(
        "game-2026-11-19_01.mp4"
      );
    });

    it("rejects separators, traversal, devices and non-mp4 names", () => {
      for (const name of [
        "",
        "   ",
        "video.avi",
        ".mp4",
        "a/b.mp4",
        "a\\b.mp4",
        "..",
        "../x.mp4",
        "x/../../y.mp4",
        "a:b.mp4",
        "con.mp4",
        "NUL.mp4",
        "com1.mp4",
        "lpt2.mp4",
        "x\0y.mp4",
        " leading space.mp4",
        `${"a".repeat(200)}.mp4`
      ]) {
        expect(errorCode(() => assertExportFileName(name))).toBe(
          "invalid-file-name"
        );
      }
    });
  });

  describe("assertExportOutputPath", () => {
    // Built with the host path module so the policy is exercised with the
    // exact shapes a caller would produce on the running platform.
    const root = resolve(tmpDirectory(), "cog-export-policy");
    const directory = join(root, "exports");

    it("accepts an absolute mp4 inside the export directory", () => {
      expect(assertExportOutputPath(join(directory, "out.mp4"), directory)).toBe(
        join(directory, "out.mp4")
      );
      expect(
        assertExportOutputPath(join(directory, "sub", "out.mp4"), directory)
      ).toBe(join(directory, "sub", "out.mp4"));
    });

    it("accepts names whose stem merely starts with dots", () => {
      // The containment check must not confuse "..keep.mp4" with traversal.
      expect(
        assertExportOutputPath(join(directory, "..keep.mp4"), directory)
      ).toBe(join(directory, "..keep.mp4"));
    });

    it("rejects relative and empty output paths", () => {
      expect(errorCode(() => assertExportOutputPath("out.mp4", directory))).toBe(
        "invalid-output-path"
      );
      expect(errorCode(() => assertExportOutputPath("", directory))).toBe(
        "invalid-output-path"
      );
    });

    it("rejects paths that escape the export directory", () => {
      expect(
        errorCode(() =>
          assertExportOutputPath(join(root, "other", "out.mp4"), directory)
        )
      ).toBe("output-outside-directory");
      expect(
        errorCode(() => assertExportOutputPath(join(root, "out.mp4"), directory))
      ).toBe("output-outside-directory");
      expect(errorCode(() => assertExportOutputPath(directory, directory))).toBe(
        "output-outside-directory"
      );
    });

    it.runIf(process.platform === "win32")(
      "rejects another drive on Windows",
      () => {
        const windowsDirectory = "C:\\ops\\exports";
        expect(
          errorCode(() =>
            assertExportOutputPath("D:\\ops\\exports\\out.mp4", windowsDirectory)
          )
        ).toBe("output-outside-directory");
      }
    );

    it("rejects a missing export directory and non-mp4 outputs", () => {
      expect(errorCode(() => assertExportOutputPath(join(directory, "out.mp4"), ""))).toBe(
        "invalid-output-path"
      );
      expect(
        errorCode(() => assertExportOutputPath(join(directory, "out.mov"), directory))
      ).toBe("invalid-output-path");
    });
  });

  describe("validateExportFrame", () => {
    it("accepts a complete bounded JPEG", () => {
      const bytes = jpegBytes(64);
      expect(() => validateExportFrame(bytes)).not.toThrow();
    });

    it("rejects empty, malformed and oversized frames", () => {
      expect(errorCode(() => validateExportFrame(new Uint8Array(0)))).toBe(
        "invalid-frame"
      );
      // @ts-expect-error exercising a hostile runtime value
      expect(errorCode(() => validateExportFrame("not-a-frame"))).toBe(
        "invalid-frame"
      );

      const noSoi = jpegBytes(32);
      noSoi[0] = 0x00;
      expect(errorCode(() => validateExportFrame(noSoi))).toBe("invalid-frame");

      const noEoi = jpegBytes(32);
      noEoi[noEoi.byteLength - 1] = 0x00;
      expect(errorCode(() => validateExportFrame(noEoi))).toBe("invalid-frame");

      const big = jpegBytes(64);
      expect(errorCode(() => validateExportFrame(big, 16))).toBe(
        "frame-too-large"
      );
    });
  });
});
