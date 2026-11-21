import { afterEach, expect, it, vi } from "vitest";
import { simulatedFrames } from "../../../game/src/cli-evaluate.js";
import { createBoardReader } from "../../src/providers/provider-factory.js";

const board = {
  boardVisible: true,
  handOverBoard: false,
  squares: Array.from({ length: 64 }, (_, square) => ({
    square, color: "empty", kind: "unknown", confidence: 0.99
  }))
};
const text = JSON.stringify(board);
const usage = { input_tokens: 120, output_tokens: 30 };

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([
  {
    provider: "openai",
    model: "gpt-6.1-sol",
    response: {
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
      usage
    }
  },
  {
    provider: "anthropic",
    model: "claude-haiku-5-5",
    response: {
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage
    }
  }
] as const)("reads a replay frame through the $provider SDK offline", async ({ provider, model, response }) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(response));
  vi.stubGlobal("fetch", fetch);
  const reader = createBoardReader({ provider, model, cloudEnabled: true }, "offline-test-key");
  const frame = simulatedFrames()[0]!;
  const context = {
    requestId: "offline-replay",
    sessionId: frame.sessionId,
    positionVersion: 0,
    referenceSequence: frame.sequence
  };

  const result = await reader.read({
    frame, reference: null, context, signal: new AbortController().signal
  });

  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[1]?.body).toContain(Buffer.from(frame.bytes).toString("base64"));
  expect(result).toEqual({
    ok: true,
    observation: { ...board, context, provider, model, inputTokens: 120, outputTokens: 30 }
  });
});
