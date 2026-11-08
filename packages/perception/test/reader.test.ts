import { describe, expect, it } from "vitest";
import { ProviderError, toReadFailure, type BoardReader } from "@chessonglass/perception";
import { newSessionId, type RequestContext } from "@chessonglass/contracts";

function context(): RequestContext {
  return {
    requestId: "req-1",
    sessionId: newSessionId(),
    positionVersion: 1,
    referenceSequence: null
  };
}

describe("provider failure mapping", () => {
  it("maps an abort to a non-retryable cancelled result", () => {
    const controller = new AbortController();
    controller.abort();
    expect(toReadFailure(new Error("anything"), controller.signal)).toEqual({
      ok: false,
      code: "cancelled",
      message: "read cancelled",
      retryable: false
    });
  });

  it("classifies provider errors and never copies secret-bearing messages", () => {
    const signal = new AbortController().signal;
    const unauthorized = toReadFailure(
      new ProviderError("unauthorized", "401 Bearer sk-live-SECRET", false),
      signal
    );
    expect(unauthorized).toMatchObject({
      ok: false,
      code: "unauthorized",
      retryable: false
    });
    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok) {
      expect(unauthorized.message).not.toContain("SECRET");
    }

    const unavailable = toReadFailure(
      new ProviderError("unavailable", "temporary network failure", true),
      signal
    );
    expect(unavailable).toMatchObject({ code: "unavailable", retryable: true });
  });

  it("maps unknown throws to a generic unavailable failure", () => {
    const failure = toReadFailure(new Error("raw /secret/path and token=abc"), new AbortController().signal);
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.code).toBe("unavailable");
      expect(failure.retryable).toBe(true);
      expect(failure.message).not.toContain("/secret/path");
      expect(failure.message).not.toContain("token=abc");
    }
  });
});

describe("BoardReader contract", () => {
  it("can represent a provider that ignores cancellation without leaking a raw throw", async () => {
    const reader: BoardReader = {
      async read() {
        return {
          ok: false,
          code: "cancelled",
          message: "read cancelled",
          retryable: false
        };
      }
    };

    const result = await reader.read({
      frame: {
        sessionId: newSessionId(),
        sourceId: newSessionId(),
        sequence: 0n,
        capturedAtMonotonicMs: null,
        capturedAtWallMs: 0,
        receivedAtMonotonicMs: 0,
        bytes: new Uint8Array(),
        mimeType: "image/jpeg"
      },
      reference: null,
      context: context(),
      signal: new AbortController().signal
    });

    expect(result.ok).toBe(false);
  });
});
