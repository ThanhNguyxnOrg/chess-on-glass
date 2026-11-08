/**
 * Provider-neutral perception contracts for ChessOnGlass.
 *
 * Vision providers translate transport and response envelopes; chess state
 * and move selection do not depend on a specific provider.
 */
export const PACKAGE_NAME = "@chessonglass/perception";

export { parseObservation } from "./observations.js";
export type { Observation, PieceColor, PieceKind, PieceObservation } from "@chessonglass/contracts";
export { ProviderError, toReadFailure } from "./reader.js";
export type { BoardReader, ReadFailure, ReadFailureCode, ReadResult } from "./reader.js";
