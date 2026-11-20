/**
 * Native OS credential storage.
 *
 * The store is selected per operating system and only on its native OS:
 * Windows Credential Manager on win32, macOS Keychain on darwin and the
 * Secret Service on Linux. Every other platform fails closed with a typed
 * error — there is deliberately no plaintext, file-based or in-memory
 * fallback. On Linux the entry is pinned to the Secret Service: the kernel
 * keyutils keyring is RAM-only (it does not survive a reboot) and must never
 * be selected silently, so an unavailable Secret Service is an error instead.
 */

export type NativeSecretStoreCode =
  | "unsupported-os"
  | "invalid-account"
  | "store-unavailable";

/** A secret-storage failure callers can classify without parsing text. */
export class NativeSecretStoreError extends Error {
  readonly code: NativeSecretStoreCode;

  constructor(code: NativeSecretStoreCode, message: string) {
    super(message);
    this.name = "NativeSecretStoreError";
    this.code = code;
  }
}

/** The OS-backed store a {@link NativeSecretStore} instance is bound to. */
export type NativeSecretStoreBackend =
  | "windows-credential-manager"
  | "macos-keychain"
  | "linux-secret-service";

/**
 * OS-facing secret storage. Read failures (locked store, IPC failure) reject;
 * a missing credential reads as `null`. Implementations never consult
 * environment variables: overrides are owned by the application layer.
 */
export interface NativeSecretStore {
  /** The backend this store writes to; used for honest diagnostics. */
  readonly backend: NativeSecretStoreBackend;
  read(account: string): Promise<string | null>;
  write(account: string, secret: string): Promise<void>;
  /** Removing an absent credential succeeds; a failed deletion rejects. */
  remove(account: string): Promise<void>;
}

/**
 * The subset of the native binding's entry used here, plus the selection
 * bag handed to the factory. Pinned in a type of our own so the Linux
 * honest-selection rule is visible in this package's public surface.
 */
export interface KeyringEntry {
  getPassword(signal?: AbortSignal): Promise<string | null>;
  setPassword(secret: string, signal?: AbortSignal): Promise<void>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}

/**
 * The credential-store selection forwarded to the native binding. The Linux
 * store is always pinned to the persistent Secret Service; requiring an
 * unavailable store throws at entry construction instead of falling back.
 */
export type KeyringSelection = Readonly<{ linux: { store: "secret-service" } }>;

export type KeyringEntryFactory = (
  service: string,
  account: string,
  selection: KeyringSelection
) => Promise<KeyringEntry>;

export type NativeSecretStoreOptions = Readonly<{
  /** Credential service name; also the visible prefix inside the OS store. */
  service?: string;
  /** Test seam: build entries instead of loading the native binding. */
  entryFactory?: KeyringEntryFactory;
}>;

const DEFAULT_SERVICE = "ChessOnGlass";
/** Windows Credential Manager target names are capped well below this. */
const MAX_ACCOUNT_LENGTH = 512;
const PINNED_SELECTION: KeyringSelection = { linux: { store: "secret-service" } };

/**
 * Create the native secret store for the given platform. Unsupported
 * platforms throw {@link NativeSecretStoreError} with code
 * `unsupported-os` naming the supported stores, so callers can surface an
 * actionable message instead of silently degrading.
 */
export function createNativeSecretStore(
  platform: NodeJS.Platform,
  options: NativeSecretStoreOptions = {}
): NativeSecretStore {
  const backend = selectBackend(platform);
  const service = options.service ?? DEFAULT_SERVICE;
  assertValidService(service);
  return new KeyringSecretStore(
    backend,
    service,
    options.entryFactory ?? defaultEntryFactory
  );
}

function selectBackend(platform: NodeJS.Platform): NativeSecretStoreBackend {
  if (platform === "win32") {
    return "windows-credential-manager";
  }
  if (platform === "darwin") {
    return "macos-keychain";
  }
  if (platform === "linux") {
    return "linux-secret-service";
  }
  throw new NativeSecretStoreError(
    "unsupported-os",
    `native secret storage is not implemented on ${platform}; supported: ` +
      "Windows Credential Manager (win32), macOS Keychain (darwin), " +
      "Linux Secret Service (linux). There is no plaintext fallback."
  );
}

function assertValidService(service: string): void {
  if (service.trim() === "" || service.length > MAX_ACCOUNT_LENGTH || /[\0\r\n]/.test(service)) {
    throw new NativeSecretStoreError("invalid-account", "secret service name is invalid");
  }
}

/**
 * Default entry factory. The binding is imported lazily so that platforms
 * without a prebuilt binary fail only when secrets are actually used, and
 * so unit tests can inject a factory instead. The optional platform
 * package (`@napi-rs/keyring-*`) is resolved by npm per-OS/arch.
 */
const defaultEntryFactory: KeyringEntryFactory = async (service, account, selection) => {
  const binding = (await import("@napi-rs/keyring")) as {
    AsyncEntry: new (
      service: string,
      username: string,
      options?: unknown
    ) => KeyringEntry;
  };
  // `selection` pins the Linux Secret Service; the binding throws when that
  // store is unavailable rather than degrading to RAM-only keyutils.
  return new binding.AsyncEntry(service, account, selection);
};

/**
 * Credential-manager backed store shared by the three supported desktop
 * platforms. All native failures are wrapped in typed errors; account
 * validation happens before the store is touched.
 */
export class KeyringSecretStore implements NativeSecretStore {
  readonly backend: NativeSecretStoreBackend;

  private readonly service: string;
  private readonly entryFactory: KeyringEntryFactory;

  constructor(
    backend: NativeSecretStoreBackend,
    service: string,
    entryFactory: KeyringEntryFactory
  ) {
    this.backend = backend;
    this.service = service;
    this.entryFactory = entryFactory;
  }

  async read(account: string): Promise<string | null> {
    this.assertAccount(account);
    const entry = await this.entry(account);
    try {
      return await entry.getPassword();
    } catch (error) {
      throw unavailable(error);
    }
  }

  async write(account: string, secret: string): Promise<void> {
    this.assertAccount(account);
    const entry = await this.entry(account);
    try {
      await entry.setPassword(secret);
    } catch (error) {
      throw unavailable(error);
    }
  }

  async remove(account: string): Promise<void> {
    this.assertAccount(account);
    const entry = await this.entry(account);
    try {
      // `false` means the credential was already absent: cleanup stays
      // idempotent, while a locked store still rejects.
      await entry.deleteCredential();
    } catch (error) {
      throw unavailable(error);
    }
  }

  private async entry(account: string): Promise<KeyringEntry> {
    try {
      return await this.entryFactory(this.service, account, PINNED_SELECTION);
    } catch (error) {
      // Entry construction fails on Linux when the pinned Secret Service is
      // unavailable; on other platforms this path is not expected to fail.
      throw unavailable(error);
    }
  }

  private assertAccount(account: string): void {
    if (
      account.trim() === "" ||
      account.length > MAX_ACCOUNT_LENGTH ||
      /[\0\r\n]/.test(account)
    ) {
      throw new NativeSecretStoreError(
        "invalid-account",
        "secret account name must be non-empty, printable and at most 512 characters"
      );
    }
  }
}

function unavailable(error: unknown): NativeSecretStoreError {
  if (error instanceof NativeSecretStoreError) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new NativeSecretStoreError(
    "store-unavailable",
    `native credential store operation failed: ${detail}`
  );
}
