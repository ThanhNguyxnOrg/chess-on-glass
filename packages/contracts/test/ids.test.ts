import { describe, expect, it } from "vitest";
import { newSessionId, newSourceId, parseSequence } from "@chessonglass/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("opaque identities", () => {
  it("creates distinct UUID-shaped session IDs", () => {
    const first = newSessionId();
    const second = newSessionId();
    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(first).not.toBe(second);
  });

  it("creates distinct UUID-shaped source IDs", () => {
    const first = newSourceId();
    const second = newSourceId();
    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(first).not.toBe(second);
  });
});

describe("parseSequence", () => {
  it("preserves a bigint string beyond Number.MAX_SAFE_INTEGER", () => {
    expect(parseSequence("9007199254740993")).toBe(9007199254740993n);
  });

  it("accepts bigint and safe non-negative integers", () => {
    expect(parseSequence(0n)).toBe(0n);
    expect(parseSequence(42)).toBe(42n);
    expect(parseSequence("0007")).toBe(7n);
  });

  it("rejects decimals, negatives, unsafe JSON numbers and objects", () => {
    const rejected: unknown[] = [
      1.5,
      -1,
      "-1",
      "1.5",
      "",
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      {},
      [],
      null,
      undefined,
      true
    ];
    for (const value of rejected) {
      expect(() => parseSequence(value), `expected rejection for ${String(value)}`).toThrow();
    }
  });
});
