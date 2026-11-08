import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, test } from "vitest";

import { JpegSplitter, MAX_EDGE, Replay, VideoFile, toJpeg } from "../src/capture.js";
import { makeVideo } from "./fakes.js";

const tmp = () => mkdtempSync(join(tmpdir(), "chesshacker-test-"));
const jpeg = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 10, b: 10 } } }).jpeg().toBuffer();

test("big images are shrunk to the vision models' limit, small ones kept", async () => {
  const big = await sharp(await toJpeg(await jpeg(4000, 3000))).metadata();
  expect([big.width, big.height]).toEqual([MAX_EDGE, 1932]);
  const small = await sharp(await toJpeg(await jpeg(640, 480))).metadata();
  expect([small.width, small.height, small.format]).toEqual([640, 480, "jpeg"]);
});

test("a stream of JPEGs is split into images, even across chunk boundaries", async () => {
  const [a, b] = await Promise.all([jpeg(20, 20), jpeg(30, 10)]);
  const stream = Buffer.concat([a, b]);
  const splitter = new JpegSplitter();
  const images = [...splitter.push(stream.subarray(0, a.length + 7)), ...splitter.push(stream.subarray(a.length + 7))];
  expect(images.map((image) => image.equals(a) || image.equals(b))).toEqual([true, true]);
  expect(images[1].equals(b)).toBe(true);
});

describe("recordings", () => {
  test("VideoFile takes a frame every n seconds", async () => {
    const video = makeVideo(join(tmp(), "clip.mp4"));
    const frames = [];
    for await (const frame of new VideoFile(video, 1.0)) frames.push(frame);
    expect(frames.map((f) => f.t)).toEqual([0, 1, 2]);
    expect(frames.every((f) => f.jpeg[0] === 0xff && f.jpeg[1] === 0xd8)).toBe(true);
    expect(await new VideoFile(video).duration()).toBeCloseTo(3, 1);
  });

  test("Replay plays a recording in real time, then finishes", async () => {
    const replay = await Replay.open(makeVideo(join(tmp(), "clip.mp4"), 1), 10.0);
    const first = await replay.grab();
    expect(first?.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const deadline = Date.now() + 10_000;
    while (!replay.finished && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replay.finished).toBe(true);
    expect(await replay.grab()).toBeNull();
  });

  test("Replay says clearly when a file can't be played", async () => {
    await expect(Replay.open(join(tmp(), "missing.mp4"))).rejects.toThrow(/Couldn't play/);
  });
});
