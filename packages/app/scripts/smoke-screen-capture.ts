#!/usr/bin/env node
/**
 * Consented window-capture smoke: enumerate windows, capture two distinct
 * frames of one chosen window (foreground by default, or the first title
 * containing argv[2]), then close the native session and print JSON evidence.
 * A window title is data only; it never becomes a path or a command.
 *
 * Run: node packages/app/scripts/smoke-screen-capture.ts ["title text"]
 */
import { createHash } from "node:crypto";
import {
  captureApiSupport,
  enumerateWindows,
  foregroundWindow,
  ImageFormat,
  isSupported,
  ScreenCapture
} from "@screen-capture/node";

type WindowSelection = ReturnType<typeof foregroundWindow>;

function chooseTarget(): WindowSelection {
  const needle = process.argv[2];
  if (needle === undefined || needle.trim() === "") {
    return foregroundWindow();
  }
  const match = enumerateWindows().find((window) => window.title.includes(needle));
  if (match === undefined) {
    throw new Error("no window title contains the requested text");
  }
  return match;
}

const startedAt = Date.now();
const support = { isSupported: isSupported(), api: captureApiSupport() };
if (!support.isSupported) {
  throw new Error("native screen capture is unavailable on this host");
}

const target = chooseTarget();
const capture = new ScreenCapture({
  windowHandle: target.handle,
  cursorCapture: false,
  minimumUpdateIntervalMs: 100
});

const frames: Array<{
  width: number;
  height: number;
  bytes: number;
  hash: string;
}> = [];
const hashes = new Set<string>();
let closedCleanly = false;

try {
  await capture.start();
  const deadline = Date.now() + 10_000;
  while (frames.length < 2 && Date.now() < deadline) {
    const frame = await capture.nextFrame();
    if (frame === undefined) {
      break;
    }
    const jpeg = frame.encode(ImageFormat.Jpeg);
    const hash = createHash("sha256").update(jpeg).digest("hex");
    if (!hashes.has(hash)) {
      hashes.add(hash);
      frames.push({
        width: frame.width,
        height: frame.height,
        bytes: jpeg.byteLength,
        hash: hash.slice(0, 16)
      });
    }
  }
} finally {
  await capture.stop();
  closedCleanly = true;
}

const report = {
  support,
  target: {
    title: target.title,
    processName: target.processName,
    processId: target.processId,
    monitorIndex: target.monitorIndex
  },
  frames,
  distinctFrameCount: frames.length,
  closedCleanly,
  durationMs: Date.now() - startedAt
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (frames.length < 2) {
  process.exitCode = 1;
}
