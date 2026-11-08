import type { Sequence, SessionId, SourceId } from "./ids.js";

export type Capabilities = Readonly<{
  video: boolean;
  microphone: boolean;
  audioOutput: boolean;
  display: boolean;
}>;

/**
 * Identity carried by every asynchronous piece of work. A result may modify
 * live state only while all four fields still describe the active request.
 */
export type RequestContext = Readonly<{
  requestId: string;
  sessionId: SessionId;
  positionVersion: number;
  referenceSequence: Sequence | null;
}>;

export type Frame = Readonly<{
  sessionId: SessionId;
  sourceId: SourceId;
  sequence: Sequence;
  /** Null until a trusted clock-offset estimate exists for this source. */
  capturedAtMonotonicMs: number | null;
  capturedAtWallMs: number;
  receivedAtMonotonicMs: number;
  bytes: Uint8Array;
  mimeType: "image/jpeg";
}>;

export interface FrameSource {
  readonly capabilities: Capabilities;
  /** Resolve with a fresh frame, or null only for closure, source end or abort. */
  next(signal: AbortSignal): Promise<Frame | null>;
  close(): Promise<void>;
}
