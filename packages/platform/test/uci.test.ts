import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UciEngine } from "@chessonglass/platform";
import { newSessionId, type RequestContext } from "@chessonglass/contracts";

const FAKE_ENGINE = String.raw`
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "normal";
const rl = createInterface({ input: process.stdin });
let fen = "";
let moveNumber = 0;

rl.on("line", (line) => {
  if (line === "uci") {
    console.log("id name fake-stockfish");
    console.log("uciok");
    return;
  }
  if (line === "isready") {
    console.log("readyok");
    return;
  }
  if (line.startsWith("position fen ")) {
    fen = line.slice("position fen ".length);
    return;
  }
  if (line.startsWith("go movetime ")) {
    moveNumber += 1;
    const reply = () => {
      if (mode === "malformed") {
        console.log("bestmove zz9");
        return;
      }
      if (mode === "slow") {
        console.log("info depth 1 score cp 12");
        console.log("bestmove e2e4");
        return;
      }
      if (mode === "by-fen") {
        console.log("info depth 2 score mate 2");
        const replyMove = fen === "first" ? "bestmove e2e4" : "bestmove d2d4";
        if (fen.startsWith("slow")) {
          setTimeout(() => console.log(replyMove), 300);
        } else {
          console.log(replyMove);
        }
        return;
      }
      console.log("info depth 3 score cp 31");
      console.log(moveNumber === 1 ? "bestmove e2e4" : "bestmove d2d4");
    };
    if (mode === "slow") {
      setTimeout(reply, 5000);
    } else {
      setTimeout(reply, 5);
    }
    return;
  }
  if (line === "quit") {
    process.exit(0);
  }
});
`;

const temporaryDirectories: string[] = [];

async function fakeEngine(mode: string): Promise<{ executable: string; args: string[] }> {
  const directory = await mkdtemp(join(tmpdir(), "chessonglass-uci-"));
  temporaryDirectories.push(directory);
  const script = join(directory, "fake-uci.mjs");
  await writeFile(script, FAKE_ENGINE, "utf8");
  return { executable: process.execPath, args: [script, mode] };
}

function context(): RequestContext {
  return {
    requestId: "request-1",
    sessionId: newSessionId(),
    positionVersion: 1,
    referenceSequence: null
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("UciEngine", () => {
  it("performs the handshake and returns a complete bestmove with its score", async () => {
    const fake = await fakeEngine("normal");
    const engine = await UciEngine.start(fake.executable, fake.args, { responseTimeoutMs: 2000 });

    const result = await engine.best({
      fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      context: context(),
      signal: new AbortController().signal
    });

    expect(result.uci).toBe("e2e4");
    expect(result.score).toEqual({ cp: 31 });
    await engine.close();
  });

  it("serializes concurrent requests instead of mixing their answers", async () => {
    const fake = await fakeEngine("normal");
    const engine = await UciEngine.start(fake.executable, fake.args, { responseTimeoutMs: 2000 });

    const first = engine.best({
      fen: "first",
      context: context(),
      signal: new AbortController().signal
    });
    const second = engine.best({
      fen: "second",
      context: context(),
      signal: new AbortController().signal
    });

    await expect(first).resolves.toMatchObject({ uci: "e2e4" });
    await expect(second).resolves.toMatchObject({ uci: "d2d4" });
    await engine.close();
  });

  it("rejects a malformed bestmove and restarts before the next request", async () => {
    const fake = await fakeEngine("malformed");
    const engine = await UciEngine.start(fake.executable, fake.args, { responseTimeoutMs: 2000 });

    await expect(
      engine.best({ fen: "first", context: context(), signal: new AbortController().signal })
    ).rejects.toThrow(/bestmove/i);

    await expect(
      engine.best({ fen: "first", context: context(), signal: new AbortController().signal })
    ).rejects.toThrow(/bestmove/i);

    await engine.close();
  });

  it("rejects on timeout and never feeds a late answer to the next request", async () => {
    const fake = await fakeEngine("by-fen");
    const engine = await UciEngine.start(fake.executable, fake.args, { responseTimeoutMs: 60 });

    const timedOut = engine.best({
      fen: "slow-first",
      context: context(),
      signal: new AbortController().signal
    });
    await expect(timedOut).rejects.toThrow(/timed out|timeout/i);

    // The old process's delayed answer must not satisfy this newer request.
    const next = await engine.best({
      fen: "second",
      context: context(),
      signal: new AbortController().signal
    });
    expect(next.uci).toBe("d2d4");

    await engine.close();
  });

  it("close is idempotent and rejects later work", async () => {
    const fake = await fakeEngine("normal");
    const engine = await UciEngine.start(fake.executable, fake.args, { responseTimeoutMs: 2000 });
    await engine.close();
    await engine.close();

    await expect(
      engine.best({ fen: "first", context: context(), signal: new AbortController().signal })
    ).rejects.toThrow(/closed/i);
  });
});
