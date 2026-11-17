import { describe, expect, it } from "vitest";
import { newSessionId, newSourceId, type Frame } from "@chessonglass/contracts";
import {
  AnthropicBoardReader,
  type AnthropicTransport,
  type AnthropicTransportRequest,
  type AnthropicTransportResponse
} from "../src/providers/anthropic-reader.js";
import {
  emptySquares,
  midGameSquares,
  observationContext
} from "./support/provider-fakes.js";

function frame(bytes = new Uint8Array([5, 6, 7])): Frame {
  return {
    sessionId: newSessionId(),
    sourceId: newSourceId(),
    sequence: 3n,
    capturedAtMonotonicMs: null,
    capturedAtWallMs: 1_700_000_000_000,
    receivedAtMonotonicMs: 42,
    bytes,
    mimeType: "image/jpeg"
  };
}

function answer(
  squares: ReturnType<typeof emptySquares>,
  overrides: Partial<AnthropicTransportResponse> = {}
): AnthropicTransportResponse {
  return {
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          boardVisible: true,
          handOverBoard: false,
          squares
        })
      }
    ],
    usage: { input_tokens: 500, output_tokens: 80 },
    ...overrides
  };
}

class FakeTransport implements AnthropicTransport {
  readonly calls: AnthropicTransportRequest[] = [];
  private readonly script: Array<() => Promise<AnthropicTransportResponse>>;

  constructor(script: Array<() => Promise<AnthropicTransportResponse>>) {
    this.script = script;
  }

  async create(input: AnthropicTransportRequest): Promise<AnthropicTransportResponse> {
    this.calls.push(input);
    const next = this.script.shift();
    if (next === undefined) {
      throw new Error("unexpected extra transport call");
    }
    return next();
  }
}

describe("AnthropicBoardReader", () => {
  it("sends base64 image content, the reference FEN and a strict schema", async () => {
    const transport = new FakeTransport([async () => answer(midGameSquares())]);
    const reader = new AnthropicBoardReader({
      transport,
      model: "claude-sonnet-5-5"
    });
    const position = {
      initialFen: "start",
      fen: "8/8/8/8/8/8/8/4K3 b - - 0 1",
      history: [],
      uncertainty: { castlingRights: false, enPassant: false, promotion: false }
    };

    const result = await reader.read({
      frame: frame(),
      reference: { frame: frame(new Uint8Array([9])), position },
      context: observationContext({ referenceSequence: 3n }),
      signal: new AbortController().signal
    });

    expect(result.ok).toBe(true);
    const call = transport.calls[0]!;
    expect(call.model).toBe("claude-sonnet-5-5");
    const serialized = JSON.stringify(call);
    expect(serialized).toContain(Buffer.from([5, 6, 7]).toString("base64"));
    expect(serialized).toContain("8/8/8/8/8/8/8/4K3 b - - 0 1");
    expect(call.output_config.format.type).toBe("json_schema");

    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.observation.provider).toBe("anthropic");
    expect(result.observation.inputTokens).toBe(500);
    expect(result.observation.outputTokens).toBe(80);
  });

  it("maps refusal and truncation to a non-retryable failure", async () => {
    const refusal = new FakeTransport([
      async () => answer(emptySquares(), {
        stop_reason: "refusal",
        content: [{ type: "text", text: "I cannot help with that." }]
      })
    ]);
    const truncated = new FakeTransport([
      async () => answer(emptySquares(), { stop_reason: "max_tokens" })
    ]);

    for (const transport of [refusal, truncated]) {
      const reader = new AnthropicBoardReader({
        transport,
        model: "claude-sonnet-5-5"
      });
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

  it("retries 429 once, never 401, and never leaks the key", async () => {
    const throttled = new FakeTransport([
      async () => {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      },
      async () => answer(emptySquares())
    ]);
    const reader = new AnthropicBoardReader({
      transport: throttled,
      model: "claude-sonnet-5-5"
    });
    const recovered = await reader.read({
      frame: frame(),
      reference: null,
      context: observationContext(),
      signal: new AbortController().signal
    });
    expect(recovered.ok).toBe(true);
    expect(throttled.calls).toHaveLength(2);

    const unauthorized = new FakeTransport([
      async () => {
        throw Object.assign(new Error("bad key sk-ant-secret"), { status: 401 });
      }
    ]);
    const deniedReader = new AnthropicBoardReader({
      transport: unauthorized,
      model: "claude-sonnet-5-5"
    });
    const denied = await deniedReader.read({
      frame: frame(),
      reference: null,
      context: observationContext(),
      signal: new AbortController().signal
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe("unauthorized");
      expect(denied.message).not.toContain("sk-ant-secret");
    }
    expect(unauthorized.calls).toHaveLength(1);
  });
});
