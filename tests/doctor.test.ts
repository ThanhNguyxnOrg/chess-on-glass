import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import * as config from "../src/config.js";
import * as doctor from "../src/doctor.js";
import * as macos from "../src/macos.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("keys", () => {
  test("no Anthropic key anywhere is reported, not a crash", async () => {
    vi.stubEnv("CHESSHACKER_MODEL", "claude-opus-5-5");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.spyOn(config, "anthropicKey").mockReturnValue(null);
    const noCredentials = async () => {
      throw new Error('Could not resolve authentication method. Expected one of apiKey, authToken, ...');
    };
    vi.spyOn(config, "anthropicClient").mockReturnValue({ models: { retrieve: noCredentials, list: noCredentials } } as any);

    const check = await doctor.checkAnthropic();
    expect([check.ok, check.detail, check.optional]).toEqual([false, "none found", false]);
    expect(check.fix).toContain("chesshacker setup");
  });

  test("the key for the other provider is optional", async () => {
    vi.stubEnv("CHESSHACKER_MODEL", "gpt-6.1-sol");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.spyOn(config, "openaiKey").mockReturnValue(null);
    expect((await doctor.checkOpenai()).optional).toBe(false);
  });

  test("checking the key for a --model the config doesn't name makes it required", async () => {
    vi.stubEnv("CHESSHACKER_MODEL", "gpt-6.1-sol");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.spyOn(config, "anthropicKey").mockReturnValue(null);
    const rejected = async () => {
      throw new Error("Could not resolve authentication method.");
    };
    vi.spyOn(config, "anthropicClient").mockReturnValue({ models: { retrieve: rejected, list: rejected } } as any);
    const check = await doctor.checkVisionKey("claude-opus-5-5");
    expect([check.name.startsWith("Anthropic"), check.ok, check.optional]).toEqual([true, false, false]);
  });
});

describe("WhatsApp", () => {
  function fakeApp(electron: boolean, version: string): string {
    const app = join(mkdtempSync(join(tmpdir(), "chesshacker-test-")), "WhatsApp.app");
    mkdirSync(join(app, "Contents", "Frameworks", electron ? "Electron Framework.framework" : "Other.framework"), { recursive: true });
    writeFileSync(
      join(app, "Contents", "Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>desktop.WhatsApp</string>` +
        `<key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
    );
    return app;
  }

  test("the old Electron app is rejected", async () => {
    const app = await macos.whatsapp([fakeApp(true, "2.2338.12")]);
    expect(app?.electron).toBe(true);
    vi.spyOn(macos, "whatsapp").mockResolvedValue(app);
    const check = await doctor.checkWhatsapp();
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("discontinued");
    expect(check.fix).toContain("App Store");
  });

  test("a version not yet through test-call is flagged, not failed", async () => {
    const app = await macos.whatsapp([fakeApp(false, "26.20.1")]);
    expect([app?.electron, app?.version]).toEqual([false, "26.20.1"]);
    vi.spyOn(macos, "whatsapp").mockResolvedValue(app);
    vi.spyOn(config, "tested").mockReturnValue({});
    const check = await doctor.checkWhatsapp();
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("test-call");
    vi.spyOn(config, "tested").mockReturnValue({ whatsapp: "26.20.1" });
    expect((await doctor.checkWhatsapp()).detail).toBe("26.20.1, passed test-call");
  });
});

test("BlackHole is found among the audio outputs", async () => {
  vi.spyOn(macos, "audioOutputs").mockResolvedValue(["MacBook Pro Speakers"]);
  expect((await doctor.checkBlackhole()).ok).toBe(false);
  vi.spyOn(macos, "audioOutputs").mockResolvedValue(["MacBook Pro Speakers", "BlackHole 2ch"]);
  expect((await doctor.checkBlackhole()).ok).toBe(true);
});

test("failed optional checks don't fail the run, and a crashing check is reported", async () => {
  const lines: string[] = [];
  const required = async (): Promise<doctor.Check> => ({ ok: true, name: "required", detail: "fine" });
  const optional = async (): Promise<doctor.Check> => ({ ok: false, name: "optional", detail: "missing", fix: "add it", optional: true });
  expect(await doctor.run([required, optional], (line) => lines.push(line))).toBe(0);
  expect(lines.join("\n")).toContain("– optional: missing");
  const broken = async (): Promise<doctor.Check> => {
    throw new Error("boom");
  };
  expect(await doctor.run([broken], (line) => lines.push(line))).toBe(1);
  expect(lines.join("\n")).toContain("check crashed");
});
