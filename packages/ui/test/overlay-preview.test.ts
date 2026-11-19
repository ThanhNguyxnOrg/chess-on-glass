import { describe, expect, it } from "vitest";
import {
  OverlayPreviewController,
  describeOverlayStatus,
  type OverlayPreviewDeps,
  type OverlayPreviewState,
  type OverlayStatusSnapshot
} from "../src/components/overlay-preview.js";

function status(overrides: Partial<OverlayStatusSnapshot> = {}): OverlayStatusSnapshot {
  return {
    overlay: "active",
    frameSequence: "7",
    geometrySequence: "7",
    tracking: true,
    reason: null,
    result: { moveUci: "e2e4", status: "ready" },
    ...overrides
  };
}

type Harness = {
  deps: OverlayPreviewDeps;
  statusFetches: number;
  frameFetches: number;
  createdUrls: string[];
  revoked: string[];
  updates: OverlayPreviewState[];
  statusQueue: Array<OverlayStatusSnapshot | Error | Promise<OverlayStatusSnapshot>>;
  statusCursor: number;
  pendingSignals: AbortSignal[];
  frameSignals: AbortSignal[];
  intervalCallbacks: Array<() => void>;
  clearedIntervals: number;
};

function makeHarness(): Harness {
  const harness: Harness = {
    deps: undefined as unknown as OverlayPreviewDeps,
    statusFetches: 0,
    frameFetches: 0,
    createdUrls: [],
    revoked: [],
    updates: [],
    statusQueue: [status()],
    statusCursor: 0,
    pendingSignals: [],
    frameSignals: [],
    intervalCallbacks: [],
    clearedIntervals: 0
  };
  const deps: OverlayPreviewDeps = {
    fetchStatus: async (signal) => {
      harness.statusFetches += 1;
      harness.pendingSignals.push(signal);
      // Serve queued statuses in order; once the queue runs dry the last
      // status repeats, so extra polls stay deterministic.
      const next = harness.statusQueue[Math.min(harness.statusCursor, harness.statusQueue.length - 1)];
      harness.statusCursor += 1;
      if (next instanceof Error) {
        throw next;
      }
      if (next === undefined) {
        throw new Error("no status queued");
      }
      return await next;
    },
    fetchFrame: async (signal) => {
      harness.frameFetches += 1;
      harness.frameSignals.push(signal);
      return new Uint8Array([0xff, 0xd8, harness.frameFetches]);
    },
    createObjectUrl: (bytes) => {
      const url = `blob:preview-${bytes.at(2) ?? 0}`;
      harness.createdUrls.push(url);
      return url;
    },
    revokeObjectUrl: (url) => {
      harness.revoked.push(url);
    },
    setInterval: (handler) => {
      harness.intervalCallbacks.push(handler);
      return harness.intervalCallbacks.length;
    },
    clearInterval: () => {
      harness.clearedIntervals += 1;
    },
    onUpdate: (snapshot) => {
      harness.updates.push(snapshot);
    }
  };
  harness.deps = deps;
  return harness;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("OverlayPreviewController", () => {
  it("applies each new frame sequence exactly once", async () => {
    const harness = makeHarness();
    const controller = new OverlayPreviewController(harness.deps);

    await controller.refresh();
    await controller.refresh();

    expect(harness.statusFetches).toBe(2);
    expect(harness.frameFetches).toBe(1);
    expect(controller.state.appliedSequence).toBe("7");
    expect(controller.state.objectUrl).toBe("blob:preview-1");
    expect(harness.revoked).toEqual([]);
    expect(controller.state.overlay).toBe("active");
    expect(controller.state.error).toBeNull();
  });

  it("revokes the previous object URL when a new sequence arrives", async () => {
    const harness = makeHarness();
    harness.statusQueue.push(status({ frameSequence: "8", geometrySequence: "8" }));
    const controller = new OverlayPreviewController(harness.deps);

    await controller.refresh();
    await controller.refresh();

    expect(harness.frameFetches).toBe(2);
    expect(controller.state.objectUrl).toBe("blob:preview-2");
    expect(harness.revoked).toEqual(["blob:preview-1"]);
    expect(harness.createdUrls).toEqual(["blob:preview-1", "blob:preview-2"]);
  });

  it("drops ticks while a refresh is in flight instead of accumulating", async () => {
    const harness = makeHarness();
    const gate = deferred<OverlayStatusSnapshot>();
    harness.statusQueue = [gate.promise];
    const controller = new OverlayPreviewController(harness.deps);

    const first = controller.refresh();
    // The second tick arrives while the first is still in flight: it must be
    // dropped, not queued behind it.
    await controller.refresh();
    expect(harness.statusFetches).toBe(1);

    gate.resolve(status({ frameSequence: "9", geometrySequence: "9" }));
    await first;
    expect(controller.state.appliedSequence).toBe("9");
  });

  it("revokes the URL and shows status when the overlay becomes unavailable", async () => {
    const harness = makeHarness();
    harness.statusQueue.push(
      status({ overlay: "unavailable", frameSequence: null, geometrySequence: null, tracking: false, result: null })
    );
    const controller = new OverlayPreviewController(harness.deps);

    await controller.refresh();
    await controller.refresh();

    expect(harness.revoked).toEqual(["blob:preview-1"]);
    expect(controller.state.objectUrl).toBeNull();
    expect(controller.state.appliedSequence).toBeNull();
    expect(controller.state.overlay).toBe("unavailable");
    expect(controller.state.statusText).toContain("unavailable");
  });

  it("fetches the status-only image when the frame exists but geometry is hidden", async () => {
    const harness = makeHarness();
    harness.statusQueue = [
      status({ overlay: "hidden", tracking: false, reason: "geometry-expired", result: null })
    ];
    const controller = new OverlayPreviewController(harness.deps);

    await controller.refresh();

    expect(harness.frameFetches).toBe(1);
    expect(controller.state.appliedSequence).toBe("7");
    expect(controller.state.statusText).toContain("geometry-expired");
  });

  it("records errors and keeps the last good frame until a refresh recovers", async () => {
    const harness = makeHarness();
    harness.statusQueue = [new Error("dashboard closed")];
    const controller = new OverlayPreviewController(harness.deps);

    await controller.refresh();
    expect(controller.state.error).toContain("dashboard closed");
    expect(controller.state.appliedSequence).toBeNull();

    harness.statusQueue.push(status());
    await controller.refresh();
    expect(controller.state.error).toBeNull();
    expect(controller.state.appliedSequence).toBe("7");
  });

  it("aborts in-flight work, revokes the URL and stops polling on stop()", async () => {
    const harness = makeHarness();
    const gate = deferred<OverlayStatusSnapshot>();
    harness.statusQueue = [gate.promise];
    const controller = new OverlayPreviewController(harness.deps);

    const pending = controller.refresh();
    controller.start();
    controller.stop();

    expect(harness.clearedIntervals).toBe(1);
    expect(harness.pendingSignals[0]?.aborted).toBe(true);
    gate.resolve(status());
    await pending;
    // The late-arriving status must not resurrect the preview after stop.
    expect(controller.state.appliedSequence).toBeNull();
    expect(harness.frameFetches).toBe(0);
  });

  it("runs one interval tick per poll and stops cleanly", async () => {
    const harness = makeHarness();
    const controller = new OverlayPreviewController(harness.deps);

    controller.start();
    expect(harness.intervalCallbacks.length).toBe(1);
    // Idempotent start: a second call must not stack a second loop.
    controller.start();
    expect(harness.intervalCallbacks.length).toBe(1);

    // Each tick's refresh is async; let its microtasks settle before the
    // next tick so the in-flight guard does not drop it.
    await harness.intervalCallbacks[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.intervalCallbacks[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.statusFetches).toBe(2);
    expect(harness.frameFetches).toBe(1);

    controller.stop();
    expect(harness.clearedIntervals).toBe(1);
  });
});

describe("describeOverlayStatus", () => {
  it("describes the active overlay with its move and status", () => {
    const text = describeOverlayStatus(status());
    expect(text).toContain("active");
    expect(text).toContain("e2e4");
    expect(text).toContain("ready");
  });

  it("describes the hidden overlay with its invalidation reason", () => {
    const text = describeOverlayStatus(
      status({ overlay: "hidden", tracking: false, reason: "geometry-expired", result: null })
    );
    expect(text).toContain("hidden");
    expect(text).toContain("geometry-expired");
  });

  it("describes the unavailable pipeline", () => {
    const text = describeOverlayStatus(
      status({ overlay: "unavailable", frameSequence: null, geometrySequence: null, tracking: false, result: null })
    );
    expect(text).toContain("unavailable");
  });
});
