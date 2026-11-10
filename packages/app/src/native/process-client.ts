import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

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

/** A bounded helper that also exposes stdin for request JSON. */
export type HelperProcessHandle = BoundedProcessHandle & {
  readonly stdin: Writable;
};

function observe(
  child: ChildProcess,
  limit: number
): Omit<BoundedProcessHandle, "stdout"> & { stdout: Readable; stderr: Readable } {
  if (child.stdout === null || child.stderr === null) {
    throw new Error("bounded process did not provide stdout/stderr pipes");
  }
  const stdout = child.stdout;
  const stderr = child.stderr;

  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  stderr.on("data", (chunk: Buffer) => {
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
    stdout,
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
    },
    stderr
  };
}

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
  const observed = observe(child, options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT);
  return {
    stdout: observed.stdout,
    closed: observed.closed,
    kill: observed.kill,
    stderrText: observed.stderrText
  };
}

/** Spawn a helper with a stdin pipe for bounded JSON requests. */
export function spawnHelperProcess(
  options: BoundedProcessOptions
): HelperProcessHandle {
  const child = spawn(options.executable, [...options.args], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (child.stdin === null) {
    throw new Error("helper process did not provide a stdin pipe");
  }
  const observed = observe(child, options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT);
  return {
    stdin: child.stdin,
    stdout: observed.stdout,
    closed: observed.closed,
    kill: observed.kill,
    stderrText: observed.stderrText
  };
}
