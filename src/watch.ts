/** Read frames as cheaply as possible: Jev pre-check, then the vision model, then the tracker. */

import type { Frame } from "./capture.js";
import type { GateAnswer, Verdict } from "./gate.js";
import { type Reading, type Tracker, type Update, skipped } from "./match.js";
import type { Answer } from "./vision.js";

export interface Step {
  frame: Frame;
  verdict: Verdict; // what the pre-check decided ("ask_claude" when there's no pre-check)
  gate: GateAnswer | null;
  answer: Answer | null; // the vision model's answer, when it was asked
  reading: Reading | null;
  update: Update;
}

/** The parts of a Vision the Watcher uses (the eval wraps it with a cache). */
export interface Reader {
  ask(frame: Frame, fen: string, reference: Frame | null): Promise<Answer>;
  reading(answer: Answer, fen: string): Reading;
}

/** The parts of a Gate the Watcher uses. */
export interface PreCheck {
  ask(frame: Frame, earlier: Frame | null): Promise<GateAnswer>;
  verdict(answer: GateAnswer, options: { maySkipUnchanged: boolean }): Verdict;
}

/**
 * Reads each frame and updates the tracker.
 *
 * `reference` is the latest frame the vision model confirmed, and `referenceFen` the position it
 * shows. Jev compares new frames with it, and the changes strategy uses it as image 1, described
 * as `referenceFen`. That's usually the tracked position, but it can be one move ahead: when a
 * move is committed only because it fits together with the reply that followed it, the frame
 * already shows the reply, which the tracker hasn't committed yet. Describing image 1 as the
 * tracked position then would hide the reply for good.
 *
 * With no reference (at the start, after a fix by hand, in a new game), `firstLook` reads the
 * frame on its own, so the board is really checked against the tracked position rather than
 * compared with itself. A frame Jev judges unchanged is only skipped while no move is pending or
 * being confirmed, and never more than `maxUnchangedSkips` times in a row, so a change Jev misses
 * still reaches the model soon.
 */
export class Watcher {
  reference: Frame | null = null;
  referenceFen: string | null = null;
  private unchangedSkips = 0;

  constructor(
    readonly tracker: Tracker,
    readonly vision: Reader,
    readonly gate: PreCheck | null = null,
    readonly maxUnchangedSkips = 3,
    readonly firstLook: Reader | null = null,
  ) {}

  /** `frame` shows the tracked position (the eval uses this when it resyncs to the real game). */
  confirm(frame: Frame): void {
    this.reference = frame;
    this.referenceFen = this.tracker.board.fen();
  }

  /** Forget the reference: the tracked position was changed by hand. */
  forget(): void {
    this.reference = null;
    this.referenceFen = null;
  }

  async step(frame: Frame): Promise<Step> {
    let gateAnswer: GateAnswer | null = null;
    let verdict: Verdict = "ask_claude";
    if (this.gate !== null) {
      gateAnswer = await this.gate.ask(frame, this.reference);
      const pending = this.referenceFen !== null && this.referenceFen !== this.tracker.board.fen();
      const maySkipUnchanged = !this.tracker.confirming && !pending && this.unchangedSkips < this.maxUnchangedSkips;
      verdict = this.gate.verdict(gateAnswer, { maySkipUnchanged });
    }

    if (verdict === "unchanged") {
      this.unchangedSkips++;
      return { frame, verdict, gate: gateAnswer, answer: null, reading: null, update: skipped };
    }
    if (verdict !== "ask_claude") {
      // unreadable, or a hand in the way
      const reading: Reading = { boardVisible: verdict !== "unreadable", handOverBoard: verdict === "hand", grid: null };
      return { frame, verdict, gate: gateAnswer, answer: null, reading, update: this.tracker.update(reading) };
    }

    this.unchangedSkips = 0;
    let reader = this.vision;
    let fen = this.referenceFen ?? this.tracker.board.fen();
    let reference = this.reference;
    if (reference === null) {
      if (this.firstLook) reader = this.firstLook;
      else reference = frame; // no single-frame reader: compare the frame with itself
      fen = this.tracker.board.fen();
    }
    const answer = await reader.ask(frame, fen, reference);
    const reading = reader.reading(answer, fen);
    const update = this.tracker.update(reading);
    if (update.kind === "committed") {
      const reply = update.match?.ranked[0]?.reply ?? null;
      this.reference = frame;
      this.referenceFen = reply ? reply.after : this.tracker.board.fen();
    } else if (update.match?.kind === "no_change") {
      this.confirm(frame);
    }
    return { frame, verdict, gate: gateAnswer, answer, reading, update };
  }
}
