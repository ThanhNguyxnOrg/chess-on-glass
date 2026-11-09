import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newSessionId, newSourceId } from "@chessonglass/contracts";
import { apiError } from "../../src/api/api-error.js";
import {
  createBrowserFrameRoutes,
  type BrowserUploadTarget
} from "../../src/http/browser-frame-routes.js";
import {
  FRAME_BODY_LIMIT,
  startDashboardServer,
  type DashboardRoutes,
  type DashboardResponse,
  type DashboardServer
} from "../../src/http/server.js";
import { BrowserFrameSource } from "../../src/sources/browser-frame-source.js";

type RawResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

function send(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string | string[]>;
  body?: Buffer;
}): Promise<RawResponse> {
  const headers: Record<string, string | string[]> = { ...(options.headers ?? {}) };
  if (
    options.body !== undefined &&
    headers["Content-Length"] === undefined &&
    headers["Transfer-Encoding"] === undefined
  ) {
    headers["Content-Length"] = String(options.body.byteLength);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let status = 0;
    let responseHeaders: IncomingHttpHeaders = {};
    const chunks: Buffer[] = [];
    const finish = (): void => {
      if (!settled) {
        settled = true;
        resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks) });
      }
    };

    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: options.port,
        method: options.method,
        path: options.path,
        headers
      },
      (response) => {
        status = response.statusCode ?? 0;
        responseHeaders = response.headers;
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", finish);
        // An early 413 closes the socket while the client is still
        // uploading; the response has already been delivered.
        response.on("close", finish);
      }
    );
    request.on("error", (error) => {
      if (status !== 0) {
        finish();
      } else {
        reject(error);
      }
    });
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

describe("browser frame upload boundary", () => {
  let staticDir: string;
  let server: DashboardServer;
  let source: BrowserFrameSource;
  let sessionId: ReturnType<typeof newSessionId>;
  let sourceId: ReturnType<typeof newSourceId>;
  let positionVersion: number;
  let now: number;

  beforeEach(async () => {
    staticDir = await mkdtemp(join(tmpdir(), "cog-frames-"));
    await writeFile(join(staticDir, "index.html"), "<h1>ChessOnGlass</h1>", "utf8");

    sessionId = newSessionId();
    sourceId = newSourceId();
    source = new BrowserFrameSource(sessionId, sourceId);
    positionVersion = 3;
    now = 1_000;

    const target = (): BrowserUploadTarget => ({
      source,
      sessionId,
      positionVersion
    });
    const browserRoutes = createBrowserFrameRoutes({
      target,
      decodeJpeg: async (bytes) => {
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
          throw new Error("not a jpeg");
        }
        return bytes;
      },
      now: () => now
    });
    const routes: DashboardRoutes = {
      async handle(request) {
        return (
          (await browserRoutes.handle(request)) ?? {
            status: 404,
            json: apiError("not_found", "no route")
          }
        );
      },
      bodyPolicy: (request) => browserRoutes.bodyPolicy(request)
    };
    server = await startDashboardServer({ staticDir, routes });
  });

  afterEach(async () => {
    await server.close();
    await source.close();
    await rm(staticDir, { recursive: true, force: true });
  });

  const port = (): number => Number(new URL(server.url).port);
  const token = (): string => server.localSession.token;
  const origin = (): string => server.localSession.origin;

  function frameHeaders(input: {
    sequence: bigint;
    session?: string;
    sourceValue?: string;
    version?: number;
    clientMonotonicMs?: number;
    contentType?: string;
  }): Record<string, string> {
    return {
      Authorization: `Bearer ${token()}`,
      Origin: origin(),
      "Content-Type": input.contentType ?? "image/jpeg",
      "x-frame-session": input.session ?? sessionId,
      "x-frame-source": input.sourceValue ?? sourceId,
      "x-frame-sequence": input.sequence.toString(),
      "x-frame-wall-ms": "1700000000000",
      "x-frame-request-id": "request-1",
      "x-frame-position-version": String(input.version ?? positionVersion),
      ...(input.clientMonotonicMs === undefined
        ? {}
        : { "x-frame-client-monotonic-ms": String(input.clientMonotonicMs) })
    };
  }

  it("rejects unauthorized, wrong-session and stale-position uploads", async () => {
    const unauthorized = await send({
      port: port(),
      method: "POST",
      path: "/api/source/browser/frame",
      headers: { ...frameHeaders({ sequence: 1n }), Authorization: "Bearer wrong" },
      body: JPEG
    });
    expect(unauthorized.status).toBe(401);

    const wrongSession = await send({
      port: port(),
      method: "POST",
      path: "/api/source/browser/frame",
      headers: frameHeaders({ sequence: 1n, session: newSessionId() }),
      body: JPEG
    });
    expect(wrongSession.status).toBe(403);

    const wrongSource = await send({
      port: port(),
      method: "POST",
      path: "/api/source/browser/frame",
      headers: frameHeaders({ sequence: 1n, sourceValue: newSourceId() }),
      body: JPEG
    });
    expect(wrongSource.status).toBe(403);

    const stale = await send({
      port: port(),
      method: "POST",
      path: "/api/source/browser/frame",
      headers: frameHeaders({ sequence: 1n, version: positionVersion - 1 }),
      body: JPEG
    });
    expect(stale.status).toBe(409);
  });

  it("rejects oversize bodies and invalid images before state changes", async () => {
    // The declared length alone is enough to reject; the server must not read
    // or buffer the oversized upload.
    const oversize = await send({
      port: port(),
      method: "POST",
      path: "/api/source/browser/frame",
      headers: {
        ...frameHeaders({ sequence: 1n }),
        "Content-Length": String(FRAME_BODY_LIMIT + 1)
      }
    });
    expect(oversize.status).toBe(413);

    const invalid = await send({
      port: port(),
      method: "POST",
      path: "/api/source/browser/frame",
      headers: frameHeaders({ sequence: 1n }),
      body: Buffer.from("not a jpeg")
    });
    expect(invalid.status).toBe(400);

    const wrongType = await send({
      port: port(),
      method: "POST",
      path: "/api/source/browser/frame",
      headers: frameHeaders({ sequence: 1n, contentType: "application/json" }),
      body: JPEG
    });
    expect(wrongType.status).toBe(415);
  });

  it("accepts a fresh frame, ignores the client monotonic clock and rejects replays", async () => {
    now = 4_242;
    const accepted = await send({
      port: port(),
      method: "POST",
      path: "/api/source/browser/frame",
      headers: frameHeaders({
        sequence: 5n,
        clientMonotonicMs: Number.MAX_SAFE_INTEGER
      }),
      body: JPEG
    });
    expect(accepted.status).toBe(202);
    expect(JSON.parse(accepted.body.toString("utf8"))).toEqual({
      accepted: true,
      receivedAtMonotonicMs: 4_242
    });

    const duplicate = await send({
      port: port(),
      method: "POST",
      path: "/api/source/browser/frame",
      headers: frameHeaders({ sequence: 5n }),
      body: JPEG
    });
    expect(duplicate.status).toBe(409);

    const outOfOrder = await send({
      port: port(),
      method: "POST",
      path: "/api/source/browser/frame",
      headers: frameHeaders({ sequence: 4n }),
      body: JPEG
    });
    expect(outOfOrder.status).toBe(409);

    const frame = await source.next(new AbortController().signal);
    expect(frame).not.toBeNull();
    expect(frame?.sessionId).toBe(sessionId);
    expect(frame?.sourceId).toBe(sourceId);
    expect(frame?.sequence).toBe(5n);
    expect(frame?.capturedAtMonotonicMs).toBeNull();
    expect(frame?.capturedAtWallMs).toBe(1_700_000_000_000);
    expect(frame?.receivedAtMonotonicMs).toBe(4_242);
    expect(frame?.mimeType).toBe("image/jpeg");
  });

  it("validates and re-encodes real JPEGs with the default sharp decoder", async () => {
    const { default: sharp } = await import("sharp");
    const realJpeg = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 10, g: 20, b: 30 }
      }
    })
      .jpeg()
      .toBuffer();

    const realRoutes = createBrowserFrameRoutes({
      target: () => ({ source, sessionId, positionVersion })
    });
    const realServer = await startDashboardServer({
      staticDir,
      routes: {
        async handle(request): Promise<DashboardResponse> {
          return (
            (await realRoutes.handle(request)) ?? {
              status: 404,
              json: apiError("not_found", "no route")
            }
          );
        },
        bodyPolicy: (request) => realRoutes.bodyPolicy(request)
      }
    });

    const accepted = await send({
      port: Number(new URL(realServer.url).port),
      method: "POST",
      path: "/api/source/browser/frame",
      headers: {
        Authorization: `Bearer ${realServer.localSession.token}`,
        Origin: realServer.localSession.origin,
        "Content-Type": "image/jpeg",
        "x-frame-session": sessionId,
        "x-frame-source": sourceId,
        "x-frame-sequence": "9",
        "x-frame-wall-ms": "1700000000000",
        "x-frame-request-id": "request-9",
        "x-frame-position-version": String(positionVersion)
      },
      body: realJpeg
    });
    expect(accepted.status).toBe(202);

    const garbage = await send({
      port: Number(new URL(realServer.url).port),
      method: "POST",
      path: "/api/source/browser/frame",
      headers: {
        Authorization: `Bearer ${realServer.localSession.token}`,
        Origin: realServer.localSession.origin,
        "Content-Type": "image/jpeg",
        "x-frame-session": sessionId,
        "x-frame-source": sourceId,
        "x-frame-sequence": "10",
        "x-frame-wall-ms": "1700000000000",
        "x-frame-request-id": "request-10",
        "x-frame-position-version": String(positionVersion)
      },
      body: Buffer.from("not a jpeg at all")
    });
    expect(garbage.status).toBe(400);

    const frame = await source.next(new AbortController().signal);
    expect(frame?.bytes[0]).toBe(0xff);
    expect(frame?.bytes[1]).toBe(0xd8);

    await realServer.close();
  });

  it("answers 503 when no browser source is active", async () => {
    const accepting = new BrowserFrameSource(sessionId, sourceId);
    const idleRoutes = createBrowserFrameRoutes({
      target: () => null,
      decodeJpeg: async (bytes) => bytes
    });
    const idleServer = await startDashboardServer({
      staticDir,
      routes: {
        async handle(request): Promise<DashboardResponse> {
          return (
            (await idleRoutes.handle(request)) ?? {
              status: 404,
              json: apiError("not_found", "no route")
            }
          );
        },
        bodyPolicy: (request) => idleRoutes.bodyPolicy(request)
      }
    });

    const response = await send({
      port: Number(new URL(idleServer.url).port),
      method: "POST",
      path: "/api/source/browser/frame",
      headers: {
        Authorization: `Bearer ${idleServer.localSession.token}`,
        Origin: idleServer.localSession.origin,
        "Content-Type": "image/jpeg",
        "x-frame-session": sessionId,
        "x-frame-source": sourceId,
        "x-frame-sequence": "1",
        "x-frame-wall-ms": "1700000000000",
        "x-frame-request-id": "request-1",
        "x-frame-position-version": "0"
      },
      body: JPEG
    });
    expect(response.status).toBe(503);

    await idleServer.close();
    await accepting.close();
  });
});
