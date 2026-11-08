import { spawn } from "node:child_process";

export type ProcessFailureCode = "spawn" | "timeout" | "aborted" | "output-limit";

/** A bounded-process failure that callers can classify without parsing text. */
export class ProcessFailure extends Error {
  readonly code: ProcessFailureCode;

  constructor(code: ProcessFailureCode, message: string) {
    super(message);
    this.name = "ProcessFailure";
    this.code = code;
  }
}

export type ProcessResult = Readonly<{
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

/**
 * Run one owned child process with no shell, a deadline, cancellation and a
 * hard output ceiling. The child is killed on timeout, abort or limit breach,
 * and every listener/timer is removed on the first terminal event.
 */
export function runProcess(
  file: string,
  args: readonly string[],
  options: { signal: AbortSignal; timeoutMs: number; maxOutputBytes: number }
): Promise<ProcessResult> {
  if (options.signal.aborted) {
    return Promise.reject(new ProcessFailure("aborted", "process was aborted before start"));
  }
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
    return Promise.reject(new ProcessFailure("output-limit", "maxOutputBytes must be positive"));
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return Promise.reject(new ProcessFailure("timeout", "timeoutMs must be positive"));
  }

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(file, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      options.signal.removeEventListener("abort", onAbort);
    };

    const fail = (failure: ProcessFailure): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.kill();
      reject(failure);
    };

    const onAbort = (): void => {
      fail(new ProcessFailure("aborted", "process was aborted"));
    };

    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
      return;
    }

    timer = setTimeout(() => {
      fail(new ProcessFailure("timeout", `process exceeded ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      totalBytes += chunk.byteLength;
      if (totalBytes > options.maxOutputBytes) {
        fail(new ProcessFailure("output-limit", `process output exceeded ${options.maxOutputBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));

    child.on("error", (error) => {
      fail(new ProcessFailure("spawn", `failed to start process: ${error.message}`));
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({
        code: code ?? 1,
        stdout: new Uint8Array(Buffer.concat(stdout)),
        stderr: new Uint8Array(Buffer.concat(stderr))
      });
    });
  });
}
