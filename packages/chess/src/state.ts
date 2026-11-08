import { Chess, DEFAULT_POSITION, validateFen, type PieceSymbol } from "chess.js";
import type {
  GamePosition,
  PieceKind,
  PositionUncertainty,
  Promotion
} from "@chessonglass/contracts";

const DEFAULT_UNCERTAINTY: PositionUncertainty = Object.freeze({
  castlingRights: false,
  enPassant: false,
  promotion: false
});

/** A placed piece as seen by ChessOnGlass; square order is a8..h1, row-major. */
export type BoardPiece = Readonly<{
  color: "white" | "black";
  kind: Exclude<PieceKind, "unknown">;
}>;

const KIND_BY_SYMBOL: Readonly<Record<PieceSymbol, BoardPiece["kind"]>> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king"
};

export class IllegalMoveError extends Error {
  readonly uci: string;

  constructor(uci: string, detail: string) {
    super(`illegal move ${uci}: ${detail}`);
    this.name = "IllegalMoveError";
    this.uci = uci;
  }
}

export class InvalidPositionError extends Error {
  constructor(detail: string) {
    super(`invalid position: ${detail}`);
    this.name = "InvalidPositionError";
  }
}

type MoveDescriptor = { from: string; to: string; promotion?: string };

function parseUci(uci: string): MoveDescriptor {
  const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci);
  if (match === null) {
    throw new IllegalMoveError(uci, "not a UCI coordinate move");
  }
  const descriptor: MoveDescriptor = { from: match[1]!, to: match[2]! };
  if (match[3] !== undefined) {
    descriptor.promotion = match[3];
  }
  return descriptor;
}

function applyTo(chess: Chess, uci: string): void {
  const descriptor = parseUci(uci);
  try {
    chess.move(descriptor);
  } catch (error) {
    throw new IllegalMoveError(uci, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Immutable-facing adapter over chess.js. Callers receive snapshots; chess.js
 * board internals never escape this class. History is kept as verified UCI
 * moves and is never synthesized from an image.
 */
export class ChessState {
  private readonly chess: Chess;
  private readonly initialFen: string;
  private readonly history: string[];
  private readonly uncertainty: PositionUncertainty;

  private constructor(
    chess: Chess,
    initialFen: string,
    history: string[],
    uncertainty: PositionUncertainty
  ) {
    this.chess = chess;
    this.initialFen = initialFen;
    this.history = history;
    this.uncertainty = uncertainty;
  }

  static initial(): ChessState {
    return new ChessState(new Chess(), DEFAULT_POSITION, [], DEFAULT_UNCERTAINTY);
  }

  static fromConfirmed(input: {
    fen: string;
    history?: readonly string[];
    uncertainty?: Partial<PositionUncertainty>;
  }): ChessState {
    const validation = validateFen(input.fen);
    if (!validation.ok) {
      throw new InvalidPositionError(validation.error ?? "FEN rejected by chess.js");
    }

    const chess = new Chess(input.fen);
    const history = [...(input.history ?? [])];
    for (const uci of history) {
      applyTo(chess, uci);
    }

    return new ChessState(chess, input.fen, history, {
      ...DEFAULT_UNCERTAINTY,
      ...input.uncertainty
    });
  }

  position(): GamePosition {
    return {
      initialFen: this.initialFen,
      fen: this.chess.fen(),
      history: [...this.history],
      uncertainty: { ...this.uncertainty }
    };
  }

  legalMoves(): readonly { uci: string; san: string; promotion?: Promotion }[] {
    return this.chess.moves({ verbose: true }).map((move) => {
      const promotion = move.promotion as Promotion | undefined;
      return promotion === undefined
        ? { uci: move.lan, san: move.san }
        : { uci: move.lan, san: move.san, promotion };
    });
  }

  /**
   * Snapshot the board in the same square order as observations: index 0 is
   * a8, index 63 is h1. The returned array and entries are fresh copies, so
   * callers cannot mutate chess.js state through them.
   */
  pieces(): readonly (BoardPiece | null)[] {
    return this.chess.board().flat().map((cell) =>
      cell === null
        ? null
        : {
            color: cell.color === "w" ? "white" : "black",
            kind: KIND_BY_SYMBOL[cell.type]
          }
    );
  }

  apply(uci: string): GamePosition {
    applyTo(this.chess, uci);
    this.history.push(uci);
    return this.position();
  }

  undo(): GamePosition | null {
    if (this.history.length === 0) {
      return null;
    }
    const undone = this.chess.undo();
    if (undone === null) {
      return null;
    }
    this.history.pop();
    return this.position();
  }

  clone(): ChessState {
    const chess = new Chess(this.initialFen);
    for (const uci of this.history) {
      applyTo(chess, uci);
    }
    return new ChessState(chess, this.initialFen, [...this.history], { ...this.uncertainty });
  }

  isCheckmate(): boolean {
    return this.chess.isCheckmate();
  }

  isStalemate(): boolean {
    return this.chess.isStalemate();
  }

  isDraw(): boolean {
    return this.chess.isDraw();
  }

  isGameOver(): boolean {
    return this.chess.isGameOver();
  }
}
