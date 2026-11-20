import type { Artifact } from "../artifacts.js";

/**
 * A fully pinned artifact record: the reviewed identity fields from
 * {@link Artifact} plus the two facts the installer needs — how the official
 * binary was built (`buildFlags`, provenance only, never executed) and which
 * single archive member is the executable to install (`executable`).
 */
export type VerifiedArtifact = Artifact &
  Readonly<{
    buildFlags: readonly string[];
    executable: string;
  }>;

export type ArtifactManifest = Readonly<{
  schemaVersion: 1;
  artifacts: readonly VerifiedArtifact[];
}>;

const NODE_PLATFORMS: ReadonlySet<string> = new Set([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "linux",
  "openbsd",
  "sunos",
  "win32"
]);

const ARTIFACT_IDS: ReadonlySet<string> = new Set(["stockfish", "ffmpeg"]);

/**
 * Validate one archive member name. Member names are untrusted data that
 * become filesystem paths, so the rule is strict: relative, forward-slash
 * separated, printable ASCII, no `.`/`..`/empty segments, no drive letters.
 * The pinned release artifacts all comply; anything else fails closed.
 */
export function assertSafeMemberName(name: string, context: string): void {
  const fail = (reason: string): never => {
    throw new Error(`unsafe ${context} member name ${JSON.stringify(name)}: ${reason}`);
  };
  if (typeof name !== "string" || name === "") {
    fail("must be a non-empty string");
  }
  if (name !== name.trim()) {
    fail("must not have leading or trailing whitespace");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) {
    // Interior spaces are legitimate (the official Stockfish archive ships
    // "Top CPU Contributors.txt"); control characters are not.
    fail("must contain only printable characters without control codes");
  }
  if (name.includes("\\")) {
    fail("backslash separators are ambiguous across operating systems");
  }
  if (name.startsWith("/")) {
    fail("must be a relative path");
  }
  if (/^[a-za-z]:/.test(name)) {
    fail("drive-letter paths are not allowed");
  }
  for (const segment of name.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      fail(`path segment ${JSON.stringify(segment)} is not allowed`);
    }
  }
}

/**
 * Parse and structurally validate a manifest document. Trust (real digests)
 * is enforced later by `selectArtifact`: a record may carry a placeholder
 * digest so release engineering can see what is not yet pinned, and any
 * attempt to select it fails closed.
 */
export function parseArtifactManifest(raw: unknown): readonly VerifiedArtifact[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("artifact manifest must be an object");
  }
  const document = raw as Record<string, unknown>;
  if (document["schemaVersion"] !== 1) {
    throw new Error("artifact manifest schemaVersion must be 1");
  }
  if (!Array.isArray(document["artifacts"])) {
    throw new Error("artifact manifest artifacts must be an array");
  }

  const seen = new Set<string>();
  return document["artifacts"].map((entry) => parseRecord(entry, seen));
}

function parseRecord(raw: unknown, seen: Set<string>): VerifiedArtifact {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("artifact manifest record must be an object");
  }
  const record = raw as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "string" || !ARTIFACT_IDS.has(id)) {
    throw new Error(`artifact manifest record id must be one of ${[...ARTIFACT_IDS].join(", ")}`);
  }

  const version = requireNonEmptyString(record["version"], "version");
  const url = requireNonEmptyString(record["url"], "url");
  const sha256 = requireNonEmptyString(record["sha256"], "sha256");
  const license = requireNonEmptyString(record["license"], "license");
  const sourceUrl = requireNonEmptyString(record["sourceUrl"], "sourceUrl");
  const executable = requireNonEmptyString(record["executable"], "executable");

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`artifact url must be a valid URL: ${JSON.stringify(url)}`);
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`artifact url must be https: ${JSON.stringify(url)}`);
  }

  const os = record["os"];
  if (typeof os !== "string" || !NODE_PLATFORMS.has(os)) {
    throw new Error(`artifact manifest record os must be a Node.js platform, got ${JSON.stringify(os)}`);
  }
  const arch = requireNonEmptyString(record["arch"], "arch");

  const buildFlags = record["buildFlags"];
  if (!Array.isArray(buildFlags)) {
    throw new Error("artifact manifest record buildFlags must be an array of strings");
  }
  for (const flag of buildFlags) {
    if (typeof flag !== "string" || flag.trim() === "") {
      throw new Error("artifact manifest record buildFlags must contain non-empty strings");
    }
  }

  try {
    assertSafeMemberName(executable, "executable");
  } catch (error) {
    throw new Error(`artifact manifest record executable is invalid: ${(error as Error).message}`);
  }

  const key = `${id}/${os}/${arch}`;
  if (seen.has(key)) {
    throw new Error(`duplicate artifact manifest record for ${key}`);
  }
  seen.add(key);

  return {
    id: id as Artifact["id"],
    version,
    url,
    sha256,
    os: os as NodeJS.Platform,
    arch,
    license,
    sourceUrl,
    buildFlags: Object.freeze([...buildFlags]),
    executable
  };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`artifact manifest record ${field} must be a non-empty string`);
  }
  return value;
}
