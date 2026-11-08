/**
 * Shared contracts for ChessOnGlass.
 *
 * The public surface is documented in docs/architecture.md. This slice adds
 * identity, frame and observation contracts; no runtime code belongs here.
 */
export const PACKAGE_NAME = "@chessonglass/contracts";

export { newSessionId, newSourceId, parseSequence } from "./ids.js";
export type { Brand, Sequence, SessionId, SourceId } from "./ids.js";
export type {
  GamePosition,
  GameStatus,
  PositionUncertainty,
  Promotion
} from "./positions.js";
export type { Capabilities, Frame, FrameSource, RequestContext } from "./frames.js";
export { LatestFrameMailbox } from "./mailbox.js";
