import { ChessState } from "@chessonglass/chess";
import {
  newSourceId,
  type Frame,
  type FrameSource,
  type GamePosition,
  type Observation,
  type PieceObservation,
  type RequestContext,
  type Sequence,
  type SessionId,
  type SourceId
} from "@chessonglass/contracts";
import {
  CostLedger,
  GameCoordinator,
  type CoordinatorDependencies,
  type GameRecord,
  type GameStore,
  type Result,
  type ResumableGameRecord
} from "@chessonglass/game";
import type { BoardReader, ReadResult } from "@chessonglass/perception";
import type { Advisor } from "@chessonglass/platform";

export const CAPABILITIES = Object.freeze({
  video: true,
  microphone: false,
  audioOutput: false,
  display: false
});

/** Yield to the event loop until `condition` holds, or fail loudly. */
export async function until(
  condition: () => boolean,
  label: string,
  attempts = 200
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`condition not met after ${attempts} turns: ${label}`);
}

/** Let already-scheduled coordinator work advance without asserting. */
export async function flushTurns(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export function squareIndex(square: string): number {
  const file = square.charCodeAt(0) - "a".charCodeAt(0);
  const rank = Number(square[1]);
  return (8 - rank) * 8 + file;
}

export function makeFrame(
  sessionId: SessionId,
  sourceId: SourceId,
  sequence: Sequence,
  bytes?: Uint8Array
): Frame {
  return {
    sessionId,
    sourceId,
    sequence,
    capturedAtMonotonicMs: null,
    capturedAtWallMs: 1_700_000_000_000,
    receivedAtMonotonicMs: Number(sequence),
    bytes: bytes ?? new Uint8Array([Number(sequence % 251n), 1, 2]),
    mimeType: "image/jpeg"
  };
}

export function frameAfter(
  sessionId: SessionId,
  sequence: Sequence,
  bytes?: Uint8Array
): Frame {
  return makeFrame(sessionId, newSourceId(), sequence, bytes);
}

/** Build a full 64-square observation of the board described by `fen`. */
export function observationFor(input: {
  context: RequestContext;
  fen: string;
  hide?: readonly number[];
  confidence?: number | null;
  boardVisible?: boolean;
  handOverBoard?: boolean;
}): Observation {
  const pieces = ChessState.fromConfirmed({ fen: input.fen }).pieces();
  const hidden = new Set(input.hide ?? []);
  const squares: PieceObservation[] = [];

  for (let square = 0; square < 64; square += 1) {
    if (hidden.has(square)) {
      squares.push({ square, color: "unknown", kind: "unknown", confidence: null });
      continue;
    }
    const piece = pieces[square] ?? null;
    if (piece === null) {
      squares.push({ square, color: "empty", kind: "unknown", confidence: 0.99 });
    } else {
      squares.push({
        square,
        color: piece.color,
        kind: piece.kind,
        confidence: input.confidence ?? 0.95
      });
    }
  }

  return {
    context: input.context,
    boardVisible: input.boardVisible ?? true,
    handOverBoard: input.handOverBoard ?? false,
    squares,
    provider: "test-provider",
    model: "test-model",
    inputTokens: 100,
    outputTokens: 50
  };
}

export class ManualSource implements FrameSource {
  readonly capabilities = CAPABILITIES;
  closeCalls = 0;
  ended = false;

  private readonly queue: Frame[] = [];
  private readonly waiters: Array<{
    signal: AbortSignal;
    resolve: (frame: Frame | null) => void;
    onAbort: () => void;
  }> = [];

  push(frame: Frame): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(frame);
      return;
    }
    this.queue.push(frame);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(null);
    }
  }

  next(signal: AbortSignal): Promise<Frame | null> {
    if (signal.aborted || this.ended) {
      return Promise.resolve(null);
    }
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise<Frame | null>((resolve) => {
      const waiter = {
        signal,
        resolve,
        onAbort: (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          resolve(null);
        }
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal.aborted) {
        waiter.onAbort();
      }
    });
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.end();
  }
}

/** A source whose `next` and `close` never settle and ignore abort. */
export class StuckSource implements FrameSource {
  readonly capabilities = CAPABILITIES;
  closeCalls = 0;

  next(): Promise<Frame | null> {
    return new Promise<Frame | null>(() => undefined);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    return new Promise<void>(() => undefined);
  }
}

export type ReadInput = Parameters<BoardReader["read"]>[0];

export type PendingRead = {
  readonly input: ReadInput;
  resolve(result: ReadResult): void;
  reject(error: unknown): void;
};

export class ManualReader implements BoardReader {
  readonly calls: PendingRead[] = [];

  read(input: ReadInput): Promise<ReadResult> {
    return new Promise<ReadResult>((resolve, reject) => {
      this.calls.push({ input, resolve, reject });
    });
  }

  settle(index: number, result: ReadResult): void {
    this.calls[index]!.resolve(result);
  }

  settleWithMove(index: number, fen: string, hide?: readonly number[]): void {
    const call = this.calls[index]!;
    call.resolve({
      ok: true,
      observation: observationFor({ context: call.input.context, fen, hide })
    });
  }
}

export type PendingBest = {
  readonly input: { fen: string; context: RequestContext; signal: AbortSignal };
  resolve(value: { uci: string; score: { cp?: number; mate?: number } }): void;
  reject(error: unknown): void;
};

export class ManualAdvisor implements Advisor {
  readonly calls: PendingBest[] = [];
  closed = false;

  best(input: PendingBest["input"]): Promise<{ uci: string; score: { cp?: number } }> {
    return new Promise((resolve, reject) => {
      this.calls.push({ input, resolve, reject });
    });
  }

  resolveBest(index: number, uci: string): void {
    this.calls[index]!.resolve({ uci, score: { cp: 20 } });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function copyRecord(record: GameRecord): GameRecord {
  return {
    ...record,
    position: {
      ...record.position,
      history: [...record.position.history],
      uncertainty: { ...record.position.uncertainty }
    }
  };
}

export class MemoryStore implements GameStore {
  readonly records = new Map<SessionId, GameRecord>();
  readonly appends: GameRecord[] = [];
  failNextAppend = false;

  async load(_sessionId: SessionId): Promise<ResumableGameRecord | null> {
    return null;
  }

  async append(record: GameRecord): Promise<void> {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("store unavailable");
    }
    const copy = copyRecord(record);
    this.appends.push(copy);
    this.records.set(record.sessionId, copy);
  }

  async exportPgn(_sessionId: SessionId): Promise<string> {
    return "";
  }

  async delete(sessionId: SessionId): Promise<void> {
    this.records.delete(sessionId);
  }
}

export class RecordingSink {
  readonly results: Result[] = [];
  readonly clears: Array<RequestContext | undefined> = [];
  failNextPublish = false;
  closeCalls = 0;

  async publish(result: Result): Promise<void> {
    if (this.failNextPublish) {
      this.failNextPublish = false;
      throw new Error("sink unavailable");
    }
    this.results.push(result);
  }

  clear(context?: RequestContext): void {
    this.clears.push(context);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

export type Harness = {
  readonly source: ManualSource;
  readonly reader: ManualReader;
  readonly advisor: ManualAdvisor;
  readonly store: MemoryStore;
  readonly ledger: CostLedger;
  readonly sink: RecordingSink;
  readonly coordinator: GameCoordinator;
};

export function createHarness(
  options: {
    now?: () => number;
    shutdownTimeoutMs?: number;
    ledger?: CostLedger;
    sink?: CoordinatorDependencies["sink"];
  } = {}
): Harness {
  const source = new ManualSource();
  const reader = new ManualReader();
  const advisor = new ManualAdvisor();
  const store = new MemoryStore();
  const ledger = options.ledger ?? new CostLedger(10, 0.5);
  const sink = new RecordingSink();
  const coordinator = new GameCoordinator({
    reader,
    advisor,
    store,
    ledger,
    sink: options.sink ?? sink,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: options.shutdownTimeoutMs })
  });
  return { source, reader, advisor, store, ledger, sink, coordinator };
}

export function positionAfter(moves: readonly string[]): GamePosition {
  return ChessState.fromConfirmed({
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    history: moves
  }).position();
}

export function fenAfter(moves: readonly string[]): string {
  return positionAfter(moves).fen;
}

export function startPosition(): GamePosition {
  return ChessState.initial().position();
}
