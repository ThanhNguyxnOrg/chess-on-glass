import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { userDataDir } from "../paths.js";
import { ProcessFailure, runProcess } from "../process.js";
import {
  createNativeSecretStore,
  type NativeSecretStore
} from "../secrets/native-keyring.js";
import type { PlatformServices } from "../services.js";

export type NodePlatformServicesOptions = Readonly<{
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Test seam: replaces the OS credential store entirely. */
  secretStore?: NativeSecretStore;
  /** Test seam: replaces the per-OS open command. */
  openExternalImpl?: (url: string) => Promise<void>;
}>;

const OPEN_TIMEOUT_MS = 10_000;
const OPEN_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Concrete `PlatformServices` for the supported desktop platforms. Secrets
 * always go through the native credential store (created lazily, so
 * construction never throws on an exotic OS — the first secret operation
 * does, with a typed error). Environment overrides are never read here:
 * they belong to the application's SecretService and are never copied into
 * OS storage.
 */
export class NodePlatformServices implements PlatformServices {
  readonly platform: NodeJS.Platform;

  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly secretStoreOverride: NativeSecretStore | undefined;
  private readonly openExternalOverride: ((url: string) => Promise<void>) | undefined;
  private secretStore: NativeSecretStore | undefined;

  constructor(options: NodePlatformServicesOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.home = options.home ?? homedir();
    this.secretStoreOverride = options.secretStore;
    this.openExternalOverride = options.openExternalImpl;
  }

  userDataDir(): string {
    return userDataDir(this.env, this.platform, this.home);
  }

  async readSecret(account: string): Promise<string | null> {
    return this.store().read(account);
  }

  async writeSecret(account: string, secret: string): Promise<void> {
    await this.store().write(account, secret);
  }

  async openExternal(url: string): Promise<void> {
    const validated = validateExternalUrl(url);
    if (this.openExternalOverride !== undefined) {
      await this.openExternalOverride(validated);
      return;
    }
    await this.openExternalNative(validated);
  }

  private store(): NativeSecretStore {
    this.secretStore ??= this.secretStoreOverride ?? createNativeSecretStore(this.platform);
    return this.secretStore;
  }

  /**
   * Per-OS opener. Only http/https URLs reach a process, and every child is
   * spawned without a shell with a deadline and an output ceiling.
   */
  private async openExternalNative(url: string): Promise<void> {
    if (this.platform === "win32") {
      const systemRoot = this.env["SystemRoot"] ?? this.env["SYSTEMROOT"] ?? this.env["windir"];
      if (systemRoot === undefined || systemRoot.trim() === "") {
        throw new Error("SystemRoot is required to resolve rundll32 on Windows");
      }
      const rundll32 = join(systemRoot, "System32", "rundll32.exe");
      if (!existsSync(rundll32)) {
        throw new Error(`rundll32.exe was not found at ${rundll32}`);
      }
      await this.spawnBounded(rundll32, ["url.dll,FileProtocolHandler", url]);
      return;
    }
    if (this.platform === "darwin") {
      await this.spawnBounded("open", [url]);
      return;
    }
    if (this.platform === "linux") {
      await this.spawnBounded("xdg-open", [url]);
      return;
    }
    throw new Error(`opening external URLs is not implemented on ${this.platform}`);
  }

  private async spawnBounded(file: string, args: readonly string[]): Promise<void> {
    try {
      await runProcess(file, args, {
        signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
        timeoutMs: OPEN_TIMEOUT_MS,
        maxOutputBytes: OPEN_MAX_OUTPUT_BYTES
      });
    } catch (error) {
      if (error instanceof ProcessFailure) {
        throw new Error(`failed to open external URL: ${error.message}`);
      }
      throw error;
    }
  }
}

/**
 * Only web URLs may be handed to the OS opener. Schemes like `file:` or
 * `javascript:` would turn a remote link into local execution, so they fail
 * closed here instead of reaching rundll32/open/xdg-open.
 */
function validateExternalUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid url (must be absolute http or https): ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("only http and https URLs can be opened externally");
  }
  return parsed.toString();
}
