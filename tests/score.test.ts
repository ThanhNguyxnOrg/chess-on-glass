/** The eval end to end on a tiny synthetic video, with a fake vision model. */

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Chess } from "chess.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { type Deps, main } from "../evals/score.js";
import { ClaudeVision } from "../src/vision.js";
import { FakeClaude, FakeJev, makeVideo, occupancyReply } from "./fakes.js";

let tmp: string;
let client: FakeClaude;
let deps: Partial<Deps>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "chesshacker-test-"));
  client = new FakeClaude(occupancyReply(new Chess().fen())); // the starting position, every time
  deps = {
    out: join(tmp, "out"),
    cache: join(tmp, ".cache"),
    makeVision: (model, options) => new ClaudeVision(client as any, { ...options, model }),
    checkVisionKey: async () => ({ ok: true, name: "key", detail: "fake" }),
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => vi.restoreAllMocks());

async function run(...args: string[]): Promise<Record<string, any>> {
  expect(await main(args, deps)).toBe(0);
  const latest = readdirSync(deps.out!).sort().at(-1)!;
  return JSON.parse(readFileSync(join(deps.out!, latest, "summary.json"), "utf8"));
}

test("scoring a recording caches answers", async () => {
  const video = makeVideo(join(tmp, "game.mp4"));
  const args = [video, "--color", "white", "--every", "1", "--strategy", "occupancy", "--model", "claude-opus-5-5"];

  const first = await run(...args);
  expect([first.vision.answers, first.vision.cached]).toEqual([3, 0]);
  expect([first.correct, first.not_reached]).toEqual([0, 33]);
  expect(first.new_spend).toBeGreaterThan(0);
  expect(client.calls).toHaveLength(3);

  const second = await run(...args);
  expect([second.vision.answers, second.vision.cached, second.new_spend]).toEqual([3, 3, 0]);
  expect(client.calls).toHaveLength(3); // nothing new was asked
});

test("the Jev pre-check skips frames", async () => {
  deps.typesafeClient = () => new FakeJev({ readable: 0.95, hand: 0.02, changed: 0.05 }) as any;
  deps.checkJev = async () => ({ ok: true, name: "Jev", detail: "fake" });
  const video = makeVideo(join(tmp, "game.mp4"));

  const summary = await run(video, "--color", "white", "--every", "1", "--strategy", "occupancy", "--model", "claude-opus-5-5", "--gate");
  expect(summary.verdicts).toEqual({ ask_claude: 1, unchanged: 2 });
  expect([summary.jev.answers, summary.vision.answers]).toEqual([3, 1]);
});

test("a simulated game with clean readings is scored perfectly", async () => {
  const summary = await run("--simulate", "--noise", "0", "--unknown", "0");
  expect([summary.correct, summary.plies, summary.wrong, summary.missed]).toEqual([33, 33, [], []]);
});

test("a missing key stops the eval with the fix", async () => {
  deps.checkVisionKey = async () => ({ ok: false, name: "OpenAI API key", detail: "none found", fix: "Run setup." });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await main([makeVideo(join(tmp, "game.mp4")), "--color", "white"], deps)).toBe(1);
  expect(errors).toHaveBeenCalledWith("OpenAI API key: none found.\n→ Run setup.");
});

test("a video needs --color, and the model needs a price", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await main(["clip.mov"], deps)).toBe(2);
  expect(await main(["clip.mov", "--color", "white", "--model", "mystery-model"], deps)).toBe(2);
  expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([
    expect.stringContaining("give a video and --color"),
    expect.stringContaining("no price for mystery-model"),
  ]);
});
