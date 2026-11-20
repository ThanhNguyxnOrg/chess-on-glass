import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  NativeSecretStoreError,
  NodePlatformServices,
  type NativeSecretStore
} from "@chessonglass/platform";

function fakeStore(overrides: Partial<NativeSecretStore> = {}): NativeSecretStore & { writes: Array<[string, string]> } {
  const writes: Array<[string, string]> = [];
  return {
    writes,
    read: vi.fn(async () => null),
    write: vi.fn(async (account: string, secret: string) => {
      writes.push([account, secret]);
    }),
    remove: vi.fn(async () => undefined),
    ...overrides
  } as NativeSecretStore & { writes: Array<[string, string]> };
}

describe("NodePlatformServices", () => {
  it("resolves the per-OS user data directory through the shared path logic", () => {
    const services = new NodePlatformServices({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
      home: "C:\\Users\\dev"
    });
    expect(services.userDataDir()).toBe("C:\\Users\\dev\\AppData\\Roaming\\ChessOnGlass");

    const override = new NodePlatformServices({
      platform: "linux",
      env: { CHESSONGLASS_DATA_DIR: "/data/cog" },
      home: "/home/dev"
    });
    expect(override.userDataDir()).toBe("/data/cog");

    const posix = new NodePlatformServices({
      platform: "darwin",
      env: {},
      home: "/Users/dev"
    });
    // join() keeps the expectation honest on any host path separator.
    expect(posix.userDataDir()).toBe(
      join("/Users/dev", "Library", "Application Support", "ChessOnGlass")
    );
  });

  it("delegates secrets to the native store and returns its results unchanged", async () => {
    const store = fakeStore({ read: vi.fn(async () => "keyring-value") });
    const services = new NodePlatformServices({ platform: "win32", secretStore: store });
    await expect(services.readSecret("chessonglass.openai")).resolves.toBe("keyring-value");
    await services.writeSecret("chessonglass.openai", "sk-test");
    expect(store.writes).toEqual([["chessonglass.openai", "sk-test"]]);
  });

  it("does not copy environment overrides into OS storage", async () => {
    // The environment override belongs to SecretService (app); the platform
    // implementation must write exactly what it is given, verbatim.
    const store = fakeStore();
    const services = new NodePlatformServices({
      platform: "win32",
      env: { CHESSONGLASS_OPENAI_API_KEY: "sk-env-override" },
      secretStore: store
    });
    await services.writeSecret("chessonglass.openai", "sk-explicit");
    expect(store.writes).toEqual([["chessonglass.openai", "sk-explicit"]]);
  });

  it("fails closed with a typed error when secrets are used on an unsupported OS", async () => {
    const services = new NodePlatformServices({ platform: "sunos" });
    const error = await services.readSecret("chessonglass.openai").then(
      () => null,
      (thrown) => thrown
    );
    expect(error).toBeInstanceOf(NativeSecretStoreError);
    expect((error as NativeSecretStoreError).code).toBe("unsupported-os");
    await expect(services.writeSecret("a", "b")).rejects.toBeInstanceOf(NativeSecretStoreError);
  });

  it("refuses to open non-web URL schemes", async () => {
    const openExternalImpl = vi.fn(async () => undefined);
    const services = new NodePlatformServices({
      platform: "win32",
      openExternalImpl
    });
    for (const url of ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "not a url"]) {
      await expect(services.openExternal(url)).rejects.toThrow(/http and https|invalid url/i);
    }
    expect(openExternalImpl).not.toHaveBeenCalled();
  });

  it("opens https URLs through the injected implementation", async () => {
    const openExternalImpl = vi.fn(async () => undefined);
    const services = new NodePlatformServices({ platform: "win32", openExternalImpl });
    await services.openExternal("https://chessonglass.example/docs");
    expect(openExternalImpl).toHaveBeenCalledWith("https://chessonglass.example/docs");
  });
});
