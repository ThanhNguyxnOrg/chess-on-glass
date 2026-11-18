import {
  isInvertibleHomography,
  isHomographyShape,
  projectPoint,
  requireFiniteHomography
} from "./homography.js";
import { GeometryError } from "./types.js";
import type {
  GeometryConfidence,
  GeometryValidationOptions,
  Homography,
  Point
} from "./types.js";

/**
 * Baseline acceptance floor for the fraction of corner samples the detector
 * reports as inliers. A policy default, not a calibrated accuracy claim;
 * callers with their own capture pipeline should tune it via options.
 */
export const DEFAULT_MIN_INLIER_RATIO = 0.8;

/**
 * Baseline ceiling on the detector's reported corner reprojection error, in
 * pixels. Same caveat as the inlier floor: a policy default, not a claim.
 */
export const DEFAULT_MAX_REPROJECTION_ERROR_PX = 6;

const SQUARE_COUNT = 64;
const SQUARES_PER_SIDE = 8;
const LAST_FILE_OR_RANK = SQUARES_PER_SIDE - 1;

/**
 * Project one board square to its four image-space corner points, in board
 * order near-left, near-right, far-right, far-left (the `BoardCorners`
 * convention applied to the single square, suitable for a closed polygon).
 *
 * `square` uses the `PieceObservation.square` indexing: row-major from the
 * top of the board image, so square 0 = a8, square 7 = h8, square 56 = a1,
 * square 63 = h1 (see packages/chess/src/state.ts).
 *
 * `side` decides how that index lands on the image-fixed corner frame: with
 * `"w"` the white back rank (rank 1) is the near edge and a1 is the near-left
 * corner; with `"b"` the labeling is rotated 180 degrees, so the black back
 * rank (rank 8) is the near edge and h8 is the near-left corner. "Near"
 * always means closest to the camera; `side` never changes the corner names,
 * only which color's back rank they belong to.
 *
 * The transform must be a finite homography as produced by
 * `fitBoardHomography`. Structurally invalid transforms and projections that
 * would produce non-finite coordinates throw `GeometryError` rather than
 * returning junk; trust policy (confidence bounds, invertibility) is
 * `validateGeometry`'s job and should gate the transform before rendering.
 */
export function projectSquare(
  transform: Homography,
  square: number,
  side: "w" | "b"
): readonly Point[] {
  const matrix = requireFiniteHomography(transform);
  if (!Number.isSafeInteger(square) || square < 0 || square >= SQUARE_COUNT) {
    throw new GeometryError("invalid-square", "square must be an integer in [0,63]");
  }
  if (side !== "w" && side !== "b") {
    throw new GeometryError("invalid-side", 'side must be "w" or "b"');
  }
  const column = square % SQUARES_PER_SIDE;
  const row = Math.floor(square / SQUARES_PER_SIDE);
  // Square rows count from the top of the board image (row 0 = rank 8), while
  // board-frame rows count from the near edge (row 0 = rank 1 with side "w"),
  // hence the flip. Side "b" rotates the labeling 180 degrees inside that
  // image-fixed frame, so the near edge carries rank 8 and the left edge the
  // h-file.
  const nearColumn = side === "w" ? column : LAST_FILE_OR_RANK - column;
  const nearRow = side === "w" ? LAST_FILE_OR_RANK - row : row;
  return [
    projectPoint(matrix, nearColumn, nearRow),
    projectPoint(matrix, nearColumn + 1, nearRow),
    projectPoint(matrix, nearColumn + 1, nearRow + 1),
    projectPoint(matrix, nearColumn, nearRow + 1)
  ];
}

function requireConfidenceShape(confidence: GeometryConfidence): void {
  if (typeof confidence !== "object" || confidence === null) {
    throw new GeometryError("invalid-confidence", "confidence must be an object");
  }
  if (typeof confidence.inlierRatio !== "number") {
    throw new GeometryError("invalid-confidence", "confidence.inlierRatio must be a number");
  }
  if (typeof confidence.reprojectionErrorPx !== "number") {
    throw new GeometryError(
      "invalid-confidence",
      "confidence.reprojectionErrorPx must be a number"
    );
  }
  if (typeof confidence.observedSequence !== "bigint") {
    throw new GeometryError(
      "invalid-confidence",
      "confidence.observedSequence must be a bigint sequence"
    );
  }
}

/**
 * Policy gate for transforms about to drive overlay output. Returns false —
 * never junk — when the transform or its detector confidence cannot be
 * trusted:
 *
 * - the matrix must be finite and invertible;
 * - `inlierRatio` must meet `minInlierRatio` and `reprojectionErrorPx` must
 *   stay within `maxReprojectionErrorPx` (both bounds inclusive);
 * - `observedSequence` must be a non-negative frame sequence.
 *
 * Argument shapes that are malformed outright (not objects, wrong field
 * types, invalid options) throw `GeometryError`: those are caller bugs, while
 * a well-shaped-but-untrustworthy transform is a normal runtime rejection.
 * Image-bounds reasoning belongs to the caller, which knows the frame size;
 * this gate covers transform integrity and detector confidence only.
 */
export function validateGeometry(
  transform: Homography,
  confidence: GeometryConfidence,
  options: GeometryValidationOptions = {}
): boolean {
  if (!isHomographyShape(transform)) {
    throw new GeometryError(
      "invalid-transform",
      "transform must be a homography with a nine-entry matrix"
    );
  }
  requireConfidenceShape(confidence);
  const minInlierRatio = options.minInlierRatio ?? DEFAULT_MIN_INLIER_RATIO;
  const maxReprojectionErrorPx =
    options.maxReprojectionErrorPx ?? DEFAULT_MAX_REPROJECTION_ERROR_PX;
  if (!Number.isFinite(minInlierRatio) || minInlierRatio < 0 || minInlierRatio > 1) {
    throw new GeometryError("invalid-options", "minInlierRatio must be a finite number in [0,1]");
  }
  if (!Number.isFinite(maxReprojectionErrorPx) || maxReprojectionErrorPx <= 0) {
    throw new GeometryError(
      "invalid-options",
      "maxReprojectionErrorPx must be a finite number greater than zero"
    );
  }

  const matrix = transform.matrix;
  if (!matrix.every((entry) => Number.isFinite(entry))) {
    return false;
  }
  if (
    !Number.isFinite(confidence.inlierRatio) ||
    confidence.inlierRatio < 0 ||
    confidence.inlierRatio > 1
  ) {
    return false;
  }
  if (!Number.isFinite(confidence.reprojectionErrorPx) || confidence.reprojectionErrorPx < 0) {
    return false;
  }
  if (confidence.observedSequence < 0n) {
    return false;
  }
  if (!isInvertibleHomography(matrix)) {
    return false;
  }
  return (
    confidence.inlierRatio >= minInlierRatio &&
    confidence.reprojectionErrorPx <= maxReprojectionErrorPx
  );
}
