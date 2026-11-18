import { describe, expect, it } from "vitest";
import {
  GeometryError,
  fitBoardHomography,
  type BoardCorners,
  type GeometryErrorCode
} from "@chessonglass/perception";

/**
 * Axis-aligned 600x600 board centered in an 800x800 frame. Image y grows
 * down, so the near edge (toward the camera) sits at y = 700 and the far
 * edge at y = 100. The exact homography is affine:
 * x = 75u + 100, y = -75v + 700.
 */
const AFFINE_CORNERS: BoardCorners = {
  nearLeft: [100, 700],
  nearRight: [700, 700],
  farRight: [700, 100],
  farLeft: [100, 100]
};

/**
 * Symmetric perspective trapezoid in a 1000x750 frame: the near edge is
 * 700 px wide and the far edge 300 px wide. The exact homography is
 * x = (525u + 500v + 900) / (v + 6), y = (-175v + 4200) / (v + 6).
 */
const PERSPECTIVE_CORNERS: BoardCorners = {
  nearLeft: [150, 700],
  nearRight: [850, 700],
  farRight: [650, 200],
  farLeft: [350, 200]
};

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

describe("fitBoardHomography", () => {
  it("recovers the exact affine map of an axis-aligned board", () => {
    const fitted = fitBoardHomography(AFFINE_CORNERS, 800, 800);
    const expected = [75, 0, 100, 0, -75, 700, 0, 0, 1];
    expected.forEach((value, index) => {
      expect(fitted.matrix[index]).toBeCloseTo(value, 6);
    });
  });

  it("recovers the exact perspective map of a trapezoid board", () => {
    const fitted = fitBoardHomography(PERSPECTIVE_CORNERS, 1000, 750);
    const expected = [87.5, 500 / 6, 150, 0, -175 / 6, 700, 0, 1 / 6, 1];
    expected.forEach((value, index) => {
      expect(fitted.matrix[index]).toBeCloseTo(value, 6);
    });
  });

  it("is deterministic for identical inputs", () => {
    expect(fitBoardHomography(PERSPECTIVE_CORNERS, 1000, 750)).toEqual(
      fitBoardHomography(PERSPECTIVE_CORNERS, 1000, 750)
    );
  });

  it("rejects corners that are not finite [x, y] pairs", () => {
    expectGeometryError(
      () => fitBoardHomography({ ...AFFINE_CORNERS, nearLeft: [Number.NaN, 700] }, 800, 800),
      "invalid-corners"
    );
    expectGeometryError(
      () =>
        fitBoardHomography(
          { ...AFFINE_CORNERS, farLeft: [100, Number.POSITIVE_INFINITY] },
          800,
          800
        ),
      "invalid-corners"
    );
    expectGeometryError(
      () =>
        fitBoardHomography(
          { ...AFFINE_CORNERS, nearRight: [700] } as unknown as BoardCorners,
          800,
          800
        ),
      "invalid-corners"
    );
  });

  it("rejects a malformed corner object", () => {
    expectGeometryError(
      () => fitBoardHomography(null as unknown as BoardCorners, 800, 800),
      "invalid-corners"
    );
  });

  it("rejects repeated, collinear and crossed corner orders", () => {
    expectGeometryError(
      () => fitBoardHomography({ ...AFFINE_CORNERS, nearRight: [100, 700] }, 800, 800),
      "degenerate-corners"
    );
    expectGeometryError(
      () =>
        fitBoardHomography(
          { nearLeft: [0, 0], nearRight: [100, 0], farRight: [200, 0], farLeft: [300, 0] },
          800,
          800
        ),
      "degenerate-corners"
    );
    expectGeometryError(
      () =>
        fitBoardHomography(
          { nearLeft: [0, 0], nearRight: [100, 100], farRight: [0, 100], farLeft: [100, 0] },
          800,
          800
        ),
      "degenerate-corners"
    );
  });

  it("rejects zero, negative and non-finite image sizes", () => {
    const sizes: ReadonlyArray<[number, number]> = [
      [0, 800],
      [800, 0],
      [-800, 800],
      [Number.NaN, 800],
      [800, Number.POSITIVE_INFINITY]
    ];
    for (const [width, height] of sizes) {
      expectGeometryError(
        () => fitBoardHomography(AFFINE_CORNERS, width, height),
        "invalid-image-size"
      );
    }
  });
});

describe("GeometryError", () => {
  it("is a typed Error carrying a code", () => {
    const error = new GeometryError("invalid-square", "square must be an integer in [0,63]");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GeometryError");
    expect(error.code).toBe("invalid-square");
  });
});
