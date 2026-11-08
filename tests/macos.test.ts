import { expect, test } from "vitest";

import { type Window, pickCallWindow } from "../src/macos.js";

const win = (id: number, title: string, width: number, height: number): Window => ({ id, owner: "WhatsApp", title, width, height });

test("the call is the largest WhatsApp window that isn't the main one", () => {
  const found = [win(1, "WhatsApp", 1200, 900), win(2, "Video call", 600, 800), win(3, "Settings", 400, 300)];
  expect(pickCallWindow(found)?.id).toBe(2);
});

test("with no call there's no window to watch, never the chat list", () => {
  expect(pickCallWindow([win(1, "WhatsApp", 1200, 900)])).toBeNull();
  expect(pickCallWindow([])).toBeNull();
});
