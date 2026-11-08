export type Price = {
  inputPerMillion: number;
  outputPerMillion: number;
  effectiveAt: string;
};

export type ReservationDecision = {
  allowed: boolean;
  reason: string | null;
};

export type LedgerSnapshot = {
  reservedUsd: number;
  actualUsd: number;
  paused: boolean;
};

const TOKENS_PER_MILLION = 1_000_000;

function requirePositiveUsd(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite positive USD amount`);
  }
}

function requireTokenCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

/**
 * A price is usable only when both rates are finite, non-negative and tied to
 * a real effective date. An unknown price is never treated as free.
 */
function isKnownPrice(price: Price): boolean {
  if (typeof price !== "object" || price === null) {
    return false;
  }
  return (
    Number.isFinite(price.inputPerMillion) &&
    price.inputPerMillion >= 0 &&
    Number.isFinite(price.outputPerMillion) &&
    price.outputPerMillion >= 0 &&
    typeof price.effectiveAt === "string" &&
    price.effectiveAt.trim() !== "" &&
    !Number.isNaN(Date.parse(price.effectiveAt))
  );
}

/**
 * Shared estimated-cost ledger for vision, locator and optional paid gates.
 * Each request reserves a conservative fixed amount before work, then settles
 * against reported token usage. The snapshot is an estimate, not a guaranteed
 * provider invoice ceiling. No credentials or provider payloads are stored.
 */
export class CostLedger {
  private readonly limitUsd: number;
  private readonly reservePerCallUsd: number;
  private readonly reservations = new Map<string, number>();
  private reservedUsd = 0;
  private actualUsd = 0;

  constructor(limitUsd: number, reservePerCallUsd: number) {
    requirePositiveUsd(limitUsd, "limitUsd");
    requirePositiveUsd(reservePerCallUsd, "reservePerCallUsd");
    this.limitUsd = limitUsd;
    this.reservePerCallUsd = reservePerCallUsd;
  }

  reserve(requestId: string, price: Price): ReservationDecision {
    if (typeof requestId !== "string" || requestId.trim() === "") {
      return { allowed: false, reason: "request id is required" };
    }
    if (!isKnownPrice(price)) {
      return { allowed: false, reason: "model price is unknown or invalid" };
    }
    if (this.reservations.has(requestId)) {
      return { allowed: false, reason: "request is already reserved" };
    }
    if (this.actualUsd + this.reservedUsd + this.reservePerCallUsd > this.limitUsd) {
      return { allowed: false, reason: "estimated budget exhausted" };
    }

    this.reservations.set(requestId, this.reservePerCallUsd);
    this.reservedUsd += this.reservePerCallUsd;
    return { allowed: true, reason: null };
  }

  /**
   * Reconcile one completed request. Repeated calls for the same id are
   * ignored. If the settle price is unknown, the conservative reservation is
   * charged instead of silently counting the call as free.
   */
  settle(requestId: string, inputTokens: number, outputTokens: number, price: Price): void {
    requireTokenCount(inputTokens, "inputTokens");
    requireTokenCount(outputTokens, "outputTokens");

    const reservation = this.reservations.get(requestId);
    if (reservation === undefined) {
      return;
    }

    const cost = isKnownPrice(price)
      ? (inputTokens / TOKENS_PER_MILLION) * price.inputPerMillion +
        (outputTokens / TOKENS_PER_MILLION) * price.outputPerMillion
      : reservation;

    this.reservations.delete(requestId);
    this.reservedUsd = Math.max(0, this.reservedUsd - reservation);
    this.actualUsd += cost;
  }

  /** Cancel a request that never produced a provider charge. */
  release(requestId: string): void {
    const reservation = this.reservations.get(requestId);
    if (reservation === undefined) {
      return;
    }
    this.reservations.delete(requestId);
    this.reservedUsd = Math.max(0, this.reservedUsd - reservation);
  }

  snapshot(): LedgerSnapshot {
    return {
      reservedUsd: this.reservedUsd,
      actualUsd: this.actualUsd,
      paused:
        this.actualUsd + this.reservedUsd + this.reservePerCallUsd > this.limitUsd
    };
  }
}
