import {
  ChessState,
  decideMove,
  rankMoves,
  type Evidence,
  type MoveCandidate
} from "@chessonglass/chess";
import {
  newSessionId,
  type Frame,
  type FrameSource,
  type GamePosition,
  type GameStatus,
  type Observation,
  type Promotion,
  type RequestContext,
  type Sequence,
  type SessionId,
  type SourceId
} from "@chessonglass/contracts";
import { toReadFailure, type BoardReader, type ReadFailure, type ReadResult } from "@chessonglass/perception";
import type { Advisor } from "@chessonglass/platform";
import type { CostLedger } from "./budget.js";
import type { GameCommand } from "./commands.js";
import type { GameRecord } from "./journal.js";
import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  settleWithin,
  SourceSlot
} from "./replace-source.js";
import type { ResultSink } from "./results.js";
import type { GameStore } from "./storage.js";

/** One publishable outcome. UI, audio and file sinks each select their part. */
export type Result = {
  context: RequestContext;
  moveUci: string | null;
  spokenText: string | null;
  status: GameStatus;
  reason: string | null;
};

export type GameSnapshot = {
  sessionId: SessionId;
  positionVersion: number;
  status: GameStatus;
  position: GamePosition | null;
  suggestion: Result | null;
  frameAgeMs: number | null;
  error: string | null;
};

export type CoordinatorDependencies = {
  reader: BoardReader;
  advisor: Advisor;
  store: GameStore;
  ledger: CostLedger;
  sink: ResultSink;
  /** Injectable clock for deterministic freshness tests. */
  now?: () => number;
  /** Overall bound for close/source replacement, default 2 s. */
  shutdownTimeoutMs?: number;
};

const EVIDENCE_LIMIT = 4;
const BUDGET_EXHAUSTED = "estimated budget exhausted; paid work is paused";

type ActiveRequest = {
  readonly context: RequestContext;
  readonly controller: AbortController;
};

function sameContext(left: RequestContext, right: RequestContext): boolean {
  return (
    left.requestId === right.requestId &&
    left.sessionId === right.sessionId &&
    left.positionVersion === right.positionVersion &&
    left.referenceSequence === right.referenceSequence
  );
}

/**
 * Detect the one ambiguity a user command can resolve directly: tied moves
 * that differ only in their promotion piece.
 */
function detectPendingPromotion(
  ranked: readonly MoveCandidate[]
): { from: string; to: string } | null {
  const best = ranked[0];
  if (best === undefined || best.uci === null) {
    return null;
  }
  const tied = ranked.filter(
    (candidate) =>
      candidate.uci !== null &&
      candidate.mismatch === best.mismatch &&
      candidate.margin === 0
  );
  if (tied.length < 2) {
    return null;
  }
  const prefixes = new Set(tied.map((candidate) => candidate.uci!.slice(0, 4)));
  if (prefixes.size !== 1) {
    return null;
  }
  const promotions = new Set(
    tied
      .map((candidate) => candidate.uci!.slice(4))
      .filter((suffix) => /^[qrbn]$/.test(suffix))
  );
  if (promotions.size < 2) {
    return null;
  }
  const uci = tied[0]!.uci!;
  return { from: uci.slice(0, 2), to: uci.slice(2, 4) };
}

/**
 * The single writer for one game session. Capture and inference may run
 * concurrently, but every result carries a RequestContext and is checked
 * again immediately before it may mutate state or publish. Scheduled work
 * from an old position, session or source is dropped, never replayed.
 */
export class GameCoordinator {
  private readonly deps: CoordinatorDependencies;
  private readonly outputClock: () => number;
  private readonly shutdownTimeoutMs: number;
  private readonly sourceSlot = new SourceSlot();
  private readonly listeners = new Set<(snapshot: GameSnapshot) => void>();
  private readonly requests = new Map<string, AbortController>();
  private readonly lastSequences = new Map<SourceId, Sequence>();

  private sessionId: SessionId = newSessionId();
  private generation = 0;
  private requestCounter = 0;
  private position: ChessState | null = null;
  private positionVersion = 0;
  private status: GameStatus = "needs-position";
  private suggestion: Result | null = null;
  private error: string | null = null;
  private evidence: Evidence[] = [];
  private pendingPromotion: { from: string; to: string } | null = null;
  private lastFrame: Frame | null = null;
  private lastFrameReceivedAtWallMs: number | null = null;
  private createdAtWallMs: number | null = null;
  private lastPublishedContext: RequestContext | null = null;
  private started = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private activeReadToken: symbol | null = null;
  private pumpController: AbortController | null = null;
  private pump: Promise<void> | null = null;

  constructor(dependencies: CoordinatorDependencies) {
    this.deps = dependencies;
    this.outputClock = dependencies.now ?? Date.now;
    this.shutdownTimeoutMs =
      dependencies.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    if (!Number.isFinite(this.shutdownTimeoutMs) || this.shutdownTimeoutMs <= 0) {
      throw new RangeError("shutdownTimeoutMs must be a finite positive number");
    }
  }

  /** Begin a session and resolve after the initial state is published. */
  async start(source: FrameSource, initial: GamePosition | null): Promise<void> {
    this.requireOpen();
    if (this.started) {
      throw new Error("coordinator has already started");
    }
    this.started = true;
    this.sessionId = newSessionId();
    this.applyInitialState(initial);
    this.attachPump(source);
    await this.persist();
    await this.publishNotice(
      initial === null ? "waiting for a confirmed position" : "game started"
    );
    this.maybeSuggest();
  }

  /**
   * Swap the active source without trusting anything from the old lifecycle:
   * the session rotates, pending work is aborted and the previous source is
   * closed only after the replacement is active.
   */
  async replaceSource(source: FrameSource, initial: GamePosition | null): Promise<void> {
    this.requireStarted();
    const previous = this.sourceSlot.current();
    const pump = this.pump;
    this.detachPump();
    this.invalidatePending("source replaced");
    this.sessionId = newSessionId();
    this.applyInitialState(initial);
    this.attachPump(source);
    await this.persist();
    await this.publishNotice("source replaced");
    this.maybeSuggest();

    if (pump !== null) {
      await settleWithin(async () => { await pump; }, this.shutdownTimeoutMs);
    }
    if (previous !== null && previous !== source) {
      await settleWithin(() => previous.close(), this.shutdownTimeoutMs);
    }
  }

  async dispatch(command: GameCommand): Promise<void> {
    this.requireStarted();
    switch (command.type) {
      case "pause":
        return this.pause();
      case "resume":
        return this.resume();
      case "undo":
        return this.undo();
      case "repeat":
        return this.repeat();
      case "new-game":
        return this.newGame(command.initial);
      case "manual-move":
        return this.commitMove(command.uci, "manual move");
      case "choose-promotion":
        return this.choosePromotion(command.promotion);
      case "confirm-position":
        return this.confirmPosition(command.position);
    }
  }

  snapshot(): GameSnapshot {
    return {
      sessionId: this.sessionId,
      positionVersion: this.positionVersion,
      status: this.status,
      position: this.position?.position() ?? null,
      suggestion:
        this.suggestion === null
          ? null
          : { ...this.suggestion, context: { ...this.suggestion.context } },
      frameAgeMs:
        this.lastFrameReceivedAtWallMs === null
          ? null
          : Math.max(0, this.outputClock() - this.lastFrameReceivedAtWallMs),
      error: this.error
    };
  }

  subscribe(listener: (snapshot: GameSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Abort owned work, close the source and wait within a bounded shutdown. */
  async close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    this.closed = true;
    this.invalidatePending("coordinator closed");
    this.deps.sink.clear();

    const pump = this.pump;
    this.detachPump();
    const source = this.sourceSlot.detach();

    this.closePromise = settleWithin(async () => {
      const tasks: Array<Promise<unknown>> = [];
      if (pump !== null) {
        tasks.push(pump);
      }
      if (source !== null) {
        tasks.push(source.close());
      }
      await Promise.allSettled(tasks);
    }, this.shutdownTimeoutMs).then(() => undefined);
    return this.closePromise;
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new Error("coordinator is closed");
    }
  }

  private requireStarted(): void {
    this.requireOpen();
    if (!this.started) {
      throw new Error("coordinator has not started");
    }
  }

  private applyInitialState(initial: GamePosition | null): void {
    this.evidence = [];
    this.pendingPromotion = null;
    this.suggestion = null;
    this.error = null;
    this.lastFrame = null;
    this.lastFrameReceivedAtWallMs = null;
    this.lastSequences.clear();
    this.createdAtWallMs = null;
    this.positionVersion = 0;

    if (initial === null) {
      this.position = null;
      this.status = "needs-position";
      return;
    }
    try {
      this.position = ChessState.fromConfirmed({
        fen: initial.initialFen,
        history: initial.history,
        uncertainty: initial.uncertainty
      });
      this.status = this.position.isGameOver() ? "finished" : "ready";
    } catch {
      this.position = null;
      this.status = "needs-position";
      this.error = "position is not playable";
    }
  }

  private attachPump(source: FrameSource): void {
    this.sourceSlot.activate(source);
    const controller = new AbortController();
    this.pumpController = controller;
    this.pump = this.runPump(source, controller.signal).catch(() => undefined);
  }

  private detachPump(): void {
    this.pumpController?.abort("pump detached");
    this.pumpController = null;
    this.pump = null;
    // A provider that ignores abort may never settle its read; the new
    // session must not inherit that guard.
    this.activeReadToken = null;
  }

  private async runPump(source: FrameSource, signal: AbortSignal): Promise<void> {
    while (!this.closed && !signal.aborted) {
      let frame: Frame | null;
      try {
        frame = await source.next(signal);
      } catch {
        frame = null;
      }

      if (frame === null) {
        if (this.closed || signal.aborted || this.sourceSlot.current() !== source) {
          return;
        }
        await this.markLost();
        return;
      }
      if (this.sourceSlot.current() !== source || frame.sessionId !== this.sessionId) {
        continue;
      }

      const last = this.lastSequences.get(frame.sourceId);
      if (last !== undefined && frame.sequence <= last) {
        continue;
      }
      this.lastSequences.set(frame.sourceId, frame.sequence);

      const previous = this.lastFrame;
      this.lastFrame = frame;
      this.lastFrameReceivedAtWallMs = this.outputClock();
      this.emitSnapshot();

      if (!this.canRead()) {
        continue;
      }
      await this.readFrame(frame, previous);
    }
  }

  private async markLost(): Promise<void> {
    if (this.status === "finished") {
      return;
    }
    this.invalidatePending("source lost");
    this.evidence = [];
    this.status = "lost";
    this.error = "frame source ended";
    await this.publishNotice("frame source ended");
  }

  private canRead(): boolean {
    if (this.closed || this.position === null) {
      return false;
    }
    if (this.status !== "ready" && this.status !== "waiting") {
      return false;
    }
    if (this.deps.ledger.snapshot().paused) {
      this.markBudgetExhausted();
      return false;
    }
    return true;
  }

  private markBudgetExhausted(): void {
    if (this.status === "uncertain" && this.error === BUDGET_EXHAUSTED) {
      return;
    }
    this.status = "uncertain";
    this.error = BUDGET_EXHAUSTED;
    this.emitSnapshot();
  }

  private async readFrame(frame: Frame, previous: Frame | null): Promise<void> {
    if (this.activeReadToken !== null) {
      return;
    }
    const token = Symbol("read");
    this.activeReadToken = token;
    const request = this.beginRequest(frame.sequence);
    try {
      const reference =
        previous !== null && this.position !== null
          ? { frame: previous, position: this.position.position() }
          : null;
      let result: ReadResult;
      try {
        result = await this.deps.reader.read({
          frame,
          reference,
          context: request.context,
          signal: request.controller.signal
        });
      } catch (error) {
        result = toReadFailure(error, request.controller.signal);
      }

      const live = this.isLive(request);
      this.endRequest(request.context.requestId);
      if (!live) {
        return;
      }
      if (!result.ok) {
        this.handleReadFailure(result);
        return;
      }
      if (!sameContext(result.observation.context, request.context)) {
        this.markUncertain("provider observation does not match the active request");
        return;
      }
      this.ingestObservation(result.observation);
    } finally {
      if (this.activeReadToken === token) {
        this.activeReadToken = null;
      }
    }
  }

  private handleReadFailure(failure: ReadFailure): void {
    if (failure.code === "cancelled") {
      return;
    }
    this.error = failure.message;
    if (!failure.retryable) {
      this.status = "uncertain";
    }
    this.emitSnapshot();
  }

  private ingestObservation(observation: Observation): void {
    if (this.position === null) {
      return;
    }
    const current = this.position.position();
    let ranked: readonly MoveCandidate[];
    try {
      ranked = rankMoves(current, observation);
    } catch {
      this.markUncertain("provider observation is malformed");
      return;
    }

    const best = ranked[0];
    const candidate: MoveCandidate = best ?? {
      uci: null,
      mismatch: Number.MAX_SAFE_INTEGER,
      margin: 0,
      requiresReply: false
    };
    this.evidence.push({ observation, candidate });
    while (this.evidence.length > EVIDENCE_LIMIT) {
      this.evidence.shift();
    }

    const decision = decideMove(current, this.evidence);
    switch (decision.kind) {
      case "wait":
        this.status = "waiting";
        this.error = null;
        this.emitSnapshot();
        return;
      case "no-change":
        this.evidence = [];
        this.status = "ready";
        this.error = null;
        this.emitSnapshot();
        return;
      case "uncertain":
        this.evidence = [];
        this.status = "uncertain";
        this.error = decision.reason;
        this.emitSnapshot();
        return;
      case "confirm":
        this.pendingPromotion = detectPendingPromotion(ranked);
        this.status = "confirming";
        this.error = decision.reason;
        this.emitSnapshot();
        return;
      case "commit":
        void this.commitMove(decision.uci!, "observed move");
        return;
    }
  }

  private markUncertain(reason: string): void {
    this.evidence = [];
    this.status = "uncertain";
    this.error = reason;
    this.emitSnapshot();
  }

  private maybeSuggest(): void {
    if (this.status === "ready" && this.suggestion === null) {
      void this.requestSuggestion();
    }
  }

  private async requestSuggestion(): Promise<void> {
    try {
      if (this.closed || this.position === null || this.status !== "ready") {
        return;
      }
      if (this.position.isGameOver()) {
        this.status = "finished";
        this.suggestion = null;
        this.emitSnapshot();
        return;
      }
      if (this.deps.ledger.snapshot().paused) {
        this.markBudgetExhausted();
        return;
      }

      const request = this.beginRequest(null);
      let best: { uci: string } | null = null;
      let failed = false;
      try {
        const answer = await this.deps.advisor.best({
          fen: this.position.position().fen,
          context: request.context,
          signal: request.controller.signal
        });
        if (this.isLive(request)) {
          best = { uci: answer.uci };
        }
      } catch {
        failed = this.isLive(request);
      } finally {
        this.endRequest(request.context.requestId);
      }

      if (failed) {
        this.error = "engine request failed";
        this.emitSnapshot();
        return;
      }
      if (best === null) {
        return;
      }

      const move = this.position
        .legalMoves()
        .find((entry) => entry.uci === best!.uci);
      if (move === undefined) {
        this.error = "engine suggested an illegal move";
        this.emitSnapshot();
        await this.publishNotice("engine suggestion rejected");
        return;
      }

      const result: Result = {
        context: request.context,
        moveUci: move.uci,
        spokenText: `Suggested ${move.san}`,
        status: this.status,
        reason: "engine suggestion"
      };
      this.suggestion = result;
      await this.emit(result);
    } catch {
      // Suggestions are advisory; a failure never breaks the game.
    }
  }

  private async pause(): Promise<void> {
    if (this.status === "paused") {
      return;
    }
    this.status = "paused";
    this.evidence = [];
    this.error = null;
    this.invalidatePending("paused");
    await this.publishNotice("paused");
  }

  private async resume(): Promise<void> {
    if (this.status !== "paused") {
      return;
    }
    this.status =
      this.position === null
        ? "needs-position"
        : this.position.isGameOver()
          ? "finished"
          : "ready";
    this.error = null;
    await this.publishNotice("resumed");
    this.maybeSuggest();
  }

  private async undo(): Promise<void> {
    if (this.position === null) {
      await this.publishNotice("no position to undo");
      return;
    }
    if (this.position.undo() === null) {
      await this.publishNotice("nothing to undo");
      return;
    }

    this.positionVersion += 1;
    this.invalidatePending("undo");
    this.evidence = [];
    this.pendingPromotion = null;
    this.suggestion = null;
    this.error = null;
    this.status = this.position.isGameOver() ? "finished" : "ready";
    await this.persist();
    await this.publishNotice("undo");
    this.maybeSuggest();
  }

  private async repeat(): Promise<void> {
    if (this.suggestion === null) {
      await this.publishNotice("nothing to repeat");
      return;
    }
    const result: Result = {
      context: this.newOutputContext(),
      moveUci: this.suggestion.moveUci,
      spokenText: this.suggestion.spokenText,
      status: this.status,
      reason: "repeated result"
    };
    this.suggestion = result;
    await this.emit(result);
  }

  private async newGame(initial: GamePosition | null): Promise<void> {
    this.invalidatePending("new game");
    this.sessionId = newSessionId();
    this.applyInitialState(initial ?? ChessState.initial().position());
    await this.persist();
    await this.publishNotice("new game");
    this.maybeSuggest();
  }

  private async choosePromotion(promotion: Promotion): Promise<void> {
    if (this.pendingPromotion === null) {
      this.error = "no promotion is pending";
      this.emitSnapshot();
      await this.publishNotice("promotion rejected");
      return;
    }
    const { from, to } = this.pendingPromotion;
    await this.commitMove(`${from}${to}${promotion}`, "promotion confirmed");
  }

  private async confirmPosition(position: GamePosition): Promise<void> {
    let confirmed: ChessState;
    try {
      confirmed = ChessState.fromConfirmed({
        fen: position.initialFen,
        history: position.history,
        uncertainty: position.uncertainty
      });
    } catch {
      this.error = "position is not playable";
      this.emitSnapshot();
      await this.publishNotice("position rejected");
      return;
    }

    this.invalidatePending("position confirmed");
    this.position = confirmed;
    this.positionVersion += 1;
    this.evidence = [];
    this.pendingPromotion = null;
    this.suggestion = null;
    this.error = null;
    this.status = confirmed.isGameOver() ? "finished" : "ready";
    await this.persist();
    await this.publishNotice("position confirmed");
    this.maybeSuggest();
  }

  private async commitMove(uci: string, reason: string): Promise<void> {
    if (this.position === null) {
      this.error = "no position to play from";
      this.emitSnapshot();
      await this.publishNotice("move rejected");
      return;
    }
    const move = this.position.legalMoves().find((entry) => entry.uci === uci);
    if (move === undefined) {
      this.error = "move is not legal in the current position";
      this.emitSnapshot();
      await this.publishNotice("move rejected");
      return;
    }

    this.position.apply(uci);
    this.positionVersion += 1;
    this.invalidatePending(reason);
    this.evidence = [];
    this.pendingPromotion = null;
    this.suggestion = null;
    this.error = null;
    this.status = this.position.isGameOver() ? "finished" : "ready";
    await this.persist();
    await this.publishMove(uci, `Played ${move.san}`, reason);
    this.maybeSuggest();
  }

  private beginRequest(referenceSequence: Sequence | null): ActiveRequest {
    const controller = new AbortController();
    const context: RequestContext = {
      requestId: `${this.sessionId}:${this.generation}:${this.requestCounter++}`,
      sessionId: this.sessionId,
      positionVersion: this.positionVersion,
      referenceSequence
    };
    this.requests.set(context.requestId, controller);
    return { context, controller };
  }

  private endRequest(requestId: string): void {
    this.requests.delete(requestId);
  }

  private isLive(request: ActiveRequest): boolean {
    return (
      !this.closed &&
      this.requests.has(request.context.requestId) &&
      request.context.sessionId === this.sessionId &&
      request.context.positionVersion === this.positionVersion
    );
  }

  private invalidatePending(reason: string): void {
    this.generation += 1;
    for (const controller of this.requests.values()) {
      controller.abort(reason);
    }
    this.requests.clear();
    this.deps.sink.clear(this.lastPublishedContext ?? undefined);
    this.lastPublishedContext = null;
  }

  private newOutputContext(): RequestContext {
    return {
      requestId: `${this.sessionId}:${this.generation}:${this.requestCounter++}:out`,
      sessionId: this.sessionId,
      positionVersion: this.positionVersion,
      referenceSequence: this.lastFrame?.sequence ?? null
    };
  }

  private async publishNotice(reason: string): Promise<void> {
    await this.emit({
      context: this.newOutputContext(),
      moveUci: null,
      spokenText: null,
      status: this.status,
      reason
    });
  }

  private async publishMove(
    uci: string,
    spokenText: string,
    reason: string
  ): Promise<void> {
    await this.emit({
      context: this.newOutputContext(),
      moveUci: uci,
      spokenText,
      status: this.status,
      reason
    });
  }

  private async emit(result: Result): Promise<void> {
    this.lastPublishedContext = result.context;
    this.emitSnapshot();
    try {
      await this.deps.sink.publish(result);
    } catch {
      this.error = "result output failed";
      this.emitSnapshot();
    }
  }

  private emitSnapshot(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Subscriber faults must not become game faults.
      }
    }
  }

  private async persist(): Promise<void> {
    if (this.position === null) {
      return;
    }
    if (this.createdAtWallMs === null) {
      this.createdAtWallMs = this.outputClock();
    }
    const record: GameRecord = {
      schemaVersion: 1,
      sessionId: this.sessionId,
      position: this.position.position(),
      positionVersion: this.positionVersion,
      createdAtWallMs: this.createdAtWallMs,
      updatedAtWallMs: Math.max(this.createdAtWallMs, this.outputClock())
    };
    try {
      await this.deps.store.append(record);
    } catch {
      this.error = "game record could not be saved";
      this.emitSnapshot();
    }
  }
}
