import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export type Artifact = Readonly<{
  id: "stockfish" | "ffmpeg";
  version: string;
  url: string;
  sha256: string;
  os: NodeJS.Platform;
  arch: string;
  license: string;
  sourceUrl: string;
}>;

const SHA256_HEX = /^[0-9a-f]{64}$/i;
const UNVERIFIED = "unverified";

function verified(value: string): boolean {
  return value.trim() !== "" && value !== UNVERIFIED;
}

/**
 * Select exactly one immutable artifact for the requested OS/architecture.
 * Missing evidence, a placeholder or an ambiguous match fails closed; there is
 * no fallback to a generic archive or a global executable.
 */
export function selectArtifact(
  records: readonly Artifact[],
  id: Artifact["id"],
  os: NodeJS.Platform,
  arch: string
): Artifact {
  const matches = records.filter(
    (record) => record.id === id && record.os === os && record.arch === arch
  );

  if (matches.length === 0) {
    throw new Error(`no verified artifact for ${id} on ${os}/${arch}`);
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous artifact selection for ${id} on ${os}/${arch}`);
  }

  const artifact = matches[0]!;
  if (!verified(artifact.sourceUrl)) {
    throw new Error(`artifact sourceUrl is unverified for ${id} on ${os}/${arch}`);
  }
  if (!SHA256_HEX.test(artifact.sha256)) {
    throw new Error(`artifact sha256 is not a verified digest for ${id} on ${os}/${arch}`);
  }
  if (!verified(artifact.version) || !verified(artifact.url) || !verified(artifact.license)) {
    throw new Error(`artifact metadata is unverified for ${id} on ${os}/${arch}`);
  }
  return artifact;
}

/**
 * Stream a file through SHA-256. The file is read, never executed. A malformed
 * expected digest is rejected before any filesystem work.
 */
export async function verifyFileDigest(path: string, expectedSha256: string): Promise<void> {
  if (!SHA256_HEX.test(expectedSha256)) {
    throw new Error("expected sha256 must be a 64-character hexadecimal digest");
  }

  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });

  const actual = hash.digest("hex");
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`digest mismatch: expected ${expectedSha256.toLowerCase()}, got ${actual}`);
  }
}
