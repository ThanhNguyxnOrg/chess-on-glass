import { Chess } from "chess.js";
import { describe, expect, test } from "vitest";

import type { Frame } from "../src/capture.js";
import { Grid } from "../src/match.js";
import { ClaudeVision, FALLBACK_BETA, GptVision, type Vision } from "../src/vision.js";
import { FakeClaude, FakeOpenAI, occupancyReply } from "./fakes.js";

const FRAME: Frame = { jpeg: Buffer.from("\xff\xd8 not really a jpeg"), t: 0 };
const START = new Chess().fen();
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const E4_CHANGES = {
  board_visible: true,
  hand_over_board: false,
  changes: [
    { square: "e2", now: "empty" },
    { square: "e4", now: "white" },
  ],
};

async function look(vision: Vision, fen = START) {
  const answer = await vision.ask(FRAME, fen, FRAME);
  return { answer, reading: vision.reading(answer, fen) };
}

const claude = (client: FakeClaude, strategy: "occupancy" | "changes" | "pick", model = "claude-opus-5-5") =>
  new ClaudeVision(client as any, { strategy, model });

describe("Claude", () => {
  test("occupancy reading", async () => {
    const client = new FakeClaude(occupancyReply(AFTER_E4));
    const { answer, reading } = await look(claude(client, "occupancy"));
    expect(reading.grid?.equals(Grid.of(AFTER_E4))).toBe(true);
    expect(reading.boardVisible).toBe(true);
    expect([answer.input_tokens, answer.output_tokens]).toEqual([1500, 60]);

    const [endpoint, params] = client.calls[0];
    expect(endpoint).toBe("beta");
    expect(params.betas).toEqual([FALLBACK_BETA]);
    expect(params.fallbacks).toBe("default");
    expect(params.output_config.effort).toBe("low");
    expect(params.output_config.format.schema.additionalProperties).toBe(false);
    expect(params.output_config.format.schema.required).toContain("rank1");
    expect(params.messages[0].content[0].type).toBe("image");
  });

  test("Haiku has no fallback", async () => {
    const client = new FakeClaude(occupancyReply(START, { visible: false }));
    await look(claude(client, "occupancy", "claude-haiku-5-5"));
    const [endpoint, params] = client.calls[0];
    expect(endpoint).toBe("messages");
    expect(params).not.toHaveProperty("fallbacks");
  });

  test("changes apply to the known position, comparing two images", async () => {
    const client = new FakeClaude(E4_CHANGES);
    const { reading } = await look(claude(client, "changes"));
    expect(reading.grid?.equals(Grid.of(AFTER_E4))).toBe(true);
    const images = client.calls[0][1].messages[0].content.filter((block: any) => block.type === "image");
    expect(images).toHaveLength(2);
  });

  test("pick reading, and the choices are the legal moves plus none", async () => {
    const client = new FakeClaude({ board_visible: true, hand_over_board: false, move: "e2e4" });
    const { reading } = await look(claude(client, "pick"));
    expect(reading.grid?.equals(Grid.of(AFTER_E4))).toBe(true);
    const choices = client.calls[0][1].output_config.format.schema.properties.move.enum;
    expect(choices).toHaveLength(21);
    expect(choices.at(-1)).toBe("none");
  });

  test.each([
    [{ board_visible: true, hand_over_board: false, rank8: "bbbbbbbb" }],
    [{ ...occupancyReply(START), rank3: "wbx....." }],
  ])("unusable occupancy answers give no grid: %j", async (reply) => {
    const { reading } = await look(claude(new FakeClaude(reply), "occupancy"));
    expect(reading.grid).toBeNull();
  });

  test("an unknown square or occupant in changes gives no grid", async () => {
    for (const change of [{ square: "i9", now: "white" }, { square: "e4", now: "purple" }]) {
      const reply = { board_visible: true, hand_over_board: false, changes: [change] };
      const { reading } = await look(claude(new FakeClaude(reply), "changes"));
      expect(reading.grid).toBeNull();
    }
  });

  test("a refusal is an error, not a crash", async () => {
    const { answer, reading } = await look(claude(new FakeClaude({}, "refusal"), "occupancy"));
    expect(answer.error).toBe("stop_reason refusal");
    expect(reading.grid).toBeNull();
  });
});

describe("GPT", () => {
  test("gets the same question through the Responses API", async () => {
    const client = new FakeOpenAI(E4_CHANGES);
    const { answer, reading } = await look(new GptVision(client as any, { strategy: "changes", model: "gpt-6.1-sol" }));
    expect(reading.grid?.equals(Grid.of(AFTER_E4))).toBe(true);
    expect(answer.model).toBe("gpt-6.1-sol");
    const params = client.calls[0];
    expect(params.reasoning).toEqual({ effort: "low" });
    expect(params.text.format.strict).toBe(true);
    expect(params.input[0].content.map((part: any) => part.type)).toEqual([
      "input_text",
      "input_image",
      "input_text",
      "input_image",
      "input_text",
    ]);
  });

  test.each([[new FakeOpenAI(E4_CHANGES, "incomplete")], [new FakeOpenAI(E4_CHANGES, "completed", true)]])(
    "unfinished or refused answers are errors",
    async (client) => {
      const { answer, reading } = await look(new GptVision(client as any, { strategy: "changes", model: "gpt-6.1-sol" }));
      expect(answer.error).toBeTruthy();
      expect(reading.grid).toBeNull();
    },
  );
});
