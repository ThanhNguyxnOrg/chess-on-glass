#!/usr/bin/env node
/**
 * Brand, provenance and legacy-isolation acceptance checks for ChessOnGlass.
 *
 * Run with `node scripts/check-brand.mjs` (or `npm run check:brand`). The
 * script only reads files; it never modifies the repository. It exits 1 and
 * lists every failure when any check does not hold.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const LOGO_PATH = "asset/logo.png";
const LOGO_SHA256 =
  "3054b16d2b2cfd263fc3bd2997c392cec6fb9f17b7bb1a9a0bdf22af4af79909";
const ORIGINAL_AUTHOR = "picklerpeej";
const LEGACY_INVENTORY = "docs/legacy-replacement.md";

/** Every file that existed under the legacy `src/` at baseline 2aaa0f9. */
const LEGACY_SRC_FILES = [
  "src/bin.ts",
  "src/board-svg.ts",
  "src/capture.ts",
  "src/cli.ts",
  "src/config.ts",
  "src/doctor.ts",
  "src/engine.ts",
  "src/events.ts",
  "src/feed.ts",
  "src/game.ts",
  "src/gate.ts",
  "src/geometry.ts",
  "src/keychain.ts",
  "src/locate.ts",
  "src/macos.ts",
  "src/main.ts",
  "src/match.ts",
  "src/overlay.ts",
  "src/pricing.ts",
  "src/speak.ts",
  "src/static/index.html",
  "src/vision.ts",
  "src/watch.ts",
  "src/web.ts"
];

/** Markers that legacy-style tests used; none may reach runtime sources. */
const DUMMY_SECRET_MARKERS = [
  "sk-live-",
  "sk-test-",
  "PAIRING-SECRET",
  "FRAME-SECRET",
  "RAW-SECRET",
  "CANARY_SECRET"
];

const failures = [];
const checks = [];

function defineCheck(name, fn) {
  checks.push({ name, fn });
}

function fail(message) {
  failures.push(message);
}

function display(path) {
  return relative(root, path).split(sep).join("/");
}

async function walk(directory, predicate) {
  const results = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walk(path, predicate)));
    } else if (entry.isFile() && predicate(path)) {
      results.push(path);
    }
  }
  return results;
}

async function readIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function runtimeSources() {
  return walk(join(root, "packages"), (path) =>
    path.endsWith(".ts") && path.includes(`${sep}src${sep}`)
  );
}

async function workspacePackageFiles() {
  const entries = await readdir(join(root, "packages"), { withFileTypes: true });
  return [
    join(root, "package.json"),
    ...entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, "packages", entry.name, "package.json"))
  ];
}

defineCheck("logo hash", async () => {
  let bytes;
  try {
    bytes = await readFile(join(root, LOGO_PATH));
  } catch {
    fail(`${LOGO_PATH} is missing`);
    return;
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== LOGO_SHA256) {
    fail(`${LOGO_PATH} sha256 is ${digest}, expected ${LOGO_SHA256}`);
  }
});

defineCheck("workspace metadata", async () => {
  for (const file of await workspacePackageFiles()) {
    const label = display(file);
    const text = await readIfPresent(file);
    if (text === null) {
      fail(`${label} is missing`);
      continue;
    }
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch {
      fail(`${label} is not valid JSON`);
      continue;
    }
    if (pkg.private !== true) {
      fail(`${label} must stay private before a publisher is approved`);
    }
    if (text.toLowerCase().includes(ORIGINAL_AUTHOR)) {
      fail(`${label} still names the original author`);
    }
    if (pkg.publishConfig !== undefined) {
      fail(`${label} must not define publishConfig before a publisher is approved`);
    }
    const name = typeof pkg.name === "string" ? pkg.name : "";
    if (name !== "chessonglass" && !name.startsWith("@chessonglass/")) {
      fail(`${label} uses an unapproved package name: ${name}`);
    }
  }
});

defineCheck("legacy imports", async () => {
  const files = [
    ...(await runtimeSources()),
    ...(await walk(join(root, "scripts"), (path) => path.endsWith(".mjs")))
  ];
  const specifierPattern =
    /(?:import\s[^"'`]*?from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(specifierPattern)) {
      const specifier = match[1].replaceAll("\\", "/");
      if (/(^|\/)src\//.test(specifier)) {
        fail(`${display(file)} imports legacy path ${match[1]}`);
      }
      if (/(^|\/)(macos|speak)(\.js)?$/.test(specifier)) {
        fail(`${display(file)} imports legacy module ${match[1]}`);
      }
    }
  }
});

defineCheck("dummy secret markers", async () => {
  for (const file of await runtimeSources()) {
    const text = await readFile(file, "utf8");
    for (const marker of DUMMY_SECRET_MARKERS) {
      if (text.includes(marker)) {
        fail(`${display(file)} contains dummy secret marker ${marker}`);
      }
    }
  }
});

defineCheck("legacy inventory", async () => {
  const inventory = await readIfPresent(join(root, LEGACY_INVENTORY));
  if (inventory === null) {
    fail(`${LEGACY_INVENTORY} is missing`);
    return;
  }
  const lines = inventory.split(/\r?\n/);
  for (const legacy of LEGACY_SRC_FILES) {
    const line = lines.find((entry) => entry.includes(legacy));
    if (line === undefined) {
      fail(`${LEGACY_INVENTORY} does not mention ${legacy}`);
      continue;
    }
    if (!/false/.test(line)) {
      fail(`${legacy} must record removal-approved:false`);
    }
  }
  if (/removal-approved[^\n]*true/i.test(inventory)) {
    fail("no legacy file may be approved for removal yet");
  }
});

defineCheck("README and DESIGN branding", async () => {
  for (const doc of ["README.md", "DESIGN.md"]) {
    const text = await readIfPresent(join(root, doc));
    if (text === null) {
      fail(`${doc} is missing`);
      continue;
    }
    if (!text.includes("ChessOnGlass")) {
      fail(`${doc} must describe ChessOnGlass`);
    }
    if (/chesshacker/i.test(text)) {
      fail(`${doc} still presents the legacy product name as current`);
    }
  }
});

let failedChecks = 0;
for (const { name, fn } of checks) {
  const before = failures.length;
  try {
    await fn();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (failures.length === before) {
    console.log(`ok   ${name}`);
  } else {
    failedChecks += 1;
    console.error(`FAIL ${name}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error(
    `check-brand: ${failures.length} failure(s) in ${failedChecks} check(s)`
  );
  process.exitCode = 1;
} else {
  console.log("check-brand: all checks passed");
}
