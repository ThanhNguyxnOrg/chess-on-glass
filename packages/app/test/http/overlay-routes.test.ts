import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Frame, GamePosition, SessionId, SourceId } from "@chessonglass/contracts";
import {
  GeometryState,
  fitBoardHomography,
  type GeometryConfidence,
  type Homography,
  type OverlayResult
} from "@chessonglass/perception";
import { startDashboardServer, type DashboardServer } from "../../src/http/server.js";
import {
  createOverlayRoutes,
  OVERLAY_FRAME_PATH,
  OVERLAY_STATUS_PATH,
  type OverlayPipelineSnapshot
} from "../../src/http/overlay-routes.js";
import { startWindowsApplication, type WindowsApplication } from "../../src/runtime/windows-application.js";

type RawResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

function send(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers
      },
      (response) => {
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks)
          })
        );
      }
    );
    request.on("error", reject);
    request.end();
  });
}

const WIDTH = 32;
const HEIGHT = 24;
const BOARD_CORNERS = {
  nearLeft: [2, 22],
  nearRight: [30, 22],
  farRight: [30, 2],
  farLeft: [2, 2]
} as const;
const TRANSFORM: Homography = fitBoardHomography(BOARD_CORNERS, WIDTH, HEIGHT);

async function fixtureJpeg(): Promise<Uint8Array> {
  const { default: sharp } = await import("sharp");
  return new Uint8Array(
    await sharp({
      create: { width: WIDTH, height: HEIGHT, channels: 3, background: { r: 10, g: 20, b: 30 } }
    })
      .jpeg()
      .toBuffer()
  );
}

function makeFrame(bytes: Uint8Array, sequence = 7n): Frame {
  const receivedAtMonotonicMs = performance.now();
  return {
    sessionId: "session-1" as SessionId,
    sourceId: "source-1" as SourceId,
    sequence,
    capturedAtMonotonicMs: null,
    capturedAtWallMs: 0,
    receivedAtMonotonicMs,
    bytes,
    mimeType: "image/jpeg"
  };
}

function confidence(sequence: bigint): GeometryConfidence {
  return { inlierRatio: 0.95, reprojectionErrorPx: 1.5, observedSequence: sequence };
}

function position(): GamePosition {
  const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  return {
    initialFen: fen,
    fen,
    history: [],
    uncertainty: { castlingRights: true, enPassant: false, promotion: false }
  };
}

describe("overlay routes", () => {
  let server: DashboardServer;
  let pipeline: OverlayPipelineSnapshot;
  let geometryState: GeometryState;
  let jpeg: Uint8Array;

  beforeEach(async () => {
    jpeg = await fixtureJpeg();
    geometryState = new GeometryState({ lifetimeMs: 60_000 });
    pipeline = {
      latestFrame: null,
      geometryState,
      result: null,
      position: null,
      note: null
    };
    const routes = createOverlayRoutes({ pipeline: () => pipeline });
    server = await startDashboardServer({
      staticDir: await mkdtemp(join(tmpdir(), "cog-overlay-")),
      routes: {
        async handle(request) {
          return (
            (await routes.handle(request)) ?? {
              status: 404,
              json: { error: { code: "not_found", message: "no route" } }
            }
          );
        },
        bodyPolicy: (request) => routes.bodyPolicy(request)
      }
    });
  });

  afterEach(async () => {
    await server.close();
  });

  const port = (): number => Number(new URL(server.url).port);
  const authHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${server.localSession.token}`
  });

  it("answers 503 JSON while the pipeline has no frame at all", async () => {
    const frame = await send({ port: port(), method: "GET", path: OVERLAY_FRAME_PATH, headers: authHeaders() });
    expect(frame.status).toBe(503);
    expect(JSON.parse(frame.body.toString("utf8"))).toMatchObject({
      error: { code: "overlay_unavailable" }
    });

    const status = await send({ port: port(), method: "GET", path: OVERLAY_STATUS_PATH, headers: authHeaders() });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body.toString("utf8"))).toMatchObject({
      overlay: "unavailable",
      frameSequence: null,
      tracking: false
    });
  });

  it("serves the composed overlay image with no-store when the pipeline is live", async () => {
    const frame = makeFrame(jpeg, 7n);
    geometryState.update(frame, TRANSFORM, confidence(7n));
    pipeline = {
      ...pipeline,
      latestFrame: frame,
      result: { moveUci: "e2e4", status: "ready", reason: null } satisfies OverlayResult,
      position: position()
    };

    const response = await send({ port: port(), method: "GET", path: OVERLAY_FRAME_PATH, headers: authHeaders() });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body[0]).toBe(0xff);
    expect(response.body[1]).toBe(0xd8);

    const status = await send({ port: port(), method: "GET", path: OVERLAY_STATUS_PATH, headers: authHeaders() });
    expect(status.status).toBe(200);
    const body = JSON.parse(status.body.toString("utf8"));
    expect(body).toMatchObject({
      overlay: "active",
      tracking: true,
      frameSequence: "7",
      geometrySequence: "7",
      result: { moveUci: "e2e4", status: "ready" }
    });
  });

  it("answers a labeled status-only image when the frame has no trusted geometry", async () => {
    pipeline = { ...pipeline, latestFrame: makeFrame(jpeg, 7n) };

    const response = await send({ port: port(), method: "GET", path: OVERLAY_FRAME_PATH, headers: authHeaders() });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.body[0]).toBe(0xff);
    expect(response.body[1]).toBe(0xd8);

    const status = await send({ port: port(), method: "GET", path: OVERLAY_STATUS_PATH, headers: authHeaders() });
    const body = JSON.parse(status.body.toString("utf8"));
    expect(body.overlay).toBe("hidden");
    expect(body.tracking).toBe(false);
    expect(body.frameSequence).toBe("7");
  });

  it("maps renderer failures to typed HTTP errors without leaking internals", async () => {
    pipeline = { ...pipeline, latestFrame: makeFrame(Buffer.from("not a jpeg"), 7n) };

    const response = await send({ port: port(), method: "GET", path: OVERLAY_FRAME_PATH, headers: authHeaders() });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({
      error: { code: "overlay_unavailable" }
    });
  });

  it("requires authorization and answers only GET", async () => {
    const unauthorized = await send({ port: port(), method: "GET", path: OVERLAY_FRAME_PATH });
    expect(unauthorized.status).toBe(401);

    // Mutations need the allowed origin (server CSRF wall) before routing.
    const forbidden = await send({ port: port(), method: "POST", path: OVERLAY_FRAME_PATH, headers: authHeaders() });
    expect(forbidden.status).toBe(403);

    const posted = await send({
      port: port(),
      method: "POST",
      path: OVERLAY_FRAME_PATH,
      headers: { ...authHeaders(), Origin: server.localSession.origin }
    });
    expect(posted.status).toBe(404);
  });

  it("stays available through the composed application before any pipeline exists", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "cog-overlay-app-"));
    await writeFile(join(staticDir, "index.html"), "<h1>ChessOnGlass</h1>", "utf8");
    let app: WindowsApplication | null = null;
    try {
      app = await startWindowsApplication({ staticDir });
      const url = new URL(app.url);
      const status = await send({
        port: Number(url.port),
        method: "GET",
        path: OVERLAY_STATUS_PATH,
        headers: { Authorization: "Bearer placeholder" }
      });
      // Without a token the route is rejected by the same authorization wall.
      expect(status.status).toBe(401);

      const launched = new URL(app.launchUrl);
      const authorized = await send({
        port: Number(launched.port),
        method: "GET",
        path: OVERLAY_STATUS_PATH,
        headers: { Authorization: `Bearer ${launched.hash.slice("#token=".length)}` }
      });
      expect(authorized.status).toBe(200);
      const body = JSON.parse(authorized.body.toString("utf8"));
      expect(body.overlay).toBe("unavailable");

      const frame = await send({
        port: Number(launched.port),
        method: "GET",
        path: OVERLAY_FRAME_PATH,
        headers: { Authorization: `Bearer ${launched.hash.slice("#token=".length)}` }
      });
      expect(frame.status).toBe(503);
    } finally {
      await app?.close();
      await rm(staticDir, { recursive: true, force: true });
    }
  });
});
