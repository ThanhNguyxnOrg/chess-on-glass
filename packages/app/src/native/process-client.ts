import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

/**
 * A spawned helper with bounded stderr capture. stdout stays streaming so
 * callers can parse frames without buffering the whole output.
 */
export type BoundedProcessHandle = {
  readonly stdout: Readable;
  readonly closed: Promise<{ code: number | null }>;
  kill(): void;
  stderrText(): string;
};

export type BoundedProcessOptions = {
  executable: string;
  args: readonly string[];
  stderrLimitBytes?: number;
};

const DEFAULT_STDERR_LIMIT = 8 * 1024;

/**
 * Spawn without a shell and with an argument array, so no user path becomes
 * shell syntax. stderr is truncated at the limit and never used as a status.
 */
export function spawnBoundedProcess(
  options: BoundedProcessOptions
): BoundedProcessHandle {
  const child = spawn(options.executable, [...options.args], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (child.stdout === null || child.stderr === null) {
    throw new Error("bounded process did not provide stdout/stderr pipes");
  }

  const limit = options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT;
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= limit) {
      return;
    }
    const remaining = limit - stderrBytes;
    const slice =
      chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    stderrChunks.push(slice);
    stderrBytes += slice.byteLength;
  });

  const closed = new Promise<{ code: number | null }>((resolve) => {
    child.once("close", (code) => resolve({ code }));
    child.once("error", () => resolve({ code: null }));
  });

  return {
    stdout: child.stdout,
    closed,
    kill(): void {
      try {
        child.kill();
      } catch {
        // The process may already be gone.
      }
    },
    stderrText(): string {
      return Buffer.concat(stderrChunks).toString("utf8");
    }
  };
}
