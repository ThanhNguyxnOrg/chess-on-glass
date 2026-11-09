import type { WebcamFrameSender } from "../media/webcam-uploader.js";

export type BrowserFrameTarget = {
  sessionId: string;
  sourceId: string;
  positionVersion: number;
  referenceSequence: bigint | null;
};

export type BrowserSourceClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  requestId?: () => string;
};

/**
 * Authorized JSON/JPEG client for the local dashboard. The token travels in
 * the Authorization header only; it is never placed in a URL or query string.
 */
export class BrowserSourceClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly requestId: () => string;

  constructor(options: BrowserSourceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchFn = options.fetch ?? fetch;
    this.requestId =
      options.requestId ?? (() => globalThis.crypto.randomUUID());
  }

  createSender(target: BrowserFrameTarget): WebcamFrameSender {
    return async ({ jpeg, sequence, capturedAtWallMs, signal }) => {
      const response = await this.fetchFn(
        `${this.baseUrl}/api/source/browser/frame`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "image/jpeg",
            "x-frame-session": target.sessionId,
            "x-frame-source": target.sourceId,
            "x-frame-sequence": sequence.toString(),
            "x-frame-wall-ms": String(capturedAtWallMs),
            "x-frame-request-id": this.requestId(),
            "x-frame-position-version": String(target.positionVersion),
            ...(target.referenceSequence === null
              ? {}
              : {
                  "x-frame-reference-sequence":
                    target.referenceSequence.toString()
                })
          },
          body: jpeg,
          signal
        }
      );
      if (response.status !== 202) {
        throw new Error(`frame upload failed (${response.status})`);
      }
    };
  }
}
