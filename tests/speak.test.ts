import { expect, test } from "vitest";

import { BLACKHOLE, Speaker, type Target, sayable } from "../src/speak.js";

test.each([
  ["call", ["say", "-a", BLACKHOLE, "Knight to f3"]],
  ["speakers", ["say", "Knight to f3"]],
  ["none", null],
] as [Target, string[] | null][])("speech to %s", async (target, command) => {
  const ran: string[][] = [];
  const spoken: string[] = [];
  const speaker = new Speaker(target, {
    run: async (cmd) => (ran.push(cmd), true),
    onSpoken: (text) => spoken.push(text),
  });
  speaker.say("Knight to f3");
  await speaker.wait();
  expect(ran).toEqual(command ? [command] : []);
  expect(spoken).toEqual(["Knight to f3"]);
});

test("lines are spoken in order, one at a time", async () => {
  const log: string[] = [];
  const speaker = new Speaker("speakers", {
    run: async (cmd) => {
      log.push(`start ${cmd.at(-1)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push(`end ${cmd.at(-1)}`);
      return true;
    },
  });
  for (const line of ["Ready. You're white.", "Pawn to e4"]) speaker.say(line);
  await speaker.wait();
  expect(log).toEqual(["start Ready. You're white.", "end Ready. You're white.", "start Pawn to e4", "end Pawn to e4"]);
});

test("a failed `say` doesn't stop later lines", async () => {
  const ran: string[] = [];
  let first = true;
  const speaker = new Speaker("speakers", {
    run: async (cmd) => {
      if (first) {
        first = false;
        throw new Error("say crashed");
      }
      ran.push(cmd.at(-1)!);
      return true;
    },
  });
  speaker.say("one");
  speaker.say("two");
  await speaker.wait();
  expect(ran).toEqual(["two"]);
});

test("a line `say` couldn't play is reported as failed, not spoken", async () => {
  const spoken: string[] = [];
  const failed: string[] = [];
  const speaker = new Speaker("call", {
    run: async (cmd) => cmd.at(-1) !== "Knight to f3",
    onSpoken: (text) => spoken.push(text),
    onFailed: (text) => failed.push(text),
  });
  speaker.say("Ready. You're white.");
  speaker.say("Knight to f3");
  await speaker.wait();
  expect(spoken).toEqual(["Ready. You're white."]);
  expect(failed).toEqual(["Knight to f3"]);
});

test("clear() drops lines that haven't started", async () => {
  const ran: string[] = [];
  let release!: () => void;
  const playing = new Promise<void>((resolve) => (release = resolve));
  const speaker = new Speaker("speakers", {
    run: async (cmd) => {
      ran.push(cmd.at(-1)!);
      if (cmd.at(-1) === "Pawn to e4") await playing; // still saying this one
      return true;
    },
  });
  speaker.say("Pawn to e4");
  speaker.say("Knight to f3"); // queued for a position about to be undone
  await new Promise((resolve) => setTimeout(resolve, 5));
  speaker.clear();
  speaker.say("Bishop to c4");
  release();
  await speaker.wait();
  expect(ran).toEqual(["Pawn to e4", "Bishop to c4"]);
});

test("the a-file is spelled out, so `say` doesn't read it as the word 'uh'", () => {
  expect(sayable("Rook a to d1")).toBe("Rook ay to d1");
  expect(sayable("Pawn a takes b5")).toBe("Pawn ay takes b5");
  expect(sayable("Pawn to a4")).toBe("Pawn to ay 4");
  expect(sayable("Queen a1 to c3, check")).toBe("Queen ay 1 to c3, check");
  expect(sayable("Stalemate. It's a draw.")).toBe("Stalemate. It's a draw.");
  expect(sayable("Knight b to d7")).toBe("Knight b to d7");
  expect(new Speaker("speakers").command("Rook to a8")).toEqual(["say", "Rook to ay 8"]);
});
