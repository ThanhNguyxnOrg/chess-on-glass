import { randomBytes, timingSafeEqual } from "node:crypto";
import { newSessionId, type SessionId } from "@chessonglass/contracts";

/** Per-run local authorization. The token never leaves memory or the URL fragment. */
export type LocalSession = Readonly<{
  sessionId: SessionId;
  token: string;
  origin: string;
}>;

export function createLocalSession(origin: string): LocalSession {
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new TypeError("local session origin must be a loopback http origin");
  }
  return {
    sessionId: newSessionId(),
    token: randomBytes(32).toString("base64url"),
    origin: url.origin
  };
}

function parseBearer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^Bearer (.+)$/.exec(value);
  return match?.[1] ?? null;
}

export function isAuthorized(
  session: LocalSession,
  authorization: string | undefined
): boolean {
  const provided = parseBearer(authorization);
  if (provided === null) {
    return false;
  }
  const expected = Buffer.from(session.token, "utf8");
  const actual = Buffer.from(provided, "utf8");
  return (
    actual.length === expected.length && timingSafeEqual(actual, expected)
  );
}

export function isAllowedOrigin(
  session: LocalSession,
  origin: string | undefined
): boolean {
  return typeof origin === "string" && origin === session.origin;
}
