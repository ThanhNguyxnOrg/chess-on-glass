/**
 * Tracking-mode configuration with the spike-evidence gate.
 *
 * Default mode is `locator-only`: board geometry comes exclusively from the
 * (provider) locator and the overlay hides between valid observations. The
 * optional `local-assisted` mode — a local flow tracker smoothing the gap
 * between locator observations — is NOT reachable unless a recorded spike
 * verdict with status "pass" exists. A config flag without measured evidence
 * is rejected, because enabling an unevaluated tracker is how an
 * unvalidated optimization ends up driving overlay output.
 */

/** The two tracking modes. `locator-only` is the shipped default. */
export type TrackingMode = "locator-only" | "local-assisted";

export type TrackingSpikeStatus = "pass" | "fail" | "inconclusive";

/**
 * The recorded outcome of a local-tracking spike, constructed by the app
 * after reading the committed spike document. `evidencePath` must cite that
 * document; a verdict nobody can trace back to measurements is not evidence.
 */
export type TrackingSpikeVerdict = Readonly<{
  status: TrackingSpikeStatus;
  /** Committed evidence document the verdict cites (the spike markdown). */
  evidencePath: string;
  /** Wall-clock time the verdict was recorded, ms since the epoch. */
  recordedAtWallMs: number;
  /** Optional one-paragraph human summary of the measured result. */
  summary?: string;
}>;

/**
 * The resolved tracking configuration. `localTrackingAllowed` is true only
 * when mode is `local-assisted` AND a passing spike verdict was recorded;
 * in `locator-only` mode no local tracker may be constructed or consulted.
 */
export type TrackingConfig = Readonly<{
  mode: TrackingMode;
  localTrackingAllowed: boolean;
  spikeEvidence: TrackingSpikeVerdict | null;
}>;

export const DEFAULT_TRACKING_MODE: TrackingMode = "locator-only";

/**
 * The shipped configuration: locator-only, no local tracking, no evidence.
 * Frozen so nothing can flip it in place.
 */
export const DEFAULT_TRACKING_CONFIG: TrackingConfig = Object.freeze({
  mode: DEFAULT_TRACKING_MODE,
  localTrackingAllowed: false,
  spikeEvidence: null
});

export type TrackingConfigErrorCode = "local-assisted-without-evidence";

/**
 * Typed refusal of an unearned `local-assisted` request. Distinct from a
 * `RangeError` (which marks malformed caller input) so the app can tell a
 * config mistake from a policy denial.
 */
export class TrackingConfigError extends Error {
  readonly code: TrackingConfigErrorCode;

  constructor(code: TrackingConfigErrorCode, message: string) {
    super(message);
    this.name = "TrackingConfigError";
    this.code = code;
  }
}

export type TrackingConfigOptions = Readonly<{
  /** Defaults to `DEFAULT_TRACKING_MODE` (`locator-only`). */
  mode?: TrackingMode;
  /** Recorded spike evidence; required (and passing) for `local-assisted`. */
  spikeVerdict?: TrackingSpikeVerdict | null;
}>;

function requireSpikeVerdict(verdict: TrackingSpikeVerdict | null | undefined): TrackingSpikeVerdict | null {
  if (verdict === undefined || verdict === null) {
    return null;
  }
  if (typeof verdict !== "object") {
    throw new RangeError("spike verdict must be an object");
  }
  if (verdict.status !== "pass" && verdict.status !== "fail" && verdict.status !== "inconclusive") {
    throw new RangeError('spike verdict status must be "pass", "fail" or "inconclusive"');
  }
  if (typeof verdict.evidencePath !== "string" || verdict.evidencePath.trim() === "") {
    throw new RangeError("spike verdict evidencePath must be a non-empty string");
  }
  if (typeof verdict.recordedAtWallMs !== "number" || !Number.isFinite(verdict.recordedAtWallMs)) {
    throw new RangeError("spike verdict recordedAtWallMs must be a finite number");
  }
  if (verdict.summary !== undefined && typeof verdict.summary !== "string") {
    throw new RangeError("spike verdict summary must be a string when present");
  }
  return verdict;
}

/**
 * Resolve the tracking configuration. `local-assisted` is rejected with a
 * typed `TrackingConfigError` unless a recorded spike verdict with status
 * "pass" is supplied — the spike is the only path to enabling local
 * tracking, and an inconclusive or failed spike leaves the configuration
 * locator-only. Malformed arguments (unknown mode, malformed verdict) throw
 * `RangeError`; the mode gate itself throws `TrackingConfigError`. The
 * result is frozen.
 */
export function resolveTrackingConfig(options: TrackingConfigOptions = {}): TrackingConfig {
  if (typeof options !== "object" || options === null) {
    throw new RangeError("tracking options must be an object");
  }
  const mode = options.mode ?? DEFAULT_TRACKING_MODE;
  if (mode !== "locator-only" && mode !== "local-assisted") {
    throw new RangeError('mode must be "locator-only" or "local-assisted"');
  }
  const verdict = requireSpikeVerdict(options.spikeVerdict);
  if (mode === "local-assisted") {
    if (verdict === null || verdict.status !== "pass") {
      throw new TrackingConfigError(
        "local-assisted-without-evidence",
        'local-assisted requires a recorded spike verdict with status "pass"; ' +
          `the recorded status is ${verdict === null ? "none" : `"${verdict.status}"`}`
      );
    }
    return Object.freeze({ mode, localTrackingAllowed: true, spikeEvidence: verdict });
  }
  // locator-only: a passing verdict is recorded but enables nothing; the
  // mode itself is the switch, and it stays off unless explicitly earned.
  return Object.freeze({ mode, localTrackingAllowed: false, spikeEvidence: verdict });
}
