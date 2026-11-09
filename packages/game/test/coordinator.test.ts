import { describe, expect, it } from "vitest";
import { ChessState } from "@chessonglass/chess";
import {
  newSessionId,
  newSourceId,
  type GamePosition,
  type SessionId
} from "@chessonglass/contracts";
import {
  CostLedger,
  SourceSlot,
  type GameSnapshot
} from "@chessonglass/game";
import {
  createHarness,
  fenAfter,
  flushTurns,
  makeFrame,
  ManualSource,
  observationFor,
  positionAfter,
  squareIndex,
  startPosition,
  StuckSource,
  until
} from "./support/coordinator-fakes.js";

const PROMOTION_FEN = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
const MATE_FEN = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1";
const ALL_SQUARES = Array.from({ length: 64 }, (_, square) => square);

function fenOf(fen: string, moves: readonly string[] = []): string {
  const state = ChessState.fromConfirmed({ fen, history: moves });
  return state.position().fen;
}

describe("GameCoordinator normal play", () => {
  it("starts a confirmed game, persists version 0 and publishes the initial state", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());

    const snapshot = h.coordinator.snapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.positionVersion).toBe(0);
    expect(snapshot.position?.history).toEqual([]);
    expect(snapshot.error).toBeNull();

    expect(h.store.appends).toHaveLength(1);
    expect(h.store.appends[0]).toMatchObject({
      sessionId: snapshot.sessionId,
      positionVersion: 0
    });
    expect(h.sink.results).toHaveLength(1);
    expect(h.sink.results[0]?.status).toBe("ready");

    await h.coordinator.close();
  });

  it("requires explicit confirmation for a mid-game position and reads nothing before it", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, null);
    expect(h.coordinator.snapshot().status).toBe("needs-position");

    const sessionId = h.coordinator.snapshot().sessionId;
    h.source.push(makeFrame(sessionId, newSourceId(), 1n));
    await flushTurns();
    expect(h.reader.calls).toHaveLength(0);
    expect(h.advisor.calls).toHaveLength(0);
    expect(h.store.appends).toHaveLength(0);

    await h.coordinator.dispatch({
      type: "confirm-position",
      position: positionAfter(["e2e4", "e7e5"])
    });

    const snapshot = h.coordinator.snapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.position?.history).toEqual(["e2e4", "e7e5"]);
    expect(snapshot.positionVersion).toBe(1);

    h.source.push(makeFrame(sessionId, newSourceId(), 2n));
    await until(() => h.reader.calls.length === 1, "read after confirmation");

    await h.coordinator.close();
  });

  it("auto-commits after two fresh agreeing observations and suggests the reply", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    const sessionId = h.coordinator.snapshot().sessionId;

    await until(() => h.advisor.calls.length === 1, "initial suggestion request");
    h.advisor.resolveBest(0, "e2e4");
    await until(
      () => h.coordinator.snapshot().suggestion?.moveUci === "e2e4",
      "initial suggestion"
    );

    const observed = fenAfter(["e2e4"]);
    h.source.push(makeFrame(sessionId, newSourceId(), 1n));
    await until(() => h.reader.calls.length === 1, "first read");
    h.reader.settleWithMove(0, observed);
    await until(
      () => h.coordinator.snapshot().status === "waiting",
      "waiting for a corroborating frame"
    );

    h.source.push(makeFrame(sessionId, newSourceId(), 2n));
    await until(() => h.reader.calls.length === 2, "second read");
    h.reader.settleWithMove(1, observed);

    await until(
      () => h.coordinator.snapshot().position?.history.length === 1,
      "move committed"
    );
    const snapshot = h.coordinator.snapshot();
    expect(snapshot.position?.history).toEqual(["e2e4"]);
    expect(snapshot.positionVersion).toBe(1);
    expect(snapshot.suggestion).toBeNull();
    expect(h.store.appends.map((record) => record.positionVersion)).toEqual([0, 1]);

    await until(() => h.advisor.calls.length === 2, "reply suggestion request");
    h.advisor.resolveBest(1, "e7e5");
    await until(
      () => h.coordinator.snapshot().suggestion?.moveUci === "e7e5",
      "reply suggestion"
    );
    expect(h.coordinator.snapshot().suggestion?.context.positionVersion).toBe(1);

    await h.coordinator.close();
  });

  it("asks for confirmation when fresh readings tie, and a manual move resolves it", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    const sessionId = h.coordinator.snapshot().sessionId;
    await until(() => h.advisor.calls.length === 1, "initial suggestion request");
    h.advisor.resolveBest(0, "g1f3");
    await until(() => h.coordinator.snapshot().suggestion !== null, "initial suggestion");

    // e2 is visibly empty and a2 is still a white pawn; the pawn on e2 could
    // have advanced one or two squares, so the move is ambiguous.
    const hide = ALL_SQUARES.filter(
      (square) => square !== squareIndex("a2") && square !== squareIndex("e2")
    );
    const ambiguous = "4k3/8/8/8/8/8/P7/4K3 w - - 0 1";

    h.source.push(makeFrame(sessionId, newSourceId(), 1n));
    await until(() => h.reader.calls.length === 1, "first read");
    h.reader.settleWithMove(0, ambiguous, hide);
    await until(() => h.coordinator.snapshot().status === "waiting", "waiting");

    h.source.push(makeFrame(sessionId, newSourceId(), 2n));
    await until(() => h.reader.calls.length === 2, "second read");
    h.reader.settleWithMove(1, ambiguous, hide);

    await until(
      () => h.coordinator.snapshot().status === "confirming",
      "confirmation asked"
    );
    expect(h.coordinator.snapshot().position?.history).toEqual([]);
    expect(h.coordinator.snapshot().error).not.toBeNull();

    await h.coordinator.dispatch({ type: "manual-move", uci: "e2e4" });
    const snapshot = h.coordinator.snapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.position?.history).toEqual(["e2e4"]);
    expect(snapshot.positionVersion).toBe(1);

    await h.coordinator.close();
  });

  it("offers a promotion choice when the observation cannot name the piece", async () => {
    const h = createHarness();
    await h.coordinator.start(
      h.source,
      ChessState.fromConfirmed({ fen: PROMOTION_FEN }).position()
    );
    const sessionId = h.coordinator.snapshot().sessionId;
    await until(() => h.advisor.calls.length === 1, "initial suggestion request");
    h.advisor.resolveBest(0, "a7a8q");
    await until(() => h.coordinator.snapshot().suggestion !== null, "initial suggestion");

    // a7 is visibly empty while a8 is hidden: all four promotions tie.
    const hide = ALL_SQUARES.filter(
      (square) => square !== squareIndex("a7") && square !== squareIndex("e1")
    );
    const emptyRank = "4k3/8/8/8/8/8/8/4K3 w - - 0 1";

    h.source.push(makeFrame(sessionId, newSourceId(), 1n));
    await until(() => h.reader.calls.length === 1, "first read");
    h.reader.settleWithMove(0, emptyRank, hide);
    await until(() => h.coordinator.snapshot().status === "waiting", "waiting");

    h.source.push(makeFrame(sessionId, newSourceId(), 2n));
    await until(() => h.reader.calls.length === 2, "second read");
    h.reader.settleWithMove(1, emptyRank, hide);
    await until(
      () => h.coordinator.snapshot().status === "confirming",
      "promotion confirmation asked"
    );

    await h.coordinator.dispatch({ type: "choose-promotion", promotion: "q" });
    const snapshot = h.coordinator.snapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.position?.history).toEqual(["a7a8q"]);

    await h.coordinator.close();
  });

  it("rejects a promotion choice when no promotion is pending", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    await until(() => h.advisor.calls.length === 1, "initial suggestion request");
    h.advisor.resolveBest(0, "e2e4");
    await until(() => h.coordinator.snapshot().suggestion !== null, "initial suggestion");

    await h.coordinator.dispatch({ type: "choose-promotion", promotion: "q" });
    expect(h.coordinator.snapshot().error).toMatch(/promotion/i);
    expect(h.coordinator.snapshot().position?.history).toEqual([]);
    expect(h.coordinator.snapshot().positionVersion).toBe(0);

    await h.coordinator.close();
  });

  it("rejects an illegal engine suggestion", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    await until(() => h.advisor.calls.length === 1, "suggestion request");

    h.advisor.resolveBest(0, "e2e5");
    await until(() => h.coordinator.snapshot().error !== null, "illegal suggestion rejected");

    expect(h.coordinator.snapshot().suggestion).toBeNull();
    expect(h.coordinator.snapshot().error).toMatch(/illegal/i);
    expect(h.coordinator.snapshot().positionVersion).toBe(0);

    await h.coordinator.close();
  });

  it("lets the user play a different legal move than the suggestion", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    await until(() => h.advisor.calls.length === 1, "initial suggestion request");
    h.advisor.resolveBest(0, "e2e4");
    await until(
      () => h.coordinator.snapshot().suggestion?.moveUci === "e2e4",
      "initial suggestion"
    );

    await h.coordinator.dispatch({ type: "manual-move", uci: "d2d4" });
    expect(h.coordinator.snapshot().position?.history).toEqual(["d2d4"]);
    expect(h.coordinator.snapshot().suggestion).toBeNull();

    await until(() => h.advisor.calls.length === 2, "reply suggestion request");
    h.advisor.resolveBest(1, "g8f6");
    await until(
      () => h.coordinator.snapshot().suggestion?.moveUci === "g8f6",
      "reply suggestion"
    );

    await h.coordinator.close();
  });

  it("stops new paid work once the game is over", async () => {
    const h = createHarness();
    await h.coordinator.start(
      h.source,
      ChessState.fromConfirmed({ fen: MATE_FEN }).position()
    );
    const sessionId = h.coordinator.snapshot().sessionId;
    await until(() => h.advisor.calls.length === 1, "initial suggestion request");
    h.advisor.resolveBest(0, "a1a8");
    await until(() => h.coordinator.snapshot().suggestion !== null, "initial suggestion");

    const mate = fenOf(MATE_FEN, ["a1a8"]);
    h.source.push(makeFrame(sessionId, newSourceId(), 1n));
    await until(() => h.reader.calls.length === 1, "first read");
    h.reader.settleWithMove(0, mate);
    await until(() => h.coordinator.snapshot().status === "waiting", "waiting");

    h.source.push(makeFrame(sessionId, newSourceId(), 2n));
    await until(() => h.reader.calls.length === 2, "second read");
    h.reader.settleWithMove(1, mate);

    await until(() => h.coordinator.snapshot().status === "finished", "game finished");
    expect(h.coordinator.snapshot().position?.history).toEqual(["a1a8"]);
    expect(h.advisor.calls).toHaveLength(1);

    h.source.push(makeFrame(sessionId, newSourceId(), 3n));
    await flushTurns();
    expect(h.reader.calls).toHaveLength(2);

    await h.coordinator.close();
  });

  it("undoes a committed move, clears the suggestion and persists the new version", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    await until(() => h.advisor.calls.length === 1, "initial suggestion request");
    h.advisor.resolveBest(0, "e2e4");
    await until(() => h.coordinator.snapshot().suggestion !== null, "initial suggestion");

    await h.coordinator.dispatch({ type: "manual-move", uci: "e2e4" });
    await until(() => h.advisor.calls.length === 2, "suggestion for the reply");

    await h.coordinator.dispatch({ type: "undo" });
    const snapshot = h.coordinator.snapshot();
    expect(snapshot.position?.history).toEqual([]);
    expect(snapshot.positionVersion).toBe(2);
    expect(snapshot.suggestion).toBeNull();
    expect(snapshot.status).toBe("ready");
    expect(h.store.appends.map((record) => record.positionVersion)).toEqual([0, 1, 2]);
    expect(h.sink.clears.length).toBeGreaterThan(0);

    await until(() => h.advisor.calls.length === 3, "suggestion after undo");

    await h.coordinator.close();
  });

  it("new-game rotates the session and resets to version 0", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    const firstSession = h.coordinator.snapshot().sessionId;
    await until(() => h.advisor.calls.length === 1, "initial suggestion request");
    h.advisor.resolveBest(0, "e2e4");
    await h.coordinator.dispatch({ type: "manual-move", uci: "d2d4" });

    await h.coordinator.dispatch({ type: "new-game", initial: null });
    const snapshot = h.coordinator.snapshot();
    expect(snapshot.sessionId).not.toBe(firstSession);
    expect(snapshot.position?.history).toEqual([]);
    expect(snapshot.positionVersion).toBe(0);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.suggestion).toBeNull();

    const newRecords = h.store.appends.filter(
      (record) => record.sessionId === snapshot.sessionId
    );
    expect(newRecords).toHaveLength(1);
    expect(newRecords[0]?.positionVersion).toBe(0);

    await h.coordinator.close();
  });

  it("rejects an unplayable confirmed position without changing state", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    await until(() => h.advisor.calls.length === 1, "initial suggestion request");
    h.advisor.resolveBest(0, "e2e4");
    await until(() => h.coordinator.snapshot().suggestion !== null, "initial suggestion");

    const invalid: GamePosition = {
      initialFen: "not-a-fen",
      fen: "not-a-fen",
      history: [],
      uncertainty: { castlingRights: false, enPassant: false, promotion: false }
    };
    await h.coordinator.dispatch({ type: "confirm-position", position: invalid });

    expect(h.coordinator.snapshot().error).not.toBeNull();
    expect(h.coordinator.snapshot().position?.history).toEqual([]);
    expect(h.coordinator.snapshot().positionVersion).toBe(0);

    await h.coordinator.close();
  });

  it("repeats the current suggestion on demand", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    await until(() => h.advisor.calls.length === 1, "initial suggestion request");
    h.advisor.resolveBest(0, "e2e4");
    await until(
      () => h.coordinator.snapshot().suggestion?.moveUci === "e2e4",
      "initial suggestion"
    );

    const before = h.sink.results.length;
    await h.coordinator.dispatch({ type: "repeat" });

    expect(h.sink.results.length).toBe(before + 1);
    expect(h.sink.results[h.sink.results.length - 1]?.moveUci).toBe("e2e4");

    await h.coordinator.close();
  });

  it("notifies subscribers until they unsubscribe", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    const seen: GameSnapshot[] = [];
    const unsubscribe = h.coordinator.subscribe((snapshot) => seen.push(snapshot));

    await h.coordinator.dispatch({ type: "pause" });
    expect(seen.some((snapshot) => snapshot.status === "paused")).toBe(true);

    const count = seen.length;
    unsubscribe();
    await h.coordinator.dispatch({ type: "resume" });
    expect(seen.length).toBe(count);

    await h.coordinator.close();
  });

  it("keeps the move but surfaces a journal write failure", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    await until(() => h.advisor.calls.length === 1, "initial suggestion request");
    h.advisor.resolveBest(0, "e2e4");
    await until(() => h.coordinator.snapshot().suggestion !== null, "initial suggestion");

    h.store.failNextAppend = true;
    await h.coordinator.dispatch({ type: "manual-move", uci: "e2e4" });

    expect(h.coordinator.snapshot().position?.history).toEqual(["e2e4"]);
    expect(h.coordinator.snapshot().error).toMatch(/save/i);

    await h.coordinator.close();
  });

  it("does no paid work when the shared ledger is paused", async () => {
    const ledger = new CostLedger(1, 0.5);
    const price = {
      inputPerMillion: 1,
      outputPerMillion: 1,
      effectiveAt: "2026-01-01T00:00:00Z"
    };
    expect(ledger.reserve("seed", price).allowed).toBe(true);
    ledger.settle("seed", 2_000_000, 0, price);
    expect(ledger.snapshot().paused).toBe(true);

    const h = createHarness({ ledger });
    await h.coordinator.start(h.source, startPosition());
    await flushTurns();

    expect(h.advisor.calls).toHaveLength(0);
    h.source.push(makeFrame(h.coordinator.snapshot().sessionId, newSourceId(), 1n));
    await flushTurns();

    expect(h.reader.calls).toHaveLength(0);
    expect(h.coordinator.snapshot().status).toBe("uncertain");
    expect(h.coordinator.snapshot().error).toMatch(/budget/i);

    await h.coordinator.close();
  });

  it("reports frame age from receipt time", async () => {
    let now = 5_000;
    const h = createHarness({ now: () => now });
    await h.coordinator.start(h.source, startPosition());
    expect(h.coordinator.snapshot().frameAgeMs).toBeNull();

    h.source.push(makeFrame(h.coordinator.snapshot().sessionId, newSourceId(), 1n));
    await until(() => h.coordinator.snapshot().frameAgeMs !== null, "frame received");
    expect(h.coordinator.snapshot().frameAgeMs).toBe(0);

    now = 5_250;
    expect(h.coordinator.snapshot().frameAgeMs).toBe(250);

    await h.coordinator.close();
  });

  it("closes idempotently and refuses commands afterwards", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());

    await h.coordinator.close();
    expect(h.source.closeCalls).toBe(1);
    await h.coordinator.close();
    expect(h.source.closeCalls).toBe(1);

    await expect(h.coordinator.dispatch({ type: "pause" })).rejects.toThrow(/closed/i);
  });

  it("binds a caller-provided session id so a frame source can stamp frames", async () => {
    const h = createHarness();
    const sessionId = newSessionId();
    await h.coordinator.start(h.source, startPosition(), sessionId);
    expect(h.coordinator.snapshot().sessionId).toBe(sessionId);

    h.source.push(makeFrame(sessionId, newSourceId(), 1n));
    await until(() => h.reader.calls.length === 1, "read with a bound session");

    const replacementSession = newSessionId();
    await h.coordinator.replaceSource(
      new ManualSource(),
      startPosition(),
      replacementSession
    );
    expect(h.coordinator.snapshot().sessionId).toBe(replacementSession);

    await h.coordinator.close();
  });

  it("rejects a non-canonical session id", async () => {
    const h = createHarness();
    await expect(
      h.coordinator.start(h.source, startPosition(), "not-a-uuid" as SessionId)
    ).rejects.toThrow(TypeError);
    await h.coordinator.close();
  });

  it("reports a frame source that is not bound to the active session", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    const wrongSession = newSessionId();
    for (let index = 1; index <= 5; index += 1) {
      h.source.push(makeFrame(wrongSession, newSourceId(), BigInt(index)));
    }

    await until(() => h.coordinator.snapshot().error !== null, "mismatch reported");
    expect(h.coordinator.snapshot().error).toMatch(/session/i);
    expect(h.reader.calls).toHaveLength(0);

    await h.coordinator.close();
  });

  it("does not start duplicate engine requests for one position", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    await until(() => h.advisor.calls.length === 1, "initial suggestion request");
    h.advisor.resolveBest(0, "e2e4");
    await until(() => h.coordinator.snapshot().suggestion !== null, "initial suggestion");

    await h.coordinator.dispatch({ type: "manual-move", uci: "e2e4" });
    await until(() => h.advisor.calls.length === 2, "suggestion for the reply");
    await h.coordinator.dispatch({ type: "manual-move", uci: "e7e5" });
    await until(() => h.advisor.calls.length === 3, "suggestion after the second move");

    // Interleaved commands reach maybeSuggest with no current suggestion; only
    // one engine request may exist for the restored position.
    const firstUndo = h.coordinator.dispatch({ type: "undo" });
    const secondUndo = h.coordinator.dispatch({ type: "undo" });
    await Promise.all([firstUndo, secondUndo]);
    await flushTurns();
    expect(h.advisor.calls.length).toBe(4);

    h.advisor.resolveBest(3, "g1f3");
    await until(
      () => h.coordinator.snapshot().suggestion?.moveUci === "g1f3",
      "restored suggestion"
    );

    await h.coordinator.close();
  });
});

describe("SourceSlot", () => {
  it("keeps only the current source and leaves replaced sources to the caller", async () => {
    const slot = new SourceSlot();
    const closed: string[] = [];
    const capabilities = {
      video: true,
      microphone: false,
      audioOutput: false,
      display: false
    };
    const makeSource = (name: string) => ({
      capabilities,
      next: async () => null,
      close: async () => {
        closed.push(name);
      }
    });

    const first = makeSource("first");
    const second = makeSource("second");
    expect(slot.current()).toBeNull();

    slot.activate(first);
    expect(slot.current()).toBe(first);
    slot.activate(second);
    expect(slot.current()).toBe(second);

    expect(await slot.closeWithin(50)).toBe(true);
    expect(closed).toEqual(["second"]);
  });

  it("bounds a close that never settles and is idempotent", async () => {
    const slot = new SourceSlot();
    const stuck = new StuckSource();
    slot.activate(stuck);

    const started = Date.now();
    expect(await slot.closeWithin(20)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(stuck.closeCalls).toBe(1);
    expect(await slot.closeWithin(20)).toBe(true);
    expect(stuck.closeCalls).toBe(1);
  });
});
