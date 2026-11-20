import { join, resolve } from "node:path";
import {
  DEFAULT_EXPORT_FPS,
  MAX_EXPORT_FRAME_BYTES,
  OverlayExportError,
  assertExportFileName,
  validateExportFps,
  validateExportFrame,
  type OverlayExporter
} from "@chessonglass/perception";
import { HttpError, badRequest } from "./errors.js";
import { JSON_BODY_LIMIT } from "./server.js";
import type {
  ComposableRoutes,
  DashboardResponse
} from "./server.js";

export const EXPORT_START_PATH = "/api/export/overlay/start";
export const EXPORT_FRAME_PATH = "/api/export/overlay/frame";
export const EXPORT_STOP_PATH = "/api/export/overlay/stop";
export const EXPORT_STATUS_PATH = "/api/export/overlay/status";

export type ExportRoutesOptions = {
  /**
   * Absolute, operator-selected directory that bounds every export. Read per
   * request so settings can change between exports.
   */
  exportDirectory(): string;
  /**
   * Build a fresh exporter for a new export, or null when the approved
   * FFmpeg binary is not configured (answered with 503, never a half-start).
   */
  createExporter(): OverlayExporter | null;
};

type ActiveExport = {
  exporter: OverlayExporter;
  fileName: string;
  framesWritten: number;
  controller: AbortController;
};

/**
 * Map an exporter failure onto an honest HTTP error. Messages carry codes
 * and generic wording only — never filesystem paths or child-process stderr,
 * which stay in local logs where the operator can act on them.
 */
function toHttpError(error: OverlayExportError): HttpError {
  switch (error.code) {
    case "output-exists":
      return new HttpError(
        409,
        "export_output_exists",
        "an export file with this name already exists"
      );
    case "invalid-output-path":
    case "invalid-file-name":
    case "output-outside-directory":
      return badRequest("invalid export target");
    case "invalid-fps":
      return badRequest("export fps must be an integer between 1 and 60");
    case "output-directory-missing":
      return new HttpError(
        503,
        "export_unavailable",
        "the export directory is not available"
      );
    case "invalid-frame":
      return badRequest("frame is not a bounded JPEG");
    case "frame-too-large":
      return new HttpError(413, "payload_too_large", "frame exceeds the export size ceiling");
    case "invalid-state":
      return new HttpError(409, "export_not_active", "the export is not active");
    case "process-failed":
    case "aborted":
      return new HttpError(502, "export_failed", "the overlay exporter failed");
  }
}

function requireExportBody(json: unknown): { fileName?: unknown; fps?: unknown } {
  if (typeof json !== "object" || json === null) {
    return {};
  }
  const body = json as Record<string, unknown>;
  return { fileName: body["fileName"], fps: body["fps"] };
}

/**
 * Overlay video export routes, mounted behind the plan-02 authorization wall
 * (token + loopback + origin checks run in the server before routes see a
 * request). Exactly one export is active at a time; the frame endpoint
 * consumes the same rendered overlay JPEGs the dashboard preview serves, so
 * preview and export share one renderer and one state.
 *
 * Every response is honest JSON with no filesystem paths: clients chose the
 * file name and get exactly that name back, never the resolved location.
 */
export function createExportRoutes(options: ExportRoutesOptions): ComposableRoutes {
  let active: ActiveExport | null = null;

  function deactivate(): void {
    active = null;
  }

  return {
    bodyPolicy({ method, path }) {
      if (method !== "POST") {
        return null;
      }
      if (path === EXPORT_FRAME_PATH) {
        return { limit: MAX_EXPORT_FRAME_BYTES, contentType: "image/jpeg" as const };
      }
      if (path === EXPORT_START_PATH || path === EXPORT_STOP_PATH) {
        return { limit: JSON_BODY_LIMIT, contentType: "application/json" as const };
      }
      return null;
    },

    async handle(request): Promise<DashboardResponse | null> {
      if (request.method === "GET" && request.path === EXPORT_STATUS_PATH) {
        return {
          status: 200,
          json: {
            active: active !== null,
            fileName: active?.fileName ?? null,
            framesWritten: active?.framesWritten ?? 0
          }
        };
      }

      if (request.method === "POST" && request.path === EXPORT_START_PATH) {
        const body = requireExportBody(request.json);
        try {
          // Validate client input before touching the exporter so a bad
          // request never constructs a process.
          const fileName = assertExportFileName(
            typeof body.fileName === "string" ? body.fileName : ""
          );
          const fps = validateExportFps(
            body.fps === undefined ? DEFAULT_EXPORT_FPS : (body.fps as number)
          );
          if (active !== null) {
            throw new HttpError(409, "export_active", "an export is already running");
          }
          const exporter = options.createExporter();
          if (exporter === null) {
            throw new HttpError(
              503,
              "export_unavailable",
              "overlay export is not configured on this machine"
            );
          }
          const outputPath = join(resolve(options.exportDirectory()), fileName);
          const controller = new AbortController();
          // Reserve the slot synchronously so concurrent starts cannot race.
          active = { exporter, fileName, framesWritten: 0, controller };
          try {
            await exporter.start({ outputPath, fps, signal: controller.signal });
          } catch (error) {
            deactivate();
            throw error;
          }
          return { status: 202, json: { started: true, fileName, fps } };
        } catch (error) {
          if (error instanceof OverlayExportError) {
            throw toHttpError(error);
          }
          throw error;
        }
      }

      if (request.method === "POST" && request.path === EXPORT_FRAME_PATH) {
        if (active === null) {
          throw new HttpError(409, "export_not_active", "no export is running");
        }
        const frameBytes = request.body ?? new Uint8Array(0);
        try {
          validateExportFrame(frameBytes);
          await active.exporter.write(frameBytes);
        } catch (error) {
          if (error instanceof OverlayExportError) {
            if (error.code === "invalid-state" || error.code === "process-failed" || error.code === "aborted") {
              deactivate();
            }
            throw toHttpError(error);
          }
          throw error;
        }
        active.framesWritten += 1;
        return {
          status: 202,
          json: { accepted: true, framesWritten: active.framesWritten }
        };
      }

      if (request.method === "POST" && request.path === EXPORT_STOP_PATH) {
        if (active === null) {
          throw new HttpError(409, "export_not_active", "no export is running");
        }
        // Stopping is terminal regardless of the close outcome: the writer
        // refuses further work after close, so the slot must go.
        const finished = active;
        deactivate();
        try {
          const result = await finished.exporter.close();
          return {
            status: 200,
            json: {
              stopped: true,
              fileName: finished.fileName,
              framesWritten: result.framesWritten
            }
          };
        } catch (error) {
          if (error instanceof OverlayExportError) {
            throw toHttpError(error);
          }
          throw error;
        }
      }

      return null;
    }
  };
}
