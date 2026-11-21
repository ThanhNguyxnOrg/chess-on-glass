import { PROVIDER_CATALOG } from "@chessonglass/perception";
import type { LedgerSnapshot } from "@chessonglass/game";
import type { AppSettings } from "../settings/settings.js";
import type { SecretProviderName, SecretStatus } from "../secrets/secret-service.js";
import { badRequest, HttpError } from "./errors.js";
import type { ComposableRoutes, DashboardResponse } from "./server.js";

export const SETTINGS_PATH = "/api/settings";
export const SECRETS_PATH = "/api/secrets";
export const REPLAY_START_PATH = "/api/source/replay/start";
export const REPLAY_STOP_PATH = "/api/source/replay/stop";

export type RuntimeCapabilities = Readonly<{
  stockfish: boolean;
  ffmpeg: boolean;
  speech: boolean;
  wgc: boolean;
}>;

export type SettingsRoutesOptions = {
  getSettings(): AppSettings;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  getSecretStatuses(): Promise<Record<SecretProviderName, SecretStatus>>;
  writeSecret(provider: SecretProviderName, secret: string): Promise<SecretStatus>;
  getLedgerSnapshot(): LedgerSnapshot;
  getCapabilities(): RuntimeCapabilities;
  startReplay?(input: { path: string; fps?: number; speed?: number }): Promise<void>;
  stopReplay?(): Promise<void>;
};

const VALID_PROVIDERS = new Set<string>(["openai", "anthropic"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Authorized local dashboard routes for runtime settings, OS-keyring secret
 * writes (never echoed back), cost ledger visibility and replay control.
 */
export function createSettingsRoutes(
  options: SettingsRoutesOptions
): ComposableRoutes {
  return {
    bodyPolicy() {
      return null;
    },

    async handle(request): Promise<DashboardResponse | null> {
      if (request.path === SETTINGS_PATH && request.method === "GET") {
        const secrets = await options.getSecretStatuses();
        return {
          status: 200,
          json: {
            settings: options.getSettings(),
            secrets,
            catalog: PROVIDER_CATALOG,
            ledger: options.getLedgerSnapshot(),
            capabilities: options.getCapabilities()
          }
        };
      }

      if (request.path === SETTINGS_PATH && request.method === "PUT") {
        if (!isRecord(request.json)) {
          throw badRequest("settings payload must be a JSON object");
        }
        try {
          const updated = await options.updateSettings(
            request.json as Partial<AppSettings>
          );
          const secrets = await options.getSecretStatuses();
          return {
            status: 200,
            json: {
              settings: updated,
              secrets,
              ledger: options.getLedgerSnapshot(),
              capabilities: options.getCapabilities()
            }
          };
        } catch (error) {
          throw badRequest(
            error instanceof Error ? error.message : "invalid settings"
          );
        }
      }

      if (request.path === SECRETS_PATH && request.method === "POST") {
        if (!isRecord(request.json)) {
          throw badRequest("secret payload must be a JSON object");
        }
        const provider = request.json["provider"];
        const secret = request.json["secret"];
        if (typeof provider !== "string" || !VALID_PROVIDERS.has(provider)) {
          throw badRequest("provider must be \"openai\" or \"anthropic\"");
        }
        if (typeof secret !== "string" || secret.trim() === "" || secret.length >= 20_000) {
          throw badRequest("secret must be a non-empty string under 20000 characters");
        }
        try {
          const status = await options.writeSecret(
            provider as SecretProviderName,
            secret.trim()
          );
          return {
            status: 200,
            json: { provider, status }
          };
        } catch {
          throw new HttpError(
            503,
            "secret_store_unavailable",
            "unable to persist credential to the OS secret store"
          );
        }
      }

      if (request.path === REPLAY_START_PATH && request.method === "POST") {
        if (options.startReplay === undefined) {
          throw new HttpError(
            503,
            "source_unavailable",
            "replay source is unavailable"
          );
        }
        if (!isRecord(request.json)) {
          throw badRequest("replay payload must be a JSON object");
        }
        const path = request.json["path"];
        if (typeof path !== "string" || path.trim() === "") {
          throw badRequest("replay path is required");
        }
        const fps = request.json["fps"];
        const speed = request.json["speed"];
        try {
          await options.startReplay({
            path: path.trim(),
            ...(typeof fps === "number" ? { fps } : {}),
            ...(typeof speed === "number" ? { speed } : {})
          });
        } catch (error) {
          throw new HttpError(
            502,
            "replay_failed",
            error instanceof Error ? error.message : "failed to start replay"
          );
        }
        return { status: 202, json: { started: true } };
      }

      if (request.path === REPLAY_STOP_PATH && request.method === "POST") {
        if (options.stopReplay === undefined) {
          throw new HttpError(
            503,
            "source_unavailable",
            "replay source is unavailable"
          );
        }
        await options.stopReplay();
        return { status: 202, json: { stopped: true } };
      }

      return null;
    }
  };
}
