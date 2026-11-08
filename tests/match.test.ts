import { Chess } from "chess.js";
import { describe, expect, test } from "vitest";

import { Grid, type Reading, Tracker, match, rank, roundHalfEven } from "../src/match.js";
import { OPERA, boardAfter, boardFrom } from "./games.js";

const START_ROWS = ["bbbbbbbb", "bbbbbbbb", "........", "........", "........", "........", "wwwwwwww", "wwwwwwww"];
const PROMOTION = "8/4P3/8/8/8/8/k7/4K3 w - - 0 1";
const START = new Chess().fen();

const seen = (board: Chess): Reading => ({ boardVisible: true, handOverBoard: false, grid: Grid.of(board.fen()) });
const seenRows = (rows: string[]): Reading => ({ boardVisible: true, handOverBoard: false, grid: Grid.fromRows(rows) });
const kinds = (tracker: Tracker, readings: Reading[]) => readings.map((r) => tracker.update(r).kind);

describe("Grid", () => {
  test("rows round trip", () => {
    const grid = Grid.of(START);
    expect(grid.rows()).toEqual(START_ROWS);
    expect(Grid.fromRows(START_ROWS).equals(grid)).toBe(true);
  });

  test("unknown squares are not counted", () => {
    const rows = [...START_ROWS];
    rows[3] = "????????";
    expect(Grid.fromRows(rows).known).toBe(56);
  });

  test.each([[START_ROWS.slice(0, 7)], [[...START_ROWS.slice(0, 7), "wwwwwww"]], [[...START_ROWS.slice(0, 7), "wwwwwwwx"]]])(
    "malformed rows are rejected: %j",
    (rows) => {
      expect(() => Grid.fromRows(rows)).toThrow();
    },
  );
});

describe("match", () => {
  test("a seen move is matched", () => {
    const found = match(START, Grid.of(boardAfter("e4").fen()));
    expect([found.kind, found.move?.lan, found.margin]).toEqual(["move", "e2e4", 2]);
  });

  test("an unchanged board is no change", () => {
    expect(match(START, Grid.of(START)).kind).toBe("no_change");
  });

  test("misreads away from the move are tolerated", () => {
    const grid = Grid.of(boardAfter("e4").fen()).set("h5", "b").set("a6", "w");
    const found = match(START, grid);
    expect([found.kind, found.move?.lan]).toEqual(["move", "e2e4"]);
  });

  test("a hidden destination is weaker evidence", () => {
    const rows = Grid.of(boardAfter("e4").fen()).rows();
    rows[4] = "....?..."; // rank 4: e4 can't be seen, so only the empty e2 and e3 tell
    const found = match(START, Grid.fromRows(rows));
    expect([found.kind, found.move?.lan, found.margin]).toEqual(["move", "e2e4", 1]);
  });

  test("nonsense is no match", () => {
    const rows = Array.from({ length: 4 }, () => ["wbwbwbwb", "bwbwbwbw"]).flat();
    expect(match(START, Grid.fromRows(rows)).kind).toBe("no_match");
  });

  test.each([
    [["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"], "O-O", START, "e1g1"],
    [["e4", "a6", "e5", "d5"], "exd6", START, "e5d6"],
    [[], "e8=Q", PROMOTION, "e7e8q"],
  ] as [string[], string, string, string][])("special moves are matched: %j %s", (before, san, fen, expected) => {
    const board = boardFrom(fen, ...before);
    const found = match(board.fen(), Grid.of(boardFrom(fen, ...before, san).fen()));
    expect([found.kind, found.move?.lan]).toEqual(["move", expected]);
  });

  test("promotions to different pieces count once, as a queen", () => {
    const candidates = rank(PROMOTION, Grid.unknown());
    expect(candidates.filter((c) => c.move?.promotion).map((c) => c.move?.lan)).toEqual(["e7e8q"]);
  });

  test("halves round to even, like Python", () => {
    expect([roundHalfEven(4.5), roundHalfEven(5.5), roundHalfEven(9.6), roundHalfEven(2.4)]).toEqual([4, 6, 10, 2]);
  });
});

describe("Tracker", () => {
  test("two clear frames commit a move", () => {
    const tracker = new Tracker();
    const reading = seen(boardAfter("e4"));
    expect(tracker.update(reading).kind).toBe("seen");
    const update = tracker.update(reading);
    expect([update.kind, update.san]).toEqual(["committed", "e4"]);
    expect(tracker.board.fen()).toBe(boardAfter("e4").fen());
  });

  test("murky frames add up more slowly", () => {
    const rows = Grid.of(boardAfter("Nf3").fen()).rows();
    rows[5] = ".....?.."; // rank 3 with f3 hidden: Nf3 still fits best, by 1
    const murky = seenRows(rows);
    expect(kinds(new Tracker(), [murky, murky, murky])).toEqual(["seen", "seen", "committed"]);
  });

  test("a tie pauses the count", () => {
    const rows = Grid.of(boardAfter("e4").fen()).rows();
    [rows[4], rows[5], rows[6]] = ["....?...", "....?...", "wwww?www"]; // e2, e3 and e4 all hidden
    const tie = seenRows(rows);
    expect(match(START, tie.grid!).kind).toBe("tie");
    const clear = seen(boardAfter("e4"));
    expect(kinds(new Tracker(), [clear, tie, clear])).toEqual(["seen", "waiting", "committed"]);
  });

  test("a hand over the board pauses the count", () => {
    const reading = seen(boardAfter("e4"));
    const hand: Reading = { ...reading, handOverBoard: true };
    expect(kinds(new Tracker(), [reading, hand, reading])).toEqual(["seen", "skipped", "committed"]);
  });

  test("a different best fit restarts the count", () => {
    const e4 = seen(boardAfter("e4"));
    const d4 = seen(boardAfter("d4"));
    expect(kinds(new Tracker(), [e4, d4, e4, e4])).toEqual(["seen", "seen", "seen", "committed"]);
  });

  test("a loose fit can't commit, and six of them in a row are lost", () => {
    // the board is six moves ahead of the tracker: the best fit is still 9 squares off
    const ahead = seen(boardAfter("e4", "e5", "Nf3", "Nc6", "Bb5", "a6"));
    const tracker = new Tracker();
    expect(kinds(tracker, Array(6).fill(ahead))).toEqual(["waiting", "waiting", "waiting", "waiting", "waiting", "lost"]);
    expect(tracker.board.fen()).toBe(START); // nothing was committed on a guess
  });

  test("a couple of misread squares still confirm a move", () => {
    const rows = Grid.of(boardAfter("e4").fen()).rows();
    rows[0] = "bbbbbbb."; // h8 misread as empty
    rows[5] = "w......."; // a3 misread as white
    const noisy = seenRows(rows);
    expect(kinds(new Tracker(), [noisy, noisy])).toEqual(["seen", "committed"]);
  });

  test("a missed recapture is caught one move at a time", () => {
    // Black took on f3 and White recaptured before any frame showed the board in between. On its
    // own the capture doesn't fit (f3 is still white), so it's found by looking one reply ahead,
    // which costs evidence: it takes three frames instead of two.
    const before = OPERA.slice(0, OPERA.indexOf("Bxf3"));
    const tracker = new Tracker(boardAfter(...before));
    const reading = seen(boardAfter(...before, "Bxf3", "Qxf3"));
    const updates = Array.from({ length: 5 }, () => tracker.update(reading));
    expect(updates.map((u) => u.kind)).toEqual(["seen", "seen", "committed", "seen", "committed"]);
    expect(updates.filter((u) => u.san).map((u) => u.san)).toEqual(["Bxf3", "Qxf3"]);
  });

  test("the tracker is lost when nothing fits", () => {
    const tracker = new Tracker(undefined, { lostAfter: 3 });
    const nonsense = seenRows(Array.from({ length: 4 }, () => ["wbwbwbwb", "bwbwbwbw"]).flat());
    expect(kinds(tracker, [nonsense, nonsense, nonsense])).toEqual(["waiting", "waiting", "lost"]);
    expect(tracker.lost).toBe(true);
  });

  test("the Opera Game is followed move by move", () => {
    const tracker = new Tracker();
    const truth = new Chess();
    for (const san of OPERA) {
      truth.move(san);
      const first = tracker.update(seen(truth));
      const second = tracker.update(seen(truth));
      expect([first.kind, second.kind, second.san]).toEqual(["seen", "committed", san]);
    }
    expect(tracker.board.fen()).toBe(truth.fen());
    expect(tracker.board.isCheckmate()).toBe(true);
  });

  test("reset keeps its own copy of the board", () => {
    const board = boardAfter("e4");
    const tracker = new Tracker(board);
    board.move("e5");
    expect(tracker.board.history()).toEqual(["e4"]);
  });
});
