import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { userDataDir } from "@chessonglass/platform";

describe("userDataDir", () => {
  it("prefers a nonempty CHESSONGLASS_DATA_DIR in every platform", () => {
    const expected = "D:\\custom\\chess-data";
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(
        userDataDir({ CHESSONGLASS_DATA_DIR: expected, APPDATA: "C:\\appdata" }, platform, "C:\\home")
      ).toBe(expected);
    }
  });

  it("ignores an empty or whitespace-only override", () => {
    expect(
      userDataDir({ CHESSONGLASS_DATA_DIR: "", APPDATA: "C:\\appdata" }, "win32", "C:\\home")
    ).toBe(join("C:\\appdata", "ChessOnGlass"));
    expect(
      userDataDir({ CHESSONGLASS_DATA_DIR: "   ", APPDATA: "C:\\appdata" }, "win32", "C:\\home")
    ).toBe(join("C:\\appdata", "ChessOnGlass"));
  });

  it("uses APPDATA on Windows", () => {
    expect(userDataDir({ APPDATA: "C:\\appdata" }, "win32", "C:\\home")).toBe(
      join("C:\\appdata", "ChessOnGlass")
    );
  });

  it("uses Application Support on macOS", () => {
    expect(userDataDir({}, "darwin", "/Users/example")).toBe(
      join("/Users/example", "Library", "Application Support", "ChessOnGlass")
    );
  });

  it("uses XDG_STATE_HOME on Linux when set", () => {
    expect(userDataDir({ XDG_STATE_HOME: "/state" }, "linux", "/home/example")).toBe(
      join("/state", "ChessOnGlass")
    );
  });

  it("falls back to ~/.local/state on Linux", () => {
    expect(userDataDir({}, "linux", "/home/example")).toBe(
      join("/home/example", ".local", "state", "ChessOnGlass")
    );
  });

  it("fails closed when Windows APPDATA is missing", () => {
    expect(() => userDataDir({}, "win32", "C:\\home")).toThrow(/APPDATA/);
  });
});
