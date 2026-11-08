import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "@chessonglass/perception";

describe("@chessonglass/perception public entrypoint", () => {
  it("loads and identifies the package", () => {
    expect(PACKAGE_NAME).toBe("@chessonglass/perception");
  });
});
