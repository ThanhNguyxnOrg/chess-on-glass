import type { IncomingHttpHeaders } from "node:http";
import {
  parseSequence,
  type Sequence,
  type SessionId,
  type SourceId
} from "@chessonglass/contracts";
import { badRequest } from "./errors.js";

export type BrowserFrameHeaders = Readonly<{
  sessionId: SessionId;
  sourceId: SourceId;
  sequence: Sequence;
  capturedAtWallMs: number;
  requestId: string;
  positionVersion: number;
  referenceSequence: Sequence | null;
  clientCapturedAtMonotonicMs: number | null;
}>;

const HEADERS = {
  session: "x-frame-session",
  source: "x-frame-source",
  sequence: "x-frame-sequence",
  wall: "x-frame-wall-ms",
  requestId: "x-frame-request-id",
  positionVersion: "x-frame-position-version",
  referenceSequence: "x-frame-reference-sequence",
  clientMonotonic: "x-frame-client-monotonic-ms"
} as const;

function requireHeader(
  headers: IncomingHttpHeaders,
  name: string,
  label: string
): string {
  const value = headers[name];
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`${label} header is required`);
  }
  return value;
}

function optionalHeader(
  headers: IncomingHttpHeaders,
  name: string
): string | null {
  const value = headers[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function decimalNumber(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw badRequest(`${label} header must be a decimal integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw badRequest(`${label} header must be a non-negative safe integer`);
  }
  return parsed;
}

/** Strict upload metadata parser; malformed input is a typed 400. */
export function parseBrowserFrameHeaders(
  headers: IncomingHttpHeaders
): BrowserFrameHeaders {
  const sessionRaw = requireHeader(headers, HEADERS.session, "session");
  const sourceRaw = requireHeader(headers, HEADERS.source, "source");
  if (sessionRaw.length > 200 || sourceRaw.length > 200) {
    throw badRequest("session and source headers must be at most 200 characters");
  }

  let sequence: Sequence;
  try {
    sequence = parseSequence(requireHeader(headers, HEADERS.sequence, "sequence"));
  } catch {
    throw badRequest("sequence header must be a decimal integer");
  }

  const capturedAtWallMs = decimalNumber(
    requireHeader(headers, HEADERS.wall, "wall timestamp"),
    "wall timestamp"
  );
  const requestId = requireHeader(headers, HEADERS.requestId, "request id");
  if (requestId.length > 128) {
    throw badRequest("request id header must be at most 128 characters");
  }
  const positionVersion = decimalNumber(
    requireHeader(headers, HEADERS.positionVersion, "position version"),
    "position version"
  );

  const referenceRaw = optionalHeader(headers, HEADERS.referenceSequence);
  let referenceSequence: Sequence | null = null;
  if (referenceRaw !== null) {
    try {
      referenceSequence = parseSequence(referenceRaw);
    } catch {
      throw badRequest("reference sequence header must be a decimal integer");
    }
  }

  const clientRaw = optionalHeader(headers, HEADERS.clientMonotonic);
  const clientCapturedAtMonotonicMs =
    clientRaw === null ? null : decimalNumber(clientRaw, "client monotonic timestamp");

  return {
    sessionId: sessionRaw as SessionId,
    sourceId: sourceRaw as SourceId,
    sequence,
    capturedAtWallMs,
    requestId,
    positionVersion,
    referenceSequence,
    clientCapturedAtMonotonicMs
  };
}
