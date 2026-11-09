import { describe, expect, it } from "vitest";
import { newSourceId } from "@chessonglass/contracts";
import {
  createHarness,
  fenAfter,
  flushTurns,
  makeFrame,
  ManualSource,
  observationFor,
  positionAfter,
  startPosition,
  StuckSource,
  until
} from "./support/coordinator-fakes.js";

describe("GameCoordinator stale-work rejection", () => {
  it("pause drops an in-flight read and starts nothing until resume", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    const sessionId = h.coordinator.snapshot().sessionId;
    const sourceId = newSourceId();

    h.source.push(makeFrame(sessionId, sourceId, 1n));
    await until(() => h.reader.calls.length === 1, "first read");

    await h.coordinator.dispatch({ type: "pause" });
    expect(h.reader.calls[0]!.input.signal.aborted).toBe(true);
    expect(h.coordinator.snapshot().status).toBe("paused");

    h.source.push(makeFrame(sessionId, sourceId, 2n));
    await flushTurns();
    expect(h.reader.calls).toHaveLength(1);

    // The provider ignores the abort and answers after the pause.
    h.reader.settleWithMove(0, fenAfter(["e2e4"]));
    await flushTurns();
    expect(h.coordinator.snapshot().position?.history).toEqual([]);
    expect(h.coordinator.snapshot().status).toBe("paused");

    await h.coordinator.dispatch({ type: "resume" });
    h.source.push(makeFrame(sessionId, sourceId, 3n));
    await until(() => h.reader.calls.length === 2, "read after resume");
    expect(h.reader.calls[1]!.input.frame.sequence).toBe(3n);

    await h.coordinator.close();
  });

  it("a late observation cannot change a new game", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    const firstSession = h.coordinator.snapshot().sessionId;

    h.source.push(makeFrame(firstSession, newSourceId(), 1n));
    await until(() => h.reader.calls.length === 1, "in-flight read");
    const stale = h.reader.calls[0]!;

    await h.coordinator.dispatch({ type: "new-game", initial: null });
    const secondSession = h.coordinator.snapshot().sessionId;
    expect(secondSession).not.toBe(firstSession);
    expect(stale.input.signal.aborted).toBe(true);
    expect(h.store.records.has(secondSession)).toBe(true);

    // The provider ignores AbortSignal and answers the old request.
    stale.resolve({
      ok: true,
      observation: observationFor({
        context: stale.input.context,
        fen: fenAfter(["e2e4"])
      })
    });
    await flushTurns();

    const snapshot = h.coordinator.snapshot();
    expect(snapshot.sessionId).toBe(secondSession);
    expect(snapshot.position?.history).toEqual([]);
    expect(snapshot.positionVersion).toBe(0);
    const firstRecords = h.store.appends.filter(
      (record) => record.sessionId === firstSession
    );
    expect(firstRecords.map((record) => record.positionVersion)).toEqual([0]);

    await h.coordinator.close();
  });

  it("a late engine answer cannot become a suggestion after undo", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    await until(() => h.advisor.calls.length === 1, "initial suggestion request");
    h.advisor.resolveBest(0, "e2e4");
    await until(() => h.coordinator.snapshot().suggestion !== null, "initial suggestion");

    await h.coordinator.dispatch({ type: "manual-move", uci: "e2e4" });
    await until(() => h.advisor.calls.length === 2, "reply suggestion request");
    const stale = h.advisor.calls[1]!;

    await h.coordinator.dispatch({ type: "undo" });
    expect(stale.input.signal.aborted).toBe(true);
    expect(h.coordinator.snapshot().position?.history).toEqual([]);
    expect(h.coordinator.snapshot().suggestion).toBeNull();

    // The engine ignores AbortSignal and answers the abandoned position.
    stale.resolve({ uci: "e7e5", score: { cp: 10 } });
    await flushTurns();
    expect(h.coordinator.snapshot().suggestion).toBeNull();
    expect(h.coordinator.snapshot().position?.history).toEqual([]);

    await until(() => h.advisor.calls.length === 3, "suggestion after undo");

    await h.coordinator.close();
  });

  it("source replacement rotates the session, closes the old source and drops its late result", async () => {
    const h = createHarness({ shutdownTimeoutMs: 100 });
    await h.coordinator.start(h.source, startPosition());
    const firstSession = h.coordinator.snapshot().sessionId;
    h.source.push(makeFrame(firstSession, newSourceId(), 1n));
    await until(() => h.reader.calls.length === 1, "in-flight read");
    const stale = h.reader.calls[0]!;

    const replacement = new ManualSource();
    await h.coordinator.replaceSource(
      replacement,
      positionAfter(["e2e4", "e7e5"])
    );

    const secondSession = h.coordinator.snapshot().sessionId;
    expect(secondSession).not.toBe(firstSession);
    expect(h.source.closeCalls).toBe(1);
    expect(h.coordinator.snapshot().position?.history).toEqual(["e2e4", "e7e5"]);
    expect(h.coordinator.snapshot().positionVersion).toBe(0);
    expect(stale.input.signal.aborted).toBe(true);

    stale.resolve({
      ok: true,
      observation: observationFor({
        context: stale.input.context,
        fen: fenAfter(["e2e4"])
      })
    });
    await flushTurns();
    expect(h.coordinator.snapshot().sessionId).toBe(secondSession);
    expect(h.coordinator.snapshot().position?.history).toEqual(["e2e4", "e7e5"]);

    replacement.push(makeFrame(secondSession, newSourceId(), 1n));
    await until(() => h.reader.calls.length === 2, "read from the replacement source");
    expect(h.reader.calls[1]!.input.frame.sessionId).toBe(secondSession);

    await h.coordinator.close();
  });

  it("a hung read from the old session does not block the replacement source", async () => {
    const h = createHarness({ shutdownTimeoutMs: 25 });
    await h.coordinator.start(h.source, startPosition());
    const firstSession = h.coordinator.snapshot().sessionId;
    h.source.push(makeFrame(firstSession, newSourceId(), 1n));
    await until(() => h.reader.calls.length === 1, "hung read");

    const replacement = new ManualSource();
    await h.coordinator.replaceSource(replacement, startPosition());
    const secondSession = h.coordinator.snapshot().sessionId;
    expect(secondSession).not.toBe(firstSession);

    replacement.push(makeFrame(secondSession, newSourceId(), 1n));
    await until(() => h.reader.calls.length === 2, "read from the replacement source");
    expect(h.reader.calls[1]!.input.frame.sessionId).toBe(secondSession);

    // The abandoned read settles late and must stay dropped.
    h.reader.settle(0, {
      ok: true,
      observation: observationFor({
        context: h.reader.calls[0]!.input.context,
        fen: fenAfter(["e2e4"])
      })
    });
    await flushTurns();
    expect(h.coordinator.snapshot().sessionId).toBe(secondSession);
    expect(h.coordinator.snapshot().position?.history).toEqual([]);

    await h.coordinator.close();
  });

  it("replaceSource does not hang when the old source ignores close", async () => {
    const h = createHarness({ shutdownTimeoutMs: 25 });
    const stuck = new StuckSource();
    await h.coordinator.start(stuck, startPosition());

    const started = Date.now();
    await h.coordinator.replaceSource(new ManualSource(), startPosition());

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(stuck.closeCalls).toBe(1);

    await h.coordinator.close();
  });

  it("close aborts in-flight work, clears output and resolves within the bound", async () => {
    const h = createHarness({ shutdownTimeoutMs: 25 });
    await h.coordinator.start(h.source, startPosition());
    const sessionId = h.coordinator.snapshot().sessionId;
    h.source.push(makeFrame(sessionId, newSourceId(), 1n));
    await until(() => h.reader.calls.length === 1, "in-flight read");
    const pending = h.reader.calls[0]!;

    const clearsBefore = h.sink.clears.length;
    const resultsBefore = h.sink.results.length;
    const started = Date.now();
    await h.coordinator.close();

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(pending.input.signal.aborted).toBe(true);
    expect(h.source.closeCalls).toBe(1);
    expect(h.sink.clears.length).toBeGreaterThan(clearsBefore);

    // A result that arrives after close is dropped without publishing.
    pending.resolve({
      ok: true,
      observation: observationFor({ context: pending.input.context, fen: fenAfter(["e2e4"]) })
    });
    await flushTurns();
    expect(h.sink.results.length).toBe(resultsBefore);
    expect(h.coordinator.snapshot().position?.history).toEqual([]);

    await h.coordinator.close();
    expect(h.source.closeCalls).toBe(1);
  });

  it("duplicate and out-of-order frames cannot add evidence", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    const sessionId = h.coordinator.snapshot().sessionId;
    const sourceId = newSourceId();
    const observed = fenAfter(["e2e4"]);

    h.source.push(makeFrame(sessionId, sourceId, 1n));
    await until(() => h.reader.calls.length === 1, "first read");
    h.reader.settleWithMove(0, observed);
    await until(() => h.coordinator.snapshot().status === "waiting", "waiting");

    h.source.push(makeFrame(sessionId, sourceId, 1n));
    h.source.push(makeFrame(sessionId, sourceId, 0n));
    await flushTurns();
    expect(h.reader.calls).toHaveLength(1);

    h.source.push(makeFrame(sessionId, sourceId, 2n));
    await until(() => h.reader.calls.length === 2, "second read");
    h.reader.settleWithMove(1, observed);
    await until(
      () => h.coordinator.snapshot().position?.history.length === 1,
      "move committed"
    );

    await h.coordinator.close();
  });

  it("frozen byte-identical frames cannot add confidence", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());
    const sessionId = h.coordinator.snapshot().sessionId;
    const sourceId = newSourceId();
    const observed = fenAfter(["e2e4"]);
    const frozen = new Uint8Array([7, 7, 7, 7]);

    h.source.push(makeFrame(sessionId, sourceId, 1n, frozen));
    await until(() => h.reader.calls.length === 1, "first read");
    h.reader.settleWithMove(0, observed);
    await until(() => h.coordinator.snapshot().status === "waiting", "waiting");

    // Same bytes under a new sequence number is a frozen source, not fresh
    // evidence; it must not be read or corroborate the move.
    h.source.push(makeFrame(sessionId, sourceId, 2n, frozen));
    await flushTurns();
    expect(h.reader.calls).toHaveLength(1);
    expect(h.coordinator.snapshot().position?.history).toEqual([]);

    h.source.push(makeFrame(sessionId, sourceId, 3n, new Uint8Array([8, 8, 8, 8])));
    await until(() => h.reader.calls.length === 2, "fresh read");
    h.reader.settleWithMove(1, observed);
    await until(
      () => h.coordinator.snapshot().position?.history.length === 1,
      "move committed"
    );

    await h.coordinator.close();
  });

  it("marks the session lost when the frame source ends", async () => {
    const h = createHarness();
    await h.coordinator.start(h.source, startPosition());

    h.source.end();
    await until(() => h.coordinator.snapshot().status === "lost", "lost status");
    expect(h.coordinator.snapshot().error).toMatch(/source/i);

    // The user can still recover with an explicit command.
    await h.coordinator.dispatch({ type: "manual-move", uci: "e2e4" });
    expect(h.coordinator.snapshot().status).toBe("ready");
    expect(h.coordinator.snapshot().position?.history).toEqual(["e2e4"]);

    await h.coordinator.close();
  });
});
