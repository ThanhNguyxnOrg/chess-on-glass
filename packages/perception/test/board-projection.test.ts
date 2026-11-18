import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_REPROJECTION_ERROR_PX,
  DEFAULT_MIN_INLIER_RATIO,
  GeometryError,
  fitBoardHomography,
  projectSquare,
  validateGeometry,
  type BoardCorners,
  type GeometryConfidence,
  type GeometryErrorCode,
  type GeometryValidationOptions,
  type Homography,
  type Point
} from "@chessonglass/perception";

/** Same fixtures as homography.test.ts (see there for the analytic maps). */
const AFFINE_CORNERS: BoardCorners = {
  nearLeft: [100, 700],
  nearRight: [700, 700],
  farRight: [700, 100],
  farLeft: [100, 100]
};

const PERSPECTIVE_CORNERS: BoardCorners = {
  nearLeft: [150, 700],
  nearRight: [850, 700],
  farRight: [650, 200],
  farLeft: [350, 200]
};

const AFFINE = fitBoardHomography(AFFINE_CORNERS, 800, 800);
const PERSPECTIVE = fitBoardHomography(PERSPECTIVE_CORNERS, 1000, 750);

function corner(quad: readonly Point[], index: number): Point {
  const point = quad.at(index);
  if (point === undefined) {
    throw new Error(`quad has no corner ${index}`);
  }
  return point;
}

function expectPointClose(actual: Point, expected: Point, epsilon = 1e-6): void {
  expect(Math.abs(actual[0] - expected[0])).toBeLessThanOrEqual(epsilon);
  expect(Math.abs(actual[1] - expected[1])).toBeLessThanOrEqual(epsilon);
}

function expectGeometryError(run: () => unknown, code: GeometryErrorCode): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GeometryError);
  expect((caught as GeometryError).code).toBe(code);
}

function confidence(overrides: Partial<GeometryConfidence> = {}): GeometryConfidence {
  return { inlierRatio: 0.95, reprojectionErrorPx: 1.5, observedSequence: 42n, ...overrides };
}

describe("projectSquare orientation (white)", () => {
  it("maps boundary squares to their exact image quads on an axis-aligned board", () => {
    const boundaryQuads: ReadonlyArray<[square: number, quad: [Point, Point, Point, Point]]> = [
      [0, [[100, 175], [175, 175], [175, 100], [100, 100]]],
      [7, [[625, 175], [700, 175], [700, 100], [625, 100]]],
      [56, [[100, 700], [175, 700], [175, 625], [100, 625]]],
      [63, [[625, 700], [700, 700], [700, 625], [625, 625]]]
    ];
    for (const [square, expected] of boundaryQuads) {
      const quad = projectSquare(AFFINE, square, "w");
      for (const [index, point] of expected.entries()) {
        expectPointClose(corner(quad, index), point);
      }
    }
  });

  it("places square centers at their analytic positions", () => {
    for (const square of [0, 18, 27, 42, 63]) {
      const file = square % 8;
      const row = 7 - Math.floor(square / 8); // board-frame row from the near edge
      const center: Point = [100 + 75 * (file + 0.5), 700 - 75 * (row + 0.5)];
      const quad = projectSquare(AFFINE, square, "w");
      const centerX =
        (corner(quad, 0)[0] + corner(quad, 1)[0] + corner(quad, 2)[0] + corner(quad, 3)[0]) / 4;
      const centerY =
        (corner(quad, 0)[1] + corner(quad, 1)[1] + corner(quad, 2)[1] + corner(quad, 3)[1]) / 4;
      expectPointClose([centerX, centerY], center);
    }
  });
});

describe("projectSquare orientation (black)", () => {
  it("rotates the labeling: black square s is white square 63 - s", () => {
    for (const square of [0, 7, 27, 63]) {
      expect(projectSquare(AFFINE, square, "b")).toEqual(projectSquare(AFFINE, 63 - square, "w"));
      expect(projectSquare(PERSPECTIVE, square, "b")).toEqual(
        projectSquare(PERSPECTIVE, 63 - square, "w")
      );
    }
  });

  it("puts a1 at the far-right and h8 at the near-left from black's side", () => {
    expectPointClose(corner(projectSquare(AFFINE, 56, "b"), 2), [700, 100]);
    expectPointClose(corner(projectSquare(AFFINE, 7, "b"), 0), [100, 700]);
  });
});

describe("projectSquare on a perspective board", () => {
  it("round-trips the fitted corners through boundary squares", () => {
    expectPointClose(corner(projectSquare(PERSPECTIVE, 56, "w"), 0), PERSPECTIVE_CORNERS.nearLeft);
    expectPointClose(
      corner(projectSquare(PERSPECTIVE, 63, "w"), 1),
      PERSPECTIVE_CORNERS.nearRight
    );
    expectPointClose(
      corner(projectSquare(PERSPECTIVE, 7, "w"), 2),
      PERSPECTIVE_CORNERS.farRight
    );
    expectPointClose(corner(projectSquare(PERSPECTIVE, 0, "w"), 3), PERSPECTIVE_CORNERS.farLeft);
  });

  it("agrees on corners shared by adjacent squares and on the board center", () => {
    // Board corner (4,4) is shared by d4 (35), e4 (36), d5 (27) and e5 (28)
    // and must project to the same image point from every square that touches
    // it.
    const shared = corner(projectSquare(PERSPECTIVE, 35, "w"), 2);
    expectPointClose(shared, corner(projectSquare(PERSPECTIVE, 36, "w"), 3));
    expectPointClose(shared, corner(projectSquare(PERSPECTIVE, 27, "w"), 1));
    expectPointClose(shared, corner(projectSquare(PERSPECTIVE, 28, "w"), 0));
    expectPointClose(shared, [500, 350]);
  });
});

describe("projectSquare input validation", () => {
  it("rejects square indices outside 0-63", () => {
    for (const square of [-1, 64, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectGeometryError(() => projectSquare(AFFINE, square, "w"), "invalid-square");
    }
  });

  it("rejects unknown sides", () => {
    for (const side of ["W", "white", "", "x"]) {
      expectGeometryError(
        () => projectSquare(AFFINE, 0, side as "w" | "b"),
        "invalid-side"
      );
    }
  });

  it("rejects structurally invalid transforms instead of producing coordinates", () => {
    expectGeometryError(
      () => projectSquare(null as unknown as Homography, 0, "w"),
      "invalid-transform"
    );
    expectGeometryError(
      () =>
        projectSquare({ matrix: [75, 0, 100, 0, -75, 700, 0, 0] } as unknown as Homography, 0, "w"),
      "invalid-transform"
    );
    expectGeometryError(
      () => projectSquare({ matrix: [Number.NaN, 0, 100, 0, -75, 700, 0, 0, 1] }, 0, "w"),
      "invalid-transform"
    );
  });

  it("refuses to project through a vanishing denominator", () => {
    const throughInfinity: Homography = { matrix: [1, 0, 0, 0, 1, 0, -1, 0, 8] };
    expectGeometryError(() => projectSquare(throughInfinity, 7, "w"), "projection-failed");
    // The same transform is still usable where the denominator stays finite.
    const quad = projectSquare(throughInfinity, 0, "w");
    expect(quad).toHaveLength(4);
    for (const point of quad) {
      expect(Number.isFinite(point[0])).toBe(true);
      expect(Number.isFinite(point[1])).toBe(true);
    }
  });
});

describe("validateGeometry", () => {
  it("pins the documented default policy bounds", () => {
    expect(DEFAULT_MIN_INLIER_RATIO).toBe(0.8);
    expect(DEFAULT_MAX_REPROJECTION_ERROR_PX).toBe(6);
  });

  it("accepts fitted transforms with healthy detector confidence", () => {
    expect(validateGeometry(AFFINE, confidence())).toBe(true);
    expect(validateGeometry(PERSPECTIVE, confidence())).toBe(true);
  });

  it("enforces the inclusive default confidence bounds", () => {
    expect(
      validateGeometry(AFFINE, confidence({ inlierRatio: DEFAULT_MIN_INLIER_RATIO }))
    ).toBe(true);
    expect(
      validateGeometry(AFFINE, confidence({ inlierRatio: DEFAULT_MIN_INLIER_RATIO - 0.01 }))
    ).toBe(false);
    expect(
      validateGeometry(
        AFFINE,
        confidence({ reprojectionErrorPx: DEFAULT_MAX_REPROJECTION_ERROR_PX })
      )
    ).toBe(true);
    expect(
      validateGeometry(
        AFFINE,
        confidence({ reprojectionErrorPx: DEFAULT_MAX_REPROJECTION_ERROR_PX + 0.5 })
      )
    ).toBe(false);
  });

  it("honors configured bounds", () => {
    const options: GeometryValidationOptions = {
      minInlierRatio: 0.5,
      maxReprojectionErrorPx: 20
    };
    expect(
      validateGeometry(AFFINE, confidence({ inlierRatio: 0.6, reprojectionErrorPx: 15 }), options)
    ).toBe(true);
    expect(validateGeometry(AFFINE, confidence({ inlierRatio: 0.6, reprojectionErrorPx: 15 }))).toBe(
      false
    );
  });

  it("fails closed on domain-violating confidence values", () => {
    expect(validateGeometry(AFFINE, confidence({ inlierRatio: -0.1 }))).toBe(false);
    expect(validateGeometry(AFFINE, confidence({ inlierRatio: 1.2 }))).toBe(false);
    expect(validateGeometry(AFFINE, confidence({ inlierRatio: Number.NaN }))).toBe(false);
    expect(validateGeometry(AFFINE, confidence({ reprojectionErrorPx: -1 }))).toBe(false);
    expect(validateGeometry(AFFINE, confidence({ reprojectionErrorPx: Number.NaN }))).toBe(false);
    expect(validateGeometry(AFFINE, confidence({ observedSequence: -1n }))).toBe(false);
  });

  it("rejects non-finite and singular transforms as values, not throws", () => {
    expect(validateGeometry({ matrix: [Number.NaN, 0, 0, 0, 1, 0, 0, 0, 1] }, confidence())).toBe(
      false
    );
    expect(
      validateGeometry({ matrix: [1, 0, 0, 0, 1, 0, 0, 0, Number.POSITIVE_INFINITY] }, confidence())
    ).toBe(false);
    expect(validateGeometry({ matrix: [1, 2, 3, 2, 4, 6, 3, 6, 9] }, confidence())).toBe(false);
    expect(validateGeometry({ matrix: [0, 0, 0, 0, 0, 0, 0, 0, 0] }, confidence())).toBe(false);
  });

  it("fails an extreme off-image transform through the confidence policy", () => {
    const offImage: Homography = { matrix: [1, 0, 1e6, 0, 1, 1e6, 0, 0, 1] };
    expect(validateGeometry(offImage, confidence({ reprojectionErrorPx: 900 }))).toBe(false);
    expect(validateGeometry(offImage, confidence({ inlierRatio: 0.2 }))).toBe(false);
  });

  it("throws typed errors for malformed argument shapes", () => {
    expectGeometryError(
      () => validateGeometry(null as unknown as Homography, confidence()),
      "invalid-transform"
    );
    expectGeometryError(
      () => validateGeometry({ matrix: [1, 0, 0, 0, 1] } as unknown as Homography, confidence()),
      "invalid-transform"
    );
    expectGeometryError(
      () => validateGeometry(AFFINE, null as unknown as GeometryConfidence),
      "invalid-confidence"
    );
    expectGeometryError(
      () => validateGeometry(AFFINE, {} as unknown as GeometryConfidence),
      "invalid-confidence"
    );
    expectGeometryError(
      () => validateGeometry(AFFINE, confidence({ inlierRatio: "0.9" as unknown as number })),
      "invalid-confidence"
    );
    expectGeometryError(
      () => validateGeometry(AFFINE, confidence({ observedSequence: 42 as unknown as bigint })),
      "invalid-confidence"
    );
  });

  it("throws typed errors for malformed validation options", () => {
    const invalidOptions: readonly GeometryValidationOptions[] = [
      { minInlierRatio: 1.5 },
      { minInlierRatio: Number.NaN },
      { maxReprojectionErrorPx: 0 },
      { maxReprojectionErrorPx: -3 },
      { maxReprojectionErrorPx: Number.POSITIVE_INFINITY }
    ];
    for (const options of invalidOptions) {
      expectGeometryError(() => validateGeometry(AFFINE, confidence(), options), "invalid-options");
    }
  });
});
