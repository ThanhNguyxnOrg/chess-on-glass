import { Chess } from "chess.js";
import { describe, expect, test } from "vitest";

import type { Frame } from "../src/capture.js";
import { Grid, Tracker } from "../src/match.js";
import { type Answer, type Part, Vision } from "../src/vision.js";
import { Watcher } from "../src/watch.js";

// Fake frames carry the true occupancy (rows from rank 8 to rank 1) in place of JPEG bytes.
const frameOf = (fen: string, t: number): Frame => ({ jpeg: Buffer.from(JSON.stringify(Grid.of(fen).rows())), t });
const rowsOf = (part: Part) => JSON.parse((part as Frame).jpeg.toString()) as string[];
const WORD: Record<string, string> = { w: "white", b: "black", ".": "empty" };

const answer = (data: Record<string, unknown>): Answer => ({
  data,
  error: null,
  model: "fake",
  input_tokens: 0,
  output_tokens: 0,
  seconds: 0,
});

/**
 * The changes question, answered literally: the squares that differ between image 1 and image 2.
 * One real call to gpt-6.1-sol answered this way when the two disagreed with the written list.
 */
class LiteralChanges extends Vision {
  constructor() {
    super({ strategy: "changes", model: "fake" });
  }
  protected async call(parts: Part[]): Promise<Answer> {
    const [before, after] = [rowsOf(parts[1]!), rowsOf(parts[3]!)];
    const changes: { square: string; now: string }[] = [];
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        if (before[r]![f] !== after[r]![f]) changes.push({ square: `${"abcdefgh"[f]}${8 - r}`, now: WORD[after[r]![f]!]! });
      }
    }
    return answer({ board_visible: true, hand_over_board: false, changes });
  }
}

/** The occupancy question (one frame), answered perfectly. */
class Occupancy extends Vision {
  asked = 0;
  constructor() {
    super({ strategy: "occupancy", model: "fake" });
  }
  protected async call(parts: Part[]): Promise<Answer> {
    this.asked++;
    const rows = rowsOf(parts[0]!);
    return answer({ board_visible: true, hand_over_board: false, ...Object.fromEntries(rows.map((row, i) => [`rank${8 - i}`, row])) });
  }
}

/** Play `frames` (indexes into the positions after each of `moves`) and return what was committed. */
async function play(start: string, moves: string[], frames: number[], firstLook: Vision | null = new Occupancy()): Promise<string[]> {
  const board = new Chess(start);
  const fens = [board.fen(), ...moves.map((m) => (board.move(m), board.fen()))];
  const watcher = new Watcher(new Tracker(new Chess(start)), new LiteralChanges(), null, undefined, firstLook);
  const committed: string[] = [];
  for (const [t, i] of frames.entries()) {
    const step = await watcher.step(frameOf(fens[i]!, t));
    if (step.update.kind === "committed") committed.push(step.update.san!);
  }
  return committed;
}

const START = new Chess().fen();

describe("Watcher, changes strategy", () => {
  test("a slow game", async () => {
    expect(await play(START, ["e4", "e5", "Nf3", "Nc6"], [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4])).toEqual(["e4", "e5", "Nf3", "Nc6"]);
  });

  test("a reply made before the move was confirmed is still seen", async () => {
    // e5 lands one frame after e4: e4 commits on a frame that already shows e5
    expect(await play(START, ["e4", "e5", "Nf3", "Nc6"], [0, 0, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4])).toEqual(["e4", "e5", "Nf3", "Nc6"]);
  });

  test("a quick recapture on the same square", async () => {
    const afterE4D5 = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2";
    const moves = ["exd5", "Qxd5", "Nc3", "Qa5"];
    expect(await play(afterE4D5, moves, [0, 0, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4])).toEqual(moves);
  });

  test("the start is checked against the board, not a frame against itself", async () => {
    // e4 was already played when tracking started from the opening position
    expect(await play(START, ["e4", "e5"], [1, 1, 1, 2, 2, 2])).toEqual(["e4", "e5"]);
  });

  test("the first look is only used while there's no reference", async () => {
    const firstLook = new Occupancy();
    await play(START, ["e4"], [0, 0, 1, 1, 1], firstLook);
    expect(firstLook.asked).toBe(1); // the first frame confirms the start; the rest compare frames
  });

  test("forget() goes back to the first look", async () => {
    const firstLook = new Occupancy();
    const watcher = new Watcher(new Tracker(), new LiteralChanges(), null, undefined, firstLook);
    await watcher.step(frameOf(START, 0));
    expect(watcher.referenceFen).toBe(START);
    watcher.forget();
    await watcher.step(frameOf(START, 1));
    expect(firstLook.asked).toBe(2);
  });
});
