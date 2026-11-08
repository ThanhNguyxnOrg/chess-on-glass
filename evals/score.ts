/**
 * Score the vision step against a recording of a known game.
 *
 *     npm run eval -- fixtures/opera-white.mov --color white
 *     npm run eval -- fixtures/opera-black.mov --color black --strategy changes
 *     npm run eval -- fixtures/opera-white.mov --color white --gate      # Jev first
 *     npm run eval -- fixtures/opera-white.mov --color white --model claude-opus-5-5
 *     npm run eval -- --simulate --noise 0.05      # no video, no API: tests the matcher
 *
 * A frame is taken every --every seconds and fed through the same pipeline as the live loop:
 * the Jev pre-check (with --gate), then the vision model, then the tracker. When the tracker
 * commits a wrong move or gets lost it's counted, and it's put back on the real game so one
 * mistake doesn't spoil the rest.
 *
 * Every model answer is cached in evals/.cache, so re-scoring after a matcher change is free.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { Chess, type Move } from "chess.js";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

import { type Frame, VideoFile } from "../src/capture.js";
import { DEFAULT_MODEL, DEFAULT_STRATEGY, typesafeClient } from "../src/config.js";
import { type Check, checkJev, checkVisionKey } from "../src/doctor.js";
import { copyBoard, occupancy, startFen } from "../src/game.js";
import { Gate, type GateAnswer, JEV_MODEL, QUESTIONS, type Verdict } from "../src/gate.js";
import { Grid, type Reading, type Side, Tracker, type Update } from "../src/match.js";
import { cost, price } from "../src/pricing.js";
import { type Answer, type Effort, PROMPT_VERSION, STRATEGIES, type Strategy, type Vision, makeVision } from "../src/vision.js";
import { type Step, Watcher } from "../src/watch.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface Result {
  t: number;
  ply: number;
  committed: string; // SAN
  expected: string; // SAN, or "-" past the end of the game
  correct: boolean;
}

/** Where a frame's answers came from: true when read from the cache. */
interface Cached {
  vision: boolean | null;
  gate: boolean | null;
}

/**
 * Checks each committed move against the real game.
 *
 * After a wrong move, or when the tracker is lost, it's put back on the real game at the
 * position that best fits the current frame, and any moves jumped over count as missed. So one
 * mistake costs one move, not the rest of the game.
 */
export class Scorer {
  static readonly LOOK_AHEAD = 6; // how far into the real game a resync may jump

  readonly positions: Chess[];
  readonly truthSans: string[] = [];
  ply = 0; // moves of the real game the tracker is past, committed or missed
  readonly results: Result[] = [];
  readonly missed: number[] = [];
  readonly kinds: Record<string, number> = {};

  constructor(
    readonly truth: Move[],
    readonly tracker: Tracker,
    readonly log: (line: string) => void,
    start: Chess,
  ) {
    this.positions = [copyBoard(start)];
    for (const move of truth) {
      const next = copyBoard(this.positions.at(-1)!);
      this.truthSans.push(next.move(move.lan).san);
      this.positions.push(next);
    }
  }

  get done(): boolean {
    return this.ply >= this.truth.length;
  }

  /** Simulated readings go straight to the tracker. */
  feed(t: number, reading: Reading): Update {
    const position = this.tracker.board.fen();
    const update = this.tracker.update(reading);
    this.record(t, position, reading, update);
    return update;
  }

  /** Score one frame's outcome. Returns true when the tracker was put back on the game. */
  record(t: number, position: string, reading: Reading | null, update: Update, step: Step | null = null, cached: Cached | null = null): boolean {
    this.kinds[update.kind] = (this.kinds[update.kind] ?? 0) + 1;
    let wrong = false;
    if (update.kind === "committed") {
      const right = update.move?.lan === this.truth[this.ply].lan;
      this.results.push({ t, ply: this.ply, committed: update.san!, expected: this.truthSans[this.ply], correct: right });
      this.ply++;
      wrong = !right;
    }
    let jumped: number | null = null;
    if ((wrong || update.kind === "lost") && reading?.grid) jumped = this.resync(reading.grid);

    const ranked = update.match?.ranked ?? [];
    const record = {
      t: Math.round(t * 100) / 100,
      position,
      verdict: step?.verdict ?? null,
      kind: update.kind,
      san: update.san,
      wrong,
      resync_skipped: jumped,
      visible: reading ? reading.boardVisible : null,
      hand: reading ? reading.handOverBoard : null,
      rows: reading?.grid ? reading.grid.rows() : null,
      margin: update.match ? update.match.margin : null,
      ranked: ranked.map((c) => [c.move?.lan ?? null, c.score, c.reply?.lan ?? null]),
      gate: step?.gate ?? null,
      answer: step?.answer ?? null,
      cached,
    };
    this.log(JSON.stringify(record) + "\n");
    return jumped !== null;
  }

  /** Put the tracker on the real game where `grid` fits best; return moves jumped over. */
  resync(grid: Grid): number {
    const last = Math.min(this.ply + Scorer.LOOK_AHEAD, this.truth.length);
    let best = this.ply;
    let fewest = Infinity;
    for (let k = this.ply; k <= last; k++) {
      const mismatches = grid.mismatches(occupancy(this.positions[k].fen()));
      if (mismatches < fewest) [best, fewest] = [k, mismatches]; // ties go to the earliest: don't skip without reason
    }
    for (let k = this.ply; k < best; k++) this.missed.push(k);
    const jumped = best - this.ply;
    this.ply = best;
    this.tracker.reset(this.positions[best]);
    return jumped;
  }
}

/** A vision model whose answers are cached on disk and remembered for the report. */
export class CachedVision {
  constructor(
    readonly vision: Vision,
    readonly cache: string,
    readonly answers: [Answer, boolean][] = [], // (answer, came from the cache); can be shared
  ) {}

  async ask(frame: Frame, fen: string, reference: Frame | null): Promise<Answer> {
    const v = this.vision;
    const parts: unknown[] = [v.model, v.strategy, v.effort, PROMPT_VERSION, v.system, sha(frame.jpeg)];
    if (v.strategy !== "occupancy") parts.push(fen);
    if (v.strategy === "changes") parts.push(sha((reference ?? frame).jpeg));
    const [answer, cached] = await fromCache(this.cache, parts, () => v.ask(frame, fen, reference));
    this.answers.push([answer, cached]);
    return answer;
  }

  reading(answer: Answer, fen: string): Reading {
    return this.vision.reading(answer, fen);
  }
}

/** The Jev pre-check, with answers cached on disk and remembered for the report. */
export class CachedGate {
  readonly answers: [GateAnswer, boolean][] = [];

  constructor(
    readonly gate: Gate,
    readonly cache: string,
  ) {}

  async ask(frame: Frame, earlier: Frame | null): Promise<GateAnswer> {
    const instructions = Object.fromEntries(Object.entries(QUESTIONS).map(([name, q]) => [name, q.instructions]));
    const parts = [this.gate.model, instructions, sha(frame.jpeg), earlier ? sha(earlier.jpeg) : null];
    const [answer, cached] = await fromCache(this.cache, parts, () => this.gate.ask(frame, earlier));
    this.answers.push([answer, cached]);
    return answer;
  }

  verdict(answer: GateAnswer, options: { maySkipUnchanged: boolean }): Verdict {
    return this.gate.verdict(answer, options);
  }
}

async function fromCache<T extends { error: string | null }>(cache: string, parts: unknown[], ask: () => Promise<T>): Promise<[T, boolean]> {
  const path = join(cache, `${sha(Buffer.from(JSON.stringify(parts)))}.json`);
  if (existsSync(path)) return [JSON.parse(readFileSync(path, "utf8")) as T, true];
  const answer = await ask();
  if (answer.error === null) {
    mkdirSync(cache, { recursive: true });
    writeFileSync(path, JSON.stringify(answer));
  }
  return [answer, false];
}

/** A clean stop with a message for the person running the eval. */
class Stop extends Error {}

export interface Options {
  video?: string;
  pgn: string;
  color?: "white" | "black";
  strategy: Strategy;
  model: string;
  effort: Effort;
  gate: boolean;
  jevModel: string;
  every: number;
  start: number;
  limit?: number;
  maxCost: number;
  simulate: boolean;
  noise: number;
  unknown: number;
  framesPerPly: number;
  seed: number;
  confirm: number;
  evidence: number;
  maxMismatchRate: number;
}

/** What the eval reaches outside itself for, so tests can stand in for it. */
export interface Deps {
  out: string;
  cache: string;
  makeVision: (model: string, options: { strategy: Strategy; effort: Effort; myColor: Side }) => Vision;
  checkVisionKey: (model: string) => Promise<Check>;
  checkJev: () => Promise<Check>;
  typesafeClient: () => Pick<TypeSafeClient, "systemOne">;
}

const DEPS: Deps = {
  out: join(HERE, "out"),
  cache: join(HERE, ".cache"),
  makeVision,
  checkVisionKey,
  checkJev: () => checkJev(),
  typesafeClient: () => typesafeClient(),
};

async function visionFor(options: Options, deps: Deps): Promise<Vision> {
  const key = await deps.checkVisionKey(options.model);
  if (!key.ok) throw new Stop(`${key.name}: ${key.detail}.\n→ ${key.fix}`);
  const myColor = options.color === "white" ? "w" : "b";
  return deps.makeVision(options.model, { strategy: options.strategy, effort: options.effort, myColor });
}

async function runVideo(options: Options, scorer: Scorer, deps: Deps): Promise<[CachedVision, CachedGate | null]> {
  const vision = new CachedVision(await visionFor(options, deps), deps.cache);
  // as in the live loop, the changes strategy reads a frame with nothing to compare on its own
  // (answers go to the same list, so the report and the spending count include them)
  const myColor = options.color === "white" ? "w" : "b";
  const firstLook =
    options.strategy === "changes"
      ? new CachedVision(deps.makeVision(options.model, { strategy: "occupancy", effort: options.effort, myColor }), deps.cache, vision.answers)
      : null;
  let gate: CachedGate | null = null;
  if (options.gate) {
    const jev = await deps.checkJev();
    if (!jev.ok) throw new Stop(`${jev.name}: ${jev.detail}.\n→ ${jev.fix}`);
    gate = new CachedGate(new Gate(deps.typesafeClient(), { model: options.jevModel }), deps.cache);
  }
  const watcher = new Watcher(scorer.tracker, vision, gate, undefined, firstLook);

  const source = new VideoFile(options.video!, options.every, options.start);
  let frames = Math.floor(((await source.duration()) - options.start) / options.every) + 1;
  frames = Math.min(frames, options.limit || frames);
  console.log(`About ${frames} frames. New spend stops at $${options.maxCost.toFixed(2)}.\n`);

  let i = 0;
  for await (const frame of source) {
    if ((options.limit && i >= options.limit) || scorer.done) break;
    i++;
    const position = scorer.tracker.board.fen();
    const step = await watcher.step(frame);
    const cached: Cached = {
      vision: step.answer ? vision.answers.at(-1)![1] : null,
      gate: gate && step.gate ? gate.answers.at(-1)![1] : null,
    };
    if (scorer.record(frame.t, position, step.reading, step.update, step, cached)) {
      watcher.confirm(frame); // back on the real game: this frame shows the position
    }
    const spent = newSpend(vision, gate);
    const moves = `${scorer.results.length}/${scorer.truth.length}`;
    process.stdout.write(`\r  ${frame.t.toFixed(1).padStart(6)}s  ${moves} moves  $${spent.toFixed(2)}`);
    if (spent > options.maxCost) {
      console.log(`\nStopped: new spend passed --max-cost $${options.maxCost.toFixed(2)}.`);
      break;
    }
  }
  console.log("\n");
  return [vision, gate];
}

function answerCost(answer: Answer | GateAnswer): number {
  return cost(answer.model, answer.input_tokens, "output_tokens" in answer ? answer.output_tokens : 0);
}

function newSpend(vision: CachedVision, gate: CachedGate | null): number {
  const answers: [Answer | GateAnswer, boolean][] = [...vision.answers, ...(gate?.answers ?? [])];
  return answers.reduce((sum, [answer, cached]) => sum + (cached ? 0 : answerCost(answer)), 0);
}

/**
 * Python's random.Random (MT19937), so a seed gives the same simulated game as the Python eval
 * did: matcher results can be compared across the two.
 */
export class PythonRandom {
  private readonly mt = new Uint32Array(624);
  private index = 624;

  constructor(seed: number) {
    // CPython seeds with init_by_array on the 32-bit words of abs(seed); 0 is the key [0].
    let rest = Math.abs(Math.trunc(seed));
    const key: number[] = [];
    do {
      key.push(rest % 2 ** 32);
      rest = Math.floor(rest / 2 ** 32);
    } while (rest > 0);
    this.initByArray(key);
  }

  /** A float in [0, 1), from 53 random bits. */
  random(): number {
    const a = this.next() >>> 5;
    const b = this.next() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  choice<T>(items: readonly T[]): T {
    const n = items.length;
    const k = n.toString(2).length; // n.bit_length()
    let r = this.next() >>> (32 - k);
    while (r >= n) r = this.next() >>> (32 - k);
    return items[r];
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) mt[i] = Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i;
    this.index = 624;
  }

  private initByArray(key: number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(624, key.length); k > 0; k--) {
      mt[i] = (mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + key[j] + j;
      i++;
      j++;
      if (i >= 624) {
        mt[0] = mt[623];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k > 0; k--) {
      mt[i] = (mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i;
      i++;
      if (i >= 624) {
        mt[0] = mt[623];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  private next(): number {
    const mt = this.mt;
    if (this.index >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.index = 0;
    }
    let y = mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
}

/**
 * Readings of the real game with random misreads. Real misreads are less random than this: the
 * same square tends to be misread frame after frame.
 */
export function* simulated(start: Chess, truth: Move[], options: Options, rng: PythonRandom): Generator<[number, Reading]> {
  const board = copyBoard(start);
  let t = 0;
  for (let ply = 0; ply <= truth.length; ply++) {
    if (ply) {
      board.move(truth[ply - 1].lan);
      const hand = noisy(Grid.of(board.fen()), options.noise, options.unknown, rng);
      yield [t, { boardVisible: true, handOverBoard: true, grid: hand }]; // the hand that just made the move
      t += options.every;
    }
    for (let i = 0; i < options.framesPerPly; i++) {
      yield [t, { boardVisible: true, handOverBoard: false, grid: noisy(Grid.of(board.fen()), options.noise, options.unknown, rng) }];
      t += options.every;
    }
  }
}

export function noisy(grid: Grid, noise: number, unknown: number, rng: PythonRandom): Grid {
  const truth = grid.rows();
  let out = Grid.unknown();
  for (let square = 0; square < 64; square++) {
    if (rng.random() < unknown) continue;
    const seen = truth[7 - Math.floor(square / 8)][square % 8];
    let state: Side | null = seen === "w" ? "w" : seen === "b" ? "b" : null;
    if (rng.random() < noise) state = rng.choice((["w", "b", null] as const).filter((s) => s !== state));
    out = out.set(square, state);
  }
  return out;
}

function report(options: Options, scorer: Scorer, vision: CachedVision | null, gate: CachedGate | null, out: string): Record<string, unknown> {
  const wrong = scorer.results.filter((r) => !r.correct);
  const summary: Record<string, unknown> = {
    source: options.simulate ? "simulated" : options.video,
    strategy: options.simulate ? null : options.strategy,
    model: options.simulate ? null : options.model,
    gate: options.simulate || !options.gate ? null : options.jevModel,
    plies: scorer.truth.length,
    correct: scorer.results.length - wrong.length,
    wrong,
    missed: scorer.missed.map((ply) => ply + 1),
    not_reached: scorer.truth.length - scorer.ply,
    frames: scorer.kinds,
  };
  if (options.simulate) console.log("simulated readings");
  else console.log(`${basename(options.video!)} · ${options.strategy} · ${options.model}${options.gate ? ` · Jev pre-check (${options.jevModel})` : ""}`);
  console.log(
    `  moves    ${summary.correct}/${scorer.truth.length} right · ${wrong.length} wrong · ` +
      `${scorer.missed.length} missed · ${summary.not_reached} not reached`,
  );
  for (const r of wrong) console.log(`             move ${r.ply + 1} at ${r.t.toFixed(1)}s: saw ${r.committed}, game had ${r.expected}`);
  if (scorer.missed.length) console.log(`             missed moves: ${(summary.missed as number[]).join(", ")}`);
  const kinds = Object.entries(scorer.kinds)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([kind, n]) => `${n} ${kind}`)
    .join(", ");
  console.log(`  frames   ${sum(Object.values(scorer.kinds))}: ${kinds}`);

  for (const [label, source] of [["vision", vision], ["jev", gate]] as const) {
    if (source === null || !source.answers.length) continue;
    const answers = source.answers.map(([answer]) => answer as Answer | GateAnswer);
    const fresh = source.answers.filter(([, cached]) => !cached).map(([answer]) => answer as Answer | GateAnswer);
    const stats: Record<string, number> = {
      answers: answers.length,
      cached: answers.length - fresh.length,
      errors: answers.filter((a) => a.error !== null).length,
      input_tokens: sum(answers.map((a) => a.input_tokens)),
      output_tokens: sum(answers.map((a) => ("output_tokens" in a ? a.output_tokens : 0))),
      cost_all_answers: round(sum(answers.map(answerCost)), 4),
    };
    const latency = fresh
      .filter((a) => a.error === null)
      .map((a) => a.seconds)
      .sort((a, b) => a - b);
    if (latency.length >= 2) {
      stats.latency_p50 = round(median(latency), 2);
      stats.latency_p90 = round(decile9(latency), 2);
    }
    summary[label] = stats;
    let line =
      `  ${label.padEnd(8)} ${stats.answers} answers (${stats.cached} cached, ${stats.errors} errors) · ` +
      `${stats.input_tokens.toLocaleString("en-US")} in / ${stats.output_tokens.toLocaleString("en-US")} out tokens · ` +
      `$${stats.cost_all_answers.toFixed(3)}`;
    if ("latency_p50" in stats) line += ` · p50 ${stats.latency_p50.toFixed(1)}s, p90 ${stats.latency_p90.toFixed(1)}s`;
    console.log(line);
  }

  if (gate !== null) {
    const verdicts: Record<string, number> = {};
    for (const line of readFileSync(join(out, "frames.jsonl"), "utf8").split("\n").filter(Boolean)) {
      const verdict = JSON.parse(line).verdict as string;
      verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
    }
    summary.verdicts = verdicts;
    const total = sum(Object.values(verdicts));
    const skipped = Object.entries(verdicts)
      .filter(([v]) => v !== "ask_claude")
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([v, n]) => `${n} ${v}`)
      .join(", ");
    console.log(`  skipped  ${total - (verdicts.ask_claude ?? 0)} of ${total} frames before the vision model (${skipped || "none"})`);
  }
  if (vision !== null) {
    summary.new_spend = round(newSpend(vision, gate), 4);
    console.log(`  spend    $${(summary.new_spend as number).toFixed(3)} new this run`);
  }
  console.log(`  log      ${join(out, "frames.jsonl")}`);
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The 90th percentile, as Python's statistics.quantiles(data, n=10)[-1] computes it. */
function decile9(sorted: number[]): number {
  const n = 10;
  const m = sorted.length + 1;
  const i = n - 1;
  const j = Math.min(Math.max(Math.floor((i * m) / n), 1), sorted.length - 1);
  const delta = i * m - j * n;
  return (sorted[j - 1] * (n - delta) + sorted[j] * delta) / n;
}

function sha(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A new folder for this run's output, named by the time. */
function outputFolder(root: string): string {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-` +
    `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}-${String(now.getMilliseconds()).padStart(3, "0")}`;
  mkdirSync(root, { recursive: true });
  for (let n = 0; ; n++) {
    const path = join(root, n ? `${stamp}-${n}` : stamp);
    try {
      mkdirSync(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function parser(): Command {
  const number = (value: string) => {
    const parsed = Number(value);
    if (value.trim() === "" || !Number.isFinite(parsed)) throw new InvalidArgumentError("Not a number.");
    return parsed;
  };
  const integer = (value: string) => {
    const parsed = number(value);
    if (!Number.isInteger(parsed)) throw new InvalidArgumentError("Not a whole number.");
    return parsed;
  };
  return new Command("score")
    .description("Score the vision step against a recording of a known game.")
    .argument("[video]", "screen recording of the call window")
    .option("--pgn <file>", "the game in the recording", join(HERE, "..", "fixtures", "opera.pgn"))
    .addOption(new Option("--color <color>", "the color of the player wearing the glasses").choices(["white", "black"]))
    .addOption(new Option("--strategy <strategy>").choices(STRATEGIES).default(DEFAULT_STRATEGY))
    .option("--model <model>", "gpt-… or claude-…", DEFAULT_MODEL)
    .addOption(new Option("--effort <effort>").choices(["low", "medium", "high", "xhigh", "max"]).default("low"))
    .option("--gate", "ask Jev first, and skip frames it rules out", false)
    .option("--jev-model <model>", "the Jev model", JEV_MODEL)
    .option("--every <seconds>", "seconds between frames", number, 2.0)
    .option("--start <seconds>", "skip this many seconds of video", number, 0.0)
    .option("--limit <frames>", "stop after this many frames", integer)
    .option("--max-cost <dollars>", "stop when new API spend passes this ($)", number, 5.0)
    .option("--simulate", "noisy synthetic readings instead of video", false)
    .option("--noise <chance>", "simulate: chance a square is misread", number, 0.03)
    .option("--unknown <chance>", "simulate: chance a square is unreadable", number, 0.05)
    .option("--frames-per-ply <frames>", "simulate: frames of each position", integer, 3)
    .option("--seed <seed>", "simulate: random seed", integer, 0)
    .option("--confirm <frames>", "frames needed to commit a move", integer, 2)
    .option("--evidence <squares>", "squares of evidence to commit", integer, 3)
    .option("--max-mismatch-rate <rate>", "how far off the best fit may be", number, 0.15)
    .exitOverride()
    .configureOutput({ writeErr: (text) => process.stderr.write(text) });
}

/** Run the eval with `argv` (without node and the script). Returns the exit code. */
export async function main(argv: string[], overrides: Partial<Deps> = {}): Promise<number> {
  const deps = { ...DEPS, ...overrides };
  const cli = parser();
  try {
    cli.parse(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
  const options: Options = { ...cli.opts(), video: cli.args[0] } as Options;
  if (!options.simulate) {
    if (options.video === undefined || options.color === undefined) return usageError(cli, "give a video and --color, or use --simulate");
    if (price(options.model) === null) return usageError(cli, `no price for ${options.model}; add it to PRICES in src/pricing.ts`);
  }

  const game = new Chess();
  try {
    game.loadPgn(readFileSync(options.pgn, "utf8"));
  } catch (error) {
    console.error(`Couldn't read ${options.pgn}: ${(error as Error).message}`);
    return 1;
  }
  const start = new Chess(startFen(game)); // the opening position, or the PGN's FEN for a game joined midway
  const truth = game.history({ verbose: true });
  const tracker = new Tracker(start, {
    confirm: options.confirm,
    evidence: options.evidence,
    maxMismatchRate: options.maxMismatchRate,
  });
  const out = outputFolder(deps.out);

  writeFileSync(join(out, "frames.jsonl"), "");
  const log = (line: string) => writeFileSync(join(out, "frames.jsonl"), line, { flag: "a" });
  const scorer = new Scorer(truth, tracker, log, start);
  let vision: CachedVision | null = null;
  let gate: CachedGate | null = null;
  if (options.simulate) {
    for (const [t, reading] of simulated(start, truth, options, new PythonRandom(options.seed))) {
      if (scorer.done) break;
      scorer.feed(t, reading);
    }
  } else {
    try {
      [vision, gate] = await runVideo(options, scorer, deps);
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      console.error(error.message);
      return 1;
    }
  }
  report(options, scorer, vision, gate, out);
  return 0;
}

function usageError(cli: Command, message: string): number {
  console.error(`${cli.helpInformation().split("\n")[0]}\nerror: ${message}`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
