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
  /**
   * True while the slot has exactly one unsettled lifecycle operation: a
   * start or a frame write. The exporter's contract requires the previous
   * write to settle before the next is offered (and a not-yet-started
   * writer must not be fed), so the route enforces it: an overlapping frame
   * is answered 409 busy here instead of reaching the exporter, which means
   * an overlapping rejection can never drop the slot out from under the
   * operation that is in flight.
   */
  busy: boolean;
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
 *
 * Concurrency: each slot allows one unsettled lifecycle operation at a time
 * (`busy`). Overlapping frame requests are rejected 409 busy — never by
 * dropping the slot — so the in-flight write keeps its owner and the FFmpeg
 * child keeps its feeder. Any failure that drops a slot aborts the slot's
 * controller first, which routes through the writer's fail() → kill path;
 * stop instead closes the exporter, which owns the bounded shutdown. The
 * slot lifecycle has a single owner: handlers capture the slot once and
 * only mutate it after confirming it still owns `active`.
 */
export function createExportRoutes(options: ExportRoutesOptions): ComposableRoutes {
  let active: ActiveExport | null = null;

  /**
   * Drop a slot that failed. Aborting the controller first gives the writer
   * its kill path (fail() kills the child), so no FFmpeg process outlives
   * its slot; clearing `active` only when the slot still owns it keeps a
   * stale drop from clobbering a replacement export.
   */
  function dropSlot(slot: ActiveExport): void {
    slot.controller.abort();
    if (active === slot) {
      active = null;
    }
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
          const slot: ActiveExport = {
            exporter,
            fileName,
            framesWritten: 0,
            controller,
            // Busy until start settles: frames arriving mid-start are
            // answered 409 busy, never fed to a not-yet-started exporter.
            busy: true
          };
          // Reserve the slot synchronously so concurrent starts cannot race.
          active = slot;
          try {
            await exporter.start({ outputPath, fps, signal: controller.signal });
          } catch (error) {
            // The slot never became usable: take the kill path (abort) and
            // drop it so a half-started exporter cannot leave a child behind.
            dropSlot(slot);
            throw error;
          }
          slot.busy = false;
          return { status: 202, json: { started: true, fileName, fps } };
        } catch (error) {
          if (error instanceof OverlayExportError) {
            throw toHttpError(error);
          }
          throw error;
        }
      }

      if (request.method === "POST" && request.path === EXPORT_FRAME_PATH) {
        const slot = active;
        if (slot === null) {
          throw new HttpError(409, "export_not_active", "no export is running");
        }
        if (slot.busy) {
          // One unsettled operation per slot (start or write). The overlap
          // is rejected honestly here: the slot stays active, the in-flight
          // write keeps its owner, and the FFmpeg child keeps its feeder.
          throw new HttpError(
            409,
            "export_busy",
            "the export slot is busy; the previous frame write has not settled"
          );
        }
        const frameBytes = request.body ?? new Uint8Array(0);
        try {
          validateExportFrame(frameBytes);
        } catch (error) {
          if (error instanceof OverlayExportError) {
            throw toHttpError(error);
          }
          throw error;
        }
        slot.busy = true;
        let writeError: unknown = null;
        try {
          await slot.exporter.write(frameBytes);
        } catch (error) {
          writeError = error;
        } finally {
          slot.busy = false;
        }
        if (writeError !== null) {
          if (writeError instanceof OverlayExportError) {
            if (
              writeError.code === "invalid-state" ||
              writeError.code === "process-failed" ||
              writeError.code === "aborted"
            ) {
              // Terminal exporter failure: kill (abort) before dropping, so
              // the child never waits on a stdin nobody will feed.
              dropSlot(slot);
            }
            throw toHttpError(writeError);
          }
          // An unexpected failure leaves the exporter's state unknown: kill
          // and drop rather than keep a slot nobody can trust.
          dropSlot(slot);
          throw writeError;
        }
        // Count the settled write only while this slot still owns the
        // export. A stop may have dropped it while the write was in flight;
        // the captured slot keeps this path from ever dereferencing a slot
        // that is no longer active.
        if (active !== slot) {
          throw new HttpError(409, "export_not_active", "the export is not active");
        }
        slot.framesWritten += 1;
        return {
          status: 202,
          json: { accepted: true, framesWritten: slot.framesWritten }
        };
      }

      if (request.method === "POST" && request.path === EXPORT_STOP_PATH) {
        const slot = active;
        if (slot === null) {
          throw new HttpError(409, "export_not_active", "no export is running");
        }
        // Stopping is terminal regardless of the close outcome: the writer
        // refuses further work after close, so the slot must go. No abort
        // here — close() owns the bounded shutdown (stdin EOF, then the kill
        // fallback), which is what retires the child; aborting instead would
        // turn every clean stop into a killed run.
        active = null;
        try {
          const result = await slot.exporter.close();
          return {
            status: 200,
            json: {
              stopped: true,
              fileName: slot.fileName,
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
