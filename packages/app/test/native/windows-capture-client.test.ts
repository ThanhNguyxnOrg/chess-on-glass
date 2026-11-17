import { describe, expect, it } from "vitest";
import { newSessionId, newSourceId } from "@chessonglass/contracts";
import {
  WindowsCaptureClient,
  type NativeScreenCaptureModule,
  type NativeWindowInfo
} from "../../src/native/windows-capture-client.js";
import type {
  NativeCaptureFrame,
  NativeCaptureSession
} from "../../src/sources/windows-screen-source.js";

class ManualSession implements NativeCaptureSession {
  stopped = 0;
  private readonly queue: NativeCaptureFrame[] = [];
  private readonly waiters: Array<(frame: NativeCaptureFrame | undefined) => void> = [];

  async start(): Promise<void> {
    return undefined;
  }

  push(frame: NativeCaptureFrame): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(frame);
      return;
    }
    this.queue.push(frame);
  }

  nextFrame(): Promise<NativeCaptureFrame | undefined> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    for (const waiter of this.waiters.splice(0)) {
      waiter(undefined);
    }
  }
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

async function until(condition: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not met");
}

type FakeModule = {
  module: NativeScreenCaptureModule;
  sessions: Array<{ options: Record<string, unknown>; session: ManualSession }>;
};

function fakeModule(windows: NativeWindowInfo[]): FakeModule {
  const sessions: FakeModule["sessions"] = [];
  function FakeScreenCapture(options: Record<string, unknown>) {
    const session = new ManualSession();
    sessions.push({ options, session });
    return session;
  }
  return {
    sessions,
    module: {
      isSupported: () => true,
      enumerateWindows: () => windows,
      ImageFormat: { Jpeg: "jpeg" },
      ScreenCapture:
        FakeScreenCapture as unknown as NativeScreenCaptureModule["ScreenCapture"]
    }
  };
}

function frame(): NativeCaptureFrame {
  return { width: 640, height: 480, encode: () => Buffer.from(JPEG) };
}

describe("WindowsCaptureClient", () => {
  it("lists only valid, titled windows and keeps titles as plain data", async () => {
    const malicious = "<img src=x onerror=window.__xss=1>";
    const fake = fakeModule([
      { title: "Editor — plan.md", processName: "editor.exe", handle: 10, isValid: true },
      { title: "", processName: "ghost.exe", handle: 11, isValid: true },
      { title: malformedTitle(), processName: "bad.exe", handle: 12, isValid: false },
      { title: malicious, processName: "evil.exe", handle: 13, isValid: true }
    ]);
    const client = await WindowsCaptureClient.open({ module: fake.module });

    const targets = await client.listTargets(new AbortController().signal);
    expect(targets.map((target) => target.id)).toEqual(["10", "13"]);
    expect(targets[1]?.title).toBe(malicious);
    expect(typeof targets[1]?.title).toBe("string");
    await client.close();
  });

  it("resolves picker cancellation to null", async () => {
    const fake = fakeModule([]);
    let release: ((value: NativeWindowInfo | null) => void) | null = null;
    const client = await WindowsCaptureClient.open({
      module: fake.module,
      pickWindow: () =>
        new Promise((resolve) => {
          release = resolve;
        })
    });

    const controller = new AbortController();
    const pending = client.pickTarget(controller.signal);
    controller.abort();
    release?.(null);
    await expect(pending).resolves.toBeNull();
    await client.close();

    // Without a native picker the dashboard lists targets itself.
    const listing = await WindowsCaptureClient.open({ module: fake.module });
    await expect(
      listing.pickTarget(new AbortController().signal)
    ).resolves.toBeNull();
    await listing.close();
  });

  it("generates a bounded JPEG preview and always stops the session", async () => {
    const fake = fakeModule([
      { title: "Editor", processName: "editor.exe", handle: 10, isValid: true }
    ]);
    const client = await WindowsCaptureClient.open({
      module: fake.module,
      encodeJpeg: async () => JPEG,
      previewTimeoutMs: 1_000
    });

    const pending = client.preview("10", new AbortController().signal);
    await until(() => fake.sessions.length === 1);
    fake.sessions[0]?.session.push(frame());

    await expect(pending).resolves.toEqual(JPEG);
    expect(fake.sessions[0]?.options.windowHandle).toBe(10);
    expect(fake.sessions[0]?.session.stopped).toBe(1);
    await client.close();
  });

  it("fails closed on an unknown target, a hung preview and cancellation", async () => {
    const fake = fakeModule([
      { title: "Editor", processName: "editor.exe", handle: 10, isValid: true }
    ]);
    const client = await WindowsCaptureClient.open({
      module: fake.module,
      encodeJpeg: async () => JPEG,
      previewTimeoutMs: 20
    });

    await expect(
      client.preview("999", new AbortController().signal)
    ).rejects.toThrow(/target/i);

    await expect(
      client.preview("10", new AbortController().signal)
    ).rejects.toThrow(/preview/i);
    expect(fake.sessions[0]?.session.stopped).toBe(1);

    const controller = new AbortController();
    const cancelled = client.preview("10", controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow(/preview/i);

    await client.close();
  });

  it("rejects numeric aliases and unlisted targets on start", async () => {
    const fake = fakeModule([
      { title: "Editor", processName: "editor.exe", handle: 10, isValid: true }
    ]);
    const client = await WindowsCaptureClient.open({
      module: fake.module,
      encodeJpeg: async () => JPEG
    });

    await expect(
      client.open({
        sessionId: newSessionId(),
        sourceId: newSourceId(),
        targetId: "0x10"
      })
    ).rejects.toThrow(/target/i);
    await expect(
      client.open({
        sessionId: newSessionId(),
        sourceId: newSourceId(),
        targetId: "99"
      })
    ).rejects.toThrow(/target/i);
    expect(fake.sessions).toHaveLength(0);

    await client.close();
  });

  it("opens a screen source bound to the chosen window", async () => {
    const fake = fakeModule([
      { title: "Editor", processName: "editor.exe", handle: 10, isValid: true }
    ]);
    const client = await WindowsCaptureClient.open({
      module: fake.module,
      encodeJpeg: async () => JPEG
    });
    const sessionId = newSessionId();
    const sourceId = newSourceId();

    const opening = client.open({ sessionId, sourceId, targetId: "10", fps: 5 });
    await until(() => fake.sessions.length === 1);
    fake.sessions[0]?.session.push(frame());
    const source = await opening;

    const next = await source.next(new AbortController().signal);
    expect(next?.sessionId).toBe(sessionId);
    expect(next?.sourceId).toBe(sourceId);
    expect(fake.sessions[0]?.options.windowHandle).toBe(10);

    await source.close();
    await client.close();
  });
});

function malformedTitle(): string {
  // A title that is technically invalid (NUL) must not crash enumeration.
  return "bad\u0000title";
}
