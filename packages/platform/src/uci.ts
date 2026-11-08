import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { RequestContext } from "@chessonglass/contracts";

export interface Advisor {
  best(input: {
    fen: string;
    context: RequestContext;
    signal: AbortSignal;
  }): Promise<{ uci: string; score: { cp?: number; mate?: number } }>;
  close(): Promise<void>;
}

export type UciStartOptions = Readonly<{ responseTimeoutMs?: number }>;

const DEFAULT_RESPONSE_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const GO_MOVETIME_MS = 500;
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

type ScoredMove = { uci: string; score: { cp?: number; mate?: number } };

/**
 * A single Stockfish-compatible UCI engine. Requests serialize on one process;
 * an aborted, timed-out or malformed request kills that process, and the next
 * request restarts it, so a late answer can never satisfy newer work.
 */
export class UciEngine implements Advisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private readonly lineListeners = new Set<(line: string) => void>();
  private queueTail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly executable: string;
  private readonly args: readonly string[];
  private readonly responseTimeoutMs: number;

  private constructor(executable: string, args: readonly string[], responseTimeoutMs: number) {
    this.executable = executable;
    this.args = args;
    this.responseTimeoutMs = responseTimeoutMs;
  }

  static async start(
    executable: string,
    args: readonly string[] = [],
    options: UciStartOptions = {}
  ): Promise<UciEngine> {
    const engine = new UciEngine(
      executable,
      args,
      options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS
    );
    await engine.ensureRunning();
    return engine;
  }

  best(input: {
    fen: string;
    context: RequestContext;
    signal: AbortSignal;
  }): Promise<{ uci: string; score: { cp?: number; mate?: number } }> {
    if (this.closed) {
      return Promise.reject(new Error("UCI engine is closed"));
    }
    const run = (): Promise<ScoredMove> => this.runBest(input);
    const result = this.queueTail.then(run, run);
    this.queueTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.stopChild();
  }

  private async runBest(input: {
    fen: string;
    context: RequestContext;
    signal: AbortSignal;
  }): Promise<ScoredMove> {
    if (this.closed) {
      throw new Error("UCI engine is closed");
    }
    if (input.signal.aborted) {
      throw new Error("UCI request aborted");
    }

    await this.ensureRunning();
    try {
      return await this.requestBest(input.fen, input.signal);
    } catch (error) {
      // A late or malformed answer must never reach a later request.
      await this.stopChild();
      throw error;
    }
  }

  private async ensureRunning(): Promise<void> {
    if (this.closed) {
      throw new Error("UCI engine is closed");
    }
    if (this.child !== null) {
      return;
    }

    const child = spawn(this.executable, [...this.args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.buffer = "";

    child.stdout.on("data", (chunk: Buffer) => this.consume(child, chunk));
    child.stderr.on("data", () => {
      // Engine diagnostics are not logged here; callers own log redaction.
    });
    child.on("error", () => {
      if (this.child === child) {
        this.child = null;
      }
    });
    child.on("close", () => {
      if (this.child === child) {
        this.child = null;
      }
    });

    try {
      this.write(child, "uci");
      await this.waitForLine(child, (line) => line === "uciok", HANDSHAKE_TIMEOUT_MS, "uciok");
      this.write(child, "isready");
      await this.waitForLine(child, (line) => line === "readyok", HANDSHAKE_TIMEOUT_MS, "readyok");
    } catch (error) {
      await this.stopChild();
      throw error;
    }
  }

  private requestBest(fen: string, signal: AbortSignal): Promise<ScoredMove> {
    return new Promise<ScoredMove>((resolve, reject) => {
      const score: { cp?: number; mate?: number } = {};
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.lineListeners.delete(listener);
        signal.removeEventListener("abort", onAbort);
      };

      const finish = (error: Error | null, value?: ScoredMove): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error !== null) {
          reject(error);
        } else {
          resolve(value!);
        }
      };

      const listener = (line: string): void => {
        const scoreMatch = /score\s+(cp|mate)\s+(-?\d+)/.exec(line);
        if (scoreMatch !== null) {
          const value = Number(scoreMatch[2]);
          if (scoreMatch[1] === "cp") {
            score.cp = value;
          } else {
            score.mate = value;
          }
          return;
        }

        if (!line.startsWith("bestmove")) {
          return;
        }
        const bestMatch = /^bestmove\s+(\S+)/.exec(line);
        const move = bestMatch?.[1];
        if (move === undefined || !UCI_MOVE.test(move)) {
          finish(new Error(`UCI engine returned a malformed bestmove: ${line}`));
          return;
        }
        finish(null, { uci: move, score: { ...score } });
      };

      const onAbort = (): void => {
        finish(new Error("UCI request aborted"));
      };

      this.lineListeners.add(listener);
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        finish(new Error(`UCI engine timed out after ${this.responseTimeoutMs}ms`));
      }, this.responseTimeoutMs);

      try {
        const child = this.child;
        if (child === null) {
          finish(new Error("UCI engine is not running"));
          return;
        }
        this.write(child, `position fen ${fen}`);
        this.write(child, `go movetime ${GO_MOVETIME_MS}`);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private consume(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.child !== child) {
      return;
    }
    this.buffer += chunk.toString("utf8");
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      for (const listener of [...this.lineListeners]) {
        listener(line);
      }
      index = this.buffer.indexOf("\n");
    }
  }

  private waitForLine(
    child: ChildProcessWithoutNullStreams,
    predicate: (line: string) => boolean,
    timeoutMs: number,
    description: string
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.lineListeners.delete(listener);
        child.off("close", onClose);
      };
      const listener = (line: string): void => {
        if (predicate(line)) {
          cleanup();
          resolve();
        }
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error(`UCI engine exited before ${description}`));
      };

      this.lineListeners.add(listener);
      child.once("close", onClose);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`UCI engine timed out waiting for ${description}`));
      }, timeoutMs);
    });
  }

  private write(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child) {
      throw new Error("UCI engine is not running");
    }
    child.stdin.write(`${line}\n`);
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.buffer = "";
    if (child === null) {
      return;
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 250);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.stdin.end("quit\n");
      } catch {
        // The process may already be gone; kill below is the fallback.
      }
      child.kill();
    });
  }
}
