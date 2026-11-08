import { describe, expect, it } from "vitest";
import { CostLedger, type Price } from "@chessonglass/game";

const PRICE: Price = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  effectiveAt: "2026-01-01T00:00:00Z"
};

describe("CostLedger settings", () => {
  it("rejects zero, negative, NaN and infinite limits and reserves", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => new CostLedger(bad, 1)).toThrow();
      expect(() => new CostLedger(10, bad)).toThrow();
    }
  });
});

describe("CostLedger reservations", () => {
  it("blocks paid work when the price is unknown", () => {
    const ledger = new CostLedger(10, 0.5);
    const unknownPrices: Price[] = [
      { inputPerMillion: Number.NaN, outputPerMillion: 1, effectiveAt: "2026-01-01" },
      { inputPerMillion: 1, outputPerMillion: Number.POSITIVE_INFINITY, effectiveAt: "2026-01-01" },
      { inputPerMillion: -1, outputPerMillion: 1, effectiveAt: "2026-01-01" },
      { inputPerMillion: 1, outputPerMillion: -1, effectiveAt: "2026-01-01" },
      { inputPerMillion: 1, outputPerMillion: 1, effectiveAt: "" },
      { inputPerMillion: 1, outputPerMillion: 1, effectiveAt: "not-a-date" }
    ];

    for (const price of unknownPrices) {
      const result = ledger.reserve("request", price);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/price|unknown/i);
    }

    expect(ledger.snapshot()).toEqual({ reservedUsd: 0, actualUsd: 0, paused: false });
  });

  it("shares one cap between a vision call and a locator call", () => {
    const ledger = new CostLedger(1, 0.6);

    expect(ledger.reserve("vision-1", PRICE).allowed).toBe(true);
    const second = ledger.reserve("locator-1", PRICE);
    expect(second.allowed).toBe(false);
    expect(second.reason).toMatch(/budget/i);

    expect(ledger.snapshot().reservedUsd).toBeCloseTo(0.6);
    expect(ledger.snapshot().paused).toBe(true);
  });

  it("frees room when a reservation is released", () => {
    const ledger = new CostLedger(1, 0.6);

    expect(ledger.reserve("vision-1", PRICE).allowed).toBe(true);
    expect(ledger.reserve("locator-1", PRICE).allowed).toBe(false);

    ledger.release("vision-1");

    expect(ledger.snapshot()).toEqual({ reservedUsd: 0, actualUsd: 0, paused: false });
    expect(ledger.reserve("locator-1", PRICE).allowed).toBe(true);
  });

  it("does not double-reserve one request id", () => {
    const ledger = new CostLedger(2, 0.5);

    expect(ledger.reserve("request", PRICE).allowed).toBe(true);
    expect(ledger.reserve("request", PRICE).allowed).toBe(false);
    expect(ledger.snapshot().reservedUsd).toBeCloseTo(0.5);
  });
});

describe("CostLedger settlement", () => {
  it("reconciles actual token cost and is idempotent", () => {
    const ledger = new CostLedger(1, 0.5);
    ledger.reserve("request", PRICE);

    // 100k input * $3/M + 10k output * $15/M = $0.45.
    ledger.settle("request", 100_000, 10_000, PRICE);

    expect(ledger.snapshot().actualUsd).toBeCloseTo(0.45);
    expect(ledger.snapshot().reservedUsd).toBe(0);

    ledger.settle("request", 100_000, 10_000, PRICE);
    expect(ledger.snapshot().actualUsd).toBeCloseTo(0.45);
  });

  it("charges the conservative reserve when the settle price is unknown", () => {
    const ledger = new CostLedger(10, 0.75);
    ledger.reserve("request", PRICE);

    ledger.settle("request", 1_000, 100, { ...PRICE, inputPerMillion: Number.NaN });

    expect(ledger.snapshot().actualUsd).toBeCloseTo(0.75);
    expect(ledger.snapshot().reservedUsd).toBe(0);
  });

  it("records a late completed call without inventing a refund after pause", () => {
    const ledger = new CostLedger(1, 0.6);
    expect(ledger.reserve("vision-1", PRICE).allowed).toBe(true);
    expect(ledger.reserve("locator-1", PRICE).allowed).toBe(false);

    // The in-flight vision call finishes after the ledger is already paused.
    ledger.settle("vision-1", 1_000_000, 0, PRICE);

    expect(ledger.snapshot().actualUsd).toBeCloseTo(3);
    expect(ledger.snapshot().reservedUsd).toBe(0);
    expect(ledger.snapshot().paused).toBe(true);
    expect(ledger.reserve("later", PRICE).allowed).toBe(false);
  });

  it("rejects invalid token counts without losing the reservation", () => {
    const ledger = new CostLedger(1, 0.5);
    ledger.reserve("request", PRICE);

    const invalid: ReadonlyArray<readonly [number, number]> = [
      [-1, 0],
      [0, -1],
      [Number.NaN, 0],
      [0, Number.POSITIVE_INFINITY],
      [1.5, 0]
    ];
    for (const [input, output] of invalid) {
      expect(() => ledger.settle("request", input, output, PRICE)).toThrow();
    }

    expect(ledger.snapshot().reservedUsd).toBeCloseTo(0.5);
  });

  it("ignores release and settle for an unknown request", () => {
    const ledger = new CostLedger(1, 0.5);

    expect(() => ledger.release("missing")).not.toThrow();
    expect(() => ledger.settle("missing", 10, 5, PRICE)).not.toThrow();
    expect(ledger.snapshot()).toEqual({ reservedUsd: 0, actualUsd: 0, paused: false });
  });
});
