import type { Server } from "node:http";

import { afterEach, beforeEach, expect, test } from "vitest";

import type { Frame } from "../src/capture.js";
import { Events } from "../src/events.js";
import { type Center, serve } from "../src/web.js";

let center: Center & { controls: Record<string, unknown>[] };
let server: Server;
let base: string;

beforeEach(async () => {
  const controls: Record<string, unknown>[] = [];
  center = {
    controls,
    latestFrame: null as Frame | null,
    events: new Events(),
    snapshot: () => ({ status: "Your move" }),
    control: (request) => {
      controls.push(request);
      return request.action ? null : "no action";
    },
  };
  ({ server, url: base } = await serve(center, { ports: { from: 0, to: 0 } })); // any free port
});

afterEach(() => {
  server.closeAllConnections();
  server.close();
});

test("the page is served", async () => {
  const response = await fetch(`${base}/`);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("chesshacker");
});

test("the frame is served once there is one", async () => {
  expect((await fetch(`${base}/frame.jpg`)).status).toBe(404);
  center.latestFrame = { jpeg: Buffer.from("\xff\xd8 jpeg", "latin1"), t: 1 };
  const response = await fetch(`${base}/frame.jpg`);
  expect([response.status, response.headers.get("content-type")]).toEqual([200, "image/jpeg"]);
  expect(Buffer.from(await response.arrayBuffer()).equals(center.latestFrame.jpeg)).toBe(true);
});

test("controls must be JSON from this page", async () => {
  const body = JSON.stringify({ action: "pause" });
  expect((await fetch(`${base}/control`, { method: "POST", body, headers: { "Content-Type": "text/plain" } })).status).toBe(403);
  const evil = { "Content-Type": "application/json", Origin: "https://example.com" };
  expect((await fetch(`${base}/control`, { method: "POST", body, headers: evil })).status).toBe(403);
  const response = await fetch(`${base}/control`, { method: "POST", body, headers: { "Content-Type": "application/json" } });
  expect([response.status, await response.json()]).toEqual([200, { ok: true, error: null }]);
  expect(center.controls).toEqual([{ action: "pause" }]);
  const bad = await fetch(`${base}/control`, { method: "POST", body: "[1]", headers: { "Content-Type": "application/json" } });
  expect([bad.status, ((await bad.json()) as { error: string }).error]).toEqual([400, "expected an object"]);
});

test("events start with the current state, then recent events, then new ones", async () => {
  center.events.emit("commit", { san: "e4" });
  const response = await fetch(`${base}/events`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const received = () => text.split("\n\n").filter((chunk) => chunk.startsWith("data: ")).map((chunk) => JSON.parse(chunk.slice(6)));
  while (received().length < 2) text += decoder.decode((await reader.read()).value);
  center.events.emit("suggest", { san: "e5" });
  while (received().length < 3) text += decoder.decode((await reader.read()).value);
  await reader.cancel();
  const [state, commit, suggest] = received();
  expect(state).toEqual({ kind: "state", status: "Your move" });
  expect([commit.kind, commit.san, suggest.kind, suggest.san]).toEqual(["commit", "e4", "suggest", "e5"]);
});
