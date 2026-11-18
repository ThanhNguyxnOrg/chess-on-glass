import type { Sequence } from "@chessonglass/contracts";

/**
 * An image-space coordinate in pixels: x grows to the right and y grows down
 * (standard raster order), so the board edge nearest the camera carries the
 * largest y.
 */
export type Point = readonly [x: number, y: number];

/**
 * The four board corners in image space, named for their position in the
 * frame: "near" is the edge closest to the camera (the bottom of the board in
 * the image) and x runs left to right. The names are fixed to image space;
 * which color stands on the near edge is decided by `side`, never by these
 * names.
 */
export type BoardCorners = Readonly<{
  nearLeft: Point;
  nearRight: Point;
  farRight: Point;
  farLeft: Point;
}>;

/** Row-major 3x3 projective matrix `[h11 h12 h13; h21 h22 h23; h31 h32 h33]`. */
export type HomographyMatrix = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number
];

/**
 * A validated planar homography from board-frame coordinates (square units,
 * origin at the near-left board corner in image space; see
 * `fitBoardHomography`) to image pixels.
 */
export type Homography = Readonly<{ matrix: HomographyMatrix }>;

/**
 * Detector-reported quality of the corner observation a transform was fit
 * from. `observedSequence` ties the confidence to the frame it came from so a
 * stale transform cannot ride on fresh-looking numbers.
 */
export type GeometryConfidence = Readonly<{
  inlierRatio: number;
  reprojectionErrorPx: number;
  observedSequence: Sequence;
}>;

/**
 * Overrides for `validateGeometry`'s default policy bounds. Capture pipelines
 * with known detector quality should tune these instead of inheriting the
 * baseline defaults.
 */
export type GeometryValidationOptions = Readonly<{
  minInlierRatio?: number;
  maxReprojectionErrorPx?: number;
}>;

export type GeometryErrorCode =
  | "invalid-corners"
  | "degenerate-corners"
  | "invalid-image-size"
  | "invalid-transform"
  | "invalid-square"
  | "invalid-side"
  | "invalid-confidence"
  | "invalid-options"
  | "unsolvable"
  | "projection-failed";

/**
 * Typed failure for every geometry boundary: malformed input or a projection
 * that cannot produce finite coordinates throws this instead of returning
 * junk coordinates that would end up in overlay state.
 */
export class GeometryError extends Error {
  readonly code: GeometryErrorCode;

  constructor(code: GeometryErrorCode, message: string) {
    super(message);
    this.name = "GeometryError";
    this.code = code;
  }
}
