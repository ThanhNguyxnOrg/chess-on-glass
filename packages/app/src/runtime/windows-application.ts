import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  FrameSource,
  GamePosition,
  SessionId,
  SourceId
} from "@chessonglass/contracts";
import {
  CostLedger,
  GameCoordinator,
  QueuedTextSink
} from "@chessonglass/game";
import {
  startDashboardServer,
  type DashboardServer
} from "../http/server.js";
import {
  createBrowserFrameRoutes,
  type BrowserUploadTarget
} from "../http/browser-frame-routes.js";
import {
  createWindowsCaptureRoutes
} from "../http/windows-capture-routes.js";
import {
  createDashboardRoutes
} from "../http/dashboard-routes.js";
import { toDashboardSnapshot } from "./view-model.js";
import type { DashboardSnapshot } from "./view-model.js";

export type WindowsApplicationOptions = {
  staticDir: string;
};

export type WindowsApplication = {
  readonly launchUrl: string;
  readonly url: string;
  snapshot(): DashboardSnapshot;
  dispatch(command: { type: string; [key: string]: unknown }): Promise<void>;
  replaceSource(source: FrameSource, initial: GamePosition | null): Promise<void>;
  close(): Promise<void>;
};

export async function startWindowsApplication(
  options: WindowsApplicationOptions
): Promise<WindowsApplication> {
  const ledger = new CostLedger(10, 0.5);
  const coordinator = new GameCoordinator({
    reader: {
      read: async () => ({ ok: false, code: "unavailable" as const, message: "cloud off", retryable: false })
    },
    advisor: {
      best: async () => ({ uci: "0000", score: {} }),
      close: async () => undefined
    },
    store: {
      load: async () => null,
      append: async () => undefined,
      exportPgn: async () => "",
      delete: async () => undefined
    },
    ledger,
    sink: new QueuedTextSink(async () => undefined)
  });

  let browserUploadTarget: BrowserUploadTarget | null = null;

  const browserRoutes = createBrowserFrameRoutes({
    target: () => browserUploadTarget,
    start: async () => {
      const { BrowserFrameSource } = await import("../sources/browser-frame-source.js");
      const sessionId = randomUUID() as SessionId;
      const sourceId = randomUUID() as SourceId;
      const src = new BrowserFrameSource(sessionId, sourceId);
      browserUploadTarget = {
        source: src,
        sessionId,
        positionVersion: coordinator.snapshot().positionVersion
      };
      return { sessionId, sourceId };
    },
    stop: async () => {
      browserUploadTarget = null;
    }
  });

  const captureRoutes = createWindowsCaptureRoutes({
    backend: {
      async listTargets() { return []; },
      async pickTarget() { return null; },
      async preview() { return new Uint8Array(); },
      open() { throw new Error("window capture requires the WGC adapter to be started"); },
      async close() { return undefined; }
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
        const browserResult = await browserRoutes.handle(request);
        if (browserResult !== null) return browserResult;
        const captureResult = await captureRoutes.handle(request);
        if (captureResult !== null) return captureResult;
        return {
          status: 404,
          json: { error: { code: "not_found", message: "no route" } }
        };
      },
      bodyPolicy(request) {
        return (
          browserRoutes.bodyPolicy(request) ??
          dashboardRoutes.bodyPolicy(request) ??
          null
        );
      },
      stream(request, responder) {
        return dashboardRoutes.stream(request, responder);
      }
    }
  });

  await coordinator.start(
    {
      capabilities: { video: false, microphone: false, audioOutput: false, display: false },
      next: async () => null,
      close: async () => undefined
    },
    null
  );

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
      await coordinator.replaceSource(source, initial, sessionId);
    },
    async close() {
      await coordinator.close();
      await server.close();
    }
  };
}
