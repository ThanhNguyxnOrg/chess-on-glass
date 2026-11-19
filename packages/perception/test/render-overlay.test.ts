import { describe, expect, it } from "vitest";
import type { Frame, GamePosition, SessionId, SourceId } from "@chessonglass/contracts";
import {
  GeometryState,
  MAX_OVERLAY_INPUT_BYTES,
  MAX_OVERLAY_INPUT_PIXELS,
  OverlayError,
  composeOverlaySvg,
  fitBoardHomography,
  renderOverlay,
  resolveOverlayDisplay,
  type CurrentGeometry,
  type GeometryConfidence,
  type Homography,
  type OverlayDisplayInput,
  type OverlayResult
} from "@chessonglass/perception";

const WIDTH = 64;
const HEIGHT = 48;

const BOARD_CORNERS = {
  nearLeft: [4, 44],
  nearRight: [60, 44],
  farRight: [60, 4],
  farLeft: [4, 4]
} as const;

const TRANSFORM: Homography = fitBoardHomography(BOARD_CORNERS, WIDTH, HEIGHT);

async function fixtureJpeg(width = WIDTH, height = HEIGHT): Promise<Uint8Array> {
  const { default: sharp } = await import("sharp");
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: { r: 20, g: 40, b: 60 } }
    })
      .jpeg()
      .toBuffer()
  );
}

function makeFrame(bytes: Uint8Array, sequence = 1n, receivedAtMonotonicMs = 1_000): Frame {
  return {
    sessionId: "session-1" as SessionId,
    sourceId: "source-1" as SourceId,
    sequence,
    capturedAtMonotonicMs: null,
    capturedAtWallMs: 0,
    receivedAtMonotonicMs,
    bytes,
    mimeType: "image/jpeg"
  };
}

function confidence(sequence = 1n): GeometryConfidence {
  return { inlierRatio: 0.95, reprojectionErrorPx: 1.5, observedSequence: sequence };
}

function position(fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"): GamePosition {
  return {
    initialFen: fen,
    fen,
    history: [],
    uncertainty: { castlingRights: true, enPassant: false, promotion: false }
  };
}

const MOVE_RESULT: OverlayResult = { moveUci: "e2e4", status: "ready", reason: null };

function freshGeometry(frame: Frame): GeometryState {
  const state = new GeometryState({ lifetimeMs: 60_000 });
  state.update(frame, TRANSFORM, confidence(frame.sequence));
  return state;
}

async function meanChannel(bytes: Uint8Array): Promise<{ red: number; green: number }> {
  const { default: sharp } = await import("sharp");
  const stats = await sharp(Buffer.from(bytes)).stats();
  return { red: stats.channels[0]?.mean ?? 0, green: stats.channels[1]?.mean ?? 0 };
}

/**
 * Red-channel histogram helpers for visual assertions. The status-only frame
 * dims the backdrop (the majority of pixels darken) while drawing bright
 * label text on top, so means alone cannot distinguish "dimmed with text"
 * from "untouched" — percentiles plus a bright-text count can.
 */
async function redPixels(bytes: Uint8Array): Promise<{ sorted: number[]; brightCount: number }> {
  const { default: sharp } = await import("sharp");
  const raw = await sharp(Buffer.from(bytes)).raw().toBuffer();
  const red: number[] = [];
  let brightCount = 0;
  for (let i = 0; i < raw.length; i += 3) {
    const value = raw[i] ?? 0;
    red.push(value);
    if (value > 180) {
      brightCount += 1;
    }
  }
  red.sort((a, b) => a - b);
  return { sorted: red, brightCount };
}

describe("renderOverlay", () => {
  it("composes the move overlay on the full source frame as JPEG", async () => {
    const jpeg = await fixtureJpeg();
    const frame = makeFrame(jpeg);
    const composed = await renderOverlay(
      { frame, position: position(), result: MOVE_RESULT, geometry: freshGeometry(frame) },
      { now: () => 1_500 }
    );
    expect(composed[0]).toBe(0xff);
    expect(composed[1]).toBe(0xd8);
    const { default: sharp } = await import("sharp");
    const metadata = await sharp(Buffer.from(composed)).metadata();
    expect(metadata.width).toBe(WIDTH);
    expect(metadata.height).toBe(HEIGHT);
    // The overlay is additive on the frame: the green move marks must not
    // remove the underlying image content.
    const before = await meanChannel(jpeg);
    const after = await meanChannel(composed);
    expect(after.green).toBeGreaterThan(before.green);
  });

  it("renders identical bytes for identical input (deterministic overlay)", async () => {
    const jpeg = await fixtureJpeg();
    const frame = makeFrame(jpeg);
    const options = { now: () => 1_500 } as const;
    const first = await renderOverlay(
      { frame, position: position(), result: MOVE_RESULT, geometry: freshGeometry(frame) },
      options
    );
    const second = await renderOverlay(
      { frame, position: position(), result: MOVE_RESULT, geometry: freshGeometry(frame) },
      options
    );
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it("renders a clearly labeled status-only frame when geometry is absent", async () => {
    const jpeg = await fixtureJpeg();
    const frame = makeFrame(jpeg);
    // A state that never observed geometry: overlay hidden, not an exception.
    const composed = await renderOverlay(
      { frame, position: position(), result: MOVE_RESULT, geometry: new GeometryState({ lifetimeMs: 1_000 }) },
      { now: () => 1_500 }
    );
    expect(composed[0]).toBe(0xff);
    expect(composed[1]).toBe(0xd8);
    const { default: sharp } = await import("sharp");
    const metadata = await sharp(Buffer.from(composed)).metadata();
    expect(metadata.width).toBe(WIDTH);
    expect(metadata.height).toBe(HEIGHT);
    // The status-only backdrop visibly dims the frame (text visible, overlay
    // hidden) instead of leaving a stale drawing: most pixels darken far
    // below the source level while the label text stays bright.
    const source = await redPixels(jpeg);
    const status = await redPixels(composed);
    const quartile = status.sorted[Math.floor(status.sorted.length / 4)];
    expect(quartile).toBeLessThan(10);
    expect(status.brightCount).toBeGreaterThan(20);
    const sourceQuartile = source.sorted[Math.floor(source.sorted.length / 4)];
    expect(sourceQuartile).toBeGreaterThan(quartile);
  });

  it("renders the status-only frame when held geometry expired", async () => {
    const jpeg = await fixtureJpeg();
    const frame = makeFrame(jpeg, 1n, 1_000);
    const state = new GeometryState({ lifetimeMs: 100 });
    state.update(frame, TRANSFORM, confidence(1n));
    const composed = await renderOverlay(
      { frame, position: position(), result: MOVE_RESULT, geometry: state },
      { now: () => 2_000 }
    );
    expect(composed[0]).toBe(0xff);
    expect(composed[1]).toBe(0xd8);
    expect(state.lastInvalidation()?.reason).toBe("geometry-expired");
  });

  it("degrades to the status-only frame when projection fails, instead of throwing", async () => {
    const jpeg = await fixtureJpeg();
    const frame = makeFrame(jpeg);
    // Finite, invertible, but a board corner reaches the vanishing line for
    // some squares: projection throws GeometryError mid-render.
    const throughInfinity: CurrentGeometry = {
      transform: { matrix: [1, 0, 0, 0, 1, 0, -1, 0, 8] },
      sequence: frame.sequence
    };
    const composed = await renderOverlay(
      { frame, position: position(), result: MOVE_RESULT, geometry: throughInfinity },
      { now: () => 1_500 }
    );
    expect(composed[0]).toBe(0xff);
    expect(composed[1]).toBe(0xd8);
  });

  it("escapes hostile result and note text into the composed overlay SVG", async () => {
    const display: OverlayDisplayInput = {
      geometry: null,
      frame: makeFrame(new Uint8Array([1])),
      result: { moveUci: null, status: "uncertain", reason: '<img src=x onerror=alert(1)>' },
      invalidation: { reason: "invalid-geometry", clearedSequence: 3n },
      position: null,
      note: "<script>alert(1)</script>"
    };
    const svg = composeOverlaySvg(resolveOverlayDisplay(display), WIDTH, HEIGHT);
    expect(svg).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(svg).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(svg).not.toContain("<img");
    expect(svg).not.toContain("<script");
    // The renderer path must produce bytes from this same escaped markup.
    const jpeg = await fixtureJpeg();
    const composed = await renderOverlay(
      {
        frame: makeFrame(jpeg),
        position: position(),
        result: { moveUci: null, status: "uncertain", reason: '<img src=x onerror=alert(1)>' },
        geometry: null,
        note: "<script>alert(1)</script>"
      },
      { now: () => 1_500 }
    );
    expect(composed[0]).toBe(0xff);
    expect(composed[1]).toBe(0xd8);
  });

  it("supports an aligned board crop without warping the frame", async () => {
    const jpeg = await fixtureJpeg();
    const frame = makeFrame(jpeg);
    const composed = await renderOverlay(
      { frame, position: position(), result: MOVE_RESULT, geometry: freshGeometry(frame) },
      { now: () => 1_500, cropMode: "board" }
    );
    const { default: sharp } = await import("sharp");
    const metadata = await sharp(Buffer.from(composed)).metadata();
    // The board quad spans 4..60 x 4..44; the crop is the rounded bounding
    // box, never a warped rectangle.
    expect(metadata.width).toBe(56);
    expect(metadata.height).toBe(40);
  });

  it("rejects oversized frames before decoding", async () => {
    const oversized = new Uint8Array(MAX_OVERLAY_INPUT_BYTES + 1);
    await expect(
      renderOverlay(
        {
          frame: makeFrame(oversized),
          position: null,
          result: null,
          geometry: null
        },
        { now: () => 1_500 }
      )
    ).rejects.toMatchObject({ code: "frame-too-large" });
  });

  it("rejects non-JPEG payloads with a typed error", async () => {
    await expect(
      renderOverlay(
        { frame: makeFrame(Buffer.from("not a jpeg")), position: null, result: null, geometry: null },
        { now: () => 1_500 }
      )
    ).rejects.toBeInstanceOf(OverlayError);
    await expect(
      renderOverlay(
        {
          frame: { ...makeFrame(new Uint8Array([1, 2, 3])), mimeType: "image/png" as "image/jpeg" },
          position: null,
          result: null,
          geometry: null
        },
        { now: () => 1_500 }
      )
    ).rejects.toMatchObject({ code: "invalid-frame" });
  });

  it("keeps the documented ceilings", () => {
    expect(MAX_OVERLAY_INPUT_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_OVERLAY_INPUT_PIXELS).toBe(12_000_000);
  });
});

describe("resolveOverlayDisplay", () => {
  const base: OverlayDisplayInput = {
    geometry: null,
    frame: makeFrame(new Uint8Array([1])),
    result: null,
    invalidation: null,
    position: null
  };

  it("maps a UCI move to from/to squares with the side taken from the position", () => {
    const display = resolveOverlayDisplay({
      ...base,
      geometry: { transform: TRANSFORM, sequence: 1n },
      result: MOVE_RESULT,
      position: position()
    });
    expect(display.kind).toBe("move");
    if (display.kind !== "move") return;
    expect(display.fromSquare).toBe(52); // e2, row-major from the top
    expect(display.toSquare).toBe(36); // e4
    expect(display.side).toBe("w");
    expect(display.statusLabel).toBe("Ready");
  });

  it("reads the moving side from the FEN turn field and defaults safely", () => {
    const display = resolveOverlayDisplay({
      ...base,
      geometry: { transform: TRANSFORM, sequence: 1n },
      result: { moveUci: "e7e5", status: "ready", reason: null },
      position: position("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1")
    });
    expect(display.kind === "move" && display.side).toBe("b");
    const fallback = resolveOverlayDisplay({
      ...base,
      geometry: { transform: TRANSFORM, sequence: 1n },
      result: { moveUci: "e7e5", status: "ready", reason: null },
      position: position("not a fen")
    });
    expect(fallback.kind === "move" && fallback.side).toBe("w");
  });

  it("accepts promotion moves and ignores the promotion letter for squares", () => {
    const display = resolveOverlayDisplay({
      ...base,
      geometry: { transform: TRANSFORM, sequence: 1n },
      result: { moveUci: "e7e8q", status: "confirming", reason: null },
      position: position()
    });
    expect(display.kind).toBe("move");
    expect(display.kind === "move" && display.fromSquare).toBe(12); // e7
    expect(display.kind === "move" && display.toSquare).toBe(4); // e8
  });

  it("falls back to outline-plus-status when the move text is absent or hostile", () => {
    for (const moveUci of [null, "", "e2e9", "e2", "x9y2", "<script>e2e4</script>", "e2e4;drop"]) {
      const display = resolveOverlayDisplay({
        ...base,
        geometry: { transform: TRANSFORM, sequence: 1n },
        result: { moveUci, status: "ready", reason: null },
        position: position()
      });
      expect(display.kind).toBe("tracking");
      if (display.kind !== "tracking") continue;
      // The status text is a fixed label, never the raw move text.
      expect(display.statusLabel).toBe("Ready");
    }
  });

  it("labels known statuses and never renders an unknown status string", () => {
    const lost = resolveOverlayDisplay({
      ...base,
      geometry: { transform: TRANSFORM, sequence: 1n },
      result: { moveUci: null, status: "lost", reason: null },
      position: null
    });
    expect(lost.kind === "tracking" && lost.statusLabel).toBe("Tracking lost");
    const hostile = resolveOverlayDisplay({
      ...base,
      geometry: { transform: TRANSFORM, sequence: 1n },
      result: {
        moveUci: null,
        status: '"><script>alert(1)</script>' as unknown as OverlayResult["status"],
        reason: null
      },
      position: null
    });
    expect(hostile.kind === "tracking" && hostile.statusLabel).toBe("Status unavailable");
  });

  it("reports the hidden state with the recorded invalidation reason", () => {
    const display = resolveOverlayDisplay({
      ...base,
      geometry: null,
      invalidation: { reason: "geometry-expired", clearedSequence: 9n }
    });
    expect(display.kind).toBe("hidden");
    if (display.kind !== "hidden") return;
    expect(display.headline).toBe("Overlay hidden");
    expect(display.details.join(" ")).toContain("geometry-expired");
  });

  it("hides with a generic detail when nothing was ever invalidated", () => {
    const display = resolveOverlayDisplay(base);
    expect(display.kind).toBe("hidden");
    expect(display.kind === "hidden" && display.details.length).toBeGreaterThan(0);
  });

  it("sanitizes hostile reason and note text into the hidden details", () => {
    const display = resolveOverlayDisplay({
      ...base,
      geometry: null,
      result: { moveUci: null, status: "lost", reason: "reader\u0007failed: <b>boom</b>" },
      invalidation: { reason: "invalid-geometry", clearedSequence: null },
      note: "x".repeat(500)
    });
    expect(display.kind).toBe("hidden");
    if (display.kind !== "hidden") return;
    const joined = display.details.join("\n");
    expect(joined).not.toContain("\u0007");
    // Details are sanitized at decision time; XML escaping happens once, at
    // the SVG boundary (verified in composeOverlaySvg tests).
    expect(joined).toContain("readerfailed: <b>boom</b>");
    expect(joined.length).toBeLessThan(500);
  });
});
