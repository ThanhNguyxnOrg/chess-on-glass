import { describe, expect, it } from "vitest";
import { newSessionId, newSourceId, type Frame } from "@chessonglass/contracts";
import {
  OpenAiBoardReader,
  type OpenAiTransport,
  type OpenAiTransportRequest,
  type OpenAiTransportResponse
} from "../src/providers/openai-reader.js";
import { observationContext } from "./support/provider-fakes.js";

function frame(sequence = 1n, bytes = new Uint8Array([1, 2, 3, 4])): Frame {
  return {
    sessionId: newSessionId(),
    sourceId: newSourceId(),
    sequence,
    capturedAtMonotonicMs: null,
    capturedAtWallMs: 1_700_000_000_000,
    receivedAtMonotonicMs: 42,
    bytes,
    mimeType: "image/jpeg"
  };
}

function emptySquares(): Array<{
  square: number;
  color: string;
  kind: string;
  confidence: number | null;
}> {
  return Array.from({ length: 64 }, (_, square) => ({
    square,
    color: "empty",
    kind: "unknown",
    confidence: 0.99
  }));
}

function pieceSquares(): Array<{
  square: number;
  color: string;
  kind: string;
  confidence: number | null;
}> {
  const squares = emptySquares();
  squares[60] = { square: 60, color: "white", kind: "king", confidence: 0.97 };
  squares[4] = { square: 4, color: "black", kind: "king", confidence: 0.96 };
  squares[52] = { square: 52, color: "white", kind: "pawn", confidence: 0.9 };
  return squares;
}

function answer(
  squares: ReturnType<typeof emptySquares>,
  overrides: Partial<OpenAiTransportResponse> = {}
): OpenAiTransportResponse {
  return {
    status: "completed",
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              boardVisible: true,
              handOverBoard: false,
              squares
            })
          }
        ]
      }
    ],
    usage: { input_tokens: 120, output_tokens: 30 },
    ...overrides
  };
}

class FakeTransport implements OpenAiTransport {
  readonly calls: OpenAiTransportRequest[] = [];
  private readonly script: Array<() => Promise<OpenAiTransportResponse>>;

  constructor(script: Array<() => Promise<OpenAiTransportResponse>>) {
    this.script = script;
  }

  async respond(input: OpenAiTransportRequest): Promise<OpenAiTransportResponse> {
    this.calls.push(input);
    const next = this.script.shift();
    if (next === undefined) {
      throw new Error("unexpected extra transport call");
    }
    return next();
  }
}

describe("OpenAiBoardReader", () => {
  it("sends image bytes, the reference FEN and a strict schema, then maps usage", async () => {
    const transport = new FakeTransport([async () => answer(emptySquares())]);
    const reader = new OpenAiBoardReader({
      transport,
      model: "gpt-6.1-sol"
    });
    const target = frame(7n, new Uint8Array([9, 8, 7]));
    const referenceFrame = frame(6n, new Uint8Array([1]));
    const position = {
      initialFen: "start",
      fen: "8/8/8/8/8/8/8/4K3 w - - 0 1",
      history: [],
      uncertainty: { castlingRights: false, enPassant: false, promotion: false }
    };
    const context = observationContext({ referenceSequence: 7n });

    const result = await reader.read({
      frame: target,
      reference: { frame: referenceFrame, position },
      context,
      signal: new AbortController().signal
    });

    expect(result.ok).toBe(true);
    const call = transport.calls[0]!;
    expect(call.model).toBe("gpt-6.1-sol");
    const serialized = JSON.stringify(call);
    expect(serialized).toContain(Buffer.from(target.bytes).toString("base64"));
    expect(serialized).toContain("8/8/8/8/8/8/8/4K3 w - - 0 1");
    expect(serialized).toContain(Buffer.from(referenceFrame.bytes).toString("base64"));
    expect(call.text.format.type).toBe("json_schema");
    expect(call.text.format.strict).toBe(true);
    expect(call.text.format.schema).toMatchObject({ type: "object" });

    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.observation.context).toEqual(context);
    expect(result.observation.provider).toBe("openai");
    expect(result.observation.model).toBe("gpt-6.1-sol");
    expect(result.observation.inputTokens).toBe(120);
    expect(result.observation.outputTokens).toBe(30);
  });

  it("accepts a piece-level mid-game answer", async () => {
    const transport = new FakeTransport([async () => answer(pieceSquares())]);
    const reader = new OpenAiBoardReader({ transport, model: "gpt-6.1-sol" });

    const result = await reader.read({
      frame: frame(),
      reference: null,
      context: observationContext(),
      signal: new AbortController().signal
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const king = result.observation.squares.find((square) => square.square === 60);
      expect(king).toMatchObject({ color: "white", kind: "king" });
    }
  });

  it("maps malformed, refused and incomplete answers to a non-retryable failure", async () => {
    const malformed = new FakeTransport([
      async () => answer(emptySquares(), {
        output: [{ type: "message", content: [{ type: "output_text", text: "{not json" }] }]
      })
    ]);
    const refused = new FakeTransport([
      async () => answer(emptySquares(), {
        output: [{ type: "message", content: [{ type: "refusal", refusal: "cannot help" }] }]
      })
    ]);
    const incomplete = new FakeTransport([
      async () => answer(emptySquares(), {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" }
      })
    ]);

    for (const transport of [malformed, refused, incomplete]) {
      const reader = new OpenAiBoardReader({ transport, model: "gpt-6.1-sol" });
      const result = await reader.read({
        frame: frame(),
        reference: null,
        context: observationContext(),
        signal: new AbortController().signal
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("invalid-response");
        expect(result.retryable).toBe(false);
      }
    }
  });

  it("does not retry 401/403 and retries 429/5xx at most once", async () => {
    const unauthorized = new FakeTransport([
      async () => {
        throw Object.assign(new Error("bad key sk-secret-value"), { status: 401 });
      }
    ]);
    const unauthorizedReader = new OpenAiBoardReader({
      transport: unauthorized,
      model: "gpt-6.1-sol"
    });
    const denied = await unauthorizedReader.read({
      frame: frame(),
      reference: null,
      context: observationContext(),
      signal: new AbortController().signal
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe("unauthorized");
      expect(denied.message).not.toContain("sk-secret-value");
    }
    expect(unauthorized.calls).toHaveLength(1);

    const throttled = new FakeTransport([
      async () => {
        throw Object.assign(new Error("slow down"), { status: 429 });
      },
      async () => answer(emptySquares())
    ]);
    const throttledReader = new OpenAiBoardReader({
      transport: throttled,
      model: "gpt-6.1-sol"
    });
    const recovered = await throttledReader.read({
      frame: frame(),
      reference: null,
      context: observationContext(),
      signal: new AbortController().signal
    });
    expect(recovered.ok).toBe(true);
    expect(throttled.calls).toHaveLength(2);

    const persistent = new FakeTransport([
      async () => {
        throw Object.assign(new Error("down"), { status: 503 });
      },
      async () => {
        throw Object.assign(new Error("down again"), { status: 503 });
      }
    ]);
    const persistentReader = new OpenAiBoardReader({
      transport: persistent,
      model: "gpt-6.1-sol"
    });
    const failed = await persistentReader.read({
      frame: frame(),
      reference: null,
      context: observationContext(),
      signal: new AbortController().signal
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe("unavailable");
    }
    expect(persistent.calls).toHaveLength(2);
  });

  it("maps caller cancellation to cancelled and provider timeouts to unavailable", async () => {
    const hanging: OpenAiTransport = {
      respond: (input) =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        })
    };
    const reader = new OpenAiBoardReader({
      transport: hanging,
      model: "gpt-6.1-sol",
      timeoutMs: 20
    });

    const timedOut = await reader.read({
      frame: frame(),
      reference: null,
      context: observationContext(),
      signal: new AbortController().signal
    });
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) {
      expect(timedOut.code).toBe("unavailable");
      expect(timedOut.retryable).toBe(true);
    }

    const controller = new AbortController();
    const pending = reader.read({
      frame: frame(),
      reference: null,
      context: observationContext(),
      signal: controller.signal
    });
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) {
      expect(cancelled.code).toBe("cancelled");
    }
  });
});
