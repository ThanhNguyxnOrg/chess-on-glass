import { element, text } from "../dom.js";

/**
 * One `/api/overlay/status` response. Sequences are decimal strings so 64-bit
 * frame counters survive JSON without passing through a double.
 */
export type OverlayStatusSnapshot = Readonly<{
  overlay: "active" | "hidden" | "unavailable";
  frameSequence: string | null;
  geometrySequence: string | null;
  tracking: boolean;
  reason: string | null;
  result: Readonly<{ moveUci: string | null; status: string }> | null;
}>;

/**
 * Everything the preview needs from the browser, injected. This keeps the
 * controller runnable in plain vitest (node, no DOM): sequence dedup, URL
 * revocation and frame dropping are logic, not browser behavior.
 */
export type OverlayPreviewDeps = Readonly<{
  fetchStatus(signal: AbortSignal): Promise<OverlayStatusSnapshot>;
  /** Fetch the composed overlay image for the current frame. */
  fetchFrame(signal: AbortSignal): Promise<Uint8Array>;
  createObjectUrl(bytes: Uint8Array): string;
  revokeObjectUrl(url: string): void;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Poll cadence in milliseconds, default 500. */
  pollIntervalMs?: number;
  /** Called after every applied state change (used by the DOM panel). */
  onUpdate?(state: OverlayPreviewState): void;
}>;

/**
 * What the preview currently shows. `appliedSequence` is the frame sequence
 * of the displayed image; the preview holds at most one object URL at a time
 * (capacity-1: slow viewers drop frames, never accumulate them).
 */
export type OverlayPreviewState = Readonly<{
  appliedSequence: string | null;
  overlay: "active" | "hidden" | "unavailable";
  statusText: string;
  objectUrl: string | null;
  error: string | null;
}>;

const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * One human-readable line describing tracking/freshness/result status. The
 * inputs are server-validated fields; the text is only ever placed via
 * textContent/createTextNode downstream, never markup.
 */
export function describeOverlayStatus(status: OverlayStatusSnapshot): string {
  const parts: string[] = [`Overlay ${status.overlay}`];
  if (status.reason !== null) {
    parts.push(status.reason);
  }
  if (status.tracking) {
    parts.push(`tracking frame ${status.frameSequence ?? "?"}`);
  }
  if (status.result !== null) {
    if (status.result.moveUci !== null) {
      parts.push(`move ${status.result.moveUci}`);
    }
    parts.push(`status ${status.result.status}`);
  }
  return parts.join(" — ");
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "overlay preview failed";
}

/**
 * Drive the dashboard overlay preview: poll `/api/overlay/status`, and fetch
 * the composed image only when a NEW frame sequence appears.
 *
 * Rules this class enforces:
 * - updates happen only for a new `frameSequence` (sequence dedup);
 * - the previous object URL is revoked after the new one exists, so exactly
 *   one live URL is held at any time;
 * - a tick that arrives while another is in flight is dropped — a slow
 *   viewer never accumulates a backlog;
 * - errors keep the last good frame visible and are reported in state.
 */
export class OverlayPreviewController {
  private current: OverlayPreviewState = {
    appliedSequence: null,
    overlay: "unavailable",
    statusText: "Overlay preview not polled yet.",
    objectUrl: null,
    error: null
  };
  private inFlight = false;
  private stopped = false;
  private abort: AbortController | null = null;
  private intervalHandle: unknown = null;

  constructor(private readonly deps: OverlayPreviewDeps) {}

  get state(): OverlayPreviewState {
    return this.current;
  }

  /** Begin interval polling. Idempotent: a second call does not stack loops. */
  start(): void {
    if (this.intervalHandle !== null) {
      return;
    }
    this.stopped = false;
    this.intervalHandle = this.deps.setInterval(() => {
      void this.refresh();
    }, this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  /** Stop polling, abort in-flight work and release the held object URL. */
  stop(): void {
    this.stopped = true;
    if (this.intervalHandle !== null) {
      this.deps.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.abort?.abort();
    this.abort = null;
    this.revokeCurrent();
    this.current = { ...this.current, objectUrl: null };
  }

  /**
   * One poll tick. Safe to call arbitrarily often: concurrent ticks are
   * dropped instead of queued, so request count tracks capacity, not calls.
   */
  async refresh(): Promise<void> {
    if (this.inFlight || this.stopped) {
      return;
    }
    this.inFlight = true;
    const abort = new AbortController();
    this.abort = abort;
    try {
      const status = await this.deps.fetchStatus(abort.signal);
      if (this.stopped) {
        return;
      }
      await this.apply(status, abort.signal);
    } catch (error) {
      if (!this.stopped && !abort.signal.aborted) {
        this.current = { ...this.current, error: describeError(error) };
        this.deps.onUpdate?.(this.current);
      }
    } finally {
      this.inFlight = false;
      if (this.abort === abort) {
        this.abort = null;
      }
    }
  }

  private async apply(status: OverlayStatusSnapshot, signal: AbortSignal): Promise<void> {
    const statusText = describeOverlayStatus(status);
    if (status.frameSequence === null) {
      // Nothing to compose onto: drop the image, keep the status visible.
      this.revokeCurrent();
      this.current = {
        appliedSequence: null,
        overlay: status.overlay,
        statusText,
        objectUrl: null,
        error: null
      };
      this.deps.onUpdate?.(this.current);
      return;
    }
    if (status.frameSequence === this.current.appliedSequence) {
      // Same frame: refresh the status text only. The frame is dropped —
      // the preview never accumulates images.
      this.current = { ...this.current, overlay: status.overlay, statusText, error: null };
      this.deps.onUpdate?.(this.current);
      return;
    }
    const bytes = await this.deps.fetchFrame(signal);
    if (this.stopped) {
      return;
    }
    // Create the new URL before revoking the old one so the <img> never
    // points at a revoked blob, then release the previous URL.
    const url = this.deps.createObjectUrl(bytes);
    this.revokeCurrent();
    this.current = {
      appliedSequence: status.frameSequence,
      overlay: status.overlay,
      statusText,
      objectUrl: url,
      error: null
    };
    this.deps.onUpdate?.(this.current);
  }

  private revokeCurrent(): void {
    if (this.current.objectUrl !== null) {
      this.deps.revokeObjectUrl(this.current.objectUrl);
    }
  }
}

/**
 * DOM panel for the dashboard: a heading, a status line, the overlay image
 * and a placeholder for the hidden state. The board and move history live
 * outside this panel and stay accessible whether or not the overlay is
 * active. All text goes through text nodes — no innerHTML anywhere.
 */
export function createOverlayPreviewPanel(
  deps: OverlayPreviewDeps
): { root: HTMLElement; controller: OverlayPreviewController } {
  const statusLine = element("div", { class: "overlay-preview-status" }, text("—"));
  const image = element("img", {
    class: "overlay-preview-image",
    alt: "Board overlay preview",
    hidden: ""
  }) as HTMLImageElement;
  const placeholder = element(
    "p",
    { class: "overlay-preview-placeholder" },
    text("Overlay hidden. The board and move history below stay available.")
  );

  const controller = new OverlayPreviewController({
    ...deps,
    onUpdate: (state) => {
      deps.onUpdate?.(state);
      statusLine.textContent = state.statusText;
      if (state.error !== null) {
        statusLine.textContent = `${state.statusText} (${state.error})`;
      }
      if (state.objectUrl !== null) {
        image.src = state.objectUrl;
        image.hidden = false;
        placeholder.hidden = true;
      } else {
        image.removeAttribute("src");
        image.hidden = true;
        placeholder.hidden = false;
      }
    }
  });

  const root = element(
    "section",
    { class: "overlay-preview", "aria-label": "Overlay preview" },
    element("h2", {}, text("Overlay preview")),
    statusLine,
    image,
    placeholder
  );
  return { root, controller };
}
