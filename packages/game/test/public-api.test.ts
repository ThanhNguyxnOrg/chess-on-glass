import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "@chessonglass/game";

describe("@chessonglass/game public entrypoint", () => {
  it("loads and identifies the package", () => {
    expect(PACKAGE_NAME).toBe("@chessonglass/game");
  });
});
