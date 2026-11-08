import type { Frame, GamePosition, Observation, RequestContext } from "@chessonglass/contracts";

export type ReadFailureCode =
  | "invalid-response"
  | "unavailable"
  | "unauthorized"
  | "cancelled";

export type ReadFailure = Readonly<{
  ok: false;
  code: ReadFailureCode;
  message: string;
  retryable: boolean;
}>;

export type ReadResult = Readonly<{ ok: true; observation: Observation }> | ReadFailure;

export interface BoardReader {
  read(input: {
    frame: Frame;
    reference: { frame: Frame; position: GamePosition } | null;
    context: RequestContext;
    signal: AbortSignal;
  }): Promise<ReadResult>;
}

/** A provider adapter's typed failure, before it crosses into the core. */
export class ProviderError extends Error {
  readonly code: Exclude<ReadFailureCode, "cancelled">;
  readonly retryable: boolean;

  constructor(
    code: Exclude<ReadFailureCode, "cancelled">,
    message: string,
    retryable: boolean
  ) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

const SAFE_MESSAGES: Readonly<Record<Exclude<ReadFailureCode, "cancelled">, string>> = {
  "invalid-response": "provider returned an invalid response",
  unavailable: "provider is unavailable",
  unauthorized: "provider rejected the credentials"
};

/**
 * Classify a provider failure without copying raw provider text (which may
 * contain URLs, tokens or headers) into logs or UI state.
 */
export function toReadFailure(error: unknown, signal: AbortSignal): ReadFailure {
  if (signal.aborted) {
    return { ok: false, code: "cancelled", message: "read cancelled", retryable: false };
  }
  if (error instanceof ProviderError) {
    return {
      ok: false,
      code: error.code,
      message: SAFE_MESSAGES[error.code],
      retryable: error.retryable
    };
  }
  return {
    ok: false,
    code: "unavailable",
    message: "provider request failed",
    retryable: true
  };
}
