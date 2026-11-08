/**
 * Where the board's squares are in a frame, from where its corners are.
 *
 * The board is flat, so one perspective transform (a homography) maps the board's plane onto the
 * image. The plane is measured in squares from the wearer's point of view: u runs 0 to 8 from
 * their left to their right, v runs 0 to 8 from the near edge to the far edge.
 */

/** A point in the image, as fractions of its width and height from the top left. */
export type Point = [x: number, y: number];

/** The playing area's four outer corners in the image (the 8×8 squares, not the board's border). */
export interface Corners {
  nearLeft: Point;
  nearRight: Point;
  farRight: Point;
  farLeft: Point;
}

/** A 3×3 matrix, row by row, with the last entry 1. */
export type Homography = number[];

/** The homography that maps each `from` point onto the matching `to` point (four of each). */
export function homography(from: Point[], to: Point[]): Homography {
  // x' = (h0 x + h1 y + h2) / (h6 x + h7 y + 1), and likewise y' with h3 h4 h5: two rows per point.
  const rows: number[][] = [];
  from.forEach(([x, y], i) => {
    const [X, Y] = to[i];
    rows.push([x, y, 1, 0, 0, 0, -X * x, -X * y, X]);
    rows.push([0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]);
  });
  return [...solve(rows), 1];
}

export function project(h: Homography, [x, y]: Point): Point {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/** The board plane → image transform for these corners. */
export function boardToImage(corners: Corners): Homography {
  const plane: Point[] = [
    [0, 0],
    [8, 0],
    [8, 8],
    [0, 8],
  ];
  return homography(plane, [corners.nearLeft, corners.nearRight, corners.farRight, corners.farLeft]);
}

/** Where `square` ("e4") sits on the board plane: its near-left corner, for a wearer playing `side`. */
export function squareOnPlane(square: string, side: "w" | "b"): Point {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return side === "w" ? [file, rank] : [7 - file, 7 - rank];
}

/** The square's outline in the image: near-left, near-right, far-right, far-left. */
export function squareInImage(h: Homography, square: string, side: "w" | "b"): Point[] {
  const [u, v] = squareOnPlane(square, side);
  return [project(h, [u, v]), project(h, [u + 1, v]), project(h, [u + 1, v + 1]), project(h, [u, v + 1])];
}

/** The middle of the square in the image. */
export function squareCenter(h: Homography, square: string, side: "w" | "b"): Point {
  const [u, v] = squareOnPlane(square, side);
  return project(h, [u + 0.5, v + 0.5]);
}

/** Solve a linear system given as augmented rows, by Gaussian elimination with partial pivoting. */
function solve(rows: number[][]): number[] {
  const n = rows.length;
  const m = rows.map((row) => [...row]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) throw new Error("these corners don't make a quadrilateral");
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}
