import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StaticFiles } from "../../src/http/static-files.js";

describe("StaticFiles", () => {
  let root: string;
  let outside: string;
  let files: StaticFiles;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cog-static-"));
    outside = await mkdtemp(join(tmpdir(), "cog-static-out-"));
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "index.html"), "<h1>ChessOnGlass</h1>", "utf8");
    await writeFile(join(root, "assets", "app.js"), "export {};\n", "utf8");
    await writeFile(join(root, "styles.css"), "body {}\n", "utf8");
    await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
    await symlink(
      outside,
      join(root, "escape"),
      process.platform === "win32" ? "junction" : "dir"
    );
    files = new StaticFiles(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("serves the index and maps content types", async () => {
    const index = await files.serve("/");
    expect(index?.contentType).toContain("text/html");

    const script = await files.serve("/assets/app.js");
    expect(script?.contentType).toContain("javascript");

    const style = await files.serve("/styles.css");
    expect(style?.contentType).toContain("text/css");
  });

  it("returns null for unknown files and unsafe paths", async () => {
    await expect(files.serve("/missing.png")).resolves.toBeNull();
    await expect(files.serve("/..%2fpackage.json")).resolves.toBeNull();
    await expect(files.serve("/..%5c..%5cpackage.json")).resolves.toBeNull();
    await expect(files.serve("/%00index.html")).resolves.toBeNull();
    await expect(files.serve("/escape/secret.txt")).resolves.toBeNull();
    await expect(files.serve("/assets/")).resolves.toBeNull();
  });
});
