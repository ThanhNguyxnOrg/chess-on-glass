import { describe, expect, it } from "vitest";
import { newSessionId, type RequestContext } from "@chessonglass/contracts";
import {
  CompositeResultSink,
  QueuedTextSink,
  type Result,
  type ResultSink
} from "@chessonglass/game";
import {
  createHarness,
  flushTurns,
  ManualSource,
  positionAfter,
  RecordingSink,
  startPosition,
  until
} from "./support/coordinator-fakes.js";

type SpeechCall = {
  readonly text: string;
  readonly signal: AbortSignal;
  resolve(): void;
  reject(error: unknown): void;
};

class ControlledSpeech {
  readonly calls: SpeechCall[] = [];

  speak = (text: string, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      this.calls.push({ text, signal, resolve, reject });
    });

  resolveAll(): void {
    for (const call of this.calls) {
      call.resolve();
    }
  }
}

function contextFor(
  sessionId = newSessionId(),
  positionVersion = 0,
  requestId = "request"
): RequestContext {
  return { requestId, sessionId, positionVersion, referenceSequence: null };
}

function resultFor(context: RequestContext, spokenText: string | null): Result {
  return {
    context,
    moveUci: null,
    spokenText,
    status: "ready",
    reason: null
  };
}

describe("QueuedTextSink", () => {
  it("speaks accepted results in order", async () => {
    const speech = new ControlledSpeech();
    const sink = new QueuedTextSink(speech.speak);
    const context = contextFor();

    await sink.publish(resultFor(context, "first"));
    await until(() => speech.calls.length === 1, "first utterance");
    await sink.publish(resultFor(context, "second"));
    await sink.publish(resultFor(context, "third"));
    expect(speech.calls).toHaveLength(1);

    speech.calls[0]!.resolve();
    await until(() => speech.calls.length === 2, "second utterance");
    speech.calls[1]!.resolve();
    await until(() => speech.calls.length === 3, "third utterance");
    speech.calls[2]!.resolve();

    await sink.close();
    expect(speech.calls.map((call) => call.text)).toEqual([
      "first",
      "second",
      "third"
    ]);
  });

  it("clear drops only unstarted text from the cleared position", async () => {
    const speech = new ControlledSpeech();
    const sink = new QueuedTextSink(speech.speak);
    const oldContext = contextFor(newSessionId(), 1);
    const newContext = contextFor(newSessionId(), 2);

    await sink.publish(resultFor(oldContext, "old-first"));
    await until(() => speech.calls.length === 1, "in-flight old text");
    await sink.publish(resultFor(oldContext, "old-second"));
    await sink.publish(resultFor(newContext, "new-first"));

    sink.clear(oldContext);
    // A playing utterance is not cancelled or claimed as unheard.
    expect(speech.calls[0]!.signal.aborted).toBe(false);

    speech.calls[0]!.resolve();
    await until(() => speech.calls.length === 2, "next utterance");
    expect(speech.calls[1]!.text).toBe("new-first");

    speech.calls[1]!.resolve();
    await sink.close();
    expect(speech.calls.map((call) => call.text)).toEqual([
      "old-first",
      "new-first"
    ]);
  });

  it("clear without a context drops every unstarted text", async () => {
    const speech = new ControlledSpeech();
    const sink = new QueuedTextSink(speech.speak);
    const context = contextFor();

    await sink.publish(resultFor(context, "playing"));
    await until(() => speech.calls.length === 1, "in-flight text");
    await sink.publish(resultFor(context, "queued"));

    sink.clear();
    speech.calls[0]!.resolve();
    await flushTurns();

    await sink.close();
    expect(speech.calls.map((call) => call.text)).toEqual(["playing"]);
  });

  it("skips results without spoken text", async () => {
    const speech = new ControlledSpeech();
    const sink = new QueuedTextSink(speech.speak);
    const context = contextFor();

    await sink.publish(resultFor(context, null));
    await sink.publish(resultFor(context, "spoken"));
    await until(() => speech.calls.length === 1, "spoken text");

    speech.calls[0]!.resolve();
    await sink.close();
    expect(speech.calls.map((call) => call.text)).toEqual(["spoken"]);
  });

  it("bounds the queue by dropping the oldest unstarted text", async () => {
    const speech = new ControlledSpeech();
    const sink = new QueuedTextSink(speech.speak, { maxQueue: 2 });
    const context = contextFor();

    await sink.publish(resultFor(context, "playing"));
    await until(() => speech.calls.length === 1, "in-flight text");
    await sink.publish(resultFor(context, "dropped"));
    await sink.publish(resultFor(context, "kept"));
    await sink.publish(resultFor(context, "latest"));

    speech.calls[0]!.resolve();
    await until(() => speech.calls.length === 2, "kept");
    expect(speech.calls[1]!.text).toBe("kept");
    speech.calls[1]!.resolve();
    await until(() => speech.calls.length === 3, "latest");
    speech.calls[2]!.resolve();

    await sink.close();
    expect(speech.calls.map((call) => call.text)).toEqual([
      "playing",
      "kept",
      "latest"
    ]);
  });

  it("close stops new text, aborts the signal and waits for the real utterance", async () => {
    const speech = new ControlledSpeech();
    const sink = new QueuedTextSink(speech.speak);
    const context = contextFor();

    await sink.publish(resultFor(context, "playing"));
    await sink.publish(resultFor(context, "queued"));
    await until(() => speech.calls.length === 1, "in-flight text");

    let closed = false;
    const closing = sink.close().then(() => {
      closed = true;
    });
    expect(speech.calls[0]!.signal.aborted).toBe(true);
    await flushTurns();
    // The backend ignores abort; close must not claim the utterance ended.
    expect(closed).toBe(false);

    speech.calls[0]!.resolve();
    await closing;
    expect(closed).toBe(true);
    expect(speech.calls.map((call) => call.text)).toEqual(["playing"]);

    await expect(sink.publish(resultFor(context, "after"))).rejects.toThrow(
      /closed/i
    );
    await sink.close();
    expect(speech.calls).toHaveLength(1);
  });

  it("keeps speaking later results after an utterance fails", async () => {
    const speech = new ControlledSpeech();
    const sink = new QueuedTextSink(speech.speak);
    const context = contextFor();

    await sink.publish(resultFor(context, "broken"));
    await sink.publish(resultFor(context, "later"));
    await until(() => speech.calls.length === 1, "broken utterance");
    speech.calls[0]!.reject(new Error("speech backend unavailable"));

    await until(() => speech.calls.length === 2, "later utterance");
    expect(speech.calls[1]!.text).toBe("later");
    speech.calls[1]!.resolve();

    await sink.close();
    expect(speech.calls.map((call) => call.text)).toEqual(["broken", "later"]);
  });

  it("validates its settings", () => {
    expect(() => new QueuedTextSink(undefined as never)).toThrow(TypeError);
    expect(
      () => new QueuedTextSink(async () => undefined, { maxQueue: 0 })
    ).toThrow(RangeError);
    expect(
      () => new QueuedTextSink(async () => undefined, { maxQueue: 1.5 })
    ).toThrow(RangeError);
  });
});

describe("CompositeResultSink", () => {
  it("publishes to every sink and reports a failure", async () => {
    const recording = new RecordingSink();
    const failing: ResultSink = {
      publish: async () => {
        throw new Error("sink down");
      },
      clear: () => undefined,
      close: async () => undefined
    };
    const composite = new CompositeResultSink([failing, recording]);

    await expect(
      composite.publish(resultFor(contextFor(), "text"))
    ).rejects.toThrow(/sink/i);
    expect(recording.results).toHaveLength(1);
  });

  it("clears every sink and closes idempotently", async () => {
    const first = new RecordingSink();
    const second = new RecordingSink();
    const composite = new CompositeResultSink([first, second]);
    const context = contextFor();

    composite.clear(context);
    expect(first.clears).toEqual([context]);
    expect(second.clears).toEqual([context]);

    await composite.close();
    await composite.close();
    expect(first.closeCalls).toBe(1);
    expect(second.closeCalls).toBe(1);
  });

  it("reports a sink that fails to close but still closes the others", async () => {
    const recording = new RecordingSink();
    const failing: ResultSink = {
      publish: async () => undefined,
      clear: () => undefined,
      close: async () => {
        throw new Error("sink stuck");
      }
    };
    const composite = new CompositeResultSink([recording, failing]);

    await expect(composite.close()).rejects.toThrow(/sink/i);
    expect(recording.closeCalls).toBe(1);
  });
});

describe("result sinks with the coordinator", () => {
  it("reports an unavailable sink without losing chess state", async () => {
    const recording = new RecordingSink();
    const failing: ResultSink = {
      publish: async () => {
        throw new Error("sink down");
      },
      clear: () => undefined,
      close: async () => undefined
    };
    const h = createHarness({
      sink: new CompositeResultSink([failing, recording])
    });

    await h.coordinator.start(h.source, startPosition());
    await until(() => h.advisor.calls.length === 1, "initial suggestion request");
    h.advisor.resolveBest(0, "e2e4");

    await h.coordinator.dispatch({ type: "manual-move", uci: "d2d4" });
    expect(h.coordinator.snapshot().position?.history).toEqual(["d2d4"]);
    expect(h.coordinator.snapshot().positionVersion).toBe(1);
    expect(h.coordinator.snapshot().error).toMatch(/output/i);
    expect(recording.results.some((result) => result.moveUci === "d2d4")).toBe(
      true
    );

    await h.coordinator.close();
  });

  it("no pending text can target a replaced session", async () => {
    const speech = new ControlledSpeech();
    const textSink = new QueuedTextSink(speech.speak);
    const h = createHarness({ sink: textSink });

    await h.coordinator.start(h.source, startPosition());
    await until(() => h.advisor.calls.length === 1, "initial suggestion request");
    h.advisor.resolveBest(0, "e2e4");
    await until(() => speech.calls.length === 1, "old suggestion playing");
    expect(speech.calls[0]!.text).toBe("Suggested e4");

    // Queue a repeat for the old session behind the playing utterance.
    await h.coordinator.dispatch({ type: "repeat" });

    await h.coordinator.replaceSource(
      new ManualSource(),
      positionAfter(["e2e4"])
    );
    await until(
      () => h.advisor.calls.length >= 2,
      "replacement suggestion request"
    );
    h.advisor.resolveBest(h.advisor.calls.length - 1, "e7e5");

    speech.calls[0]!.resolve();
    await until(() => speech.calls.length === 2, "replacement suggestion playing");
    // The repeated old-session text was dropped, not spoken after the swap.
    expect(speech.calls[1]!.text).toBe("Suggested e5");
    expect(speech.calls[1]!.text).not.toBe(speech.calls[0]!.text);

    speech.resolveAll();
    await h.coordinator.close();
    await textSink.close();
  });
});
