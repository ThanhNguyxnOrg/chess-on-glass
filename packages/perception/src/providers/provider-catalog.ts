import type { ProviderName, ProviderSettings } from "../types.js";

export type CatalogEntry = Readonly<{
  provider: ProviderName;
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
  effectiveAt: string;
  source: string;
}>;

/**
 * Priced vision models verified against official provider pricing pages
 * (research/RESEARCH.md, 2026-11-10). Unknown models are not treated as free.
 */
export const PROVIDER_CATALOG: readonly CatalogEntry[] = [
  {
    provider: "openai",
    model: "gpt-6-astra",
    inputPerMillion: 10,
    outputPerMillion: 50,
    effectiveAt: "2026-11-10",
    source: "https://developers.openai.com/api/docs/pricing"
  },
  {
    provider: "openai",
    model: "gpt-6.1-sol",
    inputPerMillion: 2,
    outputPerMillion: 10,
    effectiveAt: "2026-11-10",
    source: "https://developers.openai.com/api/docs/pricing"
  },
  {
    provider: "openai",
    model: "gpt-6.1-terra",
    inputPerMillion: 1,
    outputPerMillion: 5,
    effectiveAt: "2026-11-10",
    source: "https://developers.openai.com/api/docs/pricing"
  },
  {
    provider: "openai",
    model: "gpt-6-luna",
    inputPerMillion: 0.1,
    outputPerMillion: 0.5,
    effectiveAt: "2026-11-10",
    source: "https://developers.openai.com/api/docs/pricing"
  },
  {
    provider: "anthropic",
    model: "claude-fable-5-2",
    inputPerMillion: 8,
    outputPerMillion: 40,
    effectiveAt: "2026-11-10",
    source: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  {
    provider: "anthropic",
    model: "claude-opus-5-5",
    inputPerMillion: 4,
    outputPerMillion: 20,
    effectiveAt: "2026-11-10",
    source: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    inputPerMillion: 2,
    outputPerMillion: 10,
    effectiveAt: "2026-11-10",
    source: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  {
    provider: "anthropic",
    model: "claude-haiku-5-5",
    inputPerMillion: 0.1,
    outputPerMillion: 0.5,
    effectiveAt: "2026-11-10",
    source: "https://platform.claude.com/docs/en/about-claude/pricing"
  }
] as const;

export function findModel(
  provider: ProviderName,
  model: string
): CatalogEntry | null {
  return (
    PROVIDER_CATALOG.find(
      (entry) => entry.provider === provider && entry.model === model
    ) ?? null
  );
}

/**
 * Returns the price for a cataloged model when cloud is enabled, or null when
 * the model is unknown. Unknown models are never counted as free.
 */
export function providerPrice(settings: ProviderSettings): {
  inputPerMillion: number;
  outputPerMillion: number;
  effectiveAt: string;
} | null {
  if (!settings.cloudEnabled) {
    return null;
  }
  const entry = findModel(settings.provider, settings.model);
  if (entry === null) {
    return null;
  }
  return {
    inputPerMillion: entry.inputPerMillion,
    outputPerMillion: entry.outputPerMillion,
    effectiveAt: entry.effectiveAt
  };
}
