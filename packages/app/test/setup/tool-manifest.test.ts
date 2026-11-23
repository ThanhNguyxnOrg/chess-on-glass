import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseArtifactManifest, selectArtifact } from "@chessonglass/platform";
import { TOOL_MANIFEST } from "../../src/setup/tool-manifest.js";

const records = parseArtifactManifest(TOOL_MANIFEST);
const platforms = ["win32/x64", "win32/arm64", "darwin/x64", "darwin/arm64", "linux/x64"];

describe("documented tool platforms", () => {
  it("lists every manifest platform in both support tables", async () => {
    expect([...new Set(records.map(({ os, arch }) => `${os}/${arch}`))].sort())
      .toEqual([...platforms].sort());

    for (const path of ["README.md", "docs/setup-and-usage.md"]) {
      const doc = await readFile(new URL(`../../../../${path}`, import.meta.url), "utf8");
      const rows = doc.split("\n").filter((line) => /^\|.*\| `(?:win32|darwin|linux)\//.test(line));
      expect(rows).toHaveLength(platforms.length);
      for (const key of platforms) {
        const [os, arch] = key.split("/");
        const statuses = (["stockfish", "ffmpeg"] as const).map((id) => {
          const entry = records.find((record) => record.id === id && record.os === os && record.arch === arch);
          if (entry === undefined) return "No artifact";
          try {
            selectArtifact(records, id, entry.os, entry.arch);
            return "Verified download";
          } catch {
            return "Unverified; refused";
          }
        });
        expect(rows.find((row) => row.includes(`\`${key}\``)))
          .toContain(`| ${statuses.join(" | ")} |`);
      }
      expect(doc).toContain("| All other keys | No artifact | No artifact |");
    }
  });

  it("only selects the two Windows x64 pinned artifacts", () => {
    expect(records.filter((record) => /^[0-9a-f]{64}$/i.test(record.sha256))
      .map(({ id, os, arch }) => `${id}/${os}/${arch}`).sort())
      .toEqual(["ffmpeg/win32/x64", "stockfish/win32/x64"]);
    expect(() => selectArtifact(records, "stockfish", "linux", "arm64"))
      .toThrow("no verified artifact");
    expect(() => selectArtifact(records, "stockfish", "darwin", "arm64"))
      .toThrow("sha256 is not a verified digest");
  });
});
