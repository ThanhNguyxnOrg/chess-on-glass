import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { HelperProcessHandle } from "../../src/native/process-client.js";
import {
  SpeechUnavailableError,
  SystemSpeechEngine,
  type SpeechSpawn
} from "../../src/speech/system-speech-engine.js";

class FakeHelper implements HelperProcessHandle {
  readonly stdout = new PassThrough();
  readonly stdin = new PassThrough();
  killCalls = 0;
  stdinText = "";

  private resolveClosed!: (value: { code: number | null }) => void;
  readonly closed = new Promise<{ code: number | null }>((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor() {
    this.stdin.on("data", (chunk: Buffer) => {
      this.stdinText += chunk.toString("utf8");
    });
  }

  kill(): void {
    this.killCalls += 1;
    this.resolveClosed({ code: null });
    this.stdout.end();
  }

  exit(code: number): void {
    this.resolveClosed({ code });
    this.stdout.end();
  }

  stderrText(): string {
    return "";
  }
}

type SpawnRecord = { executable: string; args: readonly string[] };

function harness() {
  const helpers: FakeHelper[] = [];
  const spawns: SpawnRecord[] = [];
  const spawn: SpeechSpawn = (options) => {
    spawns.push({ executable: options.executable, args: options.args });
    const helper = new FakeHelper();
    helpers.push(helper);
    return helper;
  };
  return { helpers, spawns, spawn };
}

const VOICES_JSON = JSON.stringify({
  voices: [
    { id: "Microsoft David", name: "Microsoft David", locale: "en-US" },
    { id: "Microsoft An", name: "Microsoft An", locale: "vi-VN" }
  ]
});

describe("SystemSpeechEngine", () => {
  it("lists voices from bounded stdout JSON", async () => {
    const h = harness();
    const engine = new SystemSpeechEngine({
      helperPath: "SpeechHelper.exe",
      spawn: h.spawn
    });

    const pending = engine.listVoices(new AbortController().signal);
    h.helpers[0]!.stdout.write(VOICES_JSON);
    h.helpers[0]!.exit(0);

    const voices = await pending;
    expect(voices).toEqual([
      { id: "Microsoft David", name: "Microsoft David", locale: "en-US" },
      { id: "Microsoft An", name: "Microsoft An", locale: "vi-VN" }
    ]);
    expect(h.spawns[0]?.args).toEqual(["list-voices"]);
    await engine.close();
  });

  it("maps malformed, oversized and failed output to speech_unavailable", async () => {
    const h = harness();
    const engine = new SystemSpeechEngine({
      helperPath: "SpeechHelper.exe",
      spawn: h.spawn
    });

    const malformed = engine.listVoices(new AbortController().signal);
    h.helpers[0]!.stdout.write("{not json");
    h.helpers[0]!.exit(0);
    await expect(malformed).rejects.toBeInstanceOf(SpeechUnavailableError);

    const oversized = engine.listVoices(new AbortController().signal);
    h.helpers[1]!.stdout.write(Buffer.alloc(80 * 1024, 0x41));
    h.helpers[1]!.exit(0);
    await expect(oversized).rejects.toBeInstanceOf(SpeechUnavailableError);

    const failed = engine.listVoices(new AbortController().signal);
    h.helpers[2]!.exit(1);
    await expect(failed).rejects.toBeInstanceOf(SpeechUnavailableError);

    await engine.close();
  });

  it("sends text as bounded stdin JSON, never on the command line", async () => {
    const h = harness();
    const engine = new SystemSpeechEngine({
      helperPath: "SpeechHelper.exe",
      spawn: h.spawn
    });
    const secretText = "Suggested Nguyễn e4";

    const pending = engine.speak({
      text: secretText,
      voiceId: "Microsoft An",
      signal: new AbortController().signal
    });
    expect(h.spawns[0]?.args).toEqual(["speak"]);
    expect(h.spawns[0]?.args.join(" ")).not.toContain(secretText);

    h.helpers[0]!.exit(0);
    await pending;
    expect(JSON.parse(h.helpers[0]!.stdinText)).toEqual({
      text: secretText,
      voiceId: "Microsoft An"
    });

    await expect(
      engine.speak({
        text: "x".repeat(5 * 1024),
        voiceId: null,
        signal: new AbortController().signal
      })
    ).rejects.toThrow(RangeError);

    await engine.close();
  });

  it("fails closed on a missing helper and a hung utterance, killing the owned child", async () => {
    const missing = new SystemSpeechEngine({
      helperPath: "missing-helper.exe",
      spawn: () => {
        throw new Error("ENOENT");
      }
    });
    await expect(
      missing.listVoices(new AbortController().signal)
    ).rejects.toBeInstanceOf(SpeechUnavailableError);
    await missing.close();

    const h = harness();
    const engine = new SystemSpeechEngine({
      helperPath: "SpeechHelper.exe",
      spawn: h.spawn,
      speakTimeoutMs: 20
    });
    await expect(
      engine.speak({ text: "hello", voiceId: null, signal: new AbortController().signal })
    ).rejects.toBeInstanceOf(SpeechUnavailableError);
    expect(h.helpers[0]?.killCalls).toBe(1);
    await engine.close();
  });

  it("abort and close kill only the helper they own", async () => {
    const a = harness();
    const b = harness();
    const engineA = new SystemSpeechEngine({
      helperPath: "a.exe",
      spawn: a.spawn
    });
    const engineB = new SystemSpeechEngine({
      helperPath: "b.exe",
      spawn: b.spawn
    });

    const controller = new AbortController();
    const pending = engineA.speak({
      text: "hello",
      voiceId: null,
      signal: controller.signal
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(a.helpers[0]?.killCalls).toBe(1);
    expect(b.helpers).toHaveLength(0);

    const pendingB = engineB.speak({
      text: "still here",
      voiceId: null,
      signal: new AbortController().signal
    });
    await engineA.close();
    expect(b.helpers[0]?.killCalls).toBe(0);
    b.helpers[0]!.exit(0);
    await pendingB;

    await engineA.close();
    await engineB.close();
    expect(b.helpers[0]?.killCalls).toBe(0);
  });

  it("stops accepting work after close", async () => {
    const h = harness();
    const engine = new SystemSpeechEngine({
      helperPath: "SpeechHelper.exe",
      spawn: h.spawn
    });
    await engine.close();
    await expect(
      engine.speak({ text: "after close", voiceId: null, signal: new AbortController().signal })
    ).rejects.toBeInstanceOf(SpeechUnavailableError);
    await engine.close();
  });
});
