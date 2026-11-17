import { describe, expect, it } from "vitest";
import type { PlatformServices } from "@chessonglass/platform";
import { SecretService } from "../../src/secrets/secret-service.js";

class FakePlatform implements PlatformServices {
  readonly platform = "win32" as const;
  readonly store = new Map<string, string>();
  writeCalls = 0;

  userDataDir(): string {
    return "C:\\fake\\userdata";
  }

  async readSecret(account: string): Promise<string | null> {
    return this.store.get(account) ?? null;
  }

  async writeSecret(account: string, secret: string): Promise<void> {
    this.writeCalls += 1;
    if (secret === "FAIL") {
      throw new Error("keyring write failed");
    }
    this.store.set(account, secret);
  }

  async openExternal(): Promise<void> {
    return undefined;
  }
}

describe("SecretService", () => {
  it("reports not-configured when neither keyring nor environment has a secret", async () => {
    const platform = new FakePlatform();
    const service = new SecretService(platform, {});
    const status = await service.status("openai");
    expect(status).toEqual({ configured: false, source: null });
  });

  it("reports keyring as the source after a write with exact readback", async () => {
    const platform = new FakePlatform();
    const service = new SecretService(platform, {});
    await service.write("openai", "sk-test-dummy");
    expect(platform.writeCalls).toBe(1);
    const status = await service.status("openai");
    expect(status).toEqual({ configured: true, source: "keyring" });
  });

  it("prefers the keyring over an environment override", async () => {
    const platform = new FakePlatform();
    platform.store.set("chessonglass.openai", "from-keyring");
    const service = new SecretService(platform, {
      openai: "from-env"
    });
    const status = await service.status("openai");
    expect(status).toEqual({ configured: true, source: "keyring" });
  });

  it("reports environment as the source when the keyring is empty", async () => {
    const platform = new FakePlatform();
    const service = new SecretService(platform, {
      anthropic: "from-env"
    });
    const status = await service.status("anthropic");
    expect(status).toEqual({ configured: true, source: "environment" });
  });

  it("never creates plaintext when the keyring write fails", async () => {
    const platform = new FakePlatform();
    const service = new SecretService(platform, {});
    await expect(service.write("openai", "FAIL")).rejects.toThrow(
      /keyring/i
    );
    expect(platform.store.size).toBe(0);
    const status = await service.status("openai");
    expect(status.configured).toBe(false);
  });
});
