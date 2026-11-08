import { execFileSync } from "node:child_process";

import { Chess } from "chess.js";
import ffmpegPath from "ffmpeg-static";

import type { Suggestion } from "../src/engine.js";
import { Grid } from "../src/match.js";

type Params = Record<string, any>;

/** Stands in for Anthropic's client: records each request, answers with `reply` as JSON. */
export class FakeClaude {
  calls: [endpoint: "messages" | "beta", params: Params][] = [];
  messages = { create: async (params: Params) => this.create("messages", params) };
  beta = { messages: { create: async (params: Params) => this.create("beta", params) } };

  constructor(
    public reply: unknown,
    public stopReason = "end_turn",
  ) {}

  private create(endpoint: "messages" | "beta", params: Params) {
    this.calls.push([endpoint, params]);
    return {
      model: params.model,
      stop_reason: this.stopReason,
      usage: { input_tokens: 1500, output_tokens: 60 },
      content: [{ type: "text", text: JSON.stringify(this.reply) }],
    };
  }
}

/** Stands in for OpenAI's Responses API. */
export class FakeOpenAI {
  calls: Params[] = [];
  responses = { create: async (params: Params) => this.create(params) };

  constructor(
    public reply: unknown,
    public status = "completed",
    public refuse = false,
  ) {}

  private create(params: Params) {
    this.calls.push(params);
    const text = JSON.stringify(this.reply);
    const part = this.refuse ? { type: "refusal", refusal: "no" } : { type: "output_text", text };
    return {
      model: params.model,
      status: this.status,
      usage: { input_tokens: 3000, output_tokens: 200 },
      output: [{ type: "message", content: [part] }],
      output_text: text,
    };
  }
}

/** Stands in for TypeSafe's client: answers each Noul with `values[name]` (or throws `error`). */
export class FakeJev {
  calls: Params[] = [];

  constructor(
    public values: Record<string, number> = {},
    public error: Error | null = null,
  ) {}

  async systemOne(request: Params) {
    this.calls.push(request);
    if (this.error) throw this.error;
    const answers = Object.fromEntries(Object.keys(request.questions).map((name) => [name, { type: "noul", noul: this.values[name] }]));
    return { model: "jev-1.13.0", answers, usage: { input_tokens: 5000 * Object.keys(request.state).length, output_tokens: 0 } } as any;
  }
}

/** Suggests the first of `preferred` (SAN) that's legal, otherwise the first legal move. */
export class FakeEngine {
  asked: string[] = [];

  constructor(public preferred: string[] = []) {}

  async best(fen: string): Promise<Suggestion> {
    this.asked.push(fen);
    const board = new Chess(fen);
    let move = board.moves({ verbose: true })[0].lan;
    for (const san of this.preferred) {
      try {
        move = new Chess(fen).move(san).lan;
        break;
      } catch {
        // not legal here: try the next one
      }
    }
    return { move, score: { cp: 30 } };
  }
}

/** What a perfect occupancy read of a position looks like. */
export function occupancyReply(fen: string, { visible = true, hand = false } = {}): Record<string, unknown> {
  const rows = Grid.of(fen).rows();
  return {
    board_visible: visible,
    hand_over_board: hand,
    ...Object.fromEntries(rows.map((row, i) => [`rank${8 - i}`, row])),
  };
}

/** A tiny synthetic video, `seconds` long. */
export function makeVideo(path: string, seconds = 3, fps = 10): string {
  execFileSync(ffmpegPath as unknown as string, [
    ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"],
    ...["-i", `testsrc=duration=${seconds}:size=320x240:rate=${fps}`, "-c:v", "mpeg4", path],
  ]);
  return path;
}
