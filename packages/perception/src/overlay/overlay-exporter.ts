import { extname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Export band for overlay video. Wide enough for any useful local review
 * speed, tight enough that a hostile or buggy client cannot request an
 * absurd frame rate from the encoder.
 */
export const MIN_EXPORT_FPS = 1;
export const MAX_EXPORT_FPS = 60;
export const DEFAULT_EXPORT_FPS = 10;

/**
 * Hard ceiling on one exported frame. Matches the app's frame body limit so
 * a frame that passed the capture pipeline can always be exported, while a
 * crafted giant buffer can never wedge the writer's stdin pump.
 */
export const MAX_EXPORT_FRAME_BYTES = 5 * 1024 * 1024;

export type OverlayExportErrorCode =
  | "invalid-output-path"
  | "invalid-file-name"
  | "output-directory-missing"
  | "output-exists"
  | "output-outside-directory"
  | "invalid-fps"
  | "invalid-frame"
  | "frame-too-large"
  | "invalid-state"
  | "process-failed"
  | "aborted";

/**
 * Typed failure for the export boundary (option, path, frame and process
 * policy violations). Route layers map the code to an honest HTTP error
 * without echoing filesystem paths back to clients.
 */
export class OverlayExportError extends Error {
  readonly code: OverlayExportErrorCode;

  constructor(code: OverlayExportErrorCode, message: string) {
    super(message);
    this.name = "OverlayExportError";
    this.code = code;
  }
}

export type OverlayExporterStartOptions = Readonly<{
  /** Absolute .mp4 path inside the operator-selected export directory. */
  outputPath: string;
  fps: number;
  /** Cancelled by the owner to abort the export and reclaim the process. */
  signal: AbortSignal;
}>;

/**
 * Bounded overlay video writer. Implementations (the app's FFmpeg writer)
 * must enforce, per frame:
 *
 * - validation before any process interaction (frame shape, byte ceiling);
 * - backpressure by pausing the upstream, never by buffering: at most one
 *   frame is in flight, so memory is bounded by the stream high-water mark
 *   plus one frame and never grows with the number of exported frames.
 *   Frames are never dropped — an export must be a faithful recording.
 * - a bounded shutdown: close stdin, wait a bounded time, then kill.
 */
export interface OverlayExporter {
  start(options: OverlayExporterStartOptions): Promise<void>;
  write(frame: Uint8Array): Promise<void>;
  close(): Promise<{ outputPath: string; framesWritten: number }>;
}

/** Validate an explicit export frame rate; returns the value unchanged. */
export function validateExportFps(fps: number): number {
  if (
    typeof fps !== "number" ||
    !Number.isSafeInteger(fps) ||
    fps < MIN_EXPORT_FPS ||
    fps > MAX_EXPORT_FPS
  ) {
    throw new OverlayExportError(
      "invalid-fps",
      `export fps must be an integer between ${MIN_EXPORT_FPS} and ${MAX_EXPORT_FPS}`
    );
  }
  return fps;
}

/**
 * Windows reserves device names regardless of extension; creating such a
 * file silently misbehaves, so the allowlist rejects them up front.
 */
const RESERVED_BASE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)
]);

const MAX_FILE_NAME_LENGTH = 100;
const EXPORT_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.mp4$/;

/**
 * Validate a client-supplied export file name. A strict allowlist (single
 * path segment, `.mp4`, no traversal, no reserved devices, bounded length)
 * is what makes the name safe to join onto the operator-selected export
 * directory on every platform.
 */
export function assertExportFileName(fileName: string): string {
  if (
    typeof fileName !== "string" ||
    fileName.length === 0 ||
    fileName.length > MAX_FILE_NAME_LENGTH ||
    !EXPORT_FILE_NAME_PATTERN.test(fileName) ||
    RESERVED_BASE_NAMES.has(fileName.slice(0, -".mp4".length).toLowerCase())
  ) {
    throw new OverlayExportError(
      "invalid-file-name",
      "export file name must be a simple <name>.mp4 without separators or traversal"
    );
  }
  return fileName;
}

/**
 * Containment policy for the explicit output path: it must be absolute,
 * resolve strictly inside the operator-selected export directory, and be an
 * .mp4 file. Checked on the resolved form so `..` segments and symlink-like
 * shapes cannot smuggle the target out of the directory.
 */
export function assertExportOutputPath(
  outputPath: string,
  exportDirectory: string
): string {
  if (typeof outputPath !== "string" || outputPath.trim() === "") {
    throw new OverlayExportError(
      "invalid-output-path",
      "output path must be a non-empty string"
    );
  }
  if (typeof exportDirectory !== "string" || exportDirectory.trim() === "") {
    throw new OverlayExportError(
      "invalid-output-path",
      "export directory must be a non-empty string"
    );
  }
  if (!isAbsolute(outputPath)) {
    throw new OverlayExportError(
      "invalid-output-path",
      "output path must be absolute"
    );
  }
  const directory = resolve(exportDirectory);
  const resolved = resolve(outputPath);
  const rel = relative(directory, resolved);
  const parentMarker = `..${sep}`;
  if (rel === "" || rel === ".." || rel.startsWith(parentMarker) || isAbsolute(rel)) {
    throw new OverlayExportError(
      "output-outside-directory",
      "output path must stay inside the export directory"
    );
  }
  if (extname(resolved).toLowerCase() !== ".mp4") {
    throw new OverlayExportError(
      "invalid-output-path",
      "overlay exports must be .mp4 files"
    );
  }
  return resolved;
}

/**
 * Structural JPEG validation for one exported frame: non-empty, within the
 * byte ceiling, and framed by SOI/EOI markers. Full decode validation is the
 * renderer's job; the writer only refuses bytes that cannot be a complete
 * JPEG so a hostile stream can never reach FFmpeg.
 */
export function validateExportFrame(
  frame: Uint8Array,
  maxBytes: number = MAX_EXPORT_FRAME_BYTES
): void {
  if (!(frame instanceof Uint8Array) || frame.byteLength === 0) {
    throw new OverlayExportError(
      "invalid-frame",
      "frame must be a non-empty Uint8Array"
    );
  }
  if (frame.byteLength > maxBytes) {
    throw new OverlayExportError(
      "frame-too-large",
      `frame exceeds the ${maxBytes} byte export ceiling`
    );
  }
  if (frame[0] !== 0xff || frame[1] !== 0xd8) {
    throw new OverlayExportError(
      "invalid-frame",
      "frame must be a JPEG (missing SOI marker)"
    );
  }
  const last = frame.byteLength - 1;
  if (frame[last - 1] !== 0xff || frame[last] !== 0xd9) {
    throw new OverlayExportError(
      "invalid-frame",
      "frame must be a complete JPEG (missing EOI marker)"
    );
  }
}
