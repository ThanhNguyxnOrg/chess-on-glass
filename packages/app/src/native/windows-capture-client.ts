import type { FrameSource, SessionId, SourceId } from "@chessonglass/contracts";
import {
  WindowsScreenSource,
  type NativeCaptureFrame,
  type NativeCaptureSession
} from "../sources/windows-screen-source.js";

export type CaptureTarget = Readonly<{
  id: string;
  title: string;
  processName: string;
}>;

export interface WindowsCaptureBackend {
  listTargets(signal: AbortSignal): Promise<readonly CaptureTarget[]>;
  pickTarget(signal: AbortSignal): Promise<CaptureTarget | null>;
  preview(targetId: string, signal: AbortSignal): Promise<Uint8Array>;
  /** Resolves after the first captured frame, so Start fails closed. */
  open(options: {
    sessionId: SessionId;
    sourceId: SourceId;
    targetId: string;
    fps?: number;
  }): Promise<FrameSource>;
  close(): Promise<void>;
}

export type NativeWindowInfo = {
  title: string;
  processName: string;
  handle: number;
  isValid: boolean;
};

export type NativeScreenCaptureModule = {
  isSupported(): boolean;
  enumerateWindows(): NativeWindowInfo[];
  ImageFormat: { Jpeg: unknown };
  ScreenCapture: new (options: Record<string, unknown>) => NativeCaptureSession;
};

export type WindowsCaptureDependencies = {
  module?: NativeScreenCaptureModule;
  encodeJpeg?(frame: NativeCaptureFrame): Promise<Uint8Array>;
  /** Optional native picker; the dashboard uses listTargets plus explicit Start. */
  pickWindow?(signal: AbortSignal): Promise<NativeWindowInfo | null>;
  now?(): number;
  previewTimeoutMs?: number;
  firstFrameTimeoutMs?: number;
};

const DEFAULT_PREVIEW_TIMEOUT_MS = 5_000;
const MAX_WIDTH = 1280;
const MAX_PIXELS = 12_000_000;
const DEFAULT_FPS = 5;

function abortPromise(signal: AbortSignal): Promise<undefined> {
  if (signal.aborted) {
    return Promise.resolve(undefined);
  }
  return new Promise<undefined>((resolve) => {
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
}

async function encodeFrame(
  module: NativeScreenCaptureModule,
  frame: NativeCaptureFrame
): Promise<Uint8Array> {
  const jpeg = new Uint8Array(frame.encode(module.ImageFormat.Jpeg));
  if (frame.width <= MAX_WIDTH && frame.width * frame.height <= MAX_PIXELS) {
    return jpeg;
  }
  const { default: sharp } = await import("sharp");
  const resized = await sharp(Buffer.from(jpeg))
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return new Uint8Array(resized);
}

/**
 * Consented window capture. Targets come from a native WGC enumeration; a
 * target id is an opaque decimal handle and a title is never a path or a
 * command. Only the selected window is captured.
 */
export class WindowsCaptureClient implements WindowsCaptureBackend {
  private readonly module: NativeScreenCaptureModule;
  private readonly dependencies: WindowsCaptureDependencies;

  private constructor(
    module: NativeScreenCaptureModule,
    dependencies: WindowsCaptureDependencies
  ) {
    this.module = module;
    this.dependencies = dependencies;
  }

  static async open(
    dependencies: WindowsCaptureDependencies = {}
  ): Promise<WindowsCaptureClient> {
    const module =
      dependencies.module ??
      ((await import("@screen-capture/node")) as unknown as NativeScreenCaptureModule);
    if (!module.isSupported()) {
      throw new Error("window capture is not supported on this host");
    }
    return new WindowsCaptureClient(module, dependencies);
  }

  async listTargets(signal: AbortSignal): Promise<readonly CaptureTarget[]> {
    if (signal.aborted) {
      return [];
    }
    return this.module
      .enumerateWindows()
      .filter((window) => window.isValid && window.title.trim() !== "")
      .map((window) => ({
        id: String(window.handle),
        title: window.title,
        processName: window.processName
      }));
  }

  async pickTarget(signal: AbortSignal): Promise<CaptureTarget | null> {
    if (signal.aborted) {
      return null;
    }
    const pick = this.dependencies.pickWindow;
    if (pick === undefined) {
      // The dashboard owns the picker: list targets, preview, explicit Start.
      return null;
    }
    const picked = await pick(signal);
    if (picked === null || signal.aborted) {
      return null;
    }
    return {
      id: String(picked.handle),
      title: picked.title,
      processName: picked.processName
    };
  }

  async preview(targetId: string, signal: AbortSignal): Promise<Uint8Array> {
    const targets = await this.listTargets(signal);
    const target = targets.find((candidate) => candidate.id === targetId);
    if (target === undefined) {
      throw new Error("unknown capture target");
    }

    const session = this.createSession(Number(targetId), 100);
    const timeoutMs =
      this.dependencies.previewTimeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS;
    try {
      await session.start();
      const frame = await Promise.race([
        session.nextFrame(),
        abortPromise(signal),
        new Promise<undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), timeoutMs);
          timer.unref?.();
        })
      ]);
      if (frame === undefined || frame === null) {
        throw new Error("window preview failed");
      }
      const encode = this.dependencies.encodeJpeg;
      return await (encode === undefined
        ? encodeFrame(this.module, frame)
        : encode(frame));
    } catch (error) {
      if (
        error instanceof Error &&
        /unknown capture target/i.test(error.message)
      ) {
        throw error;
      }
      throw new Error("window preview failed");
    } finally {
      await session.stop().catch(() => undefined);
    }
  }

  async open(options: {
    sessionId: SessionId;
    sourceId: SourceId;
    targetId: string;
    fps?: number;
  }): Promise<WindowsScreenSource> {
    const handle = Number(options.targetId);
    if (!Number.isSafeInteger(handle)) {
      throw new Error("unknown capture target");
    }
    const fps = options.fps ?? DEFAULT_FPS;
    const interval = Math.max(100, Math.round(1000 / Math.min(10, Math.max(1, fps))));
    const session = this.createSession(handle, interval);
    return WindowsScreenSource.open({
      sessionId: options.sessionId,
      sourceId: options.sourceId,
      session,
      encodeJpeg:
        this.dependencies.encodeJpeg ??
        ((frame) => encodeFrame(this.module, frame)),
      ...(this.dependencies.now === undefined
        ? {}
        : { now: this.dependencies.now }),
      ...(this.dependencies.firstFrameTimeoutMs === undefined
        ? {}
        : { firstFrameTimeoutMs: this.dependencies.firstFrameTimeoutMs })
    });
  }

  async close(): Promise<void> {
    // Sessions own their native lifetime; nothing global to release.
  }

  private createSession(
    windowHandle: number,
    minimumUpdateIntervalMs: number
  ): NativeCaptureSession {
    return new this.module.ScreenCapture({
      windowHandle,
      cursorCapture: false,
      drawBorder: false,
      minimumUpdateIntervalMs
    });
  }
}
