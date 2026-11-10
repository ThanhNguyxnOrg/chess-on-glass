import { describe, expect, it } from "vitest";
import { newSessionId, type RequestContext } from "@chessonglass/contracts";
import type { Result } from "@chessonglass/game";
import { createSpeechSink } from "../../src/speech/speech-sink.js";
import type { SpeechEngine, SpeechVoice } from "../../src/speech/system-speech-engine.js";

class FakeEngine implements SpeechEngine {
  readonly spoken: string[] = [];
  private readonly releases: Array<() => void> = [];
  failNext = false;

  async listVoices(): Promise<readonly SpeechVoice[]> {
    return [];
  }

  speak(input: { text: string; voiceId: string | null; signal: AbortSignal }): Promise<void> {
    this.spoken.push(input.text);
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("speech backend unavailable"));
    }
    return new Promise((resolve) => {
      this.releases.push(resolve);
    });
  }

  releaseAll(): void {
    for (const release of this.releases.splice(0)) {
      release();
    }
  }

  async close(): Promise<void> {
    return undefined;
  }
}

async function until(condition: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not met");
}

function context(positionVersion = 0): RequestContext {
  return {
    requestId: `request-${positionVersion}`,
    sessionId: newSessionId(),
    positionVersion,
    referenceSequence: null
  };
}

function result(resultContext: RequestContext, spokenText: string | null): Result {
  return {
    context: resultContext,
    moveUci: null,
    spokenText,
    status: "ready",
    reason: null
  };
}

describe("createSpeechSink", () => {
  it("speaks texts in order and skips empty results", async () => {
    const engine = new FakeEngine();
    const sink = createSpeechSink({ engine });
    const ctx = context();

    await sink.publish(result(ctx, "first"));
    await sink.publish(result(ctx, null));
    await sink.publish(result(ctx, "second"));

    expect(engine.spoken).toEqual(["first"]);
    engine.releaseAll();
    for (let i = 0; i < 50 && engine.spoken.length < 2; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    console.log("DIAG after release:", JSON.stringify(engine.spoken));
    expect(engine.spoken).toEqual(["first", "second"]);

    for (let i = 0; i < 50 && engine.spoken.length < 3; i += 1) {
      engine.releaseAll();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    console.log("DIAG before close:", JSON.stringify(engine.spoken));
    await sink.close();
  });

  it("drops unstarted text from a cleared position", async () => {
    const engine = new FakeEngine();
    const sink = createSpeechSink({ engine });
    const oldContext = context(1);
    const newContext = context(2);

    await sink.publish(result(oldContext, "old-playing"));
    await sink.publish(result(oldContext, "old-queued"));
    await sink.publish(result(newContext, "new-queued"));

    sink.clear(oldContext);
    engine.releaseAll();
    await until(() => engine.spoken.length === 2);

    expect(engine.spoken).toEqual(["old-playing", "new-queued"]);
    engine.releaseAll();
    await sink.close();
  });

  it("keeps speaking after a backend failure", async () => {
    const engine = new FakeEngine();
    const sink = createSpeechSink({ engine });
    const ctx = context();

    engine.failNext = true;
    await sink.publish(result(ctx, "broken"));
    await sink.publish(result(ctx, "later"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.spoken).toEqual(["broken", "later"]);
    engine.releaseAll();
    await sink.close();
  });
});
