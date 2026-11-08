/**
 * OS-facing services are injected behind this interface. Implementations for
 * Windows, macOS and Linux land in their own slice and must provide contract
 * tests; in-memory Linux stores may never be described as persistent.
 */
export interface PlatformServices {
  readonly platform: NodeJS.Platform;
  userDataDir(): string;
  readSecret(account: string): Promise<string | null>;
  writeSecret(account: string, secret: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}
