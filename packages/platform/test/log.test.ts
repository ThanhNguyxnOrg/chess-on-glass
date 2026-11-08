import { describe, expect, it } from "vitest";
import { redactLog } from "@chessonglass/platform";

describe("redactLog", () => {
  it("redacts secret-bearing values recursively without mutating the input", () => {
    const input = {
      level: "info",
      authorization: "Bearer abc123",
      nested: {
        Cookie: "session=xyz",
        token: "tok_live_123",
        apiKey: "sk-123",
        "api-key": "key-456",
        message: "still visible"
      },
      list: [{ Authorization: "Basic zzz" }, { ok: true }]
    };
    const snapshot = JSON.parse(JSON.stringify(input));

    const output = redactLog(input) as Record<string, unknown>;

    expect(input).toEqual(snapshot);
    expect(output.authorization).toBe("[REDACTED]");
    expect((output.nested as Record<string, unknown>).Cookie).toBe("[REDACTED]");
    expect((output.nested as Record<string, unknown>).token).toBe("[REDACTED]");
    expect((output.nested as Record<string, unknown>).apiKey).toBe("[REDACTED]");
    expect((output.nested as Record<string, unknown>)["api-key"]).toBe("[REDACTED]");
    expect((output.nested as Record<string, unknown>).message).toBe("still visible");
    expect((output.list as Array<Record<string, unknown>>)[0]?.Authorization).toBe("[REDACTED]");
    expect((output.list as Array<Record<string, unknown>>)[1]?.ok).toBe(true);
  });

  it("leaves primitives and non-secret keys untouched", () => {
    expect(redactLog("hello")).toBe("hello");
    expect(redactLog(42)).toBe(42);
    expect(redactLog(null)).toBeNull();
    expect(redactLog({ move: "e2e4" })).toEqual({ move: "e2e4" });
  });
});
