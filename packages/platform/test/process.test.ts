import { describe, expect, it } from "vitest";
import { runProcess, type ProcessFailure } from "@chessonglass/platform";

async function rejection(promise: Promise<unknown>): Promise<ProcessFailure> {
  try {
    await promise;
  } catch (error) {
    return error as ProcessFailure;
  }
  throw new Error("expected the process call to reject");
}

describe("runProcess", () => {
  it("passes arguments literally without a shell", async () => {
    const args = ["a b", "x;y&z", "$HOME", "`whoami`"];
    const result = await runProcess(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args],
      { signal: new AbortController().signal, timeoutMs: 5000, maxOutputBytes: 65536 }
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual(args);
  });

  it("preserves a non-zero exit code", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.exit(3)"], {
      signal: new AbortController().signal,
      timeoutMs: 5000,
      maxOutputBytes: 65536
    });

    expect(result.code).toBe(3);
  });

  it("aborts a process that exceeds its timeout", async () => {
    const failure = await rejection(
      runProcess(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
        signal: new AbortController().signal,
        timeoutMs: 100,
        maxOutputBytes: 65536
      })
    );

    expect(failure.code).toBe("timeout");
  });

  it("aborts promptly through the supplied signal", async () => {
    const controller = new AbortController();
    const pending = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      signal: controller.signal,
      timeoutMs: 5000,
      maxOutputBytes: 65536
    });

    controller.abort();
    const failure = await rejection(pending);
    expect(failure.code).toBe("aborted");
  });

  it("fails when output exceeds the byte ceiling", async () => {
    const failure = await rejection(
      runProcess(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(70000))"],
        { signal: new AbortController().signal, timeoutMs: 5000, maxOutputBytes: 65536 }
      )
    );

    expect(failure.code).toBe("output-limit");
  });
});
