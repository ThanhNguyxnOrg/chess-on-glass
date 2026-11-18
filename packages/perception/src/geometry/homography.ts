import { GeometryError } from "./types.js";
import type { BoardCorners, Homography, HomographyMatrix, Point } from "./types.js";

/**
 * Board-frame coordinates of the four board corners, in square units, in the
 * same order the caller's image corners are read: near-left, near-right,
 * far-right, far-left. "Near" is the board edge closest to the camera; x runs
 * left to right along the near edge and y runs near to far. With the
 * `side: "w"` labeling the near-left corner is a1; `projectSquare` applies
 * the side-dependent labeling on top of this frame.
 */
const BOARD_FRAME_CORNERS = [
  [0, 0],
  [8, 0],
  [8, 8],
  [0, 8]
] as const;

/**
 * Hartley normalization target: after translating the centroid to the origin,
 * points are scaled so their mean distance from it is sqrt(2). Without this
 * the 8x8 solve mixes square-unit board coordinates with pixel coordinates
 * and becomes needlessly ill-conditioned.
 */
const NORMALIZATION_MEAN_DISTANCE = Math.SQRT2;

/**
 * Pivot floor relative to the system's largest magnitude. It only has to
 * catch true singularity, not honest ill-conditioning; anything stricter
 * would reject legitimate strong-perspective boards.
 */
const PIVOT_RELATIVE_FLOOR = 1e-12;

/** Sin of the smallest turn still counted as a corner instead of a straight edge. */
const MIN_TURN_SIN = 1e-9;

/** Relative reprojection tolerance of the fit self-check. */
const FIT_TOLERANCE_RELATIVE = 1e-6;

/**
 * Denominator floor relative to the matrix terms that produced it. A smaller
 * |w| means the board point reaches the line at infinity, where projected
 * pixel coordinates are meaningless.
 */
const DENOMINATOR_RELATIVE_FLOOR = 1e-12;

type CornerQuadruple = readonly [Point, Point, Point, Point];

/**
 * Read a buffer cell explicitly: plain arrays index as `number | undefined`
 * under noUncheckedIndexedAccess, and the solver must never do arithmetic on
 * an undefined cell by accident.
 */
function at(values: readonly number[], index: number): number {
  const value = values.at(index);
  if (value === undefined) {
    throw new GeometryError("unsolvable", "geometry solver indexed outside its working buffer");
  }
  return value;
}

function requireFinitePoint(value: unknown, label: string): Point {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new GeometryError("invalid-corners", `${label} must be an [x, y] pair`);
  }
  const pair = value as unknown[];
  const x = pair[0];
  const y = pair[1];
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y)
  ) {
    throw new GeometryError("invalid-corners", `${label} must contain finite numbers`);
  }
  return [x, y];
}

function readImageCorners(corners: BoardCorners): CornerQuadruple {
  if (typeof corners !== "object" || corners === null) {
    throw new GeometryError("invalid-corners", "board corners must be an object with four corners");
  }
  return [
    requireFinitePoint(corners.nearLeft, "corner nearLeft"),
    requireFinitePoint(corners.nearRight, "corner nearRight"),
    requireFinitePoint(corners.farRight, "corner farRight"),
    requireFinitePoint(corners.farLeft, "corner farLeft")
  ];
}

function requirePositiveImageSize(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new GeometryError("invalid-image-size", "image size must be finite and greater than zero");
  }
}

/** Cross-product sine of the turn at `current`, normalized so degeneracy is scale-free. */
function turnSin(previous: Point, current: Point, next: Point): number {
  const ax = current[0] - previous[0];
  const ay = current[1] - previous[1];
  const bx = next[0] - current[0];
  const by = next[1] - current[1];
  const edgeProduct =
    Math.sqrt(ax * ax + ay * ay) * Math.sqrt(bx * bx + by * by);
  if (!(edgeProduct > 0)) {
    throw new GeometryError("degenerate-corners", "board corners contain repeated points");
  }
  return (ax * by - ay * bx) / edgeProduct;
}

/**
 * Reject any corner order a planar quadrilateral cannot produce: zero or
 * vanishing turns (repeated or collinear points) and turns that switch
 * winding (a crossed, bow-tie quad folds the board over itself in the
 * overlay). The winding direction itself stays free so a rotated camera is
 * not rejected.
 */
function assertStrictlyConvexQuad(quad: CornerQuadruple): void {
  const turns: ReadonlyArray<readonly [Point, Point, Point]> = [
    [quad[0], quad[1], quad[2]],
    [quad[1], quad[2], quad[3]],
    [quad[2], quad[3], quad[0]],
    [quad[3], quad[0], quad[1]]
  ];
  let winding = 0;
  for (const [previous, current, next] of turns) {
    const sin = turnSin(previous, current, next);
    if (!Number.isFinite(sin) || Math.abs(sin) <= MIN_TURN_SIN) {
      throw new GeometryError("degenerate-corners", "board corners contain collinear points");
    }
    const turnWinding = Math.sign(sin);
    if (winding === 0) {
      winding = turnWinding;
    } else if (winding !== turnWinding) {
      throw new GeometryError(
        "degenerate-corners",
        "board corners are crossed instead of a convex quad"
      );
    }
  }
}

type Similarity = Readonly<{ scale: number; cx: number; cy: number }>;

/**
 * Hartley similarity for one point set: translate the centroid to the origin,
 * scale so the mean point distance is the normalization target. Distinct
 * points are guaranteed by the convexity check before this runs.
 */
function similarityFor(points: readonly Point[]): Similarity {
  let cx = 0;
  let cy = 0;
  for (const point of points) {
    cx += point[0];
    cy += point[1];
  }
  cx /= points.length;
  cy /= points.length;
  let meanDistance = 0;
  for (const point of points) {
    const dx = point[0] - cx;
    const dy = point[1] - cy;
    meanDistance += Math.sqrt(dx * dx + dy * dy);
  }
  meanDistance /= points.length;
  if (!(meanDistance > 0) || !Number.isFinite(meanDistance)) {
    throw new GeometryError("degenerate-corners", "board corners carry no spread to normalize");
  }
  return { scale: NORMALIZATION_MEAN_DISTANCE / meanDistance, cx, cy };
}

function applySimilarity(similarity: Similarity, point: Point): Point {
  return [
    (point[0] - similarity.cx) * similarity.scale,
    (point[1] - similarity.cy) * similarity.scale
  ];
}

function similarityToMatrix(similarity: Similarity): HomographyMatrix {
  return [
    similarity.scale,
    0,
    -similarity.scale * similarity.cx,
    0,
    similarity.scale,
    -similarity.scale * similarity.cy,
    0,
    0,
    1
  ];
}

function inverseSimilarityToMatrix(similarity: Similarity): HomographyMatrix {
  return [
    1 / similarity.scale,
    0,
    similarity.cx,
    0,
    1 / similarity.scale,
    similarity.cy,
    0,
    0,
    1
  ];
}

function multiplyMatrices(left: HomographyMatrix, right: HomographyMatrix): HomographyMatrix {
  const product = new Array<number>(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) {
        sum += at(left, row * 3 + k) * at(right, k * 3 + col);
      }
      product[row * 3 + col] = sum;
    }
  }
  return [
    at(product, 0),
    at(product, 1),
    at(product, 2),
    at(product, 3),
    at(product, 4),
    at(product, 5),
    at(product, 6),
    at(product, 7),
    at(product, 8)
  ];
}

/**
 * Build the 8x9 augmented system for the normalized homography (h33 = 1).
 * Each correspondence contributes two rows:
 *   [u v 1 0 0 0 -xu -xv | x] and [0 0 0 u v 1 -yu -yv | y].
 */
function buildAugmentedSystem(
  boardPoints: CornerQuadruple,
  imagePoints: CornerQuadruple,
  source: Similarity,
  target: Similarity
): number[] {
  const pairs: ReadonlyArray<readonly [Point, Point]> = [
    [boardPoints[0], imagePoints[0]],
    [boardPoints[1], imagePoints[1]],
    [boardPoints[2], imagePoints[2]],
    [boardPoints[3], imagePoints[3]]
  ];
  const augmented = new Array<number>(8 * 9).fill(0);
  for (const [index, [boardPoint, imagePoint]] of pairs.entries()) {
    const [u, v] = applySimilarity(source, boardPoint);
    const [x, y] = applySimilarity(target, imagePoint);
    const rowX = index * 2;
    const rowY = rowX + 1;
    augmented[rowX * 9 + 0] = u;
    augmented[rowX * 9 + 1] = v;
    augmented[rowX * 9 + 2] = 1;
    augmented[rowX * 9 + 6] = -x * u;
    augmented[rowX * 9 + 7] = -x * v;
    augmented[rowX * 9 + 8] = x;
    augmented[rowY * 9 + 3] = u;
    augmented[rowY * 9 + 4] = v;
    augmented[rowY * 9 + 5] = 1;
    augmented[rowY * 9 + 6] = -y * u;
    augmented[rowY * 9 + 7] = -y * v;
    augmented[rowY * 9 + 8] = y;
  }
  return augmented;
}

/**
 * Gaussian elimination with partial pivoting: bounded element growth keeps
 * this exact-fit system stable with no platform-specific linear-algebra
 * dependency, and a vanished pivot becomes a typed error instead of a
 * silently wrong matrix.
 */
function solveHomographySystem(augmented: readonly number[]): number[] {
  const size = 8;
  const stride = size + 1;
  if (augmented.length !== size * stride) {
    throw new GeometryError("unsolvable", "homography system has an unexpected shape");
  }
  let scale = 0;
  for (const entry of augmented) {
    scale = Math.max(scale, Math.abs(entry));
  }
  if (!(scale > 0)) {
    throw new GeometryError("unsolvable", "homography system has no magnitude to pivot on");
  }
  const pivotFloor = PIVOT_RELATIVE_FLOOR * scale;
  const work = [...augmented];

  for (let col = 0; col < size; col += 1) {
    let pivotRow = col;
    let pivotMagnitude = Math.abs(at(work, col * stride + col));
    for (let row = col + 1; row < size; row += 1) {
      const candidate = Math.abs(at(work, row * stride + col));
      if (candidate > pivotMagnitude) {
        pivotRow = row;
        pivotMagnitude = candidate;
      }
    }
    if (!(pivotMagnitude > pivotFloor)) {
      throw new GeometryError("unsolvable", "homography system is singular");
    }
    if (pivotRow !== col) {
      for (let k = col; k < stride; k += 1) {
        const swapped = at(work, col * stride + k);
        work[col * stride + k] = at(work, pivotRow * stride + k);
        work[pivotRow * stride + k] = swapped;
      }
    }
    for (let row = col + 1; row < size; row += 1) {
      const factor = at(work, row * stride + col) / at(work, col * stride + col);
      for (let k = col; k < stride; k += 1) {
        const target = row * stride + k;
        work[target] = at(work, target) - factor * at(work, col * stride + k);
      }
    }
  }

  const solution = new Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = at(work, row * stride + size);
    for (let k = row + 1; k < size; k += 1) {
      sum -= at(work, row * stride + k) * at(solution, k);
    }
    solution[row] = sum / at(work, row * stride + row);
  }
  for (const value of solution) {
    if (!Number.isFinite(value)) {
      throw new GeometryError("unsolvable", "homography solve produced a non-finite result");
    }
  }
  return solution;
}

function homographyFromSolution(solution: readonly number[]): HomographyMatrix {
  return [
    at(solution, 0),
    at(solution, 1),
    at(solution, 2),
    at(solution, 3),
    at(solution, 4),
    at(solution, 5),
    at(solution, 6),
    at(solution, 7),
    1
  ];
}

function allFinite(matrix: HomographyMatrix): boolean {
  return matrix.every((entry) => Number.isFinite(entry));
}

/**
 * Fit self-check: an exact four-point solve must reproject its own inputs to
 * within floating-point noise. A miss means the solve blew up numerically and
 * the matrix would silently misplace overlay squares.
 */
function assertReprojectsCorners(
  matrix: HomographyMatrix,
  imagePoints: CornerQuadruple,
  width: number,
  height: number
): void {
  const tolerance = FIT_TOLERANCE_RELATIVE * Math.max(1, Math.abs(width), Math.abs(height));
  const correspondences: ReadonlyArray<readonly [Point, Point]> = [
    [BOARD_FRAME_CORNERS[0], imagePoints[0]],
    [BOARD_FRAME_CORNERS[1], imagePoints[1]],
    [BOARD_FRAME_CORNERS[2], imagePoints[2]],
    [BOARD_FRAME_CORNERS[3], imagePoints[3]]
  ];
  for (const [[u, v], [x, y]] of correspondences) {
    const denominator = matrix[6] * u + matrix[7] * v + matrix[8];
    const magnitude = Math.abs(matrix[6] * u) + Math.abs(matrix[7] * v) + Math.abs(matrix[8]);
    if (!(Math.abs(denominator) > DENOMINATOR_RELATIVE_FLOOR * magnitude)) {
      throw new GeometryError(
        "unsolvable",
        "fitted homography sends a board corner through a vanishing denominator"
      );
    }
    const projectedX = (matrix[0] * u + matrix[1] * v + matrix[2]) / denominator;
    const projectedY = (matrix[3] * u + matrix[4] * v + matrix[5]) / denominator;
    if (!Number.isFinite(projectedX) || !Number.isFinite(projectedY)) {
      throw new GeometryError(
        "unsolvable",
        "fitted homography projects a board corner to a non-finite point"
      );
    }
    const dx = projectedX - x;
    const dy = projectedY - y;
    if (!(Math.sqrt(dx * dx + dy * dy) <= tolerance)) {
      throw new GeometryError("unsolvable", "fitted homography does not reproduce the input corners");
    }
  }
}

/**
 * Fit a planar homography from the four board corners in image pixels.
 *
 * The board frame maps nearLeft to (0, 0), nearRight to (8, 0), farRight to
 * (8, 8) and farLeft to (0, 8): x runs left to right along the near edge, y
 * runs near to far, units are squares. Corners must form a strictly convex
 * quad in the given order (winding direction is free so a rotated camera is
 * accepted); repeated, collinear or crossed orders, non-finite input and
 * non-positive image sizes throw a typed `GeometryError` rather than fitting
 * a junk transform.
 *
 * This fit carries no 3D pose, camera intrinsics or eye-display calibration:
 * a single planar homography cannot determine them, and the overlay must not
 * pretend otherwise.
 */
export function fitBoardHomography(
  corners: BoardCorners,
  width: number,
  height: number
): Homography {
  const imageCorners = readImageCorners(corners);
  requirePositiveImageSize(width, height);
  assertStrictlyConvexQuad(imageCorners);

  const source = similarityFor(BOARD_FRAME_CORNERS);
  const target = similarityFor(imageCorners);
  const augmented = buildAugmentedSystem(BOARD_FRAME_CORNERS, imageCorners, source, target);
  const solution = solveHomographySystem(augmented);
  const composed = multiplyMatrices(
    multiplyMatrices(inverseSimilarityToMatrix(target), homographyFromSolution(solution)),
    similarityToMatrix(source)
  );

  if (!allFinite(composed)) {
    throw new GeometryError("unsolvable", "composed homography contains non-finite entries");
  }
  const h33 = composed[8];
  // Canonical form: h33 = 1 keeps fitted matrices comparable and makes the
  // projection denominator O(1) across the board area.
  const matrix: HomographyMatrix =
    h33 !== 0
      ? [
          composed[0] / h33,
          composed[1] / h33,
          composed[2] / h33,
          composed[3] / h33,
          composed[4] / h33,
          composed[5] / h33,
          composed[6] / h33,
          composed[7] / h33,
          composed[8] / h33
        ]
      : composed;
  if (!allFinite(matrix)) {
    throw new GeometryError("unsolvable", "normalized homography contains non-finite entries");
  }
  assertReprojectsCorners(matrix, imageCorners, width, height);
  return { matrix };
}

/** Structural check only: nine numeric entries. NaN passes and is judged as a value elsewhere. */
export function isHomographyShape(value: unknown): value is Homography {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { matrix?: unknown };
  if (!Array.isArray(candidate.matrix) || candidate.matrix.length !== 9) {
    return false;
  }
  const matrix = candidate.matrix as unknown[];
  return matrix.every((entry) => typeof entry === "number");
}

/**
 * Entry guard for coordinate-producing calls: a transform that is not a
 * well-formed finite homography throws instead of ever returning coordinates.
 */
export function requireFiniteHomography(transform: Homography): HomographyMatrix {
  if (!isHomographyShape(transform)) {
    throw new GeometryError("invalid-transform", "transform must be a homography with a nine-entry matrix");
  }
  if (!allFinite(transform.matrix)) {
    throw new GeometryError("invalid-transform", "transform matrix must contain only finite numbers");
  }
  return transform.matrix;
}

/**
 * Project one board-frame point to image pixels. Throws when the point
 * reaches the line at infinity or lands outside the finite pixel range, so
 * callers never receive junk coordinates.
 */
export function projectPoint(matrix: HomographyMatrix, u: number, v: number): Point {
  const denominator = matrix[6] * u + matrix[7] * v + matrix[8];
  const magnitude = Math.abs(matrix[6] * u) + Math.abs(matrix[7] * v) + Math.abs(matrix[8]);
  if (!(Math.abs(denominator) > DENOMINATOR_RELATIVE_FLOOR * magnitude)) {
    throw new GeometryError("projection-failed", "board point projects through a vanishing denominator");
  }
  const x = (matrix[0] * u + matrix[1] * v + matrix[2]) / denominator;
  const y = (matrix[3] * u + matrix[4] * v + matrix[5]) / denominator;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new GeometryError("projection-failed", "board point projects to a non-finite image coordinate");
  }
  return [x, y];
}

/**
 * Invertibility check by partial-pivot elimination with a pivot floor
 * relative to the matrix's own scale, so the verdict is independent of pixel
 * units. Non-finite matrices fail here by construction (NaN poisons the
 * scale comparison).
 */
export function isInvertibleHomography(matrix: HomographyMatrix): boolean {
  const work = [...matrix];
  let scale = 0;
  for (const entry of work) {
    scale = Math.max(scale, Math.abs(entry));
  }
  if (!(scale > 0)) {
    return false;
  }
  const pivotFloor = PIVOT_RELATIVE_FLOOR * scale;
  for (let col = 0; col < 3; col += 1) {
    let pivotRow = col;
    let pivotMagnitude = Math.abs(at(work, col * 3 + col));
    for (let row = col + 1; row < 3; row += 1) {
      const candidate = Math.abs(at(work, row * 3 + col));
      if (candidate > pivotMagnitude) {
        pivotRow = row;
        pivotMagnitude = candidate;
      }
    }
    if (!(pivotMagnitude > pivotFloor)) {
      return false;
    }
    if (pivotRow !== col) {
      for (let k = col; k < 3; k += 1) {
        const swapped = at(work, col * 3 + k);
        work[col * 3 + k] = at(work, pivotRow * 3 + k);
        work[pivotRow * 3 + k] = swapped;
      }
    }
    for (let row = col + 1; row < 3; row += 1) {
      const factor = at(work, row * 3 + col) / at(work, col * 3 + col);
      for (let k = col; k < 3; k += 1) {
        const target = row * 3 + k;
        work[target] = at(work, target) - factor * at(work, col * 3 + k);
      }
    }
  }
  return true;
}
