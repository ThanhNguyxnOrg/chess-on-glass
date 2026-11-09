const SOI = [0xff, 0xd8, 0xff] as const;
const EOI = [0xff, 0xd9] as const;

function indexOfPattern(
  buffer: Uint8Array,
  pattern: readonly number[],
  from = 0
): number {
  outer: for (
    let index = Math.max(0, from);
    index <= buffer.byteLength - pattern.length;
    index += 1
  ) {
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (buffer[index + offset] !== pattern[offset]) {
        continue outer;
      }
    }
    return index;
  }
  return -1;
}

/**
 * Splits an MJPEG byte stream into complete JPEG frames. Bytes before a
 * start-of-image marker are discarded; a frame is only emitted once its
 * end-of-image marker arrives, and an unterminated frame is bounded so a
 * malformed stream cannot grow memory without limit.
 */
export class JpegSplitter {
  private readonly maxFrameBytes: number;
  private buffer = new Uint8Array(0);

  constructor(maxFrameBytes = 5 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new RangeError("maxFrameBytes must be a positive safe integer");
    }
    this.maxFrameBytes = maxFrameBytes;
  }

  get bufferedBytes(): number {
    return this.buffer.byteLength;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength > 0) {
      const combined = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
      combined.set(this.buffer, 0);
      combined.set(chunk, this.buffer.byteLength);
      this.buffer = combined;
    }

    const frames: Uint8Array[] = [];
    for (;;) {
      const start = indexOfPattern(this.buffer, SOI);
      if (start < 0) {
        // Keep a possible partial start marker for the next chunk.
        const keep = Math.min(this.buffer.byteLength, SOI.length - 1);
        this.buffer = this.buffer.slice(this.buffer.byteLength - keep);
        break;
      }
      if (start > 0) {
        this.buffer = this.buffer.slice(start);
      }

      const end = indexOfPattern(this.buffer, EOI, SOI.length);
      if (end < 0) {
        if (this.buffer.byteLength > this.maxFrameBytes) {
          throw new RangeError("jpeg stream exceeded the frame bound");
        }
        break;
      }

      frames.push(this.buffer.slice(0, end + EOI.length));
      this.buffer = this.buffer.slice(end + EOI.length);
    }

    return frames;
  }
}
