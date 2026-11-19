import type { Frame, GamePosition } from "@chessonglass/contracts";
import { projectPoint, requireFiniteHomography } from "../geometry/homography.js";
import { projectSquare } from "../geometry/board-projection.js";
import { GeometryError } from "../geometry/types.js";
import type { Homography, HomographyMatrix, Point } from "../geometry/types.js";
import { GeometryState } from "../tracking/geometry-state.js";
import type { CurrentGeometry, GeometryInvalidation } from "../tracking/geometry-state.js";
import { buildOverlaySvg, overlaySpecForDisplay, type OverlaySvgSpec } from "./overlay-svg.js";
import { resolveOverlayDisplay, type OverlayDisplay, type OverlayResult } from "./overlay-state.js";

/**
 * Hard ceiling on the byte size of an input frame. Mirrors the app's frame
 * body limit so a frame that passed upload framing still cannot wedge the
 * renderer with a giant buffer.
 */
export const MAX_OVERLAY_INPUT_BYTES = 5 * 1024 * 1024;

/**
 * Hard ceiling on decoded pixels, matching the browser upload route. Sharp
 * enforces it at decode; it is re-checked from metadata so a crafted JPEG
 * cannot rely on decoder-specific limit behavior.
 */
export const MAX_OVERLAY_INPUT_PIXELS = 12_000_000;

/** Re-encoded overlay JPEG quality; matches the dashboard frame pipeline. */
export const DEFAULT_OVERLAY_JPEG_QUALITY = 85;

export type OverlayErrorCode =
  | "invalid-frame"
  | "frame-too-large"
  | "invalid-dimensions"
  | "render-failed";

/**
 * Typed failure for renderer boundary violations (malformed frames, ceiling
 * breaches, decode failures). Hidden overlay state — stale or absent
 * geometry — is deliberately NOT an error: it renders a labeled status-only
 * frame instead.
 */
export class OverlayError extends Error {
  readonly code: OverlayErrorCode;

  constructor(code: OverlayErrorCode, message: string) {
    super(message);
    this.name = "OverlayError";
    this.code = code;
  }
}

export type OverlayInput = Readonly<{
  frame: Frame;
  position: GamePosition | null;
  /**
   * The app maps the coordinator's `Result` into the structural
   * `OverlayResult` subset; perception never imports game.
   */
  result: OverlayResult | null;
  /**
   * Either the live `GeometryState` (read once, at `now`) or an
   * already-resolved `CurrentGeometry`/null for callers that resolved
   * freshness themselves. Resolving once matters: `current()` clears expired
   * state as a side effect, and a double read could flip mid-render.
   */
  geometry: GeometryState | CurrentGeometry | null;
  /** Operator-facing note (e.g. last provider error); always untrusted. */
  note?: string | null;
}>;

export type OverlayRenderOptions = Readonly<{
  /** Monotonic clock for `GeometryState` freshness, default `performance.now`. */
  now?: () => number;
  maxInputBytes?: number;
  maxInputPixels?: number;
  jpegQuality?: number;
  /**
   * `"full"` (default) returns the whole frame with the overlay composed.
   * `"board"` returns the aligned bounding box of the board outline instead.
   * The crop is an axis-aligned extraction — never a warp: a 2D homography
   * does not resolve 3D piece ambiguity, so the full frame stays available
   * to future readers alongside the aligned crop.
   */
  cropMode?: "full" | "board";
}>;

function requireFrameShape(frame: Frame): void {
  if (typeof frame !== "object" || frame === null) {
    throw new OverlayError("invalid-frame", "frame must be an object");
  }
  if (!(frame.bytes instanceof Uint8Array) || frame.bytes.byteLength === 0) {
    throw new OverlayError("invalid-frame", "frame.bytes must be a non-empty Uint8Array");
  }
  if (frame.mimeType !== "image/jpeg") {
    throw new OverlayError("invalid-frame", 'frame.mimeType must be "image/jpeg"');
  }
  if (typeof frame.sequence !== "bigint" || frame.sequence < 0n) {
    throw new OverlayError("invalid-frame", "frame.sequence must be a non-negative bigint");
  }
  if (typeof frame.sessionId !== "string" || frame.sessionId === "") {
    throw new OverlayError("invalid-frame", "frame.sessionId must be a non-empty string");
  }
  if (typeof frame.sourceId !== "string" || frame.sourceId === "") {
    throw new OverlayError("invalid-frame", "frame.sourceId must be a non-empty string");
  }
}

function safeProject(matrix: HomographyMatrix, u: number, v: number): Point | null {
  try {
    return projectPoint(matrix, u, v);
  } catch (error) {
    if (error instanceof GeometryError) {
      return null;
    }
    throw error;
  }
}

function safeProjectSquare(
  transform: Homography,
  square: number,
  side: "w" | "b"
): readonly Point[] | null {
  try {
    return projectSquare(transform, square, side);
  } catch (error) {
    if (error instanceof GeometryError) {
      return null;
    }
    throw error;
  }
}

/**
 * Build the validated SVG spec for one display decision. Projection
 * failures degrade to the hidden status frame here — one bad square or a
 * vanishing corner can never fail the frame, and can never produce stale
 * coordinates either.
 */
function buildSpec(
  display: OverlayDisplay,
  width: number,
  height: number,
  transform: Homography | null
): OverlaySvgSpec {
  if (transform === null) {
    return overlaySpecForDisplay(
      display,
      width,
      height,
      () => null,
      () => null
    );
  }
  const matrix = requireFiniteHomography(transform);
  const side = display.kind === "move" ? display.side : "w";
  return overlaySpecForDisplay(
    display,
    width,
    height,
    (square) => safeProjectSquare(transform, square, side),
    (u, v) => safeProject(matrix, u, v)
  );
}

/**
 * Render one frame with the overlay composed, as bounded JPEG bytes.
 *
 * Guarantees:
 * - input is validated and size-capped before any decode work;
 * - all free-form text is sanitized at decision time and XML-escaped at the
 *   SVG boundary — model output never reaches markup unescaped;
 * - coordinates are finite-validated and rounded to integers, so the SVG
 *   dimensions and positions are deterministic;
 * - absent/stale/unprojectable geometry renders a labeled status-only frame
 *   (never an exception, never a stale drawing);
 * - the output is always the full source frame (or its aligned crop) with
 *   additive marks — no warp, no desktop-window/AR claim.
 */
export async function renderOverlay(
  input: OverlayInput,
  options: OverlayRenderOptions = {}
): Promise<Uint8Array> {
  const nowMs = (options.now ?? (() => performance.now()))();
  const maxBytes = options.maxInputBytes ?? MAX_OVERLAY_INPUT_BYTES;
  const maxPixels = options.maxInputPixels ?? MAX_OVERLAY_INPUT_PIXELS;
  const quality = options.jpegQuality ?? DEFAULT_OVERLAY_JPEG_QUALITY;

  requireFrameShape(input.frame);
  if (input.frame.bytes.byteLength > maxBytes) {
    throw new OverlayError(
      "frame-too-large",
      `frame exceeds the ${maxBytes} byte overlay input ceiling`
    );
  }

  // Read freshness exactly once; current() clears expired geometry as a
  // side effect, and the invalidation reason labels the hidden frame.
  let resolvedGeometry: CurrentGeometry | null;
  let invalidation: GeometryInvalidation | null = null;
  if (input.geometry instanceof GeometryState) {
    resolvedGeometry = input.geometry.current(nowMs);
    invalidation = input.geometry.lastInvalidation();
  } else {
    resolvedGeometry = input.geometry;
  }

  const { default: sharp } = await import("sharp");
  let width: number | undefined;
  let height: number | undefined;
  try {
    const image = sharp(Buffer.from(input.frame.bytes), {
      failOn: "error",
      limitInputPixels: maxPixels
    });
    const metadata = await image.metadata();
    width = metadata.width;
    height = metadata.height;
  } catch {
    throw new OverlayError("invalid-frame", "frame bytes are not a decodable JPEG");
  }
  if (
    width === undefined ||
    height === undefined ||
    width <= 0 ||
    height <= 0 ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width * height > maxPixels
  ) {
    throw new OverlayError("invalid-dimensions", "frame dimensions violate the pixel ceiling");
  }

  const display = resolveOverlayDisplay({
    geometry: resolvedGeometry,
    frame: input.frame,
    result: input.result,
    invalidation,
    position: input.position,
    note: input.note
  });

  const spec = buildSpec(display, width, height, resolvedGeometry?.transform ?? null);
  const svg = buildOverlaySvg(spec);

  let composed: Buffer;
  try {
    composed = await sharp(Buffer.from(input.frame.bytes), {
      failOn: "error",
      limitInputPixels: maxPixels
    })
      .composite([{ input: Buffer.from(svg), blend: "over" }])
      .jpeg({ quality })
      .toBuffer();
  } catch {
    throw new OverlayError("render-failed", "overlay composition failed");
  }

  if (options.cropMode !== "board" || (spec.kind !== "move" && spec.kind !== "tracking")) {
    return new Uint8Array(composed);
  }
  return new Uint8Array(await cropToBoard(sharp, composed, spec, width, height, quality));
}

/**
 * Axis-aligned crop to the board outline's bounding box, rounded and
 * clamped into the frame. Returns the composed frame unchanged when the
 * outline leaves no usable rectangle.
 */
async function cropToBoard(
  sharp: typeof import("sharp").default,
  composed: Buffer,
  spec: Extract<OverlaySvgSpec, { kind: "move" | "tracking" }>,
  width: number,
  height: number,
  quality: number
): Promise<Buffer> {
  const xs = spec.outline.map(([x]) => Math.round(x));
  const ys = spec.outline.map(([, y]) => Math.round(y));
  const left = Math.max(0, Math.min(...xs));
  const top = Math.max(0, Math.min(...ys));
  const right = Math.min(width, Math.max(...xs));
  const bottom = Math.min(height, Math.max(...ys));
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  if (cropWidth < 1 || cropHeight < 1) {
    return composed;
  }
  return sharp(composed)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .jpeg({ quality })
    .toBuffer();
}

/**
 * Compose the SVG markup for a display decision. Exposed so tests (and the
 * exporter in a later slice) can assert on the exact markup the renderer
 * composes, including how hostile text is escaped, without decoding JPEG.
 * A transform must be provided for geometry-dependent displays; without one
 * they degrade to the hidden status frame.
 */
export function composeOverlaySvg(
  display: OverlayDisplay,
  width: number,
  height: number,
  transform: Homography | null = null
): string {
  return buildOverlaySvg(buildSpec(display, width, height, transform));
}
