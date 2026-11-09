import { apiError, type ApiErrorBody } from "../api/api-error.js";

export class HttpError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  /** Ask the server to close the connection after the response. */
  readonly closeConnection: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    closeConnection = false
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = apiError(code, message);
    this.closeConnection = closeConnection;
  }
}

export function unauthorized(): HttpError {
  return new HttpError(401, "unauthorized", "missing or invalid authorization");
}

export function forbiddenOrigin(): HttpError {
  return new HttpError(403, "forbidden_origin", "request origin is not allowed");
}

export function badRequest(message: string, closeConnection = false): HttpError {
  return new HttpError(400, "bad_request", message, closeConnection);
}

export function lengthRequired(closeConnection = false): HttpError {
  return new HttpError(
    411,
    "length_required",
    "content-length is required",
    closeConnection
  );
}

export function payloadTooLarge(): HttpError {
  return new HttpError(413, "payload_too_large", "request body is too large", true);
}

export function unsupportedMediaType(): HttpError {
  return new HttpError(415, "unsupported_media_type", "unsupported content type");
}

export function notFound(): HttpError {
  return new HttpError(404, "not_found", "not found");
}

export function methodNotAllowed(): HttpError {
  return new HttpError(405, "method_not_allowed", "method not allowed");
}
