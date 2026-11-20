import { describe, expect, it, vi } from "vitest";
import {
  createNativeSecretStore,
  NativeSecretStoreError,
  type KeyringEntry,
  type KeyringEntryFactory
} from "@chessonglass/platform";

function fakeEntry(overrides: Partial<KeyringEntry> = {}): KeyringEntry {
  return {
    getPassword: vi.fn(async () => null),
    setPassword: vi.fn(async () => undefined),
    deleteCredential: vi.fn(async () => true),
    ...overrides
  };
}

function capturingFactory(entry: KeyringEntry): {
  factory: KeyringEntryFactory;
  calls: Array<{ service: string; account: string; selection: unknown }>;
} {
  const calls: Array<{ service: string; account: string; selection: unknown }> = [];
  const factory: KeyringEntryFactory = async (service, account, selection) => {
    calls.push({ service, account, selection });
    return entry;
  };
  return { factory, calls };
}

describe("createNativeSecretStore", () => {
  it("fails closed on unsupported operating systems with an actionable message", () => {
    for (const platform of ["sunos", "freebsd", "openbsd", "aix", "android"] as const) {
      const { factory } = capturingFactory(fakeEntry());
      let error: unknown;
      try {
        createNativeSecretStore(platform, { entryFactory: factory });
      } catch (thrown) {
        error = thrown;
      }
      expect(error, `${platform} must not produce a secret store`).toBeInstanceOf(NativeSecretStoreError);
      const failure = error as NativeSecretStoreError;
      expect(failure.code).toBe("unsupported-os");
      expect(failure.message).toContain(platform);
      expect(failure.message).toMatch(/not implemented|unsupported/i);
    }
  });

  it("selects the native store honestly per operating system", () => {
    const win32 = createNativeSecretStore("win32", { entryFactory: capturingFactory(fakeEntry()).factory });
    const darwin = createNativeSecretStore("darwin", { entryFactory: capturingFactory(fakeEntry()).factory });
    const linux = createNativeSecretStore("linux", { entryFactory: capturingFactory(fakeEntry()).factory });
    expect(win32.backend).toBe("windows-credential-manager");
    expect(darwin.backend).toBe("macos-keychain");
    expect(linux.backend).toBe("linux-secret-service");
  });

  it("pins Linux to the persistent Secret Service and never to RAM-only keyutils", async () => {
    const { factory, calls } = capturingFactory(fakeEntry());
    const store = createNativeSecretStore("linux", { entryFactory: factory });
    await store.read("chessonglass.openai");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.selection).toEqual({ linux: { store: "secret-service" } });
  });

  it("passes the pinned selection on every platform so Linux behaviour is uniform", async () => {
    const { factory, calls } = capturingFactory(fakeEntry());
    const store = createNativeSecretStore("darwin", { entryFactory: factory });
    await store.read("chessonglass.openai");
    expect(calls[0]!.selection).toEqual({ linux: { store: "secret-service" } });
  });

  it("uses the ChessOnGlass service name by default", async () => {
    const { factory, calls } = capturingFactory(fakeEntry());
    const store = createNativeSecretStore("win32", { entryFactory: factory });
    await store.read("chessonglass.anthropic");
    expect(calls[0]!.service).toBe("ChessOnGlass");
    expect(calls[0]!.account).toBe("chessonglass.anthropic");
  });

  it("honours an explicit service name", async () => {
    const { factory, calls } = capturingFactory(fakeEntry());
    const store = createNativeSecretStore("win32", { entryFactory: factory, service: "ChessOnGlass-Test" });
    await store.read("chessonglass.openai");
    expect(calls[0]!.service).toBe("ChessOnGlass-Test");
  });
});

describe("KeyringSecretStore", () => {
  it("returns the stored secret on read", async () => {
    const entry = fakeEntry({ getPassword: vi.fn(async () => "from-keyring") });
    const store = createNativeSecretStore("win32", { entryFactory: capturingFactory(entry).factory });
    await expect(store.read("chessonglass.openai")).resolves.toBe("from-keyring");
  });

  it("resolves null when the credential is absent", async () => {
    const store = createNativeSecretStore("win32", {
      entryFactory: capturingFactory(fakeEntry()).factory
    });
    await expect(store.read("chessonglass.missing")).resolves.toBeNull();
  });

  it("rejects with a typed error when the store cannot be read, with no plaintext fallback", async () => {
    const entry = fakeEntry({
      getPassword: vi.fn(async () => {
        throw new Error("credential store is locked");
      })
    });
    const store = createNativeSecretStore("win32", { entryFactory: capturingFactory(entry).factory });
    const error = await store.read("chessonglass.openai").then(
      () => null,
      (thrown) => thrown
    );
    expect(error).toBeInstanceOf(NativeSecretStoreError);
    expect((error as NativeSecretStoreError).code).toBe("store-unavailable");
  });

  it("delegates writes to the native entry", async () => {
    const entry = fakeEntry();
    const store = createNativeSecretStore("win32", { entryFactory: capturingFactory(entry).factory });
    await store.write("chessonglass.openai", "sk-test");
    expect(entry.setPassword).toHaveBeenCalledWith("sk-test");
  });

  it("surfaces write failures as typed errors and never echoes the secret", async () => {
    const entry = fakeEntry({
      setPassword: vi.fn(async () => {
        throw new Error("credential store is locked");
      })
    });
    const store = createNativeSecretStore("win32", { entryFactory: capturingFactory(entry).factory });
    const error = await store.write("chessonglass.openai", "s3cr3t-value").then(
      () => null,
      (thrown) => thrown
    );
    expect(error).toBeInstanceOf(NativeSecretStoreError);
    expect((error as NativeSecretStoreError).code).toBe("store-unavailable");
    expect((error as Error).message).not.toContain("s3cr3t-value");
  });

  it("treats removing an absent credential as an idempotent success", async () => {
    const entry = fakeEntry({ deleteCredential: vi.fn(async () => false) });
    const store = createNativeSecretStore("win32", { entryFactory: capturingFactory(entry).factory });
    await expect(store.remove("chessonglass.gone")).resolves.toBeUndefined();
  });

  it("surfaces failed deletions as typed errors", async () => {
    const entry = fakeEntry({
      deleteCredential: vi.fn(async () => {
        throw new Error("credential store is locked");
      })
    });
    const store = createNativeSecretStore("win32", { entryFactory: capturingFactory(entry).factory });
    await expect(store.remove("chessonglass.openai")).rejects.toMatchObject({
      code: "store-unavailable"
    });
  });

  it("rejects malformed accounts before touching the store", async () => {
    const { factory, calls } = capturingFactory(fakeEntry());
    const store = createNativeSecretStore("win32", { entryFactory: factory });
    for (const account of ["", "   ", "a\nb", "a\0b", "x".repeat(513)]) {
      await expect(store.read(account)).rejects.toMatchObject({ code: "invalid-account" });
      await expect(store.write(account, "s")).rejects.toMatchObject({ code: "invalid-account" });
      await expect(store.remove(account)).rejects.toMatchObject({ code: "invalid-account" });
    }
    expect(calls).toHaveLength(0);
  });
});
