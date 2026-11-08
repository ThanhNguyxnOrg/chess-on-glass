import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "@chessonglass/platform";

describe("@chessonglass/platform public entrypoint", () => {
  it("loads and identifies the package", () => {
    expect(PACKAGE_NAME).toBe("@chessonglass/platform");
  });
});
