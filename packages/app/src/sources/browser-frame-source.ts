import {
  LatestFrameMailbox,
  type Capabilities,
  type Frame,
  type FrameSource,
  type SessionId,
  type SourceId
} from "@chessonglass/contracts";
import { FRAME_BODY_LIMIT } from "../http/server.js";

export type BrowserFrameUpload = {
  frame: Frame;
  /** Diagnostic browser clock only; never used for freshness. */
  clientCapturedAtMonotonicMs: number;
};

export type FrameAcceptStatus =
  | "accepted"
  | "duplicate"
  | "out-of-order"
  | "too-large"
  | "closed";

/**
 * A capacity-one source for authorized browser uploads. The backend receipt
 * time is the only freshness clock; the newest accepted frame wins and slow
 * consumers never create a backlog.
 */
export class BrowserFrameSource implements FrameSource {
  readonly capabilities: Capabilities = Object.freeze({
    video: true,
    microphone: false,
    audioOutput: false,
    display: false
  });

  readonly sessionId: SessionId;
  readonly sourceId: SourceId;

  private readonly mailbox: LatestFrameMailbox;
  private closed = false;

  constructor(
    sessionId: SessionId,
    sourceId: SourceId,
    limitBytes: number = FRAME_BODY_LIMIT
  ) {
    this.sessionId = sessionId;
    this.sourceId = sourceId;
    this.mailbox = new LatestFrameMailbox(limitBytes);
  }

  accept(upload: BrowserFrameUpload): FrameAcceptStatus {
    if (this.closed) {
      return "closed";
    }
    return this.mailbox.offer(upload.frame);
  }

  next(signal: AbortSignal): Promise<Frame | null> {
    return this.mailbox.next(signal);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.mailbox.close();
  }
}
