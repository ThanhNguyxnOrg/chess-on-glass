/**
 * Provider-neutral board-reader contract, strict observation parsing,
 * optional local pre-filter, and transport-agnostic vision provider readers.
 * The public surface is documented in docs/architecture.md; no runtime code
 * beyond these contracts belongs here.
 */
export const PACKAGE_NAME = "@chessonglass/perception";

export { parseObservation } from "./observations.js";
export type {
  Observation,
  PieceColor,
  PieceKind,
  PieceObservation
} from "@chessonglass/contracts";
export { ProviderError, toReadFailure } from "./reader.js";
export type {
  BoardReader,
  ReadFailure,
  ReadFailureCode,
  ReadResult
} from "./reader.js";
export { PeriodicFullReadFilter, inspectWithPreFilter } from "./prefilter.js";
export type { PreFilter, PreFilterDecision } from "./prefilter.js";
export {
  AnthropicBoardReader,
  OpenAiBoardReader
} from "./providers/index.js";
export type {
  AnthropicBoardReaderOptions,
  AnthropicTransport,
  AnthropicTransportRequest,
  AnthropicTransportResponse,
  OpenAiBoardReaderOptions,
  OpenAiTransport,
  OpenAiTransportRequest,
  OpenAiTransportResponse
} from "./providers/index.js";
export {
  PROVIDER_CATALOG,
  findModel,
  providerPrice
} from "./providers/provider-catalog.js";
export type { CatalogEntry } from "./providers/provider-catalog.js";
export type { ProviderName, ProviderSettings } from "./types.js";
