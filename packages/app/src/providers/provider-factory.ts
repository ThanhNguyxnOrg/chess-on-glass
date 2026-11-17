import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { BoardReader } from "@chessonglass/perception";
import {
  AnthropicBoardReader,
  OpenAiBoardReader,
  type OpenAiTransportResponse,
  type AnthropicTransportResponse
} from "@chessonglass/perception";
import { providerPrice } from "@chessonglass/perception";
import type { ProviderSettings } from "@chessonglass/perception";

export type { ProviderSettings };

/**
 * Narrow provider factory: translates settings + secret into a BoardReader.
 * Only these files import provider SDKs. Cloud-disabled factory constructs no
 * network client.
 */
export function createBoardReader(
  settings: ProviderSettings,
  secret: string
): BoardReader {
  if (!settings.cloudEnabled) {
    throw new Error("cloud vision is disabled");
  }
  if (typeof secret !== "string" || secret.trim() === "") {
    throw new Error("provider credential is missing");
  }
  if (secret.length >= 20_000) {
    throw new Error("provider credential is too long");
  }
  const priced = providerPrice(settings);
  if (priced === null) {
    throw new Error("model is not in the priced catalog");
  }

  switch (settings.provider) {
    case "openai": {
      const openai = new OpenAI({
        apiKey: secret,
        timeout: 10_000,
        maxRetries: 0
      });
      return new OpenAiBoardReader({
        transport: {
          async respond(request) {
            const response = (await openai.responses.create({
              model: request.model,
              input: request.input as never,
              text: {
                format: {
                  ...request.text.format,
                  schema: request.text.format.schema as {
                    [key: string]: unknown;
                  }
                }
              },
              timeout: request.timeoutMs,
              signal: request.signal
            } as never)) as unknown as {
              status: string;
              output?: Array<{
                type: string;
                content?: Array<{
                  type: string;
                  text?: string;
                  refusal?: string;
                }>;
              }>;
              usage?: { input_tokens: number; output_tokens: number };
            };
            return {
              status: response.status,
              output: response.output?.map((item) => ({
                type: item.type,
                content: item.content?.map((part) => ({
                  type: part.type,
                  text: part.text,
                  refusal: part.refusal
                }))
              })),
              usage: response.usage
                ? {
                    input_tokens: response.usage.input_tokens,
                    output_tokens: response.usage.output_tokens
                  }
                : undefined
            } as OpenAiTransportResponse;
          }
        },
        model: settings.model
      });
    }
    case "anthropic": {
      const anthropic = new Anthropic({
        apiKey: secret,
        timeout: 10_000,
        maxRetries: 0
      });
      return new AnthropicBoardReader({
        transport: {
          async create(request) {
            const response = (await anthropic.messages.create({
              model: request.model,
              system: request.system,
              max_tokens: 4096,
              messages: request.messages as never,
              output_config: request.output_config as never
            } as never)) as unknown as {
              stop_reason: string;
              content: Array<{ type: string; text?: string }>;
              usage: { input_tokens: number; output_tokens: number };
            };
            return {
              stop_reason: response.stop_reason,
              content: response.content.map((part) => ({
                type: part.type,
                text: part.text
              })),
              usage: response.usage
            };
          }
        },
        model: settings.model
      });
    }
  }
}

export { providerPrice };
