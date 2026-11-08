import { APIConnectionError, AuthenticationError } from "@typesafe-ai/sdk";
import { Chess } from "chess.js";
import sharp from "sharp";
import { describe, expect, test } from "vitest";

import type { Frame } from "../src/capture.js";
import { Gate, type GateAnswer, JEV_MAX_EDGE, fitForJev } from "../src/gate.js";
import { Tracker } from "../src/match.js";
import { ClaudeVision } from "../src/vision.js";
import { Watcher } from "../src/watch.js";
import { FakeClaude, FakeJev, occupancyReply } from "./fakes.js";
import { boardAfter } from "./games.js";

const jpeg = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 90, g: 120, b: 60 } } }).jpeg().toBuffer();

const answer = (overrides: Partial<GateAnswer> = {}): GateAnswer => ({
  readable: 0.95,
  hand: 0.02,
  changed: null,
  model: "jev-1.13.0",
  input_tokens: 5000,
  seconds: 0.3,
  error: null,
  ...overrides,
});

describe("Gate", () => {
  test("glasses frames are shrunk to Jev's limit", async () => {
    const fitted = await sharp(await fitForJev(await jpeg(1472, 1968))).metadata();
    expect(Math.max(fitted.width!, fitted.height!)).toBe(JEV_MAX_EDGE);
    const small = await jpeg(600, 800);
    expect(await fitForJev(small)).toBe(small);
  });

  test("changed is only asked with an earlier frame", async () => {
    const frame: Frame = { jpeg: await jpeg(600, 800), t: 0 };
    const jev = new FakeJev({ readable: 0.9, hand: 0.1, changed: 0.05 });
    const gate = new Gate(jev as any);
    expect((await gate.ask(frame)).changed).toBeNull();
    expect(Object.keys(jev.calls.at(-1)!.questions)).toEqual(["readable", "hand"]);
    expect(jev.calls.at(-1)!.state).toEqual({ current_frame: "<current_frame>" });
    expect((await gate.ask(frame, frame)).changed).toBe(0.05);
    expect(Object.keys(jev.calls.at(-1)!.assets).sort()).toEqual(["<current_frame>", "<earlier_frame>"]);
  });

  test("a Jev failure is an error, not a crash", async () => {
    const frame: Frame = { jpeg: await jpeg(600, 800), t: 0 };
    const gate = new Gate(new FakeJev({}, new APIConnectionError("offline")) as any);
    const result = await gate.ask(frame);
    expect(result.error).toBeTruthy();
    expect(gate.verdict(result, { maySkipUnchanged: true })).toBe("ask_claude");
  });

  test("any other failure, even a bad frame, sends the frame on to the model", async () => {
    const thrown = await new Gate(new FakeJev({}, new TypeError("boom")) as any).ask({ jpeg: await jpeg(600, 800), t: 0 });
    expect(thrown.error).toMatch(/boom/);
    const garbled = await new Gate(new FakeJev({ readable: 0.9, hand: 0 }) as any).ask({ jpeg: Buffer.from("not a jpeg"), t: 0 });
    expect(garbled.error).toBeTruthy();
  });

  test("a rejected key turns the pre-check off instead of failing on every frame", async () => {
    const frame: Frame = { jpeg: await jpeg(600, 800), t: 0 };
    const jev = new FakeJev({}, new AuthenticationError(401, { error: "invalid key" }, new Headers()));
    const gate = new Gate(jev as any);
    const first = await gate.ask(frame);
    expect(first.error).toMatch(/pre-check off/);
    expect(gate.verdict(first, { maySkipUnchanged: true })).toBe("ask_claude");
    expect((await gate.ask(frame)).error).toMatch(/pre-check off/);
    expect(jev.calls).toHaveLength(1); // it stopped asking
  });

  test.each([
    [answer({ readable: 0.6 }), true, "unreadable"],
    [answer({ hand: 0.9 }), true, "hand"],
    [answer({ changed: 0.05 }), true, "unchanged"],
    [answer({ changed: 0.05 }), false, "ask_claude"], // a move is being confirmed
    [answer({ changed: 0.4 }), true, "ask_claude"],
    [answer(), true, "ask_claude"], // nothing to compare with yet
  ] as [GateAnswer, boolean, string][])("verdict %#", (result, maySkip, verdict) => {
    expect(new Gate(new FakeJev() as any).verdict(result, { maySkipUnchanged: maySkip })).toBe(verdict);
  });
});

describe("Watcher", async () => {
  const FRAME: Frame = { jpeg: await jpeg(600, 800), t: 0 };
  const watcher = (jev: FakeJev, claude: FakeClaude, maxUnchangedSkips = 3) =>
    new Watcher(new Tracker(), new ClaudeVision(claude as any, { strategy: "occupancy" }), new Gate(jev as any), maxUnchangedSkips);

  test("a hand skips the vision model", async () => {
    const claude = new FakeClaude(occupancyReply(new Chess().fen()));
    const step = await watcher(new FakeJev({ readable: 0.95, hand: 0.99 }), claude).step(FRAME);
    expect([step.verdict, step.update.kind, claude.calls.length]).toEqual(["hand", "skipped", 0]);
  });

  test("unchanged frames skip the vision model, but not forever", async () => {
    const claude = new FakeClaude(occupancyReply(new Chess().fen()));
    const w = watcher(new FakeJev({ readable: 0.95, hand: 0.02, changed: 0.05 }), claude, 2);
    const verdicts = [];
    for (let i = 0; i < 5; i++) verdicts.push((await w.step(FRAME)).verdict);
    // The first frame has nothing to compare with; then two skips, a forced read, two skips.
    expect(verdicts).toEqual(["ask_claude", "unchanged", "unchanged", "ask_claude", "unchanged"]);
    expect(claude.calls).toHaveLength(2);
  });

  test("frames are never skipped while a move is being confirmed", async () => {
    const claude = new FakeClaude(occupancyReply(new Chess().fen()));
    const jev = new FakeJev({ readable: 0.95, hand: 0.02, changed: 0.05 });
    const w = watcher(jev, claude);
    expect((await w.step(FRAME)).update.kind).toBe("waiting"); // the start is confirmed: now a reference
    claude.reply = occupancyReply(boardAfter("e4").fen());
    jev.values.changed = 0.9;
    expect((await w.step(FRAME)).update.kind).toBe("seen");
    jev.values.changed = 0.05; // Jev wrongly thinks nothing changed...
    const update = (await w.step(FRAME)).update; // ...but e4 is being confirmed, so the model is asked anyway
    expect([update.kind, update.san]).toEqual(["committed", "e4"]);
  });
});
