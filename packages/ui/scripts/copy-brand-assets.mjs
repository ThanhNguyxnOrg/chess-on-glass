#!/usr/bin/env node
/**
 * Copies the untouched brand asset into the UI build output and proves both
 * sides still hash to the recorded value. The source image is only read.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_SHA256 =
  "3054b16d2b2cfd263fc3bd2997c392cec6fb9f17b7bb1a9a0bdf22af4af79909";

const uiDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(uiDir, "..", "..");
const source = join(repoRoot, "asset", "logo.png");
const destination = join(uiDir, "dist", "logo.png");

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

const sourceHash = await sha256(source);
if (sourceHash !== EXPECTED_SHA256) {
  throw new Error(
    `brand logo changed: ${sourceHash} != ${EXPECTED_SHA256}`
  );
}

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);

const outputHash = await sha256(destination);
if (outputHash !== sourceHash) {
  throw new Error(`copied logo does not match the source: ${outputHash}`);
}

console.log(`brand assets: copied ${source} -> ${destination}`);
