import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const UI_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = resolve(UI_DIR, "..", "..");
const LOGO_PATH = join(REPO_ROOT, "asset", "logo.png");
const LOGO_SHA256 =
  "3054b16d2b2cfd263fc3bd2997c392cec6fb9f17b7bb1a9a0bdf22af4af79909";
const DIST = join(UI_DIR, "dist");

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

describe("branded UI build", () => {
  beforeAll(async () => {
    const { build } = await import("vite");
    await build({ root: UI_DIR, logLevel: "silent" });
    execFileSync(
      process.execPath,
      [join(UI_DIR, "scripts", "copy-brand-assets.mjs")],
      { stdio: "pipe" }
    );
  }, 60_000);

  it("keeps the source logo byte-for-byte", async () => {
    expect(await sha256(LOGO_PATH)).toBe(LOGO_SHA256);
  });

  it("copies the unchanged logo into the build output", async () => {
    const [source, output] = await Promise.all([
      readFile(LOGO_PATH),
      readFile(join(DIST, "logo.png"))
    ]);

    expect(output.equals(source)).toBe(true);
    expect(createHash("sha256").update(output).digest("hex")).toBe(LOGO_SHA256);
  });

  it("builds a branded page with relative external assets and no inline script", async () => {
    const html = await readFile(join(DIST, "index.html"), "utf8");

    expect(html).toContain("ChessOnGlass");
    expect(html.toLowerCase()).not.toContain("chesshacker");

    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(
      (match) => match[1]!
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith("/")).toBe(false);
      expect(/^[a-z]+:/i.test(url)).toBe(false);
    }

    const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>/i;
    expect(inlineScript.test(html)).toBe(false);
  });
});
