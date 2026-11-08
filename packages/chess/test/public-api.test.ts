import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "@chessonglass/chess";

describe("@chessonglass/chess public entrypoint", () => {
  it("loads and identifies the package", () => {
    expect(PACKAGE_NAME).toBe("@chessonglass/chess");
  });
});
