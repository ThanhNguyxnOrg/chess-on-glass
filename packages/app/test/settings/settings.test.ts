import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings
} from "../../src/settings/settings.js";

describe("AppSettings", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cog-settings-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns safe defaults when no settings file exists", async () => {
    const settings = await loadSettings(join(dir, "settings.json"));
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips a modified settings file atomically", async () => {
    const path = join(dir, "settings.json");
    const modified = {
      ...DEFAULT_SETTINGS,
      provider: "openai" as const,
      visionModel: "gpt-6.1-sol",
      cloudEnabled: true,
      browserFps: 3
    };
    await saveSettings(path, modified);
    const loaded = await loadSettings(path);
    expect(loaded).toEqual(modified);
  });

  it("rejects malformed settings without overwriting the file", async () => {
    const path = join(dir, "settings.json");
    await writeFile(path, '{"provider":"openai","cloudEnabled":"yes"}', "utf8");
    await expect(loadSettings(path)).rejects.toThrow(/settings/i);
    const raw = await readFile(path, "utf8");
    expect(raw).toContain('"yes"');
  });

  it("rejects unknown fields in settings", async () => {
    const path = join(dir, "settings.json");
    await writeFile(path, '{"cloudEnabled":false,"apiKey":"sk-test"}', "utf8");
    await expect(loadSettings(path)).rejects.toThrow(/unknown|settings/i);
  });

  it("rejects invalid fps and cost values", async () => {
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify({ ...DEFAULT_SETTINGS, browserFps: 0 }),
      "utf8"
    );
    await expect(loadSettings(path)).rejects.toThrow(/fps|browser/i);
  });
});
