import type { Frame, GamePosition, GameStatus } from "@chessonglass/contracts";
import type { CurrentGeometry, GeometryInvalidation } from "../tracking/geometry-state.js";

/**
 * What the overlay renders about one move result. This is a structural
 * subset of the game coordinator's `Result` (moveUci/status/reason) defined
 * here — NOT imported from game — so the dependency direction stays
 * `app → game → perception`; the app maps its real `Result` into this shape
 * at the call boundary.
 */
export type OverlayResult = Readonly<{
  moveUci: string | null;
  status: GameStatus;
  reason: string | null;
}>;

/**
 * The overlay decision for one frame: either a live move drawing (green
 * from/to marks over a tracked board), a tracked board waiting for a move,
 * or the hidden state — a clearly labeled status-only frame rendered when
 * geometry is absent or stale. The hidden state is a normal result, never
 * an exception and never a stale drawing.
 */
export type OverlayDisplay =
  | Readonly<{
      kind: "move";
      fromSquare: number;
      toSquare: number;
      side: "w" | "b";
      moveUci: string;
      statusLabel: string;
    }>
  | Readonly<{ kind: "tracking"; statusLabel: string }>
  | Readonly<{ kind: "hidden"; headline: string; details: readonly string[] }>;

export type OverlayDisplayInput = Readonly<{
  /** Already-resolved geometry (`GeometryState.current(now)`), or null. */
  geometry: CurrentGeometry | null;
  /**
   * The frame the decision is about, when one exists. The decision itself
   * never reads image data; the identity is carried so callers (and the
   * status route) reason about the same frame the renderer composes.
   */
  frame: Frame | null;
  result: OverlayResult | null;
  invalidation: GeometryInvalidation | null;
  position: GamePosition | null;
  /** Operator-facing note (e.g. last provider error); always untrusted. */
  note?: string | null;
}>;

/**
 * Upper bound for any free-form text the overlay renders. Model- or
 * provider-derived strings (reasons, notes) are truncated here before they
 * can reach an SVG text node.
 */
export const MAX_OVERLAY_TEXT_LENGTH = 200;

/** The hidden-state headline: fixed text, never derived from model output. */
export const OVERLAY_HIDDEN_HEADLINE = "Overlay hidden";

/**
 * Fixed detail when no invalidation was ever recorded: tracking simply has
 * not produced trusted geometry yet.
 */
const NO_GEOMETRY_DETAIL = "no trusted board geometry";

const MOVE_UCI_PATTERN = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

const SQUARES_PER_SIDE = 8;

/**
 * Fixed, safe status labels keyed by the contract's `GameStatus` union. An
 * unknown status (hostile input typed past the boundary) maps to a fallback
 * label instead of being rendered verbatim.
 */
const STATUS_LABELS: Readonly<Record<GameStatus, string>> = {
  "needs-position": "Waiting for position",
  ready: "Ready",
  waiting: "Waiting",
  confirming: "Confirming move",
  uncertain: "Position uncertain",
  lost: "Tracking lost",
  paused: "Paused",
  finished: "Game over"
};

const UNKNOWN_STATUS_LABEL = "Status unavailable";

/**
 * Sanitize one piece of free-form overlay text: non-strings become null and
 * XML-invalid control characters are stripped so a hostile payload cannot
 * smuggle raw control bytes into the SVG. Escaping happens once, at the SVG
 * boundary (`buildOverlaySvg`).
 */
export function sanitizeOverlayText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  // Strip C0 controls except tab/newline/carriage-return (legal XML 1.0
  // characters) plus DEL and the C1 range, which librsvg renders as junk.
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  return cleaned.slice(0, MAX_OVERLAY_TEXT_LENGTH);
}

/**
 * Parse a UCI move (`e2e4`, `e7e8q`) into board square indices using the
 * codebase convention: square 0 = a8, row-major from the top of the board
 * image. Anything that is not exactly a legal-coordinate move — including
 * hostile strings with markup — returns null, so model output can never
 * reach the projection layer unvalidated.
 */
export function parseMoveUci(
  moveUci: string
): { fromSquare: number; toSquare: number; promotion: "q" | "r" | "b" | "n" | null } | null {
  const match = MOVE_UCI_PATTERN.exec(moveUci);
  if (match === null) {
    return null;
  }
  return {
    fromSquare: squareIndex(match[1] ?? ""),
    toSquare: squareIndex(match[2] ?? ""),
    promotion: (match[3] ?? null) as "q" | "r" | "b" | "n" | null
  };
}

function squareIndex(coordinate: string): number {
  const file = coordinate.charCodeAt(0) - 97; // 'a' -> 0
  const rank = coordinate.charCodeAt(1) - 48; // '1' -> 1 … '8' -> 8
  return (SQUARES_PER_SIDE - rank) * SQUARES_PER_SIDE + file;
}

/**
 * The side to move, read from the FEN turn field. Unparseable FEN defaults
 * to "w" so a hostile position string can never select an unknown labeling.
 */
export function sideFromFen(fen: string): "w" | "b" {
  const turn = fen.split(" ")[1];
  return turn === "b" ? "b" : "w";
}

/** Fixed label for a known status; unknown values never reach the SVG. */
export function statusLabel(status: GameStatus): string {
  return STATUS_LABELS[status] ?? UNKNOWN_STATUS_LABEL;
}

/**
 * Decide what the overlay shows for this frame. The decision is pure data —
 * square indices, labels, sanitized texts — so the SVG builder downstream
 * only ever receives validated input:
 *
 * - geometry present + a syntactically valid move → `move`;
 * - geometry present without a usable move → `tracking` (outline + status);
 * - geometry absent or stale → `hidden`, carrying the recorded invalidation
 *   reason, the (sanitized) result reason and operator note.
 */
export function resolveOverlayDisplay(input: OverlayDisplayInput): OverlayDisplay {
  const { geometry, result } = input;
  if (geometry === null) {
    return hiddenDisplay(input);
  }
  const label = statusLabel(result?.status ?? "waiting");
  const move = result?.moveUci != null ? parseMoveUci(result.moveUci) : null;
  if (move === null) {
    return { kind: "tracking", statusLabel: label };
  }
  return {
    kind: "move",
    fromSquare: move.fromSquare,
    toSquare: move.toSquare,
    side: sideFromFen(input.position?.fen ?? ""),
    moveUci: result?.moveUci ?? "",
    statusLabel: label
  };
}

function hiddenDisplay(input: OverlayDisplayInput): OverlayDisplay {
  const details: string[] = [];
  const reasonDetail = sanitizeOverlayText(input.invalidation?.reason) ?? NO_GEOMETRY_DETAIL;
  details.push(reasonDetail);
  const resultReason = sanitizeOverlayText(input.result?.reason);
  if (resultReason !== null && resultReason !== "") {
    details.push(resultReason);
  }
  const note = sanitizeOverlayText(input.note);
  if (note !== null && note !== "") {
    details.push(note);
  }
  return { kind: "hidden", headline: OVERLAY_HIDDEN_HEADLINE, details };
}
