/** What model calls cost. */

// $ per million input / output tokens. Claude: Anthropic's model table (2026-10-06). GPT:
// developers.openai.com/api/docs/pricing (standard, short context). Jev: docs.typesafe.ai/models
// (output is free). Matched by prefix, so dated model names find their price.
export const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4.0, 20.0],
  "claude-sonnet-5-5": [2.0, 10.0],
  "claude-haiku-5-5": [0.1, 0.5],
  "gpt-6-astra": [10.0, 50.0],
  "gpt-6.1-sol": [2.0, 10.0],
  "gpt-6-luna": [0.1, 0.5],
  "jev-": [0.042, 0.0],
};

export function price(model: string): [number, number] | null {
  const names = Object.keys(PRICES).sort((a, b) => b.length - a.length);
  const name = names.find((n) => model.startsWith(n));
  return name ? PRICES[name] : null;
}

/**
 * Dollars for one call. A model without a known price counts as free; callers check `price()`
 * up front so that doesn't happen silently.
 */
export function cost(model: string, inputTokens: number, outputTokens = 0): number {
  const [inputPrice, outputPrice] = price(model) ?? [0, 0];
  return (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
}
