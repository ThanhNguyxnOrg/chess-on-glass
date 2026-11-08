import { parseSequence } from "@chessonglass/contracts";
import type {
  Observation,
  PieceColor,
  PieceKind,
  PieceObservation,
  RequestContext,
  SessionId
} from "@chessonglass/contracts";

const COLORS: ReadonlySet<string> = new Set(["white", "black", "empty", "unknown"]);
const KINDS: ReadonlySet<string> = new Set([
  "pawn",
  "knight",
  "bishop",
  "rook",
  "queen",
  "king",
  "unknown"
]);

const OBSERVATION_KEYS = [
  "context",
  "boardVisible",
  "handOverBoard",
  "squares",
  "provider",
  "model",
  "inputTokens",
  "outputTokens"
] as const;
const SQUARE_KEYS = ["square", "color", "kind", "confidence"] as const;
const CONTEXT_KEYS = ["requestId", "sessionId", "positionVersion", "referenceSequence"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new Error(`${label} contains unknown field ${key}`);
    }
  }
  for (const key of allowed) {
    if (!(key in value)) {
      throw new Error(`${label} is missing field ${key}`);
    }
  }
}

function requireNonEmptyString(value: unknown, label: string, maxLength = 200): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function parseContext(value: unknown): RequestContext {
  if (!isRecord(value)) {
    throw new Error("observation context must be an object");
  }
  requireExactKeys(value, CONTEXT_KEYS, "observation context");

  const requestId = requireNonEmptyString(value.requestId, "context.requestId");
  const sessionId = requireNonEmptyString(value.sessionId, "context.sessionId");
  if (!Number.isSafeInteger(value.positionVersion) || (value.positionVersion as number) < 0) {
    throw new Error("context.positionVersion must be a non-negative safe integer");
  }
  const referenceSequence =
    value.referenceSequence === null ? null : parseSequence(value.referenceSequence);

  return {
    requestId,
    sessionId: sessionId as SessionId,
    positionVersion: value.positionVersion as number,
    referenceSequence
  };
}

function sameContext(left: RequestContext, right: RequestContext): boolean {
  return (
    left.requestId === right.requestId &&
    left.sessionId === right.sessionId &&
    left.positionVersion === right.positionVersion &&
    left.referenceSequence === right.referenceSequence
  );
}

function parseSquare(value: unknown, expectedSquare: number): PieceObservation {
  if (!isRecord(value)) {
    throw new Error(`square ${expectedSquare} must be an object`);
  }
  requireExactKeys(value, SQUARE_KEYS, `square ${expectedSquare}`);

  if (
    !Number.isSafeInteger(value.square) ||
    (value.square as number) < 0 ||
    (value.square as number) > 63
  ) {
    throw new Error("square index must be an integer in [0,63]");
  }
  if (typeof value.color !== "string" || !COLORS.has(value.color)) {
    throw new Error(`square ${expectedSquare} has an invalid color`);
  }
  if (typeof value.kind !== "string" || !KINDS.has(value.kind)) {
    throw new Error(`square ${expectedSquare} has an invalid kind`);
  }

  const color = value.color as PieceColor;
  const kind = value.kind as PieceKind;
  if (color === "empty" && kind !== "unknown") {
    throw new Error(`square ${expectedSquare} is empty and cannot contain a piece kind`);
  }
  if (color === "unknown" && kind !== "unknown") {
    throw new Error(`square ${expectedSquare} has unknown color but a concrete kind`);
  }

  const confidence = value.confidence;
  if (
    confidence !== null &&
    (typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1)
  ) {
    throw new Error(`square ${expectedSquare} confidence must be null or a number in [0,1]`);
  }

  return { square: value.square as number, color, kind, confidence };
}

/**
 * Strict boundary parser for provider output. Invalid structures become a
 * thrown, typed-at-the-call-site error; they never turn into an empty board or
 * a zero-cost success.
 */
export function parseObservation(value: unknown, context: RequestContext): Observation {
  if (!isRecord(value)) {
    throw new Error("observation must be an object");
  }
  requireExactKeys(value, OBSERVATION_KEYS, "observation");

  if (typeof value.boardVisible !== "boolean") {
    throw new Error("observation.boardVisible must be a boolean");
  }
  if (typeof value.handOverBoard !== "boolean") {
    throw new Error("observation.handOverBoard must be a boolean");
  }

  const parsedContext = parseContext(value.context);
  if (!sameContext(parsedContext, context)) {
    throw new Error("observation context does not match the active request");
  }

  if (!Array.isArray(value.squares)) {
    throw new Error("observation.squares must be an array");
  }
  if (value.squares.length !== 64) {
    throw new Error("observation must contain exactly 64 squares");
  }

  const seen = new Set<number>();
  const squares: PieceObservation[] = [];
  for (const [index, entry] of value.squares.entries()) {
    const square = parseSquare(entry, index);
    if (seen.has(square.square)) {
      throw new Error(`duplicate square ${square.square}`);
    }
    seen.add(square.square);
    squares.push(square);
  }
  squares.sort((left, right) => left.square - right.square);

  const provider = requireNonEmptyString(value.provider, "observation.provider");
  const model = requireNonEmptyString(value.model, "observation.model");

  if (!Number.isSafeInteger(value.inputTokens) || (value.inputTokens as number) < 0) {
    throw new Error("observation.inputTokens must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(value.outputTokens) || (value.outputTokens as number) < 0) {
    throw new Error("observation.outputTokens must be a non-negative safe integer");
  }

  return {
    context: parsedContext,
    boardVisible: value.boardVisible,
    handOverBoard: value.handOverBoard,
    squares,
    provider,
    model,
    inputTokens: value.inputTokens as number,
    outputTokens: value.outputTokens as number
  };
}
