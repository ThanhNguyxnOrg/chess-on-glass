import { describe, expect, it } from "vitest";
import { parseArtifactManifest, selectArtifact } from "@chessonglass/platform";

const validRecord = {
  id: "stockfish",
  version: "19",
  url: "https://example.invalid/stockfish-win-x64.zip",
  sha256: "a".repeat(64),
  os: "win32",
  arch: "x64",
  license: "GPL-3.0-or-later",
  sourceUrl: "https://github.com/official-stockfish/Stockfish",
  buildFlags: ["universal"],
  executable: "stockfish/stockfish.exe"
};

function manifestWith(overrides: Partial<typeof validRecord> = {}): unknown {
  return { schemaVersion: 1, artifacts: [{ ...validRecord, ...overrides }] };
}

describe("parseArtifactManifest", () => {
  it("parses a valid manifest into verified artifact records", () => {
    const records = parseArtifactManifest(manifestWith());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "stockfish",
      version: "19",
      os: "win32",
      arch: "x64",
      buildFlags: ["universal"],
      executable: "stockfish/stockfish.exe"
    });
    expect(() => selectArtifact(records, "stockfish", "win32", "x64")).not.toThrow();
  });

  it("rejects manifests that are not objects or have an unknown schema version", () => {
    for (const raw of [null, undefined, 42, "manifest", [], { schemaVersion: 2 }, { artifacts: [] }]) {
      expect(() => parseArtifactManifest(raw)).toThrow(/schemaVersion|manifest/i);
    }
    expect(() => parseArtifactManifest({ schemaVersion: 1 })).toThrow(/artifacts/i);
    expect(() => parseArtifactManifest({ schemaVersion: 1, artifacts: "many" })).toThrow(/artifacts/i);
  });

  it("rejects records with unknown ids, platforms or empty metadata", () => {
    expect(() => parseArtifactManifest(manifestWith({ id: "notepad" as never }))).toThrow(/id/i);
    expect(() => parseArtifactManifest(manifestWith({ os: "windows" as never }))).toThrow(/os/i);
    expect(() => parseArtifactManifest(manifestWith({ os: "win64" as never }))).toThrow(/os/i);
    expect(() => parseArtifactManifest(manifestWith({ arch: "" }))).toThrow(/arch/i);
    expect(() => parseArtifactManifest(manifestWith({ version: " " }))).toThrow(/version/i);
    expect(() => parseArtifactManifest(manifestWith({ license: "" }))).toThrow(/license/i);
    expect(() => parseArtifactManifest(manifestWith({ sourceUrl: "" }))).toThrow(/sourceUrl/i);
  });

  it("rejects non-https download URLs", () => {
    expect(() => parseArtifactManifest(manifestWith({ url: "http://example.invalid/a.zip" }))).toThrow(/https/i);
    expect(() => parseArtifactManifest(manifestWith({ url: "ftp://example.invalid/a.zip" }))).toThrow(/https/i);
    expect(() => parseArtifactManifest(manifestWith({ url: "not a url" }))).toThrow(/url/i);
  });

  it("rejects malformed digests only at selection time, not parse time", () => {
    // A placeholder is structurally expressible so release engineering can see
    // what remains unpinned; selectArtifact fails closed on it.
    const records = parseArtifactManifest(manifestWith({ sha256: "unverified" }));
    expect(() => selectArtifact(records, "stockfish", "win32", "x64")).toThrow(/sha256/i);
    expect(() => parseArtifactManifest(manifestWith({ sha256: "" }))).toThrow(/sha256/i);
    expect(() => parseArtifactManifest(manifestWith({ sha256: 123 as never }))).toThrow(/sha256/i);
  });

  it("rejects build flags that are not non-empty strings", () => {
    expect(() => parseArtifactManifest(manifestWith({ buildFlags: "pgo" as never }))).toThrow(/buildFlags/i);
    expect(() => parseArtifactManifest(manifestWith({ buildFlags: [42] as never }))).toThrow(/buildFlags/i);
    expect(() => parseArtifactManifest(manifestWith({ buildFlags: ["  "] as never }))).toThrow(/buildFlags/i);
    expect(() => parseArtifactManifest(manifestWith({ buildFlags: [] }))).not.toThrow();
  });

  it("rejects unsafe executable member names", () => {
    for (const executable of [
      "",
      "/abs/stockfish.exe",
      "../stockfish.exe",
      "a/../../stockfish.exe",
      "stockfish\\stockfish.exe",
      "C:\\stockfish.exe",
      "C:/stockfish.exe",
      "C:stockfish.exe",
      "z:/stockfish.exe",
      "Z:stockfish.exe",
      "stockfish//stockfish.exe",
      "./stockfish.exe",
      "stockfish/ "
    ]) {
      expect(() => parseArtifactManifest(manifestWith({ executable })), executable).toThrow(/executable/i);
    }
  });

  it("rejects duplicate records for the same id, OS and architecture", () => {
    const manifest = {
      schemaVersion: 1,
      artifacts: [validRecord, { ...validRecord, version: "19.1" }]
    };
    expect(() => parseArtifactManifest(manifest)).toThrow(/duplicate/i);
  });

  it("rejects non-object records and unknown record fields are tolerated only if valid", () => {
    expect(() => parseArtifactManifest({ schemaVersion: 1, artifacts: ["stockfish"] })).toThrow(/record/i);
    expect(() => parseArtifactManifest({ schemaVersion: 1, artifacts: [null] })).toThrow(/record/i);
  });

  it("accepts an empty artifact list", () => {
    expect(parseArtifactManifest({ schemaVersion: 1, artifacts: [] })).toEqual([]);
  });
});
