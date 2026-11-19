import type { Frame, GamePosition } from "@chessonglass/contracts";
import {
  GeometryState,
  OverlayError,
  renderOverlay as renderOverlayDefault,
  resolveOverlayDisplay,
  type CurrentGeometry,
  type OverlayDisplay,
  type OverlayInput,
  type OverlayResult
} from "@chessonglass/perception";
import { HttpError } from "./errors.js";
import type { ComposableRoutes, DashboardResponse } from "./server.js";

export const OVERLAY_FRAME_PATH = "/api/overlay/frame";
export const OVERLAY_STATUS_PATH = "/api/overlay/status";

/**
 * Everything the overlay routes need from the capture pipeline, injected as
 * one provider. The routes never reach into the coordinator: the caller
 * maps coordinator state into this shape at the composition root, including
 * the coordinator `Result` → perception `OverlayResult` mapping
 * (moveUci/status/reason) that keeps perception free of game imports.
 */
export type OverlayPipelineSnapshot = Readonly<{
  latestFrame: Frame | null;
  geometryState: GeometryState | null;
  result: OverlayResult | null;
  position: GamePosition | null;
  /** Operator-facing note (e.g. last provider error); always untrusted. */
  note: string | null;
}>;

export type OverlayRoutesOptions = {
  /** Read the current pipeline state once per request. */
  pipeline(): OverlayPipelineSnapshot;
  /** Injectable for tests; defaults to the perception renderer. */
  renderOverlay?(input: OverlayInput): Promise<Uint8Array>;
  /** Injectable monotonic clock for freshness, default `performance.now`. */
  now?(): number;
};

/**
 * Local dashboard overlay preview routes, mounted behind the plan-02
 * authorization wall (token + loopback + origin checks run in the server
 * before routes see a request). Responses are no-store so a stale preview
 * can never be cached.
 *
 * Availability design (no pipeline vs. hidden overlay):
 * - No captured frame at all → 503 JSON (`overlay_unavailable`): there is
 *   nothing to compose onto, and a structured error lets the UI show a
 *   status line without pretending an image exists.
 * - A frame with absent/stale geometry → 200 status-only JPEG: the labeled
 *   "Overlay hidden" frame is the renderer's normal hidden state, not an
 *   error, so the preview endpoint keeps answering with a displayable image.
 */
export function createOverlayRoutes(options: OverlayRoutesOptions): ComposableRoutes {
  const renderOverlay = options.renderOverlay ?? renderOverlayDefault;
  const now = options.now ?? (() => performance.now());

  function resolveGeometry(
    geometryState: GeometryState | null
  ): { geometry: CurrentGeometry | null; invalidation: ReturnType<GeometryState["lastInvalidation"]> } {
    if (geometryState === null) {
      return { geometry: null, invalidation: null };
    }
    // Read freshness exactly once per request: current() clears expired
    // state as a side effect, and a second read could flip the answer.
    return { geometry: geometryState.current(now()), invalidation: geometryState.lastInvalidation() };
  }

  return {
    bodyPolicy() {
      return null;
    },

    async handle(request): Promise<DashboardResponse | null> {
      if (request.method !== "GET") {
        return null;
      }

      if (request.path === OVERLAY_STATUS_PATH) {
        const snapshot = options.pipeline();
        const { geometry, invalidation } = resolveGeometry(snapshot.geometryState);
        const display: OverlayDisplay = resolveOverlayDisplay({
          geometry,
          frame: snapshot.latestFrame,
          result: snapshot.result,
          invalidation,
          position: snapshot.position,
          note: snapshot.note
        });
        return {
          status: 200,
          headers: { "Cache-Control": "no-store" },
          json: {
            // No frame at all is a different state from a frame with a
            // hidden overlay: the UI needs to say "nothing is streaming"
            // rather than "the overlay is hidden".
            overlay:
              snapshot.latestFrame === null
                ? "unavailable"
                : display.kind === "hidden"
                  ? "hidden"
                  : "active",
            tracking: geometry !== null,
            frameSequence: snapshot.latestFrame?.sequence.toString() ?? null,
            geometrySequence: geometry?.sequence.toString() ?? null,
            reason: invalidation?.reason ?? null,
            result:
              snapshot.result === null
                ? null
                : { moveUci: snapshot.result.moveUci, status: snapshot.result.status }
          }
        };
      }

      if (request.path !== OVERLAY_FRAME_PATH) {
        return null;
      }

      const snapshot = options.pipeline();
      if (snapshot.latestFrame === null) {
        throw new HttpError(
          503,
          "overlay_unavailable",
          "no captured frame is available for the overlay preview"
        );
      }
      // The renderer reads freshness from the state itself, exactly once, so
      // the labeled hidden frame carries the recorded invalidation reason.
      let bytes: Uint8Array;
      try {
        bytes = await renderOverlay({
          frame: snapshot.latestFrame,
          position: snapshot.position,
          result: snapshot.result,
          geometry: snapshot.geometryState,
          note: snapshot.note
        });
      } catch (error) {
        if (error instanceof OverlayError) {
          if (error.code === "frame-too-large") {
            throw new HttpError(413, "payload_too_large", "captured frame is too large");
          }
          throw new HttpError(
            503,
            "overlay_unavailable",
            "overlay preview could not be rendered for the captured frame"
          );
        }
        throw error;
      }
      return {
        status: 200,
        headers: { "Cache-Control": "no-store" },
        contentType: "image/jpeg",
        bytes
      };
    }
  };
}
