import { describe, expect, it } from "vitest";
import {
  createBoardReader,
  providerPrice,
  type ProviderSettings
} from "../../src/providers/provider-factory.js";

const OPENAI: ProviderSettings = {
  provider: "openai",
  model: "gpt-6.1-sol",
  cloudEnabled: true
};

describe("provider factory", () => {
  it("refuses disabled cloud, unknown models and missing credentials", () => {
    expect(() =>
      createBoardReader({ ...OPENAI, cloudEnabled: false }, "sk-test")
    ).toThrow(/cloud/i);
    expect(() =>
      createBoardReader({ ...OPENAI, model: "gpt-unknown" }, "sk-test")
    ).toThrow(/model/i);
    expect(() => createBoardReader(OPENAI, "")).toThrow(/credential/i);
    expect(() => createBoardReader(OPENAI, "x".repeat(20_000))).toThrow(
      /credential/i
    );
  });

  it("builds a reader for a cataloged model without calling the provider", () => {
    const reader = createBoardReader(OPENAI, "sk-test-dummy");
    expect(typeof reader.read).toBe("function");

    const anthropic = createBoardReader(
      { provider: "anthropic", model: "claude-haiku-5-5", cloudEnabled: true },
      "sk-ant-test-dummy"
    );
    expect(typeof anthropic.read).toBe("function");
  });

  it("exposes exact catalog prices and null for unknown models", () => {
    expect(providerPrice(OPENAI)).toEqual({
      inputPerMillion: 2,
      outputPerMillion: 10,
      effectiveAt: "2026-11-10"
    });
    expect(
      providerPrice({ provider: "anthropic", model: "claude-opus-5-5", cloudEnabled: true })
    ).toEqual({
      inputPerMillion: 4,
      outputPerMillion: 20,
      effectiveAt: "2026-11-10"
    });
    expect(
      providerPrice({ provider: "openai", model: "gpt-unknown", cloudEnabled: true })
    ).toBeNull();
  });
});
