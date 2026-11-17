import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type AppSettings = {
  provider: "openai" | "anthropic" | null;
  visionModel: string | null;
  cloudEnabled: boolean;
  speechEnabled: boolean;
  voiceId: string | null;
  browserFps: number;
  replayFps: number;
  maxCostUsd: number;
};

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  provider: null,
  visionModel: null,
  cloudEnabled: false,
  speechEnabled: true,
  voiceId: null,
  browserFps: 2,
  replayFps: 5,
  maxCostUsd: 10
});

const SETTINGS_KEYS = [
  "provider",
  "visionModel",
  "cloudEnabled",
  "speechEnabled",
  "voiceId",
  "browserFps",
  "replayFps",
  "maxCostUsd"
] as const;

const PROVIDERS = new Set(["openai", "anthropic"]);

function validateSettings(value: unknown): AppSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("settings must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  for (const key of keys) {
    if (!SETTINGS_KEYS.includes(key as (typeof SETTINGS_KEYS)[number])) {
      throw new TypeError(`settings contains unknown field "${key}"`);
    }
  }
  for (const key of SETTINGS_KEYS) {
    if (!(key in record)) {
      throw new TypeError(`settings is missing field "${key}"`);
    }
  }

  const provider = record["provider"];
  if (provider !== null && (typeof provider !== "string" || !PROVIDERS.has(provider))) {
    throw new TypeError("settings.provider must be null, \"openai\" or \"anthropic\"");
  }
  const visionModel = record["visionModel"];
  if (visionModel !== null && typeof visionModel !== "string") {
    throw new TypeError("settings.visionModel must be null or a string");
  }
  if (typeof record["cloudEnabled"] !== "boolean") {
    throw new TypeError("settings.cloudEnabled must be a boolean");
  }
  if (typeof record["speechEnabled"] !== "boolean") {
    throw new TypeError("settings.speechEnabled must be a boolean");
  }
  const voiceId = record["voiceId"];
  if (voiceId !== null && typeof voiceId !== "string") {
    throw new TypeError("settings.voiceId must be null or a string");
  }
  const browserFps = record["browserFps"];
  if (typeof browserFps !== "number" || !Number.isSafeInteger(browserFps) || browserFps < 1 || browserFps > 10) {
    throw new TypeError("settings.browserFps must be an integer between 1 and 10");
  }
  const replayFps = record["replayFps"];
  if (typeof replayFps !== "number" || !Number.isSafeInteger(replayFps) || replayFps < 1 || replayFps > 10) {
    throw new TypeError("settings.replayFps must be an integer between 1 and 10");
  }
  const maxCostUsd = record["maxCostUsd"];
  if (
    typeof maxCostUsd !== "number" ||
    !Number.isFinite(maxCostUsd) ||
    maxCostUsd <= 0
  ) {
    throw new TypeError("settings.maxCostUsd must be a positive finite number");
  }

  return {
    provider: provider as "openai" | "anthropic" | null,
    visionModel: visionModel as string | null,
    cloudEnabled: record["cloudEnabled"] as boolean,
    speechEnabled: record["speechEnabled"] as boolean,
    voiceId: voiceId as string | null,
    browserFps: browserFps as number,
    replayFps: replayFps as number,
    maxCostUsd: maxCostUsd as number
  };
}

export async function loadSettings(path: string): Promise<AppSettings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError("settings file contains invalid JSON");
  }
  return validateSettings(value);
}

export async function saveSettings(
  path: string,
  settings: AppSettings
): Promise<void> {
  validateSettings(settings);
  const payload = JSON.stringify(settings, null, 2);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temp = join(parent, `.${Date.now()}.tmp`);
  await writeFile(temp, payload, "utf8");
  await rename(temp, path);
}
