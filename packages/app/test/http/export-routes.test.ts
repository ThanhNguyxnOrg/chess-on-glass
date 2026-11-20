import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OverlayExporter, OverlayExporterStartOptions } from "@chessonglass/perception";
import { OverlayExportError } from "@chessonglass/perception";
import { startDashboardServer, type DashboardServer } from "../../src/http/server.js";
import {
  createExportRoutes,
  EXPORT_FRAME_PATH,
  EXPORT_START_PATH,
  EXPORT_STATUS_PATH,
  EXPORT_STOP_PATH,
  type ExportRoutesOptions
} from "../../src/http/export-routes.js";

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
  body?: Uint8Array;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: options.port,
        method: options.method,
        path: options.path,
        headers: {
          "Content-Length": options.body === undefined ? "0" : String(options.body.byteLength),
          ...options.headers
        }
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
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

const SOI = [0xff, 0xd8, 0xff, 0xe0];
const EOI = [0xff, 0xd9];

function jpegBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 4));
  bytes[0] = SOI[0];
  bytes[1] = SOI[1];
  bytes[bytes.byteLength - 2] = EOI[0];
  bytes[bytes.byteLength - 1] = EOI[1];
  return bytes;
}

class FakeExporter implements OverlayExporter {
  started: OverlayExporterStartOptions | null = null;
  writes: Uint8Array[] = [];
  closed = false;
  startError: OverlayExportError | null = null;
  writeError: OverlayExportError | null = null;
  closeError: OverlayExportError | null = null;

  async start(options: OverlayExporterStartOptions): Promise<void> {
    if (this.startError !== null) {
      throw this.startError;
    }
    this.started = options;
  }

  async write(frame: Uint8Array): Promise<void> {
    if (this.writeError !== null) {
      throw this.writeError;
    }
    this.writes.push(frame);
  }

  async close(): Promise<{ outputPath: string; framesWritten: number }> {
    if (this.closeError !== null) {
      throw this.closeError;
    }
    this.closed = true;
    return {
      outputPath: this.started?.outputPath ?? "",
      framesWritten: this.writes.length
    };
  }
}

describe("export routes", () => {
  let server: DashboardServer;
  let exportDirectory: string;
  let exporter: FakeExporter;
  let factoryCalls: number;
  let routesOptions: ExportRoutesOptions;

  beforeEach(async () => {
    exportDirectory = await mkdtemp(join(tmpdir(), "cog-export-routes-"));
    exporter = new FakeExporter();
    factoryCalls = 0;
    routesOptions = {
      exportDirectory: () => exportDirectory,
      createExporter: () => {
        factoryCalls += 1;
        return exporter;
      }
    };
    const routes = createExportRoutes(routesOptions);
    server = await startDashboardServer({
      staticDir: await mkdtemp(join(tmpdir(), "cog-export-static-")),
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
    await rm(exportDirectory, { recursive: true, force: true });
  });

  const port = (): number => Number(new URL(server.url).port);
  const authHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${server.localSession.token}`,
    // Mutations must carry the session origin (the server's plan-02 wall).
    Origin: new URL(server.url).origin
  });

  async function startExport(
    body: Record<string, unknown>,
    headers: Record<string, string> = authHeaders()
  ): Promise<RawResponse> {
    return send({
      port: port(),
      method: "POST",
      path: EXPORT_START_PATH,
      headers: { ...headers, "Content-Type": "application/json" },
      body: Uint8Array.from(Buffer.from(JSON.stringify(body), "utf8"))
    });
  }

  async function postFrame(
    bytes: Uint8Array,
    headers: Record<string, string> = authHeaders()
  ): Promise<RawResponse> {
    return send({
      port: port(),
      method: "POST",
      path: EXPORT_FRAME_PATH,
      headers: { ...headers, "Content-Type": "image/jpeg" },
      body: bytes
    });
  }

  async function stopExport(): Promise<RawResponse> {
    return send({
      port: port(),
      method: "POST",
      path: EXPORT_STOP_PATH,
      headers: authHeaders()
    });
  }

  async function status(): Promise<RawResponse> {
    return send({
      port: port(),
      method: "GET",
      path: EXPORT_STATUS_PATH,
      headers: authHeaders()
    });
  }

  it("reports an idle export with no paths", async () => {
    const response = await status();
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString("utf8"))).toEqual({
      active: false,
      fileName: null,
      framesWritten: 0
    });
  });

  it("starts an export inside the operator-selected directory", async () => {
    const response = await startExport({ fileName: "out.mp4" });
    expect(response.status).toBe(202);
    expect(JSON.parse(response.body.toString("utf8"))).toEqual({
      started: true,
      fileName: "out.mp4",
      fps: 10
    });
    expect(factoryCalls).toBe(1);
    expect(exporter.started).not.toBeNull();
    expect(exporter.started?.outputPath).toBe(join(exportDirectory, "out.mp4"));
    expect(exporter.started?.fps).toBe(10);
    expect(exporter.started?.signal).toBeInstanceOf(AbortSignal);
  });

  it("honors a valid custom fps", async () => {
    const response = await startExport({ fileName: "out.mp4", fps: 30 });
    expect(response.status).toBe(202);
    expect(exporter.started?.fps).toBe(30);
  });

  it("rejects a second export while one is active", async () => {
    await startExport({ fileName: "out.mp4" });
    const response = await startExport({ fileName: "other.mp4" });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({
      error: { code: "export_active" }
    });
    expect(factoryCalls).toBe(1);
  });

  it("rejects traversal, bad names and bad fps without echoing input", async () => {
    for (const body of [
      { fileName: "../evil.mp4" },
      { fileName: "sub/evil.mp4" },
      { fileName: "evil.gif" },
      { fileName: ".." },
      { fileName: "out.mp4", fps: 0 },
      {}
    ]) {
      const response = await startExport(body);
      expect(response.status).toBe(400);
      const parsed = JSON.parse(response.body.toString("utf8")) as {
        error: { code: string; message: string };
      };
      expect(parsed.error.code).toBe("bad_request");
      expect(parsed.error.message).not.toContain("evil");
      expect(parsed.error.message).not.toContain(exportDirectory);
      expect(exporter.started).toBeNull();
    }
    expect(factoryCalls).toBe(0);
  });

  it("answers 503 when ffmpeg is not configured", async () => {
    routesOptions.createExporter = () => null;
    const response = await startExport({ fileName: "out.mp4" });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({
      error: { code: "export_unavailable" }
    });
  });

  it("maps exporter start failures to honest errors without leaking paths", async () => {
    exporter.startError = new OverlayExportError(
      "output-exists",
      `refusing to overwrite ${join(exportDirectory, "out.mp4")}`
    );
    const response = await startExport({ fileName: "out.mp4" });
    expect(response.status).toBe(409);
    const parsed = JSON.parse(response.body.toString("utf8")) as {
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe("export_output_exists");
    expect(parsed.error.message).not.toContain(exportDirectory);
    expect(parsed.error.message).not.toContain("out.mp4");
  });

  it("accepts rendered frames while the export is active", async () => {
    await startExport({ fileName: "out.mp4" });

    const frame = await postFrame(jpegBytes(64));
    expect(frame.status).toBe(202);
    expect(JSON.parse(frame.body.toString("utf8"))).toEqual({
      accepted: true,
      framesWritten: 1
    });
    expect(exporter.writes).toHaveLength(1);

    const statusResponse = await status();
    expect(JSON.parse(statusResponse.body.toString("utf8"))).toEqual({
      active: true,
      fileName: "out.mp4",
      framesWritten: 1
    });
  });

  it("rejects frame bodies that are not bounded jpegs", async () => {
    await startExport({ fileName: "out.mp4" });

    const garbage = await postFrame(Uint8Array.from([0x00, 0x01, 0x02]));
    expect(garbage.status).toBe(400);
    expect(JSON.parse(garbage.body.toString("utf8"))).toMatchObject({
      error: { code: "bad_request" }
    });
    expect(exporter.writes).toHaveLength(0);
  });

  it("enforces the jpeg content type on the frame endpoint", async () => {
    await startExport({ fileName: "out.mp4" });
    const response = await send({
      port: port(),
      method: "POST",
      path: EXPORT_FRAME_PATH,
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: Uint8Array.from([0x00])
    });
    expect(response.status).toBe(415);
  });

  it("rejects frames and stops outside an active export", async () => {
    const frame = await postFrame(jpegBytes(32));
    expect(frame.status).toBe(409);
    expect(JSON.parse(frame.body.toString("utf8"))).toMatchObject({
      error: { code: "export_not_active" }
    });

    const stopped = await stopExport();
    expect(stopped.status).toBe(409);
  });

  it("stops the export with a summary that carries no filesystem paths", async () => {
    await startExport({ fileName: "out.mp4" });
    await postFrame(jpegBytes(64));

    const stopped = await stopExport();
    expect(stopped.status).toBe(200);
    const parsed = JSON.parse(stopped.body.toString("utf8")) as Record<string, unknown>;
    expect(parsed).toEqual({
      stopped: true,
      fileName: "out.mp4",
      framesWritten: 1
    });
    expect(JSON.stringify(parsed)).not.toContain(exportDirectory);
    expect(exporter.closed).toBe(true);

    const statusResponse = await status();
    expect(JSON.parse(statusResponse.body.toString("utf8"))).toMatchObject({
      active: false
    });
    const lateFrame = await postFrame(jpegBytes(64));
    expect(lateFrame.status).toBe(409);
  });

  it("maps exporter write failures to a 502 and deactivates the export", async () => {
    await startExport({ fileName: "out.mp4" });
    exporter.writeError = new OverlayExportError(
      "process-failed",
      `ffmpeg died writing ${join(exportDirectory, "out.mp4")}`
    );

    const frame = await postFrame(jpegBytes(64));
    expect(frame.status).toBe(502);
    const parsed = JSON.parse(frame.body.toString("utf8")) as {
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe("export_failed");
    expect(parsed.error.message).not.toContain(exportDirectory);

    const statusResponse = await status();
    expect(JSON.parse(statusResponse.body.toString("utf8"))).toMatchObject({
      active: false
    });
  });

  it("maps close failures to a 502 without leaking the output path", async () => {
    await startExport({ fileName: "out.mp4" });
    exporter.closeError = new OverlayExportError(
      "process-failed",
      `ffmpeg exited 1 for ${join(exportDirectory, "out.mp4")}`
    );

    const stopped = await stopExport();
    expect(stopped.status).toBe(502);
    const parsed = JSON.parse(stopped.body.toString("utf8")) as {
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe("export_failed");
    expect(parsed.error.message).not.toContain(exportDirectory);

    const statusResponse = await status();
    expect(JSON.parse(statusResponse.body.toString("utf8"))).toMatchObject({
      active: false
    });
  });
});
