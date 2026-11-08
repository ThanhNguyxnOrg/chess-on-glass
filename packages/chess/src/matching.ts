import type { GamePosition, Observation, PieceKind } from "@chessonglass/contracts";
import { ChessState, type BoardPiece } from "./state.js";

/**
 * One legal move and how well it explains an observed board. `margin` is the
 * difference between this candidate's mismatch and the best candidate with a
 * different UCI move; it is zero when the move is tied with another move, and
 * negative for candidates that trail the leader.
 */
export type MoveCandidate = {
  uci: string | null;
  mismatch: number;
  margin: number;
  requiresReply: boolean;
};

/**
 * One validated observation together with the candidate selected for it.
 *
 * The plan's interface sketch also showed a sequence/candidateUci/margin
 * summary at this name. The behavioural contract and `decideMove` consume the
 * observation and its full candidate, so that is the shape kept here; the
 * sequence lives in `observation.context.referenceSequence`.
 */
export type Evidence = {
  observation: Observation;
  candidate: MoveCandidate;
};

export type MoveDecision = {
  kind: "commit" | "wait" | "confirm" | "no-change" | "uncertain";
  uci: string | null;
  reason: string;
};

const BOARD_SQUARES = 64;
const NO_RUNNER_UP_MARGIN = BOARD_SQUARES + 1;

/**
 * Baseline mismatch budget, not a calibrated accuracy claim. It tolerates a
 * few misread squares but rejects a board that is clearly another position
 * (for example most pieces missing). Revisit with measured provider data.
 */
const MAX_TRUSTED_MISMATCH = 6;

type ObservedCell =
  | { readonly kind: "hidden" }
  | { readonly kind: "empty" }
  | {
      readonly kind: PieceKind;
      readonly color: "white" | "black";
    };

/**
 * Flatten a sparse observation into square-indexed cells. `hidden` means the
 * provider could not see the square, so it cannot disagree with any move.
 */
function observe(observation: Observation): readonly ObservedCell[] {
  const cells: ObservedCell[] = Array.from({ length: BOARD_SQUARES }, () => ({
    kind: "hidden"
  }));
  const seen = new Set<number>();

  for (const square of observation.squares) {
    if (
      !Number.isSafeInteger(square.square) ||
      square.square < 0 ||
      square.square >= BOARD_SQUARES
    ) {
      throw new RangeError(
        `observation square must be an integer in [0,${BOARD_SQUARES - 1}]`
      );
    }
    if (seen.has(square.square)) {
      throw new RangeError(`observation contains duplicate square ${square.square}`);
    }
    seen.add(square.square);

    if (square.color === "unknown") {
      continue;
    }
    if (square.color === "empty") {
      cells[square.square] = { kind: "empty" };
      continue;
    }
    cells[square.square] = { kind: square.kind, color: square.color };
  }

  return cells;
}

/** Count known-square disagreements only; hidden cells never count. */
function countMismatches(
  board: readonly (BoardPiece | null)[],
  observed: readonly ObservedCell[]
): number {
  let mismatch = 0;

  for (let square = 0; square < BOARD_SQUARES; square += 1) {
    const cell = observed[square]!;
    if (cell.kind === "hidden") {
      continue;
    }

    const actual = board[square] ?? null;
    if (cell.kind === "empty") {
      if (actual !== null) {
        mismatch += 1;
      }
      continue;
    }

    if (actual === null || actual.color !== cell.color) {
      mismatch += 1;
      continue;
    }
    if (cell.kind !== "unknown" && actual.kind !== cell.kind) {
      mismatch += 1;
    }
  }

  return mismatch;
}

function compareUci(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Rank every legal move by how well it explains the observation. A move is
 * also tried with one opponent reply, because the camera may already show the
 * answer; the caller still commits only the current-side move. Promotions that
 * the observation cannot distinguish stay tied at margin zero.
 */
export function rankMoves(
  position: GamePosition,
  observation: Observation
): readonly MoveCandidate[] {
  const current = ChessState.fromConfirmed({ fen: position.fen });
  const legal = current.legalMoves();
  if (legal.length === 0) {
    return [];
  }

  const observed = observe(observation);
  const scored = legal.map((move) => {
    const after = current.clone();
    after.apply(move.uci);

    const direct = countMismatches(after.pieces(), observed);
    let best = direct;

    if (direct > 0) {
      for (const reply of after.legalMoves()) {
        after.apply(reply.uci);
        const mismatch = countMismatches(after.pieces(), observed);
        after.undo();
        if (mismatch < best) {
          best = mismatch;
        }
        if (best === 0) {
          break;
        }
      }
    }

    return {
      uci: move.uci,
      mismatch: best,
      requiresReply: best < direct
    };
  });

  scored.sort(
    (left, right) => left.mismatch - right.mismatch || compareUci(left.uci, right.uci)
  );

  return scored.map((candidate) => {
    let margin = NO_RUNNER_UP_MARGIN;
    for (const other of scored) {
      if (other.uci === candidate.uci) {
        continue;
      }
      const gap = other.mismatch - candidate.mismatch;
      if (gap < margin) {
        margin = gap;
      }
    }
    return { ...candidate, margin };
  });
}

function contextKey(observation: Observation): string {
  return `${observation.context.sessionId}\u0000${String(
    observation.context.referenceSequence
  )}`;
}

function hasVisiblePiece(observation: Observation): boolean {
  return observation.squares.some(
    (square) => square.color === "white" || square.color === "black"
  );
}

function hasUsableConfidence(observation: Observation): boolean {
  for (const square of observation.squares) {
    if (square.color !== "white" && square.color !== "black") {
      continue;
    }
    if (square.confidence === null || !(square.confidence > 0)) {
      return false;
    }
  }
  return true;
}

/**
 * Decide whether the collected readings justify one committed move.
 *
 * Policy: temporary occlusion waits; a board that cannot be trusted (no
 * confidence, no matching legal move, excessive mismatch, conflicting session
 * or position context) is uncertain; agreeing fresh frames commit; a tie or a
 * disagreement asks for confirmation. Never more than one current-side move
 * is committed, even when an opponent reply is already visible.
 */
export function decideMove(
  position: GamePosition,
  readings: readonly Evidence[]
): MoveDecision {
  if (readings.length === 0) {
    return { kind: "wait", uci: null, reason: "no observations yet" };
  }

  const sessions = new Set(
    readings.map((reading) => reading.observation.context.sessionId)
  );
  const positionVersions = new Set(
    readings.map((reading) => reading.observation.context.positionVersion)
  );
  if (sessions.size > 1 || positionVersions.size > 1) {
    return {
      kind: "uncertain",
      uci: null,
      reason: "readings come from different sessions or position contexts"
    };
  }

  const unique: Evidence[] = [];
  const seenFrames = new Set<string>();
  for (const reading of readings) {
    // A frame without a verified sequence cannot prove freshness, so it never
    // corroborates another read.
    if (reading.observation.context.referenceSequence === null) {
      continue;
    }
    const key = contextKey(reading.observation);
    if (seenFrames.has(key)) {
      continue;
    }
    seenFrames.add(key);
    unique.push(reading);
  }

  if (unique.length === 0) {
    return {
      kind: "wait",
      uci: null,
      reason: "waiting for a fresh frame with a verified sequence"
    };
  }

  const visible = unique.filter(
    (reading) =>
      reading.observation.boardVisible &&
      !reading.observation.handOverBoard &&
      hasVisiblePiece(reading.observation)
  );

  if (visible.length === 0) {
    return {
      kind: "wait",
      uci: null,
      reason: "board is not visible or a hand is covering it"
    };
  }

  if (!visible.every((reading) => hasUsableConfidence(reading.observation))) {
    return {
      kind: "uncertain",
      uci: null,
      reason: "observation confidence is unusable"
    };
  }

  const current = ChessState.fromConfirmed({ fen: position.fen });
  const currentBoard = current.pieces();
  const directMismatches = visible.map((reading) =>
    countMismatches(currentBoard, observe(reading.observation))
  );
  if (visible.length >= 2 && directMismatches.every((mismatch) => mismatch === 0)) {
    return {
      kind: "no-change",
      uci: null,
      reason: "observed board matches the current position"
    };
  }

  for (const reading of visible) {
    if (reading.candidate.uci === null) {
      return {
        kind: "uncertain",
        uci: null,
        reason: "no legal move matches the observed board"
      };
    }
    if (reading.candidate.mismatch > MAX_TRUSTED_MISMATCH) {
      return {
        kind: "uncertain",
        uci: null,
        reason: "observed board differs too much from every legal move"
      };
    }
  }

  if (visible.length < 2) {
    return {
      kind: "wait",
      uci: null,
      reason: "waiting for a second distinct fresh frame"
    };
  }

  const legal = new Set(current.legalMoves().map((move) => move.uci));
  for (const reading of visible) {
    if (!legal.has(reading.candidate.uci!)) {
      return {
        kind: "uncertain",
        uci: null,
        reason: "candidate is not legal in the current position"
      };
    }
  }

  if (visible.some((reading) => reading.candidate.margin === 0)) {
    return {
      kind: "confirm",
      uci: null,
      reason: "the observation cannot distinguish between legal moves"
    };
  }

  const supported = new Set(visible.map((reading) => reading.candidate.uci!));
  if (supported.size > 1) {
    return {
      kind: "confirm",
      uci: null,
      reason: "fresh readings support different moves"
    };
  }

  return {
    kind: "commit",
    uci: visible[0]!.candidate.uci!,
    reason: "fresh frames agree on one legal move"
  };
}
