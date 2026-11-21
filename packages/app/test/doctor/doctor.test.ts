import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlatformServices } from "@chessonglass/platform";
import { runDoctor } from "../../src/doctor/doctor.js";

class FakePlatform implements PlatformServices {
  readonly platform = "win32" as const;
  readonly store = new Map<string, string>();
  constructor(private readonly dir: string) {}
  userDataDir(): string { return this.dir; }
  async readSecret(account: string): Promise<string | null> { return this.store.get(account) ?? null; }
  async writeSecret(account: string, secret: string): Promise<void> { this.store.set(account, secret); }
  async openExternal(): Promise<void> { return undefined; }
}

describe("runDoctor", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    while (dirs.length > 0) {
      await rm(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it("reports Node/OS/arch, storage and tool availability without network calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cog-doctor-"));
    dirs.push(dir);
    const checks = await runDoctor({ platform: new FakePlatform(dir), env: { PATH: "" } });
    const byId = new Map(checks.map((check) => [check.id, check]));

    expect(byId.get("runtime")?.ok).toBe(true);
    expect(byId.get("user-data")?.ok).toBe(true);
    expect(byId.get("credential-store")?.ok).toBe(true);
    expect(byId.get("ffmpeg")?.ok).toBe(false);
    expect(byId.get("stockfish")?.ok).toBe(false);
    expect(typeof byId.get("wgc")?.ok).toBe("boolean");
    expect(typeof byId.get("speech")?.ok).toBe("boolean");

    const cloud = byId.get("cloud");
    expect(cloud?.status).toBe("not-run");
  });

  it("does not make any provider call", async () => {
    const checks = await runDoctor({ env: { PATH: "" } });
    for (const check of checks) {
      expect(check.status).not.toBe("ok-with-network");
    }
  });
});
