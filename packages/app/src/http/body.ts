import type { IncomingMessage } from "node:http";
import {
  badRequest,
  lengthRequired,
  payloadTooLarge
} from "./errors.js";

/**
 * Validate framing before a single byte is read. Returns the promised length,
 * or null when the request carries no body. Chunked bodies are rejected so
 * every length is known and bounded before state can change.
 */
export function inspectBodyLength(
  request: IncomingMessage,
  limit: number,
  required: boolean
): number | null {
  const transferEncoding = request.headers["transfer-encoding"];
  if (transferEncoding !== undefined) {
    throw badRequest("chunked request bodies are not accepted", true);
  }

  const rawLength = request.headers["content-length"];
  if (rawLength === undefined) {
    if (required) {
      throw lengthRequired(true);
    }
    return null;
  }
  if (typeof rawLength !== "string" || !/^\d+$/.test(rawLength)) {
    throw badRequest("invalid content-length", true);
  }

  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw badRequest("invalid content-length", true);
  }
  if (length > limit) {
    request.resume();
    throw payloadTooLarge();
  }
  return length;
}

export async function readBodyBytes(
  request: IncomingMessage,
  length: number
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let received = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.byteLength;
    if (received > length) {
      throw badRequest("request body exceeds its declared length");
    }
    chunks.push(buffer);
  }

  if (received !== length) {
    throw badRequest("request body is truncated", true);
  }
  return Buffer.concat(chunks);
}
