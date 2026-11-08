import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "@chessonglass/contracts";

describe("@chessonglass/contracts public entrypoint", () => {
  it("loads and identifies the package", () => {
    expect(PACKAGE_NAME).toBe("@chessonglass/contracts");
  });
});
