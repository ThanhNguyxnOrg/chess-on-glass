import { describe, expect, it } from "vitest";
import { JpegSplitter } from "../../src/sources/jpeg-splitter.js";

const SOI = [0xff, 0xd8, 0xff, 0xe0];
const EOI = [0xff, 0xd9];

function jpeg(payload: readonly number[] = [0x11, 0x22]): Uint8Array {
  return Uint8Array.from([...SOI, ...payload, ...EOI]);
}

function isFrame(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.byteLength - 2] === 0xff &&
    bytes[bytes.byteLength - 1] === 0xd9
  );
}

describe("JpegSplitter", () => {
  it("splits coalesced JPEGs from one chunk", () => {
    const splitter = new JpegSplitter();
    const first = jpeg([0x01]);
    const second = jpeg([0x02, 0x03]);
    const combined = Uint8Array.from([...first, ...second]);

    const frames = splitter.push(combined);
    expect(frames).toHaveLength(2);
    expect(isFrame(frames[0]!)).toBe(true);
    expect(isFrame(frames[1]!)).toBe(true);
    expect(frames[0]![4]).toBe(0x01);
    expect(frames[1]![4]).toBe(0x02);
    expect(splitter.bufferedBytes).toBe(0);
  });

  it("coalesces a JPEG split across many chunks", () => {
    const splitter = new JpegSplitter();
    const bytes = jpeg([0xaa, 0xbb, 0xcc]);
    const frames: Uint8Array[] = [];

    for (const byte of bytes) {
      frames.push(...splitter.push(Uint8Array.from([byte])));
    }

    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(bytes);
  });

  it("drops a garbage prefix and keeps marker-like payload bytes", () => {
    const splitter = new JpegSplitter();
    const garbage = Uint8Array.from([0x00, 0x01, 0xff, 0x00, 0x42]);
    const frame = jpeg([0x10, 0xff, 0xd8, 0xff, 0x20]);

    const frames = splitter.push(Uint8Array.from([...garbage, ...frame]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(frame);
  });

  it("waits for a complete frame and retains a partial start marker", () => {
    const splitter = new JpegSplitter();
    const complete = jpeg([0x33]);

    // First chunk ends inside the start-of-image marker.
    expect(splitter.push(Uint8Array.from([...complete.slice(0, 4), 0xff, 0xd8]))).toHaveLength(0);
    expect(splitter.bufferedBytes).toBeGreaterThan(0);

    const frames = splitter.push(
      Uint8Array.from([0xff, ...complete.slice(4)])
    );
    expect(frames).toHaveLength(1);
    expect(isFrame(frames[0]!)).toBe(true);
  });

  it("bounds a malformed stream without losing buffered accounting", () => {
    const splitter = new JpegSplitter(64);
    const partial = Uint8Array.from([...SOI, ...new Array<number>(96).fill(0x41)]);
    expect(() => splitter.push(partial)).toThrow(/bound|large/i);
  });
});
