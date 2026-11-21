import type { PlatformServices } from "@chessonglass/platform";

export type SecretProviderName = "openai" | "anthropic";
export type SecretStatus = Readonly<{
  configured: boolean;
  source: "keyring" | "environment" | null;
}>;

const ACCOUNT_PREFIX = "chessonglass.";

export type EnvironmentSecrets = Partial<
  Record<SecretProviderName, string | undefined>
>;

/**
 * Wraps PlatformServices secret storage with environment-variable override
 * logic. The keyring is the primary source; environment keys are explicit
 * overrides, never copied into the keyring. No plaintext fallback exists.
 */
export class SecretService {
  private readonly platform: PlatformServices;
  private readonly env: EnvironmentSecrets;

  constructor(platform: PlatformServices, env: EnvironmentSecrets = {}) {
    this.platform = platform;
    this.env = env;
  }

  async status(provider: SecretProviderName): Promise<SecretStatus> {
    let keyring: string | null = null;
    try {
      keyring = await this.platform.readSecret(this.account(provider));
    } catch {
      keyring = null;
    }
    if (keyring !== null && keyring !== "") {
      return { configured: true, source: "keyring" };
    }
    const envValue = this.env[provider];
    if (typeof envValue === "string" && envValue.trim() !== "") {
      return { configured: true, source: "environment" };
    }
    return { configured: false, source: null };
  }

  async read(provider: SecretProviderName): Promise<string | null> {
    let keyring: string | null = null;
    try {
      keyring = await this.platform.readSecret(this.account(provider));
    } catch {
      keyring = null;
    }
    if (keyring !== null && keyring !== "") {
      return keyring;
    }
    const envValue = this.env[provider];
    if (typeof envValue === "string" && envValue.trim() !== "") {
      return envValue.trim();
    }
    return null;
  }

  async write(
    provider: SecretProviderName,
    secret: string
  ): Promise<void> {
    await this.platform.writeSecret(this.account(provider), secret);
    const readback = await this.platform.readSecret(this.account(provider));
    if (readback !== secret) {
      throw new Error("secret write failed: readback does not match");
    }
  }

  private account(provider: SecretProviderName): string {
    return `${ACCOUNT_PREFIX}${provider}`;
  }
}
