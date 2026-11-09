import type {
  Frame,
  SessionId,
  SourceId
} from "@chessonglass/contracts";
import type { BrowserFrameSource } from "../sources/browser-frame-source.js";
import { parseBrowserFrameHeaders } from "./browser-frame-metadata.js";
import { HttpError, badRequest } from "./errors.js";
import {
  FRAME_BODY_LIMIT,
  type BodyPolicy,
  type DashboardRequest,
  type DashboardResponse
} from "./server.js";

export const BROWSER_FRAME_PATH = "/api/source/browser/frame";
export const BROWSER_START_PATH = "/api/source/browser/start";
export const BROWSER_STOP_PATH = "/api/source/browser/stop";

/** Re-encoded frames never exceed 12 megapixels. */
const MAX_PIXELS = 12_000_000;
const JPEG_QUALITY = 85;

export type BrowserUploadTarget = Readonly<{
  source: BrowserFrameSource;
  sessionId: SessionId;
  positionVersion: number;
}>;

export type BrowserFrameRoutesOptions = {
  target(): BrowserUploadTarget | null;
  decodeJpeg?(bytes: Uint8Array): Promise<Uint8Array>;
  now?(): number;
  start?(): Promise<{ sessionId: SessionId; sourceId: SourceId }>;
  stop?(): Promise<void>;
};

export type ComposableRoutes = {
  handle(request: DashboardRequest): Promise<DashboardResponse | null>;
  bodyPolicy(
    request: Readonly<{ method: string; path: string }>
  ): BodyPolicy | null;
};

async function decodeJpegWithSharp(bytes: Uint8Array): Promise<Uint8Array> {
  const { default: sharp } = await import("sharp");
  const image = sharp(Buffer.from(bytes), {
    failOn: "error",
    limitInputPixels: MAX_PIXELS
  });
  const metadata = await image.metadata();
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new Error("jpeg has no dimensions");
  }
  if (metadata.width * metadata.height > MAX_PIXELS) {
    throw new Error("jpeg exceeds the pixel limit");
  }
  return image.jpeg({ quality: JPEG_QUALITY }).toBuffer();
}

/**
 * Browser upload routes. Validation is backend-owned: authorization and body
 * framing happen in the HTTP boundary, and this layer checks session, source,
 * position version and sequence before a frame may reach the source.
 */
export function createBrowserFrameRoutes(
  options: BrowserFrameRoutesOptions
): ComposableRoutes {
  const decode = options.decodeJpeg ?? decodeJpegWithSharp;
  const now = options.now ?? (() => performance.now());
  let lastAcceptedSequence: bigint | null = null;

  return {
    bodyPolicy(request) {
      if (request.method === "POST" && request.path === BROWSER_FRAME_PATH) {
        return { limit: FRAME_BODY_LIMIT, contentType: "image/jpeg" };
      }
      return null;
    },

    async handle(request) {
      if (request.method !== "POST") {
        return null;
      }

      if (request.path === BROWSER_START_PATH) {
        if (options.start === undefined) {
          throw new HttpError(
            503,
            "source_unavailable",
            "browser source start is unavailable"
          );
        }
        const allocated = await options.start();
        return {
          status: 202,
          json: { sessionId: allocated.sessionId, sourceId: allocated.sourceId }
        };
      }

      if (request.path === BROWSER_STOP_PATH) {
        if (options.stop === undefined) {
          throw new HttpError(
            503,
            "source_unavailable",
            "browser source stop is unavailable"
          );
        }
        await options.stop();
        return { status: 202, json: { stopped: true } };
      }

      if (request.path !== BROWSER_FRAME_PATH) {
        return null;
      }

      const target = options.target();
      if (target === null) {
        throw new HttpError(503, "source_unavailable", "no browser source is active");
      }

      const headers = parseBrowserFrameHeaders(request.headers);
      if (
        headers.sessionId !== target.sessionId ||
        headers.sourceId !== target.source.sourceId
      ) {
        throw new HttpError(
          403,
          "forbidden_source",
          "frame does not belong to the active source"
        );
      }
      if (headers.positionVersion !== target.positionVersion) {
        throw new HttpError(409, "stale_position", "frame position version is stale");
      }
      if (
        lastAcceptedSequence !== null &&
        headers.sequence <= lastAcceptedSequence
      ) {
        throw new HttpError(409, "stale_sequence", "duplicate or out-of-order frame");
      }
      if (request.body === null || request.body.byteLength === 0) {
        throw badRequest("frame body is required");
      }

      let jpeg: Uint8Array;
      try {
        jpeg = await decode(request.body);
      } catch {
        throw badRequest("invalid jpeg frame");
      }

      const receivedAtMonotonicMs = now();
      const frame: Frame = {
        sessionId: target.sessionId,
        sourceId: target.source.sourceId,
        sequence: headers.sequence,
        capturedAtMonotonicMs: null,
        capturedAtWallMs: headers.capturedAtWallMs,
        receivedAtMonotonicMs,
        bytes: jpeg,
        mimeType: "image/jpeg"
      };

      const status = target.source.accept({
        frame,
        clientCapturedAtMonotonicMs:
          headers.clientCapturedAtMonotonicMs ?? 0
      });

      switch (status) {
        case "accepted":
          lastAcceptedSequence = headers.sequence;
          return {
            status: 202,
            json: { accepted: true, receivedAtMonotonicMs }
          };
        case "duplicate":
        case "out-of-order":
          throw new HttpError(409, "stale_sequence", "duplicate or out-of-order frame");
        case "too-large":
          throw new HttpError(413, "payload_too_large", "frame is too large");
        case "closed":
          throw new HttpError(503, "source_unavailable", "frame source is closed");
      }
    }
  };
}
