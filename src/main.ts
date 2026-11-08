/**
 * The live game: frames from the call → Watcher → Stockfish → speech, shown in the command center.
 *
 * The loop owns the game state. The command center reads the snapshot the loop publishes after
 * every change, and its controls are queued and applied between frames.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Chess, type Move } from "chess.js";

import { boardSvg } from "./board-svg.js";
import type { Frame, Source } from "./capture.js";
import { type Score, type Suggestion, scoreFor } from "./engine.js";
import type { Events } from "./events.js";
import { copyBoard, gameOver, moveFrom, movesText, spoken, toPgn } from "./game.js";
import { Tracker, type Update } from "./match.js";
import type { OverlayState } from "./overlay.js";
import { cost } from "./pricing.js";
import { type PreCheck, type Reader, type Step, Watcher } from "./watch.js";

export const ACTIONS = new Set(["pause", "resume", "undo", "move", "new_game", "repeat"]);

export interface Pace {
  opponent: number; // seconds between frames while waiting for the opponent's move
  mine: number; // while waiting for mine, which isn't urgent
}

export interface Advisor {
  best(fen: string): Promise<Suggestion>;
}

export interface Voice {
  say(text: string): void;
  clear?(): void; // drop lines queued but not yet started
}

export interface GameOptions {
  vision: Reader & { model: string; strategy: string };
  firstLook?: Reader | null; // reads a frame on its own when there's no reference (see Watcher)
  engine: Advisor;
  speaker: Voice;
  events: Events;
  myColor: "w" | "b";
  start?: Chess;
  gate?: PreCheck | null;
  maxCost?: number;
  runDir?: string | null;
  pace?: Pace;
  exitAtEnd?: boolean; // stop the loop when a recording runs out
}

type Phase = "setup" | "playing" | "game_over" | "ended";

export class Game {
  readonly vision: GameOptions["vision"];
  readonly firstLook: Reader | null;
  readonly gate: PreCheck | null;
  readonly engine: Advisor;
  readonly speaker: Voice;
  readonly events: Events;
  readonly maxCost: number;
  readonly runDir: string | null;
  readonly pace: Pace;
  readonly exitAtEnd: boolean;
  spent = 0;
  paused = false;
  noCall = false;
  latestFrame: Frame | null = null;
  myColor!: "w" | "b";
  tracker!: Tracker;
  watcher!: Watcher;
  phase: Phase = "setup";
  suggestion: { move: Move; score: Score } | null = null;
  private start!: Chess;
  private announcedLost = false;
  private troubled = false; // said "Something went wrong" since the last clean frame
  private errors = 0; // errors reported so far
  private failures = 0; // frames in a row that failed, for backing off
  private suggestFailed = false; // owe the wearer a suggestion Stockfish couldn't give
  private stopping = false;
  private readonly controls: Record<string, unknown>[] = [];
  private current: Record<string, unknown> = {};

  constructor(
    readonly source: Source,
    options: GameOptions,
  ) {
    this.vision = options.vision;
    this.firstLook = options.firstLook ?? null;
    this.gate = options.gate ?? null;
    this.engine = options.engine;
    this.speaker = options.speaker;
    this.events = options.events;
    this.maxCost = options.maxCost ?? 10.0;
    this.runDir = options.runDir ?? null;
    this.pace = options.pace ?? { opponent: 1.0, mine: 3.0 };
    this.exitAtEnd = options.exitAtEnd ?? false;
    this.newGame(options.myColor, options.start ?? new Chess());
  }

  // ---- the loop ---------------------------------------------------------------------------

  /**
   * Read frames until `signal` aborts. A failure in one frame (capture, the pre-check, the
   * vision model, Stockfish) is reported and the loop carries on, backing off while it repeats.
   */
  async run(signal: AbortSignal): Promise<void> {
    signal.addEventListener("abort", () => (this.stopping = true), { once: true });
    this.publish();
    while (!signal.aborted) {
      await this.applyControls();
      if (this.phase === "ended" && this.exitAtEnd) return;
      if (this.paused || this.phase === "game_over" || this.phase === "ended") {
        await pause(300, signal);
        continue;
      }
      const started = performance.now();
      try {
        const frame = await this.source.grab();
        if (frame === null) {
          this.noFrame();
          await pause(1000, signal);
          continue;
        }
        await this.onFrame(frame);
        this.failures = 0;
      } catch (error) {
        this.trouble("reading the board", error);
        this.publish();
        await pause(Math.min(10_000, 1000 * 2 ** this.failures++), signal);
        continue;
      }
      await pause(Math.max(0, this.interval() * 1000 - (performance.now() - started)), signal);
    }
  }

  /** Report a failure the game carries on from. The wearer hears about it once, not per frame. */
  private trouble(what: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.errors++;
    this.events.emit("error", { detail: `${what}: ${message}` });
    if (!this.troubled && !this.stopping) {
      this.troubled = true;
      this.speaker.say("Something went wrong. Still trying.");
    }
  }

  async onFrame(frame: Frame): Promise<void> {
    if (this.noCall) {
      this.noCall = false;
      this.events.emit("call", { detail: "the call window is back" });
    }
    this.latestFrame = frame;
    const errors = this.errors;
    const before = this.tracker.board.fen();
    const step = await this.watcher.step(frame);
    this.report(step);

    const update = step.update;
    const confirmed = update.kind === "committed" || update.match?.kind === "no_change";
    if (this.phase === "setup" && confirmed) {
      this.phase = "playing";
      await this.ready(update.kind !== "committed"); // a committed move gets its suggestion below
    }
    if (update.kind === "committed") await this.committed(update, before);
    else if (this.suggestFailed && this.phase === "playing" && this.tracker.board.turn() === this.myColor) {
      await this.suggest(); // Stockfish failed last time: try again
    }
    if (update.kind === "lost" && !this.announcedLost) {
      this.announcedLost = true;
      this.speaker.say("Lost track of the board.");
      this.events.emit("lost", { detail: "what the model sees no longer fits the tracked position" });
    }
    if (!this.tracker.lost) this.announcedLost = false;
    this.account(step); // after acting on the frame: it's already paid for
    if (this.errors === errors) this.troubled = false; // a clean frame: say so again next time
    this.publish();
  }

  private noFrame(): void {
    if (this.source.finished) {
      this.phase = "ended";
      this.events.emit("ended", { detail: "the recording is over" });
    } else if (!this.noCall) {
      this.noCall = true;
      this.events.emit("call", { detail: "can't see the WhatsApp call window" });
    }
    this.publish();
  }

  private interval(): number {
    const waitingForMe = this.tracker.board.turn() === this.myColor && !this.tracker.confirming;
    return waitingForMe ? this.pace.mine : this.pace.opponent;
  }

  // ---- what happens on the board ----------------------------------------------------------

  private async ready(suggestNow: boolean): Promise<void> {
    const mine = colorName(this.myColor);
    if (this.tracker.board.turn() === this.myColor) {
      this.speaker.say(`Ready. You're ${mine}.`);
      if (suggestNow) await this.suggest();
    } else {
      this.speaker.say(`Ready. You're ${mine}. Waiting for ${colorName(this.myColor === "w" ? "b" : "w")}.`);
    }
    this.events.emit("ready", { my_color: mine });
  }

  private async committed(update: Update, before: string): Promise<void> {
    const mine = new Chess(before).turn() === this.myColor;
    const detail: Record<string, unknown> = {};
    if (mine && this.suggestion && update.move?.lan !== this.suggestion.move.lan) detail.suggested = this.suggestion.move.san;
    this.events.emit("commit", { san: update.san, uci: update.move?.lan, by: mine ? "you" : "opponent", ...detail });
    this.savePgn();
    const board = this.tracker.board;
    // The move only fit together with a reply the frame already showed. If that reply is the
    // wearer's, they've already moved: a suggestion now would be for a position that's gone.
    const answered = update.match?.ranked[0]?.reply ?? null;
    if (gameOver(board)) this.gameOver();
    else if (board.turn() === this.myColor && answered === null) await this.suggest();
    else this.suggestion = null;
  }

  private async suggest(): Promise<void> {
    const fen = this.tracker.board.fen();
    this.suggestFailed = false;
    let move: Move | null = null;
    let score: Score = { cp: 0 };
    try {
      const best = await this.engine.best(fen);
      score = best.score;
      move = moveFrom(fen, best.move);
      if (move === null) throw new Error(`Stockfish suggested ${best.move}, which isn't legal in ${fen}`);
    } catch (error) {
      this.suggestFailed = true;
      this.suggestion = null;
      this.trouble("asking Stockfish", error);
      return;
    }
    this.suggestion = { move, score };
    const text = spoken(move);
    this.speaker.say(text);
    this.events.emit("suggest", { san: move.san, spoken: text, score: scoreText(score, this.myColor) });
  }

  private gameOver(): void {
    const outcome = gameOver(this.tracker.board)!;
    let text: string;
    if (outcome.winner === null) text = outcome.termination === "stalemate" ? "Stalemate. It's a draw." : "It's a draw.";
    else text = outcome.winner === this.myColor ? "Checkmate. You win." : "Checkmate. You lose.";
    this.phase = "game_over";
    this.suggestion = null;
    this.speaker.say(text);
    this.events.emit("game_over", { detail: text, result: outcome.result });
  }

  private account(step: Step): void {
    for (const answer of [step.answer, step.gate]) {
      if (answer) this.charge(cost(answer.model, answer.input_tokens, "output_tokens" in answer ? answer.output_tokens : 0));
    }
  }

  /** A problem with the overlay video: logged, not spoken, and the game goes on. */
  overlayError(detail: string): void {
    this.errors++;
    this.events.emit("error", { detail: `overlay: ${detail}` });
  }

  /** Count spending (the overlay's board locator calls this too), pausing past the cap. */
  charge(dollars: number): void {
    this.spent += dollars;
    if (this.spent > this.maxCost && !this.paused) {
      this.paused = true;
      this.speaker.say("Spending limit reached. Paused.");
      this.events.emit("paused", { detail: `spending passed $${this.maxCost.toFixed(2)}` });
    }
  }

  private report(step: Step): void {
    const update = step.update;
    const data: Record<string, unknown> = {
      frame_t: Math.round(step.frame.t * 10) / 10,
      verdict: step.verdict,
      update: update.kind,
    };
    if (step.gate) {
      const g = step.gate;
      data.jev = { readable: g.readable, hand: g.hand, changed: g.changed, error: g.error };
    }
    if (step.answer) data.vision = { seconds: Math.round(step.answer.seconds * 10) / 10, error: step.answer.error };
    if (update.match) {
      data.margin = update.match.margin;
      data.best = update.match.ranked.map((c) => [c.move?.san ?? null, c.score]);
    }
    if (update.kind === "seen") data.move = update.move?.san;
    this.events.emit("frame", data);
    if ((update.kind === "seen" || update.kind === "committed" || update.kind === "lost") && this.runDir) {
      const frames = join(this.runDir, "frames");
      mkdirSync(frames, { recursive: true });
      writeFileSync(join(frames, `${step.frame.t.toFixed(1).padStart(7, "0")}-${update.kind}.jpg`), step.frame.jpeg);
    }
  }

  private savePgn(): void {
    if (!this.runDir) return;
    const [white, black] = this.myColor === "w" ? ["You", "Opponent"] : ["Opponent", "You"];
    writeFileSync(join(this.runDir, "game.pgn"), `${toPgn(this.tracker.board, white, black)}\n`);
  }

  // ---- controls from the command center ---------------------------------------------------

  /** Queue a control for the loop. Returns an error message for a bad request. */
  control(request: Record<string, unknown>): string | null {
    const action = request.action;
    if (typeof action !== "string" || !ACTIONS.has(action)) return `unknown action ${JSON.stringify(action ?? null)}`;
    if (action === "move" && !request.move) return "say which move";
    if (action === "new_game") {
      if (request.color !== "white" && request.color !== "black") return "color must be white or black";
      try {
        new Chess(typeof request.fen === "string" && request.fen ? request.fen : undefined);
      } catch (error) {
        return `bad FEN: ${(error as Error).message}`;
      }
    }
    this.controls.push(request);
    return null;
  }

  async applyControls(): Promise<void> {
    while (this.controls.length) {
      const request = this.controls.shift()!;
      const { action, ...rest } = request;
      this.events.emit("control", { action, ...rest });
      try {
        if (action === "pause" || action === "resume") {
          this.paused = action === "pause";
        } else if (action === "repeat" && this.suggestion) {
          this.speaker.say(spoken(this.suggestion.move));
        } else if (action === "new_game") {
          const fen = typeof request.fen === "string" && request.fen ? request.fen : undefined;
          this.speaker.clear?.();
          this.newGame(request.color === "white" ? "w" : "b", new Chess(fen));
        } else if (action === "undo") {
          const board = copyBoard(this.tracker.board);
          if (board.undo() !== null) {
            this.setBoard(board);
            if (this.phase === "game_over") this.phase = "playing";
            this.suggestion = null;
            if (board.turn() === this.myColor) await this.suggest();
          }
        } else if (action === "move") {
          await this.manualMove(String(request.move));
        }
      } catch (error) {
        this.trouble(`the ${String(action)} control`, error);
      }
      this.publish();
    }
  }

  private async manualMove(text: string): Promise<void> {
    const board = copyBoard(this.tracker.board);
    const before = board.fen();
    let move: Move;
    try {
      move = board.move(text);
    } catch {
      this.events.emit("error", { detail: `${JSON.stringify(text)} isn't a legal move here` });
      return;
    }
    this.setBoard(board);
    this.phase = "playing";
    await this.committed({ kind: "committed", move, san: move.san, match: null }, before);
  }

  private setBoard(board: Chess): void {
    this.tracker.reset(board);
    this.watcher.forget(); // the last confirmed frame no longer shows this position
    this.speaker.clear?.(); // nor do lines queued for it
  }

  private newGame(myColor: "w" | "b", start: Chess): void {
    this.myColor = myColor;
    this.start = copyBoard(start);
    this.tracker = new Tracker(start);
    this.watcher = new Watcher(this.tracker, this.vision, this.gate, undefined, this.firstLook);
    this.phase = "setup"; // → playing → game_over; or ended, when a recording runs out
    this.suggestion = null;
    this.suggestFailed = false;
    this.announcedLost = false;
  }

  // ---- what the command center and the overlay show ---------------------------------------

  /** What the video overlay draws, apart from where the board is. */
  overlayState(): Omit<OverlayState, "corners"> {
    const board = this.tracker.board;
    const s = this.suggestion && board.turn() === this.myColor ? this.suggestion : null;
    return {
      fen: board.fen(),
      myColor: this.myColor,
      suggestion: s && { from: s.move.from, to: s.move.to, san: s.move.san, piece: s.move.piece },
      status: this.status(),
    };
  }

  snapshot(): Record<string, unknown> {
    return this.current;
  }

  private publish(): void {
    const board = this.tracker.board;
    const history = board.history({ verbose: true });
    const last = history.at(-1);
    const suggestion = this.suggestion && board.turn() === this.myColor ? this.suggestion : null;
    this.current = {
      status: this.status(),
      paused: this.paused,
      my_color: colorName(this.myColor),
      turn: colorName(board.turn()),
      fen: board.fen(),
      moves: movesText(this.start.fen(), history.slice(this.start.history().length).map((m) => m.san)),
      board_svg: boardSvg(board.fen(), {
        orientation: this.myColor,
        lastMove: last ? { from: last.from, to: last.to } : null,
        arrow: suggestion ? { from: suggestion.move.from, to: suggestion.move.to } : null,
      }),
      suggestion: suggestion && {
        san: suggestion.move.san,
        spoken: spoken(suggestion.move),
        score: scoreText(suggestion.score, this.myColor),
        bar: bar(suggestion.score),
      },
      frame_t: this.latestFrame ? Math.round(this.latestFrame.t * 10) / 10 : null,
      spent: Math.round(this.spent * 1000) / 1000,
      max_cost: this.maxCost,
      model: this.vision.model,
      strategy: this.vision.strategy,
      gate: this.gate !== null,
      run_dir: this.runDir,
    };
    this.events.publish("state", this.current);
  }

  private status(): string {
    if (this.phase === "game_over") return "Game over";
    if (this.phase === "ended") return "Recording finished";
    if (this.paused) return "Paused";
    if (this.noCall) return "Can't see the call";
    if (this.phase === "setup") return "Looking for the board";
    if (this.tracker.lost) return "Lost track";
    return this.tracker.board.turn() === this.myColor ? "Your move" : "Waiting for opponent";
  }
}

const colorName = (side: "w" | "b") => (side === "w" ? "white" : "black");

/** Sleep, but wake up early (without throwing) when `signal` aborts. */
const pause = (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }).catch(() => undefined);

/** The evaluation from the player's side: +1.5 means they're a pawn and a half up. */
export function scoreText(score: Score, myColor: "w" | "b"): string {
  const mine = scoreFor(score, myColor);
  if (mine.mate !== undefined) return mine.mate > 0 ? `mate in ${mine.mate}` : `mated in ${-mine.mate}`;
  const pawns = (mine.cp ?? 0) / 100;
  return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(1)}`;
}

/** White's share of the evaluation bar, 0 to 1. */
export function bar(score: Score): number {
  if (score.mate !== undefined) return score.mate > 0 ? 1 : 0;
  return 1 / (1 + Math.exp(-(score.cp ?? 0) / 250));
}
