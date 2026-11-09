import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import type { Socket } from "node:net";
import {
  createLocalSession,
  isAllowedOrigin,
  isAuthorized,
  type LocalSession
} from "./auth.js";
import { inspectBodyLength, readBodyBytes } from "./body.js";
import {
  HttpError,
  badRequest,
  forbiddenOrigin,
  methodNotAllowed,
  unauthorized,
  unsupportedMediaType
} from "./errors.js";
import { StaticFiles } from "./static-files.js";

export const JSON_BODY_LIMIT = 16 * 1024;
export const FRAME_BODY_LIMIT = 5 * 1024 * 1024;
export const API_PREFIX = "/api";

const REQUEST_TIMEOUT_MS = 15_000;
const HEADERS_TIMEOUT_MS = 10_000;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
  "Cache-Control": "no-store"
};

export type DashboardRequest = Readonly<{
  method: string;
  path: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: Uint8Array | null;
  json: unknown;
}>;

export type DashboardResponse = Readonly<{
  status: number;
  headers?: Readonly<Record<string, string>>;
  json?: unknown;
  bytes?: Uint8Array;
  contentType?: string;
}>;

export type BodyPolicy = Readonly<{
  limit: number;
  contentType: "application/json" | "image/jpeg";
}>;

export type StreamResponder = Readonly<{
  signal: AbortSignal;
  writeHead(status: number, headers?: Readonly<Record<string, string>>): void;
  write(chunk: string): void;
  close(): void;
}>;

export interface DashboardRoutes {
  handle(request: DashboardRequest): Promise<DashboardResponse>;
  bodyPolicy?(request: Readonly<{ method: string; path: string }>): BodyPolicy | null;
  stream?(request: DashboardRequest, responder: StreamResponder): boolean;
}

export type DashboardServer = Readonly<{
  url: string;
  launchUrl: string;
  localSession: LocalSession;
  close(): Promise<void>;
}>;

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return undefined;
}

function acceptsEventStream(request: IncomingMessage): boolean {
  const accept = headerValue(request.headers.accept)?.toLowerCase() ?? "";
  return accept.includes("text/event-stream");
}

function writeJsonError(response: ServerResponse, error: HttpError): void {
  const payload = JSON.stringify(error.body);
  const headers: Record<string, string | number> = {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  };
  if (error.closeConnection) {
    headers.Connection = "close";
  }
  response.writeHead(error.status, headers);
  // The Connection: close header ends the socket after this response; the
  // request stream stays drained so the client can finish its upload.
  response.end(payload);
}

function writeBytes(
  response: ServerResponse,
  status: number,
  contentType: string,
  bytes: Uint8Array,
  extraHeaders?: Readonly<Record<string, string>>
): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    "Content-Type": contentType,
    "Content-Length": bytes.byteLength
  });
  response.end(bytes);
}

function writePlain(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(message)
  });
  response.end(message);
}

function writeDashboardResponse(
  response: ServerResponse,
  result: DashboardResponse
): void {
  if (result.bytes !== undefined) {
    writeBytes(
      response,
      result.status,
      result.contentType ?? "application/octet-stream",
      result.bytes,
      result.headers
    );
    return;
  }
  const payload = result.json === undefined ? "" : JSON.stringify(result.json);
  response.writeHead(result.status, {
    ...SECURITY_HEADERS,
    ...result.headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

function createStreamResponder(response: ServerResponse): {
  responder: StreamResponder;
  close: () => void;
} {
  const controller = new AbortController();
  let closed = false;

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    controller.abort();
    response.end();
  };

  response.on("close", () => {
    closed = true;
    controller.abort();
  });

  return {
    responder: {
      signal: controller.signal,
      writeHead(status, headers) {
        if (closed) {
          return;
        }
        response.writeHead(status, {
          ...SECURITY_HEADERS,
          "Content-Type": "text/event-stream; charset=utf-8",
          ...headers
        });
        response.flushHeaders();
      },
      write(chunk) {
        if (!closed) {
          response.write(chunk);
        }
      },
      close
    },
    close
  };
}

/**
 * Loopback-only dashboard server. It owns authorization, framing limits,
 * security headers and static-file confinement; routes never see a request
 * that failed those checks.
 */
export async function startDashboardServer(options: {
  staticDir: string;
  routes: DashboardRoutes;
  port?: number;
}): Promise<DashboardServer> {
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("port must be a valid TCP port");
  }

  const staticFiles = new StaticFiles(options.staticDir);
  const sockets = new Set<Socket>();
  let session: LocalSession | null = null;

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    try {
      if (session === null) {
        throw new Error("dashboard server is not ready");
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = (request.method ?? "GET").toUpperCase();
      const path = url.pathname;
      const isApi = path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);

      if (!isApi) {
        if (method !== "GET") {
          throw methodNotAllowed();
        }
        const asset = await staticFiles.serve(path);
        if (asset === null) {
          writePlain(response, 404, "not found");
          return;
        }
        writeBytes(response, 200, asset.contentType, asset.bytes);
        return;
      }

      if (!isAuthorized(session, headerValue(request.headers.authorization))) {
        throw unauthorized();
      }
      if (
        MUTATION_METHODS.has(method) &&
        !isAllowedOrigin(session, headerValue(request.headers.origin))
      ) {
        throw forbiddenOrigin();
      }

      const policy = options.routes.bodyPolicy?.({ method, path }) ?? {
        limit: JSON_BODY_LIMIT,
        contentType: "application/json" as const
      };
      const length = inspectBodyLength(
        request,
        policy.limit,
        BODY_METHODS.has(method)
      );

      let body: Uint8Array | null = null;
      let json: unknown = null;
      if (length !== null) {
        if (length > 0) {
          const contentType = headerValue(request.headers["content-type"]);
          if (
            contentType === undefined ||
            !contentType.toLowerCase().startsWith(policy.contentType)
          ) {
            throw unsupportedMediaType();
          }
        }
        body = await readBodyBytes(request, length);
        if (policy.contentType === "application/json" && body.byteLength > 0) {
          try {
            json = JSON.parse(Buffer.from(body).toString("utf8"));
          } catch {
            throw badRequest("malformed json body");
          }
        }
      }

      const dashboardRequest: DashboardRequest = {
        method,
        path,
        url,
        headers: request.headers,
        body,
        json
      };

      if (
        method === "GET" &&
        options.routes.stream !== undefined &&
        acceptsEventStream(request)
      ) {
        const { responder, close } = createStreamResponder(response);
        let taken = false;
        try {
          taken = options.routes.stream(dashboardRequest, responder);
        } catch (error) {
          close();
          throw error;
        }
        if (taken) {
          return;
        }
      }

      const result = await options.routes.handle(dashboardRequest);
      writeDashboardResponse(response, result);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      writeJsonError(
        response,
        error instanceof HttpError
          ? error
          : new HttpError(500, "internal", "internal server error")
      );
    }
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.destroy();
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("dashboard server did not bind a TCP port");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  session = createLocalSession(origin);

  let closePromise: Promise<void> | null = null;
  return {
    url: `${origin}/`,
    launchUrl: `${origin}/#token=${session.token}`,
    localSession: session,
    close(): Promise<void> {
      closePromise ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
      });
      return closePromise;
    }
  };
}
