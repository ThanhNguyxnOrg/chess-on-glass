import type { GameCoordinator } from "@chessonglass/game";
import type {
  ComposableRoutes,
  DashboardRequest,
  DashboardResponse,
  StreamResponder
} from "./server.js";
import { toDashboardSnapshot } from "../runtime/view-model.js";

export type DashboardRoutesOptions = {
  coordinator: GameCoordinator;
};

export function createDashboardRoutes(
  options: DashboardRoutesOptions
): ComposableRoutes & { stream(request: DashboardRequest, responder: StreamResponder): boolean } {
  return {
    bodyPolicy() {
      return null;
    },

    stream(request, responder) {
      if (request.path !== "/api/events" || request.method !== "GET") {
        return false;
      }
      responder.writeHead(200, { "Cache-Control": "no-store" });
      const snapshot = options.coordinator.snapshot();
      responder.write(`data: ${JSON.stringify(toDashboardSnapshot(snapshot))}\n\n`);
      const unsubscribe = options.coordinator.subscribe((snap) => {
        responder.write(`data: ${JSON.stringify(toDashboardSnapshot(snap))}\n\n`);
      });
      responder.signal.addEventListener("abort", () => unsubscribe(), { once: true });
      return true;
    },

    async handle(request): Promise<DashboardResponse | null> {
      const { coordinator } = options;

      if (request.path === "/api/snapshot" && request.method === "GET") {
        return { status: 200, json: toDashboardSnapshot(coordinator.snapshot()) };
      }

      if (request.path === "/api/command" && request.method === "POST") {
        const command = request.json as { type: string; [key: string]: unknown };
        if (typeof command?.type !== "string") {
          return { status: 400, json: { error: { code: "bad_request", message: "command.type is required" } } };
        }
        await coordinator.dispatch(command as never);
        return { status: 202, json: { accepted: true } };
      }

      return null;
    }
  };
}
