import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};

export type StaticAsset = Readonly<{ bytes: Uint8Array; contentType: string }>;

function decodePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Serves only regular files that resolve inside the configured root. Symlinks
 * and junctions that leave the root, encoded traversal, backslash paths and
 * NUL bytes all return null; the caller answers 404.
 */
export class StaticFiles {
  private readonly root: string;
  private rootReal: Promise<string> | null = null;

  constructor(rootDirectory: string) {
    this.root = resolve(rootDirectory);
  }

  async serve(pathname: string): Promise<StaticAsset | null> {
    const decoded = decodePath(pathname);
    if (decoded === null || decoded.includes("\\") || decoded.includes("\0")) {
      return null;
    }

    const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    const segments = relativePath.split("/");
    if (
      segments.some(
        (segment) => segment === "" || segment === "." || segment === ".."
      )
    ) {
      return null;
    }

    const candidate = join(this.root, ...segments);
    if (!isInside(this.root, candidate)) {
      return null;
    }

    this.rootReal ??= realpath(this.root);
    const [rootReal, fileReal] = await Promise.all([
      this.rootReal,
      realpath(candidate).catch(() => null)
    ]);
    if (fileReal === null || !isInside(rootReal, fileReal)) {
      return null;
    }

    const info = await stat(fileReal);
    if (!info.isFile()) {
      return null;
    }

    return {
      bytes: await readFile(fileReal),
      contentType: CONTENT_TYPES[extname(fileReal).toLowerCase()] ?? "application/octet-stream"
    };
  }
}
