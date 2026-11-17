import type {
  Frame,
  GamePosition,
  Observation,
  RequestContext
} from "@chessonglass/contracts";
import { toReadFailure, type ReadResult } from "../reader.js";

export type OpenAiTransportRequest = {
  model: string;
  input: Array<{
    type: string;
    role?: string;
    content: Array<{
      type: string;
      image_url?: { url: string };
      text?: string;
    }>;
  }>;
  text: {
    format: {
      type: "json_schema";
      name?: string;
      strict: boolean;
      schema: unknown;
    };
  };
  signal: AbortSignal;
  timeoutMs?: number;
};

export type OpenAiTransportResponse = {
  status: string;
  output?: Array<{
    type: string;
    content: Array<{
      type: string;
      text?: string;
      refusal?: string;
    }>;
  }>;
  incomplete_details?: { reason: string };
  usage?: { input_tokens: number; output_tokens: number };
};

export type OpenAiTransport = {
  respond(request: OpenAiTransportRequest): Promise<OpenAiTransportResponse>;
};

export type OpenAiBoardReaderOptions = {
  transport: OpenAiTransport;
  model: string;
  timeoutMs?: number;
};

const RETRYABLE_STATUS = new Set([408, 429, 503]);
const AUTH_STATUS = new Set([401, 403]);
const MAX_ATTEMPTS = 2;

const OBSERVATION_SCHEMA = {
  type: "object",
  required: ["boardVisible", "handOverBoard", "squares"],
  properties: {
    boardVisible: { type: "boolean" },
    handOverBoard: { type: "boolean" },
    squares: {
      type: "array",
      minItems: 64,
      maxItems: 64,
      items: {
        type: "object",
        required: ["square", "color", "kind", "confidence"],
        properties: {
          square: { type: "integer", minimum: 0, maximum: 63 },
          color: {
            type: "string",
            enum: ["white", "black", "empty", "unknown"]
          },
          kind: {
            type: "string",
            enum: [
              "pawn",
              "knight",
              "bishop",
              "rook",
              "queen",
              "king",
              "unknown"
            ]
          },
          confidence: {
            type: ["number", "null"],
            minimum: 0,
            maximum: 1
          }
        },
        additionalProperties: false
      }
    }
  },
  additionalProperties: false
} as const;

function base64Jpeg(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function observationText(reference: {
  frame: Frame;
  position: GamePosition;
} | null): string {
  const parts = [
    "You are a chess board vision model. Return a strict JSON observation.",
    `Current side to move: ${reference?.position.fen.split(" ")[1] ?? "w"}`,
    `Reference FEN: ${reference?.position.fen ?? "none"}`,
    `Reference history: ${JSON.stringify(reference?.position.history ?? [])}`,
    "Return only the JSON object, no prose."
  ];
  return parts.join("\n");
}

function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

function sanitizeProviderError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
  }
  return String(error);
}

function timeoutValue(
  milliseconds: number,
  signal: AbortSignal
): Promise<OpenAiTransportResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const timer = setTimeout(() => {
      reject(
        Object.assign(new Error(`provider timed out after ${milliseconds}ms`), {
          status: 408
        })
      );
    }, milliseconds);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      },
      { once: true }
    );
  });
}

export class OpenAiBoardReader {
  private readonly transport: OpenAiTransport;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAiBoardReaderOptions) {
    this.transport = options.transport;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async read(input: {
    frame: Frame;
    reference: { frame: Frame; position: GamePosition } | null;
    context: RequestContext;
    signal: AbortSignal;
  }): Promise<ReadResult> {
    if (input.signal.aborted) {
      return toReadFailure(new Error("aborted"), input.signal);
    }

    let lastFailure: ReadResult | null = null;
    for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
      let response: OpenAiTransportResponse | undefined;
      try {
        response = await Promise.race([
          this.transport.respond({
            model: this.model,
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/jpeg;base64,${base64Jpeg(input.frame.bytes)}`
                    }
                  },
                  ...(input.reference !== null
                    ? [
                        {
                          type: "image_url",
                          image_url: {
                            url: `data:image/jpeg;base64,${base64Jpeg(input.reference.frame.bytes)}`
                          }
                        }
                      ]
                    : []),
                  { type: "text", text: observationText(input.reference) }
                ]
              }
            ],
            text: {
              format: {
                type: "json_schema",
                name: "board_observation",
                strict: true,
                schema: OBSERVATION_SCHEMA
              }
            },
            signal: input.signal,
            timeoutMs: this.timeoutMs
          }),
          timeoutValue(this.timeoutMs, input.signal)
        ]);
      } catch (error) {
        if (input.signal.aborted) {
          return toReadFailure(error, input.signal);
        }
        const status = errorStatus(error);
        if (AUTH_STATUS.has(status ?? 0)) {
          return {
            ok: false,
            code: "unauthorized",
            message: sanitizeProviderError(error),
            retryable: false
          };
        }
        if (status === 408) {
          return {
            ok: false,
            code: "unavailable",
            message: sanitizeProviderError(error),
            retryable: true
          };
        }
        if (RETRYABLE_STATUS.has(status ?? 0) && attemptNumber < MAX_ATTEMPTS) {
          continue;
        }
      }

      if (response === undefined || response === null) {
        return {
          ok: false,
          code: "unavailable",
          message: "provider returned no response",
          retryable: false
        };
      }
      const mapped = this.mapResponse(response, input.context);
      if (mapped.ok) {
        return mapped;
      }
      if (!mapped.retryable) {
        return mapped;
      }
      lastFailure = mapped;
    }
    return (
      lastFailure ?? {
        ok: false,
        code: "unavailable",
        message: "provider did not respond",
        retryable: false
      }
    );
  }

  private mapResponse(
    response: OpenAiTransportResponse,
    context: RequestContext
  ): ReadResult {
    if (response.status === "incomplete") {
      return {
        ok: false,
        code: "invalid-response",
        message: `provider incomplete: ${response.incomplete_details?.reason ?? "unknown"}`,
        retryable: false
      };
    }
    const message = response.output?.find((item) => item.type === "message");
    if (message === undefined) {
      return {
        ok: false,
        code: "invalid-response",
        message: "provider returned no message",
        retryable: false
      };
    }
    for (const part of message.content) {
      if (part.type === "refusal") {
        return {
          ok: false,
          code: "invalid-response",
          message: part.refusal ?? "provider refused",
          retryable: false
        };
      }
    }
    const text = message.content
      .filter((part) => part.type === "output_text")
      .map((part) => part.text ?? "")
      .join("");
    let parsed: Pick<Observation, "boardVisible" | "handOverBoard" | "squares">;
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return {
        ok: false,
        code: "invalid-response",
        message: "provider returned invalid JSON",
        retryable: false
      };
    }
    if (
      typeof parsed.boardVisible !== "boolean" ||
      typeof parsed.handOverBoard !== "boolean" ||
      !Array.isArray(parsed.squares)
    ) {
      return {
        ok: false,
        code: "invalid-response",
        message: "provider observation is missing required fields",
        retryable: false
      };
    }

    const observation: Observation = {
      context: { ...context },
      boardVisible: parsed.boardVisible,
      handOverBoard: parsed.handOverBoard,
      squares: parsed.squares.map((square) => ({ ...square })),
      provider: "openai",
      model: this.model,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0
    };
    return { ok: true, observation };
  }
}
