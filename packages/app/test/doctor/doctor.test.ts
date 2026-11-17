import { describe, expect, it } from "vitest";
import { runDoctor } from "../../src/doctor/doctor.js";

describe("runDoctor", () => {
  it("reports Node/OS/arch, storage and tool availability without network calls", async () => {
    const checks = await runDoctor();
    const byId = new Map(checks.map((check) => [check.id, check]));

    expect(byId.get("runtime")?.ok).toBe(true);
    expect(byId.get("user-data")?.ok).toBe(true);
    expect(byId.get("credential-store")?.ok).toBe(true);
    expect(byId.get("ffmpeg")?.ok).toBe(false);
    expect(byId.get("stockfish")?.ok).toBe(false);
    expect(byId.get("wgc")?.ok).toBe(true);
    expect(byId.get("speech")?.ok).toBe(true);

    const cloud = byId.get("cloud");
    expect(cloud?.status).toBe("not-run");
  });

  it("does not make any provider call", async () => {
    const checks = await runDoctor();
    for (const check of checks) {
      expect(check.status).not.toBe("ok-with-network");
    }
  });
});
