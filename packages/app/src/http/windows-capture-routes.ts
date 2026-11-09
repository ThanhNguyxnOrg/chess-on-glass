import type { WindowsCaptureBackend } from "../native/windows-capture-client.js";

import { HttpError, badRequest } from "./errors.js";
import type {
  ComposableRoutes,
  DashboardResponse
} from "./server.js";

export const SCREEN_TARGETS_PATH = "/api/source/screen/targets";
export const SCREEN_PICK_PATH = "/api/source/screen/pick";
export const SCREEN_PREVIEW_PATH = "/api/source/screen/preview";
export const SCREEN_START_PATH = "/api/source/screen/start";
export const SCREEN_STOP_PATH = "/api/source/screen/stop";

export type WindowsCaptureRoutesOptions = {
  backend: WindowsCaptureBackend;
  start?(targetId: string): Promise<void>;
  stop?(): Promise<void>;
};

function requireTargetId(json: unknown): string {
  if (typeof json === "object" && json !== null) {
    const value = (json as Record<string, unknown>)["targetId"];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  throw badRequest("targetId is required");
}

/**
 * Consented window capture routes: list, pick, preview, start and stop. A
 * target stays an opaque id; titles are only ever JSON strings.
 */
export function createWindowsCaptureRoutes(
  options: WindowsCaptureRoutesOptions
): ComposableRoutes {
  const controller = new AbortController();

  return {
    bodyPolicy() {
      return null;
    },

    async handle(request): Promise<DashboardResponse | null> {
      if (request.path === SCREEN_TARGETS_PATH && request.method === "GET") {
        const targets = await options.backend.listTargets(controller.signal);
        return { status: 200, json: { targets } };
      }

      if (request.path === SCREEN_PICK_PATH && request.method === "POST") {
        const target = await options.backend.pickTarget(controller.signal);
        return { status: 200, json: { target } };
      }

      if (request.path === SCREEN_PREVIEW_PATH && request.method === "POST") {
        const targetId = requireTargetId(request.json);
        let bytes: Uint8Array;
        try {
          bytes = await options.backend.preview(targetId, controller.signal);
        } catch (error) {
          if (
            error instanceof Error &&
            /unknown capture target/i.test(error.message)
          ) {
            throw new HttpError(404, "target_not_found", "capture target not found");
          }
          throw new HttpError(502, "capture_failed", "window capture failed");
        }
        return { status: 200, contentType: "image/jpeg", bytes };
      }

      if (request.path === SCREEN_START_PATH && request.method === "POST") {
        if (options.start === undefined) {
          throw new HttpError(
            503,
            "source_unavailable",
            "window capture start is unavailable"
          );
        }
        await options.start(requireTargetId(request.json));
        return { status: 202, json: { started: true } };
      }

      if (request.path === SCREEN_STOP_PATH && request.method === "POST") {
        if (options.stop === undefined) {
          throw new HttpError(
            503,
            "source_unavailable",
            "window capture stop is unavailable"
          );
        }
        await options.stop();
        return { status: 202, json: { stopped: true } };
      }

      return null;
    }
  };
}
