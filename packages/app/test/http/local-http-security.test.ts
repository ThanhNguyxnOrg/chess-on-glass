import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiError } from "../../src/api/api-error.js";
import {
  JSON_BODY_LIMIT,
  startDashboardServer,
  type DashboardRequest,
  type DashboardRoutes,
  type DashboardServer
} from "../../src/http/server.js";

type RawResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

type SendOptions = {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string | string[]>;
  body?: Buffer;
  noFraming?: boolean;
};

function send(options: SendOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers ?? {}
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks)
          });
        });
      }
    );
    request.on("error", reject);
    if (options.noFraming === true) {
      request.useChunkedEncodingByDefault = false;
    }
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

describe("secure loopback dashboard boundary", () => {
  let staticDir: string;
  let outsideDir: string;
  let server: DashboardServer;
  let calls: DashboardRequest[];
  let routes: DashboardRoutes;

  beforeEach(async () => {
    staticDir = await mkdtemp(join(tmpdir(), "cog-ui-"));
    outsideDir = await mkdtemp(join(tmpdir(), "cog-out-"));
    await writeFile(
      join(staticDir, "index.html"),
      "<!doctype html><html><body><h1>ChessOnGlass</h1></body></html>",
      "utf8"
    );
    await mkdir(join(staticDir, "assets"), { recursive: true });
    await writeFile(join(staticDir, "assets", "app.js"), "console.log('ok');\n", "utf8");
    await writeFile(join(outsideDir, "secret.txt"), "outside secret\n", "utf8");
    await symlink(
      outsideDir,
      join(staticDir, "escape"),
      process.platform === "win32" ? "junction" : "dir"
    );

    calls = [];
    routes = {
      async handle(request) {
        calls.push(request);
        if (request.path === "/api/command") {
          return { status: 202, json: { accepted: true } };
        }
        if (request.path === "/api/snapshot") {
          return { status: 200, json: { status: "ready" } };
        }
        return { status: 404, json: apiError("not_found", "no route") };
      }
    };
    server = await startDashboardServer({ staticDir, routes });
  });

  afterEach(async () => {
    await server.close();
    await rm(staticDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  const port = (): number => Number(new URL(server.url).port);
  const token = (): string => server.localSession.token;
  const origin = (): string => server.localSession.origin;

  it("binds loopback, keeps the token out of the base URL and returns it only in the launch fragment", () => {
    expect(new URL(server.url).hostname).toBe("127.0.0.1");
    expect(server.url).not.toContain(token());
    expect(server.launchUrl.startsWith(server.url)).toBe(true);
    expect(new URL(server.launchUrl).hash).toBe(`#token=${token()}`);
  });

  it("rejects missing, invalid and query-string tokens without invoking routes", async () => {
    const missing = await send({ port: port(), method: "GET", path: "/api/snapshot" });
    expect(missing.status).toBe(401);
    expect(missing.headers["www-authenticate"]).toBeUndefined();

    const invalid = await send({
      port: port(),
      method: "GET",
      path: "/api/snapshot",
      headers: { Authorization: "Bearer wrong" }
    });
    expect(invalid.status).toBe(401);

    const query = await send({
      port: port(),
      method: "GET",
      path: `/api/snapshot?token=${token()}`
    });
    expect(query.status).toBe(401);

    expect(calls).toHaveLength(0);
  });

  it("allows an authorized same-origin read", async () => {
    const response = await send({
      port: port(),
      method: "GET",
      path: "/api/snapshot",
      headers: { Authorization: `Bearer ${token()}` }
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString("utf8"))).toEqual({ status: "ready" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("requires the exact origin on mutations and never treats origin as authentication", async () => {
    const payload = JSON.stringify({ type: "pause" });

    for (const originHeader of [undefined, "null", "http://evil.example"]) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(payload))
      };
      if (originHeader !== undefined) {
        headers.Origin = originHeader;
      }
      const response = await send({
        port: port(),
        method: "POST",
        path: "/api/command",
        headers,
        body: Buffer.from(payload)
      });
      expect(response.status).toBe(403);
    }

    // Origin is not authentication: without a token this is 401, not 403.
    const crossSiteOnly = await send({
      port: port(),
      method: "POST",
      path: "/api/command",
      headers: {
        Origin: "http://evil.example",
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(payload))
      },
      body: Buffer.from(payload)
    });
    expect(crossSiteOnly.status).toBe(401);

    const allowed = await send({
      port: port(),
      method: "POST",
      path: "/api/command",
      headers: {
        Authorization: `Bearer ${token()}`,
        Origin: origin(),
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(payload))
      },
      body: Buffer.from(payload)
    });
    expect(allowed.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.json).toEqual({ type: "pause" });
  });

  it("rejects unsupported media types, missing or conflicting lengths, oversize bodies and malformed JSON", async () => {
    const authorized = {
      Authorization: `Bearer ${token()}`,
      Origin: origin()
    };
    const payload = "{}";
    const length = String(Buffer.byteLength(payload));

    const textPlain = await send({
      port: port(),
      method: "POST",
      path: "/api/command",
      headers: {
        ...authorized,
        "Content-Type": "text/plain",
        "Content-Length": length
      },
      body: Buffer.from(payload)
    });
    expect(textPlain.status).toBe(415);

    const noLength = await send({
      port: port(),
      method: "POST",
      path: "/api/command",
      headers: { ...authorized, "Content-Type": "application/json" },
      body: Buffer.from(payload),
      noFraming: true
    });
    expect(noLength.status).toBe(411);

    const chunked = await send({
      port: port(),
      method: "POST",
      path: "/api/command",
      headers: {
        ...authorized,
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked"
      },
      body: Buffer.from(payload)
    });
    expect(chunked.status).toBe(400);

    const conflicting = await send({
      port: port(),
      method: "POST",
      path: "/api/command",
      headers: {
        ...authorized,
        "Content-Type": "application/json",
        "Content-Length": [length, "7"]
      },
      body: Buffer.from(payload)
    });
    expect(conflicting.status).toBe(400);

    const oversize = await send({
      port: port(),
      method: "POST",
      path: "/api/command",
      headers: {
        ...authorized,
        "Content-Type": "application/json",
        "Content-Length": String(JSON_BODY_LIMIT + 1)
      },
      body: Buffer.alloc(JSON_BODY_LIMIT + 1, 0x20)
    });
    expect(oversize.status).toBe(413);
    expect(oversize.headers.connection).toBe("close");

    const malformed = await send({
      port: port(),
      method: "POST",
      path: "/api/command",
      headers: {
        ...authorized,
        "Content-Type": "application/json",
        "Content-Length": "1"
      },
      body: Buffer.from("{")
    });
    expect(malformed.status).toBe(400);

    expect(calls).toHaveLength(0);
  });

  it("serves static assets with strict headers and rejects traversal and symlink escape", async () => {
    const index = await send({ port: port(), method: "GET", path: "/" });
    expect(index.status).toBe(200);
    expect(index.body.toString("utf8")).toContain("ChessOnGlass");
    expect(index.headers["content-security-policy"]).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    expect(index.headers["x-content-type-options"]).toBe("nosniff");
    expect(index.headers["referrer-policy"]).toBe("no-referrer");
    expect(index.headers["permissions-policy"]).toContain("camera=(self)");
    expect(index.headers["cache-control"]).toBe("no-store");
    expect(index.headers["access-control-allow-origin"]).toBeUndefined();

    const asset = await send({ port: port(), method: "GET", path: "/assets/app.js" });
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toContain("javascript");

    const missing = await send({ port: port(), method: "GET", path: "/missing.png" });
    expect(missing.status).toBe(404);

    const encoded = await send({
      port: port(),
      method: "GET",
      path: "/%2e%2e%2fpackage.json"
    });
    expect(encoded.status).toBe(404);

    const backslash = await send({
      port: port(),
      method: "GET",
      path: "/..%5c..%5cpackage.json"
    });
    expect(backslash.status).toBe(404);

    const escaped = await send({
      port: port(),
      method: "GET",
      path: "/escape/secret.txt"
    });
    expect(escaped.status).toBe(404);
    expect(escaped.body.toString("utf8")).not.toContain("outside secret");

    const post = await send({ port: port(), method: "POST", path: "/" });
    expect(post.status).toBe(405);
  });

  it("closes idempotently", async () => {
    await server.close();
    await server.close();
  });
});
