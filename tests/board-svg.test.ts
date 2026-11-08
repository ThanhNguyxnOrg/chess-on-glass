import { Chess } from "chess.js";
import { expect, test } from "vitest";

import { boardSvg } from "../src/board-svg.js";

const START = new Chess().fen();
const pieces = (svg: string) => [...svg.matchAll(/class="piece (\w\w)"/g)].map((m) => m[1]);
const squareAt = (svg: string, x: number, y: number) => new RegExp(`class="square (\\w\\d)" x="${x}" y="${y}"`).exec(svg)?.[1];

test("every piece is drawn", () => {
  const svg = boardSvg(START);
  expect(pieces(svg)).toHaveLength(32);
  expect(pieces(svg).filter((p) => p === "wp")).toHaveLength(8);
  expect(svg).toContain('viewBox="0 0 390 390"');
});

test("the player's side is at the bottom", () => {
  expect(squareAt(boardSvg(START, { orientation: "w" }), 15, 330)).toBe("a1"); // bottom left
  expect(squareAt(boardSvg(START, { orientation: "b" }), 15, 330)).toBe("h8");
  expect(squareAt(boardSvg(START, { orientation: "b" }), 330, 15)).toBe("a1"); // top right
});

test("the last move is highlighted and the suggestion drawn as an arrow", () => {
  const svg = boardSvg(START, { lastMove: { from: "g1", to: "f3" }, arrow: { from: "e2", to: "e4" } });
  expect(svg).toMatch(/class="square g1"[^>]*fill="#aaa23b"/); // g1 is a dark square
  expect(svg).toMatch(/class="square f3"[^>]*fill="#cdd16a"/); // f3 is a light square
  expect(svg).toMatch(/class="square e2"[^>]*fill="#ffce9e"/); // not part of the last move
  expect(svg).toContain('class="arrow"');
  expect(boardSvg(START)).not.toContain('class="arrow"');
});

test("pieces are text, never emoji", () => {
  expect(boardSvg(START)).toContain("♟︎");
});
