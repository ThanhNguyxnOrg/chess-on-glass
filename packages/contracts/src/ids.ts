import { randomUUID } from "node:crypto";

/** Nominal wrapper used to keep opaque identifiers from being mixed up. */
export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type SourceId = Brand<string, "SourceId">;
export type Sequence = bigint;

/** Generate an opaque, cryptographically random session identifier. */
export function newSessionId(): SessionId {
  return randomUUID() as SessionId;
}

/** Generate an opaque, cryptographically random source identifier. */
export function newSourceId(): SourceId {
  return randomUUID() as SourceId;
}

/**
 * Validate an untrusted sequence value at a boundary. Strings are accepted so
 * that a 64-bit sequence survives JSON without passing through a double.
 * Objects, decimals, negatives and unsafe numbers are rejected rather than
 * coerced.
 */
export function parseSequence(value: unknown): Sequence {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new TypeError("sequence must be a non-negative integer");
    }
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("sequence must be a safe non-negative integer");
    }
    return BigInt(value);
  }

  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) {
      throw new TypeError("sequence string must contain decimal digits only");
    }
    return BigInt(value);
  }

  throw new TypeError("sequence must be a bigint, safe integer or decimal string");
}
