import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { selectArtifact, verifyFileDigest, type Artifact } from "@chessonglass/platform";

const SHA = "a".repeat(64);
const records: Artifact[] = [
  {
    id: "stockfish",
    version: "17.1",
    url: "https://example.invalid/stockfish-win-x64.zip",
    sha256: SHA,
    os: "win32",
    arch: "x64",
    license: "GPL-3.0-or-later",
    sourceUrl: "https://github.com/official-stockfish/Stockfish"
  },
  {
    id: "stockfish",
    version: "17.1",
    url: "https://example.invalid/stockfish-linux-x64.tar",
    sha256: SHA,
    os: "linux",
    arch: "x64",
    license: "GPL-3.0-or-later",
    sourceUrl: "https://github.com/official-stockfish/Stockfish"
  },
  {
    id: "ffmpeg",
    version: "7.1",
    url: "https://example.invalid/ffmpeg-win-x64.zip",
    sha256: SHA,
    os: "win32",
    arch: "x64",
    license: "GPL-3.0-or-later",
    sourceUrl: "https://ffmpeg.org"
  }
];

const temporaryDirectories: string[] = [];

async function temporaryFile(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chessonglass-artifact-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "artifact.bin");
  await writeFile(file, content);
  return file;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("selectArtifact", () => {
  it("returns the exact OS and architecture match", () => {
    expect(selectArtifact(records, "stockfish", "win32", "x64").url).toContain("win-x64");
    expect(selectArtifact(records, "stockfish", "linux", "x64").url).toContain("linux-x64");
  });

  it("fails closed for an unknown id, OS or architecture", () => {
    expect(() => selectArtifact(records, "ffmpeg", "darwin", "arm64")).toThrow(/no verified artifact/i);
    expect(() => selectArtifact(records, "stockfish", "win32", "arm64")).toThrow(/no verified artifact/i);
  });

  it("fails closed when source or digest evidence is absent", () => {
    const missingSource: Artifact = { ...records[0]!, sourceUrl: "unverified" };
    const missingDigest: Artifact = { ...records[0]!, sha256: "unverified" };
    const badDigest: Artifact = { ...records[0]!, sha256: "not-a-digest" };

    expect(() => selectArtifact([missingSource], "stockfish", "win32", "x64")).toThrow(/sourceUrl/i);
    expect(() => selectArtifact([missingDigest], "stockfish", "win32", "x64")).toThrow(/sha256/i);
    expect(() => selectArtifact([badDigest], "stockfish", "win32", "x64")).toThrow(/sha256/i);
  });

  it("rejects ambiguous matches instead of guessing", () => {
    const duplicate: Artifact = { ...records[0]!, version: "17.2" };
    expect(() => selectArtifact([records[0]!, duplicate], "stockfish", "win32", "x64")).toThrow(
      /ambiguous/i
    );
  });
});

describe("verifyFileDigest", () => {
  it("accepts a file whose SHA-256 matches", async () => {
    const file = await temporaryFile("abc");
    const expected = createHash("sha256").update("abc").digest("hex");
    await expect(verifyFileDigest(file, expected)).resolves.toBeUndefined();
    await expect(verifyFileDigest(file, expected.toUpperCase())).resolves.toBeUndefined();
  });

  it("rejects a mismatched digest without executing the file", async () => {
    const file = await temporaryFile("abc");
    await expect(verifyFileDigest(file, "b".repeat(64))).rejects.toThrow(/digest/i);
  });

  it("rejects a malformed expected digest", async () => {
    const file = await temporaryFile("abc");
    await expect(verifyFileDigest(file, "unverified")).rejects.toThrow(/sha256/i);
  });
});
