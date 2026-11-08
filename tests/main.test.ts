import { Chess } from "chess.js";
import { describe, expect, test } from "vitest";

import type { Frame, Source } from "../src/capture.js";
import { Events } from "../src/events.js";
import { Game, bar, scoreText } from "../src/main.js";
import { ClaudeVision } from "../src/vision.js";
import { FakeClaude, FakeEngine, occupancyReply } from "./fakes.js";
import { boardAfter, boardFrom } from "./games.js";

const FRAME: Frame = { jpeg: Buffer.from("frame"), t: 0 };
const noSource: Source = { grab: async () => null, finished: false };

class FakeSpeaker {
  lines: string[] = [];
  cleared = 0;
  say(text: string): void {
    this.lines.push(text);
  }
  clear(): void {
    this.cleared++;
  }
}

/** A FakeEngine that fails the first `failures` times it's asked. */
class FlakyEngine extends FakeEngine {
  constructor(
    preferred: string[],
    public failures: number,
  ) {
    super(preferred);
  }
  override async best(fen: string) {
    if (this.failures-- > 0) throw new Error("Stockfish quit unexpectedly.");
    return super.best(fen);
  }
}

function game({
  myColor = "b" as "w" | "b",
  start = new Chess(),
  preferred = ["e5"],
  maxCost = 10,
  engine = null as FakeEngine | null,
} = {}) {
  const claude = new FakeClaude(occupancyReply(start.fen()));
  const speaker = new FakeSpeaker();
  const g = new Game(noSource, {
    vision: new ClaudeVision(claude as any, { strategy: "occupancy", model: "claude-opus-5-5" }),
    engine: engine ?? new FakeEngine(preferred),
    speaker,
    events: new Events(),
    myColor,
    start,
    maxCost,
  });
  return { g, claude, speaker };
}

async function show(g: Game, claude: FakeClaude, board: Chess, times = 2): Promise<void> {
  claude.reply = occupancyReply(board.fen());
  for (let i = 0; i < times; i++) await g.onFrame(FRAME);
}

const kinds = (g: Game) => g.events.recent().filter((e) => e.kind !== "frame").map((e) => e.kind);
const snapshot = (g: Game) => g.snapshot() as Record<string, any>;

describe("Game", () => {
  test("a game as black", async () => {
    const { g, claude, speaker } = game();
    await show(g, claude, new Chess(), 1);
    expect(speaker.lines).toEqual(["Ready. You're black. Waiting for white."]);
    expect(snapshot(g).status).toBe("Waiting for opponent");

    await show(g, claude, boardAfter("e4")); // the opponent plays e4: confirmed on the second frame
    expect(speaker.lines.at(-1)).toBe("Pawn to e5");
    expect(snapshot(g).status).toBe("Your move");
    expect(snapshot(g).suggestion.san).toBe("e5");

    await show(g, claude, boardAfter("e4", "e5")); // I play the suggestion
    expect(snapshot(g).moves).toBe("1. e4 e5");
    expect(snapshot(g).status).toBe("Waiting for opponent");
    expect(snapshot(g).suggestion).toBeNull();
    expect(kinds(g)).toEqual(["ready", "commit", "suggest", "commit"]);
  });

  test("as white, the first move comes right away", async () => {
    const { g, claude, speaker } = game({ myColor: "w", preferred: ["e4"] });
    await show(g, claude, new Chess(), 1);
    expect(speaker.lines).toEqual(["Ready. You're white.", "Pawn to e4"]);
  });

  test("a game joined midway", async () => {
    const start = new Chess("2b5/1p3k1p/8/ppB5/8/8/PPP3PP/3RR1K1 w - - 0 1");
    const { g, claude, speaker } = game({ start, preferred: ["Kg6"] });
    await show(g, claude, start, 1);
    const played = new Chess(start.fen());
    played.move("Rf1");
    await show(g, claude, played);
    expect(snapshot(g).moves).toBe("1. Rf1+");
    expect(speaker.lines.at(-1)).toBe("King to g6");
  });

  test("controls: undo and entering moves", async () => {
    const { g, claude, speaker } = game();
    await show(g, claude, new Chess(), 1);
    await show(g, claude, boardAfter("e4"));
    expect(g.control({ action: "fly" })).toBe('unknown action "fly"');
    expect(g.control({ action: "new_game", color: "green" })).toBe("color must be white or black");
    expect(g.control({ action: "new_game", color: "white", fen: "not a fen" })).toMatch(/^bad FEN/);
    expect(g.control({ action: "undo" })).toBeNull();
    await g.applyControls();
    expect([snapshot(g).moves, snapshot(g).turn]).toEqual(["", "white"]);
    expect(speaker.cleared).toBe(1); // lines queued for the undone position are dropped

    g.control({ action: "move", move: "d4" });
    await g.applyControls();
    expect(snapshot(g).moves).toBe("1. d4");
    expect(speaker.lines.at(-1)).toBe("Pawn to e5");

    g.control({ action: "move", move: "Ke2" }); // not legal for Black
    await g.applyControls();
    expect(g.events.recent().at(-1)?.kind).toBe("error");
  });

  test("checkmate ends the game", async () => {
    const start = boardAfter("f3", "e5", "g4");
    const { g, claude, speaker } = game({ start, preferred: ["Qh4#"] });
    await show(g, claude, start, 1);
    expect(speaker.lines.at(-1)).toBe("Queen to h4, checkmate");
    g.control({ action: "move", move: "Qh4#" });
    await g.applyControls();
    expect(speaker.lines.at(-1)).toBe("Checkmate. You win.");
    expect(snapshot(g).status).toBe("Game over");
  });

  test("spending past the cap pauses", async () => {
    const { g, claude, speaker } = game({ maxCost: 0.0001 });
    await show(g, claude, new Chess(), 1);
    expect(g.paused).toBe(true);
    expect(speaker.lines.at(-1)).toBe("Spending limit reached. Paused.");
  });

  test("the board, last move and suggestion arrow reach the snapshot", async () => {
    const { g, claude } = game();
    await show(g, claude, new Chess(), 1);
    await show(g, claude, boardAfter("e4"));
    const svg = snapshot(g).board_svg as string;
    expect(svg).toMatch(/class="square e4"[^>]*fill="#cdd16a"/);
    expect(svg).toContain('class="arrow"');
  });

  test("the first suggestion is said once when the board has already moved", async () => {
    const { g, claude, speaker } = game(); // tracking from the opening position, as black...
    await show(g, claude, boardAfter("e4")); // ...but White has already played e4
    expect(speaker.lines).toEqual(["Ready. You're black.", "Pawn to e5"]);
  });

  test("no suggestion for a position the wearer has already moved on from", async () => {
    // after 1.e4 d5, White takes and the wearer (Black) retakes before the capture is confirmed
    const start = boardAfter("e4", "d5");
    const { g, claude, speaker } = game({ start, preferred: ["Qxd5"] });
    await show(g, claude, start, 1);
    await show(g, claude, boardFrom(start.fen(), "exd5"), 1);
    await show(g, claude, boardFrom(start.fen(), "exd5", "Qxd5"), 3);
    expect(snapshot(g).moves).toBe("2. exd5 Qxd5");
    expect(speaker.lines).toEqual(["Ready. You're black. Waiting for white."]); // never "Queen takes d5"
  });

  test("a Stockfish failure is reported, said once, and tried again on the next frame", async () => {
    const { g, claude, speaker } = game({ engine: new FlakyEngine(["e5"], 2) });
    await show(g, claude, new Chess(), 1);
    await show(g, claude, boardAfter("e4")); // e4 is committed, and Stockfish fails
    expect(kinds(g)).toContain("error");
    expect(speaker.lines.at(-1)).toBe("Something went wrong. Still trying.");
    await show(g, claude, boardAfter("e4"), 1); // it fails again: not said again
    expect(speaker.lines.filter((line) => line.startsWith("Something went wrong"))).toHaveLength(1);
    await show(g, claude, boardAfter("e4"), 1); // and works
    expect(speaker.lines.at(-1)).toBe("Pawn to e5");
    expect(snapshot(g).suggestion.san).toBe("e5");
  });

  test("a frame that fails doesn't end the game", async () => {
    let grabs = 0;
    const source: Source = {
      finished: false,
      grab: async () => {
        if (++grabs === 1) throw new Error("screencapture failed");
        return FRAME;
      },
    };
    const claude = new FakeClaude(occupancyReply(new Chess().fen()));
    const speaker = new FakeSpeaker();
    const g = new Game(source, {
      vision: new ClaudeVision(claude as any, { strategy: "occupancy", model: "claude-opus-5-5" }),
      engine: new FakeEngine(),
      speaker,
      events: new Events(),
      myColor: "b",
      pace: { opponent: 0, mine: 0 },
    });
    const stop = new AbortController();
    g.events.subscribe((event) => event.kind === "ready" && stop.abort());
    await g.run(stop.signal);
    expect(kinds(g)).toEqual(["error", "ready"]);
    expect(speaker.lines).toEqual(["Something went wrong. Still trying.", "Ready. You're black. Waiting for white."]);
  });
});

test("scores read from the player's side", () => {
  expect(scoreText({ cp: 1190 }, "w")).toBe("+11.9");
  expect(scoreText({ cp: 1190 }, "b")).toBe("-11.9");
  expect(scoreText({ cp: 0 }, "w")).toBe("+0.0");
  expect(scoreText({ mate: 2 }, "w")).toBe("mate in 2");
  expect(scoreText({ mate: 2 }, "b")).toBe("mated in 2");
  expect([bar({ mate: 3 }), bar({ mate: -1 }), bar({ cp: 0 })]).toEqual([1, 0, 0.5]);
});
