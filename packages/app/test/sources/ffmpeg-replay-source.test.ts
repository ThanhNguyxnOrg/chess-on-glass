import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { newSessionId, newSourceId } from "@chessonglass/contracts";
import type { BoundedProcessHandle } from "../../src/native/process-client.js";
import {
  FfmpegReplaySource,
  type ReplayDependencies
} from "../../src/sources/ffmpeg-replay-source.js";

const SOI = [0xff, 0xd8, 0xff, 0xe0];
const EOI = [0xff, 0xd9];

function jpeg(payload: number): Uint8Array {
  return Uint8Array.from([...SOI, payload, 0x11, ...EOI]);
}

class FakeChild implements BoundedProcessHandle {
  readonly stdout = new PassThrough();
  killCalls = 0;

  private resolveClosed!: (value: { code: number | null }) => void;
  readonly closed = new Promise<{ code: number | null }>((resolve) => {
    this.resolveClosed = resolve;
  });

  kill(): void {
    this.killCalls += 1;
    this.resolveClosed({ code: null });
  }

  exit(code: number): void {
    this.resolveClosed({ code });
  }

  stderrText(): string {
    return "";
  }
}

type Harness = {
  child: FakeChild;
  dependencies: ReplayDependencies;
  args: readonly string[][];
};

function harness(options: { maxFrameBytes?: number } = {}): Harness {
  const child = new FakeChild();
  const args: string[][] = [];
  return {
    child,
    args,
    dependencies: {
      spawn: (spawnOptions) => {
        args.push([...spawnOptions.args]);
        return child;
      },
      ...(options.maxFrameBytes === undefined
        ? {}
        : { maxFrameBytes: options.maxFrameBytes })
    }
  };
}

function replayOptions() {
  return {
    sessionId: newSessionId(),
    sourceId: newSourceId(),
    path: "C:\\recordings\\game.mp4",
    ffmpegPath: "C:\\tools\\ffmpeg.exe",
    speed: 2,
    fps: 5
  };
}

describe("FfmpegReplaySource", () => {
  it("opens on the first frame, delivers frames then drains to EOF", async () => {
    const h = harness();
    const opening = FfmpegReplaySource.open(replayOptions(), h.dependencies);

    h.child.stdout.write(jpeg(0x01));
    const source = await opening;
    expect(h.args[0]?.[h.args[0]!.indexOf("-i") + 1]).toBe(
      "C:\\recordings\\game.mp4"
    );
    expect(h.args[0]).toContain("image2pipe");
    const whitelistIndex = h.args[0]!.indexOf("-protocol_whitelist");
    expect(whitelistIndex).toBeGreaterThan(-1);
    expect(h.args[0]![whitelistIndex + 1]).toBe("file");

    const first = await source.next(new AbortController().signal);
    expect(first?.sequence).toBe(1n);
    expect(first?.mimeType).toBe("image/jpeg");
    expect(first?.capturedAtMonotonicMs).toBeNull();

    h.child.stdout.write(jpeg(0x02));
    h.child.exit(0);
    const second = await source.next(new AbortController().signal);
    expect(second?.sequence).toBe(2n);
    await expect(source.next(new AbortController().signal)).resolves.toBeNull();

    await source.close();
    expect(h.child.killCalls).toBe(1);
  });

  it("keeps only the newest frame while a consumer is slow", async () => {
    const h = harness();
    const opening = FfmpegReplaySource.open(replayOptions(), h.dependencies);
    h.child.stdout.write(jpeg(0x01));
    const source = await opening;

    h.child.stdout.write(jpeg(0x02));
    h.child.stdout.write(jpeg(0x03));
    const frame = await source.next(new AbortController().signal);
    expect(frame?.bytes[4]).toBe(0x03);

    await source.close();
  });

  it("fails closed on a nonzero exit before the first frame", async () => {
    const h = harness();
    const opening = FfmpegReplaySource.open(replayOptions(), h.dependencies);
    h.child.exit(2);

    await expect(opening).rejects.toThrow(/exited before the first frame/i);
  });

  it("fails closed when a malformed stream exceeds the frame bound", async () => {
    const h = harness({ maxFrameBytes: 16 });
    const opening = FfmpegReplaySource.open(replayOptions(), h.dependencies);
    h.child.stdout.write(
      Uint8Array.from([...SOI, ...new Array<number>(64).fill(0x41)])
    );

    await expect(opening).rejects.toThrow(/bound|large/i);
  });

  it("ignores child events after close", async () => {
    const h = harness();
    const opening = FfmpegReplaySource.open(replayOptions(), h.dependencies);
    h.child.stdout.write(jpeg(0x01));
    const source = await opening;

    await source.close();
    h.child.stdout.write(jpeg(0x02));
    h.child.exit(0);

    // The frame produced before close is still drained; the late one is not.
    const drained = await source.next(new AbortController().signal);
    expect(drained?.sequence).toBe(1n);
    expect(drained?.bytes[4]).toBe(0x01);
    await expect(source.next(new AbortController().signal)).resolves.toBeNull();
    await source.close();
    expect(h.child.killCalls).toBe(1);
  });

  it("validates speed and fps", async () => {
    const h = harness();
    for (const speed of [0, 0.1, 4.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        FfmpegReplaySource.open(
          { ...replayOptions(), speed },
          h.dependencies
        )
      ).rejects.toThrow(/speed/i);
    }
    for (const fps of [0, 11, 2.5]) {
      await expect(
        FfmpegReplaySource.open({ ...replayOptions(), fps }, h.dependencies)
      ).rejects.toThrow(/fps/i);
    }
    for (const path of [
      "http://example.com/game.mp4",
      "https://example.com/game.mp4",
      "concat:a.mp4|b.mp4",
      "subfile:secret.txt",
      "-"
    ]) {
      await expect(
        FfmpegReplaySource.open({ ...replayOptions(), path }, h.dependencies)
      ).rejects.toThrow(/local file/i);
    }
  });
});
