import { describe, expect, it } from "vitest";
import {
  WebcamUploader,
  type WebcamCapture,
  type WebcamFrameSender
} from "../src/media/webcam-uploader.js";

class FakeCapture implements WebcamCapture {
  readonly started: Array<string | null> = [];
  stopCalls = 0;
  grabCalls = 0;
  grabResult: Blob | null = new Blob([new Uint8Array([1, 2, 3])]);

  async start(deviceId: string | null): Promise<void> {
    this.started.push(deviceId);
  }

  stop(): void {
    this.stopCalls += 1;
  }

  async grab(): Promise<Blob | null> {
    this.grabCalls += 1;
    return this.grabResult;
  }
}

class ManualScheduler {
  callbacks: Array<() => void> = [];

  setInterval = (callback: () => void): ReturnType<typeof setInterval> => {
    this.callbacks.push(callback);
    return this.callbacks.length as unknown as ReturnType<typeof setInterval>;
  };

  clearInterval = (): void => {
    this.callbacks = [];
  };

  tick(): void {
    for (const callback of [...this.callbacks]) {
      callback();
    }
  }
}

describe("WebcamUploader", () => {
  it("uploads one frame per capture with a decimal sequence and wall time", async () => {
    const capture = new FakeCapture();
    const uploads: Array<{ sequence: bigint; wallMs: number }> = [];
    const send: WebcamFrameSender = async (input) => {
      uploads.push({ sequence: input.sequence, wallMs: input.capturedAtWallMs });
    };
    const uploader = new WebcamUploader({
      capture,
      send,
      now: () => 9_000
    });

    await uploader.start("device-1");
    expect(capture.started).toEqual(["device-1"]);

    await uploader.captureOnce();
    await uploader.captureOnce();
    expect(uploads).toEqual([
      { sequence: 1n, wallMs: 9_000 },
      { sequence: 2n, wallMs: 9_000 }
    ]);

    await uploader.stop();
    expect(capture.stopCalls).toBe(1);
    expect(uploader.lastError).toBeNull();
  });

  it("keeps at most one upload in flight and cancels it on stop", async () => {
    const capture = new FakeCapture();
    const releases: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    const send: WebcamFrameSender = (input) => {
      signals.push(input.signal);
      return new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    };
    const uploader = new WebcamUploader({ capture, send });
    await uploader.start(null);

    const first = uploader.captureOnce();
    await uploader.captureOnce();
    expect(signals[0]?.aborted).toBe(false);

    const stopping = uploader.stop();
    expect(signals[0]?.aborted).toBe(true);
    releases[0]?.();
    await first;
    await stopping;
    expect(capture.stopCalls).toBe(1);

    await uploader.captureOnce();
  });

  it("runs on the configured interval and surfaces upload failures", async () => {
    const capture = new FakeCapture();
    const scheduler = new ManualScheduler();
    let attempts = 0;
    const send: WebcamFrameSender = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("upload failed");
      }
    };
    const uploader = new WebcamUploader({
      capture,
      send,
      fps: 2,
      setInterval: scheduler.setInterval,
      clearInterval: scheduler.clearInterval
    });

    await uploader.start(null);
    expect(scheduler.callbacks.length).toBe(1);

    scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attempts).toBe(1);
    expect(uploader.lastError).toMatch(/upload failed/i);

    // A later successful attempt clears the stale error.
    scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attempts).toBe(2);
    expect(uploader.lastError).toBeNull();

    await uploader.stop();
    expect(scheduler.callbacks.length).toBe(0);
  });

  it("validates fps and ignores captures before start or after stop", async () => {
    const capture = new FakeCapture();
    const send: WebcamFrameSender = async () => undefined;
    expect(() => new WebcamUploader({ capture, send, fps: 0 })).toThrow(
      RangeError
    );
    expect(() => new WebcamUploader({ capture, send, fps: 2.5 })).toThrow(
      RangeError
    );
    expect(() => new WebcamUploader({ capture, send, fps: 11 })).toThrow(
      RangeError
    );

    const uploader = new WebcamUploader({ capture, send });
    await uploader.captureOnce();
    await uploader.stop();
    await uploader.captureOnce();
    expect(capture.grabCalls).toBe(0);
  });
});
