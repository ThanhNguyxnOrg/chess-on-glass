import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  Frame,
  FrameSource,
  GamePosition,
  SessionId,
  SourceId
} from "@chessonglass/contracts";
import {
  CompositeResultSink,
  CostLedger,
  FileGameStore,
  GameCoordinator,
  QueuedTextSink,
  type GameStore,
  type Price,
  type ResultSink
} from "@chessonglass/game";
import {
  providerPrice,
  type BoardReader,
  type GeometryState
} from "@chessonglass/perception";
import {
  NodePlatformServices,
  UciEngine,
  type Advisor,
  type PlatformServices
} from "@chessonglass/platform";
import { createBrowserFrameRoutes } from "../http/browser-frame-routes.js";
import { createDashboardRoutes } from "../http/dashboard-routes.js";
import { createExportRoutes } from "../http/export-routes.js";
import {
  createOverlayRoutes,
  type OverlayPipelineSnapshot
} from "../http/overlay-routes.js";
import { startDashboardServer } from "../http/server.js";
import {
  createSettingsRoutes,
  type RuntimeCapabilities
} from "../http/settings-routes.js";
import { createWindowsCaptureRoutes } from "../http/windows-capture-routes.js";
import { FfmpegOverlayWriter } from "../native/ffmpeg-overlay-writer.js";
import {
  WindowsCaptureClient,
  type WindowsCaptureBackend
} from "../native/windows-capture-client.js";
import { createBoardReader } from "../providers/provider-factory.js";
import {
  SecretService,
  type SecretProviderName
} from "../secrets/secret-service.js";
import {
  loadSettings,
  saveSettings,
  type AppSettings
} from "../settings/settings.js";
import { BrowserFrameSource } from "../sources/browser-frame-source.js";
import { FfmpegReplaySource } from "../sources/ffmpeg-replay-source.js";
import { createSpeechSink } from "../speech/speech-sink.js";
import {
  SystemSpeechEngine,
  type SpeechEngine
} from "../speech/system-speech-engine.js";
import { toDashboardSnapshot, type DashboardSnapshot } from "./view-model.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const DEFAULT_START_POSITION: GamePosition = Object.freeze({
  initialFen: START_FEN,
  fen: START_FEN,
  history: Object.freeze([]),
  uncertainty: Object.freeze({
    castlingRights: false,
    enPassant: false,
    promotion: false
  })
});

const RESERVE_PER_CALL_USD = 0.05;

export type WindowsApplicationOptions = {
  staticDir: string;
  dataDir?: string;
  platform?: PlatformServices;
  env?: NodeJS.ProcessEnv;
  reader?: BoardReader;
  advisor?: Advisor;
  store?: GameStore;
  speechEngine?: SpeechEngine | null;
  captureBackend?: WindowsCaptureBackend;
  stockfishPath?: string | null;
  ffmpegPath?: string | null;
  replayPath?: string;
  initialPosition?: GamePosition | null;
};

export type WindowsApplication = {
  readonly launchUrl: string;
  readonly url: string;
  snapshot(): DashboardSnapshot;
  dispatch(command: { type: string; [key: string]: unknown }): Promise<void>;
  replaceSource(source: FrameSource, initial: GamePosition | null): Promise<void>;
  close(): Promise<void>;
};

function findInstalledExecutable(
  dataDir: string,
  toolId: "stockfish" | "ffmpeg"
): string | null {
  const dir = join(dataDir, "tools", toolId);
  if (!existsSync(dir)) {
    return null;
  }
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (process.platform === "win32" && !entry.toLowerCase().endsWith(".exe")) {
        continue;
      }
      const candidate = join(dir, entry);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function resolveExecutable(
  explicit: string | null | undefined,
  envValue: string | undefined,
  dataDir: string,
  toolId: "stockfish" | "ffmpeg"
): string | null {
  if (explicit === null) return null;
  if (typeof explicit === "string" && explicit.trim() !== "") {
    return explicit.trim();
  }
  if (typeof envValue === "string" && envValue.trim() !== "") {
    return envValue.trim();
  }
  return findInstalledExecutable(dataDir, toolId);
}

function createUnavailableCaptureBackend(): WindowsCaptureBackend {
  return {
    async listTargets() {
      return [];
    },
    async pickTarget() {
      return null;
    },
    async preview() {
      throw new Error("window capture is not available on this host");
    },
    open() {
      throw new Error("window capture is not available on this host");
    },
    async close() {
      return undefined;
    }
  };
}

/**
 * Wraps a FrameSource to tap the latest frame for the live overlay preview
 * without interfering with coordinator delivery or close semantics.
 */
function tapFrameSource(
  inner: FrameSource,
  onFrame: (frame: Frame) => void,
  activeSessionId: () => SessionId
): FrameSource {
  return {
    capabilities: inner.capabilities,
    async next(signal) {
      const frame = await inner.next(signal);
      if (frame !== null) {
        const currentSession = activeSessionId();
        const bound =
          frame.sessionId === currentSession
            ? frame
            : { ...frame, sessionId: currentSession };
        onFrame(bound);
        return bound;
      }
      return null;
    },
    close() {
      return inner.close();
    }
  };
}

/**
 * Lazy UCI advisor that starts Stockfish on the first move request and
 * reports an honest error when no Stockfish binary is configured.
 */
function createLazyStockfishAdvisor(stockfishPath: string | null): Advisor {
  let engine: UciEngine | null = null;
  let starting: Promise<UciEngine> | null = null;

  async function ensureEngine(): Promise<UciEngine> {
    if (engine !== null) {
      return engine;
    }
    if (stockfishPath === null) {
      throw new Error(
        "Stockfish is not installed. Run `chessonglass install-tools stockfish` or set CHESSONGLASS_STOCKFISH."
      );
    }
    if (starting === null) {
      starting = UciEngine.start(stockfishPath).then((started) => {
        engine = started;
        starting = null;
        return started;
      });
    }
    return starting;
  }

  return {
    async best(input) {
      const active = await ensureEngine();
      return active.best(input);
    },
    async close() {
      if (starting !== null) {
        try {
          const started = await starting;
          await started.close();
        } catch {
          // ignore startup errors during shutdown
        }
        starting = null;
      }
      if (engine !== null) {
        const current = engine;
        engine = null;
        await current.close();
      }
    }
  };
}

export async function startWindowsApplication(
  options: WindowsApplicationOptions
): Promise<WindowsApplication> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? new NodePlatformServices();
  const dataDir = options.dataDir ?? platform.userDataDir();
  const settingsPath = join(dataDir, "settings.json");
  const gamesDir = join(dataDir, "games");
  const exportsDir = join(dataDir, "exports");

  await mkdir(dataDir, { recursive: true });
  await mkdir(gamesDir, { recursive: true });
  await mkdir(exportsDir, { recursive: true });

  let settings: AppSettings = await loadSettings(settingsPath);
  const secrets = new SecretService(platform, {
    openai: env["OPENAI_API_KEY"],
    anthropic: env["ANTHROPIC_API_KEY"]
  });

  const stockfishPath = resolveExecutable(
    options.stockfishPath,
    env["CHESSONGLASS_STOCKFISH"],
    dataDir,
    "stockfish"
  );
  const ffmpegPath = resolveExecutable(
    options.ffmpegPath,
    env["CHESSONGLASS_FFMPEG"],
    dataDir,
    "ffmpeg"
  );

  let speechEngine: SpeechEngine | null = null;
  if (options.speechEngine !== undefined) {
    speechEngine = options.speechEngine;
  } else if (process.platform === "win32") {
    const defaultHelper = resolve(
      import.meta.dirname,
      "../../native/speech/bin/SpeechHelper.exe"
    );
    if (existsSync(defaultHelper)) {
      speechEngine = new SystemSpeechEngine({ helperPath: defaultHelper });
    }
  }

  let captureBackend: WindowsCaptureBackend;
  let wgcAvailable = false;
  if (options.captureBackend !== undefined) {
    captureBackend = options.captureBackend;
    wgcAvailable = true;
  } else if (process.platform === "win32") {
    try {
      captureBackend = await WindowsCaptureClient.open();
      wgcAvailable = true;
    } catch {
      captureBackend = createUnavailableCaptureBackend();
    }
  } else {
    captureBackend = createUnavailableCaptureBackend();
  }

  // Hot-swappable BoardReader built from live settings + SecretService.
  let cachedReaderKey: string | null = null;
  let cachedReader: BoardReader | null = null;

  const dynamicReader: BoardReader = options.reader ?? {
    async read(input) {
      if (!settings.cloudEnabled || settings.provider === null || settings.visionModel === null) {
        return {
          ok: false,
          code: "unavailable",
          message: "Enable Cloud Vision and pick a provider/model in Settings to analyze frames",
          retryable: false
        };
      }
      const secret = await secrets.read(settings.provider);
      if (secret === null) {
        return {
          ok: false,
          code: "unauthorized",
          message: `API key for ${settings.provider} is missing; add it in Settings`,
          retryable: false
        };
      }
      const cacheKey = `${settings.provider}:${settings.visionModel}:${secret.length}:${secret.slice(-4)}`;
      if (cachedReader === null || cachedReaderKey !== cacheKey) {
        cachedReader = createBoardReader(
          {
            provider: settings.provider,
            model: settings.visionModel,
            cloudEnabled: true
          },
          secret
        );
        cachedReaderKey = cacheKey;
      }
      return cachedReader.read(input);
    }
  };

  const resolveReadPrice = (): Price | null => {
    if (options.reader !== undefined) {
      return {
        inputPerMillion: 0,
        outputPerMillion: 0,
        effectiveAt: "2026-01-01T00:00:00Z"
      };
    }
    if (!settings.cloudEnabled || settings.provider === null || settings.visionModel === null) {
      return {
        inputPerMillion: 0,
        outputPerMillion: 0,
        effectiveAt: "2026-01-01T00:00:00Z"
      };
    }
    return providerPrice({
      provider: settings.provider,
      model: settings.visionModel,
      cloudEnabled: true
    });
  };

  const ledger = new CostLedger(settings.maxCostUsd, RESERVE_PER_CALL_USD);
  const advisor = options.advisor ?? createLazyStockfishAdvisor(stockfishPath);
  const store = options.store ?? new FileGameStore(gamesDir);

  const sinks: ResultSink[] = [new QueuedTextSink(async () => undefined)];
  if (speechEngine !== null) {
    const activeSpeechEngine = speechEngine;
    sinks.push(
      createSpeechSink({
        engine: {
          listVoices: (signal) => activeSpeechEngine.listVoices(signal),
          speak: async (input) => {
            if (!settings.speechEnabled) {
              return;
            }
            await activeSpeechEngine.speak({
              ...input,
              voiceId: settings.voiceId ?? input.voiceId
            });
          },
          close: () => activeSpeechEngine.close()
        }
      })
    );
  }
  const sink = new CompositeResultSink(sinks);

  const coordinator = new GameCoordinator({
    reader: dynamicReader,
    advisor,
    store,
    ledger,
    sink,
    readPrice: resolveReadPrice
  });

  // Active source + overlay pipeline state
  let overlayFrame: OverlayPipelineSnapshot["latestFrame"] = null;
  let overlayGeometryState: GeometryState | null = null;
  let activeBrowserSource: BrowserFrameSource | null = null;
  let activeBrowserSessionId: SessionId | null = null;

  const idleSource = (): FrameSource => {
    let closed = false;
    let wake: (() => void) | null = null;
    return {
      capabilities: { video: false, microphone: false, audioOutput: false, display: false },
      next: (signal) =>
        new Promise<Frame | null>((resolveNext) => {
          if (closed || signal.aborted) {
            resolveNext(null);
            return;
          }
          const done = (): void => {
            wake = null;
            signal.removeEventListener("abort", done);
            resolveNext(null);
          };
          wake = done;
          signal.addEventListener("abort", done, { once: true });
        }),
      close: async () => {
        closed = true;
        wake?.();
      }
    };
  };

  const currentPositionOrStart = (): GamePosition =>
    coordinator.snapshot().position ?? DEFAULT_START_POSITION;

  async function attachSource(
    source: FrameSource,
    sessionId: SessionId,
    initial: GamePosition | null = currentPositionOrStart()
  ): Promise<void> {
    const tapped = tapFrameSource(
      source,
      (frame) => {
        overlayFrame = frame;
      },
      () => coordinator.snapshot().sessionId
    );
    await coordinator.replaceSource(tapped, initial, sessionId);
  }

  const browserRoutes = createBrowserFrameRoutes({
    target: () => {
      if (activeBrowserSource === null || activeBrowserSessionId === null) {
        return null;
      }
      const snap = coordinator.snapshot();
      return {
        source: activeBrowserSource,
        sessionId: snap.sessionId,
        positionVersion: snap.positionVersion
      };
    },
    start: async () => {
      if (activeBrowserSource !== null) {
        const previous = activeBrowserSource;
        activeBrowserSource = null;
        activeBrowserSessionId = null;
        await previous.close();
      }
      const sessionId = randomUUID() as SessionId;
      const sourceId = randomUUID() as SourceId;
      const src = new BrowserFrameSource(sessionId, sourceId);
      activeBrowserSource = src;
      activeBrowserSessionId = sessionId;
      await attachSource(src, sessionId);
      return { sessionId, sourceId };
    },
    stop: async () => {
      if (activeBrowserSource !== null) {
        const previous = activeBrowserSource;
        activeBrowserSource = null;
        activeBrowserSessionId = null;
        await previous.close();
      }
      await coordinator.replaceSource(idleSource(), currentPositionOrStart(), randomUUID() as SessionId);
    }
  });

  const captureRoutes = createWindowsCaptureRoutes({
    backend: captureBackend,
    start: async (targetId: string) => {
      if (activeBrowserSource !== null) {
        const previous = activeBrowserSource;
        activeBrowserSource = null;
        activeBrowserSessionId = null;
        await previous.close();
      }
      const sessionId = randomUUID() as SessionId;
      const sourceId = randomUUID() as SourceId;
      const source = await captureBackend.open({
        sessionId,
        sourceId,
        targetId,
        fps: settings.browserFps
      });
      await attachSource(source, sessionId);
    },
    stop: async () => {
      await coordinator.replaceSource(idleSource(), currentPositionOrStart(), randomUUID() as SessionId);
    }
  });

  const overlayRoutes = createOverlayRoutes({
    pipeline: () => {
      const snapshot = coordinator.snapshot();
      const suggestion = snapshot.suggestion;
      const result = suggestion
        ? {
            moveUci: suggestion.moveUci,
            status: suggestion.status,
            reason: suggestion.reason ?? snapshot.error
          }
        : { moveUci: null, status: snapshot.status, reason: snapshot.error };
      return {
        latestFrame: overlayFrame,
        geometryState: overlayGeometryState,
        result,
        position: snapshot.position,
        note: snapshot.error
      };
    }
  });

  const exportRoutes = createExportRoutes({
    exportDirectory: () => exportsDir,
    createExporter: () =>
      ffmpegPath === null
        ? null
        : new FfmpegOverlayWriter({
            ffmpegPath,
            exportDirectory: exportsDir
          })
  });

  const getCapabilities = (): RuntimeCapabilities => ({
    stockfish: stockfishPath !== null || options.advisor !== undefined,
    ffmpeg: ffmpegPath !== null,
    speech: speechEngine !== null,
    wgc: wgcAvailable
  });

  const startReplay = async (input: {
    path: string;
    fps?: number;
    speed?: number;
  }): Promise<void> => {
    if (ffmpegPath === null) {
      throw new Error(
        "FFmpeg is not installed. Run `chessonglass install-tools ffmpeg` or set CHESSONGLASS_FFMPEG."
      );
    }
    if (activeBrowserSource !== null) {
      const previous = activeBrowserSource;
      activeBrowserSource = null;
      activeBrowserSessionId = null;
      await previous.close();
    }
    const sessionId = randomUUID() as SessionId;
    const sourceId = randomUUID() as SourceId;
    const replaySource = await FfmpegReplaySource.open({
      sessionId,
      sourceId,
      path: input.path,
      ffmpegPath,
      fps: input.fps ?? settings.replayFps,
      speed: input.speed ?? 1
    });
    await attachSource(replaySource, sessionId);
  };

  const settingsRoutes = createSettingsRoutes({
    getSettings: () => ({ ...settings }),
    updateSettings: async (patch) => {
      const merged: AppSettings = {
        ...settings,
        ...patch
      };
      await saveSettings(settingsPath, merged);
      settings = merged;
      cachedReader = null;
      cachedReaderKey = null;
      return { ...settings };
    },
    getSecretStatuses: async () => ({
      openai: await secrets.status("openai"),
      anthropic: await secrets.status("anthropic")
    }),
    writeSecret: async (provider: SecretProviderName, secret: string) => {
      await secrets.write(provider, secret);
      cachedReader = null;
      cachedReaderKey = null;
      return secrets.status(provider);
    },
    getLedgerSnapshot: () => ledger.snapshot(),
    getCapabilities,
    startReplay,
    stopReplay: async () => {
      await coordinator.replaceSource(idleSource(), currentPositionOrStart(), randomUUID() as SessionId);
    }
  });

  const dashboardRoutes = createDashboardRoutes({ coordinator });
  const staticDir = resolve(options.staticDir);

  const server = await startDashboardServer({
    staticDir,
    routes: {
      async handle(request) {
        const dashboardResult = await dashboardRoutes.handle(request);
        if (dashboardResult !== null) return dashboardResult;
        const settingsResult = await settingsRoutes.handle(request);
        if (settingsResult !== null) return settingsResult;
        const browserResult = await browserRoutes.handle(request);
        if (browserResult !== null) return browserResult;
        const captureResult = await captureRoutes.handle(request);
        if (captureResult !== null) return captureResult;
        const overlayResult = await overlayRoutes.handle(request);
        if (overlayResult !== null) return overlayResult;
        const exportResult = await exportRoutes.handle(request);
        if (exportResult !== null) return exportResult;
        return {
          status: 404,
          json: { error: { code: "not_found", message: "no route" } }
        };
      },
      bodyPolicy(request) {
        return (
          browserRoutes.bodyPolicy(request) ??
          exportRoutes.bodyPolicy(request) ??
          dashboardRoutes.bodyPolicy(request) ??
          null
        );
      },
      stream(request, responder) {
        return dashboardRoutes.stream(request, responder);
      }
    }
  });

  const initialPos =
    options.initialPosition === undefined
      ? DEFAULT_START_POSITION
      : options.initialPosition;

  await coordinator.start(idleSource(), initialPos);

  if (options.replayPath !== undefined && options.replayPath.trim() !== "") {
    await startReplay({ path: options.replayPath });
  }

  return {
    launchUrl: server.launchUrl,
    url: server.url,
    snapshot() {
      return toDashboardSnapshot(coordinator.snapshot());
    },
    async dispatch(command) {
      await coordinator.dispatch(command as never);
    },
    async replaceSource(source: FrameSource, initial: GamePosition | null) {
      const sessionId = randomUUID() as SessionId;
      await attachSource(source, sessionId, initial);
    },
    async close() {
      if (activeBrowserSource !== null) {
        const previous = activeBrowserSource;
        activeBrowserSource = null;
        activeBrowserSessionId = null;
        await previous.close();
      }
      await coordinator.close();
      await captureBackend.close();
      if (speechEngine !== null) {
        await speechEngine.close();
      }
      await server.close();
    }
  };
}
