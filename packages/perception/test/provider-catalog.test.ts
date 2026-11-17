import { describe, expect, it } from "vitest";
import {
  PROVIDER_CATALOG,
  findModel
} from "../src/providers/provider-catalog.js";

describe("provider catalog", () => {
  it("lists priced vision models with a real effective date and source", () => {
    expect(PROVIDER_CATALOG.length).toBeGreaterThanOrEqual(6);
    for (const entry of PROVIDER_CATALOG) {
      expect(entry.inputPerMillion).toBeGreaterThanOrEqual(0);
      expect(entry.outputPerMillion).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(entry.effectiveAt))).toBe(false);
      expect(entry.source.startsWith("https://")).toBe(true);
      expect(entry.model.length).toBeGreaterThan(0);
    }
  });

  it("finds known models and returns null for unknown ones or wrong providers", () => {
    expect(findModel("openai", "gpt-6.1-sol")).toMatchObject({
      inputPerMillion: 2,
      outputPerMillion: 10
    });
    expect(findModel("anthropic", "claude-sonnet-5-5")).toMatchObject({
      inputPerMillion: 2,
      outputPerMillion: 10
    });
    expect(findModel("openai", "gpt-3.5-legacy")).toBeNull();
    expect(findModel("anthropic", "gpt-6.1-sol")).toBeNull();
  });
});
