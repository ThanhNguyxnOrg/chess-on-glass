import type { Point } from "../geometry/types.js";
import type { OverlayDisplay } from "./overlay-state.js";

/**
 * Cyan board outline. A fixed constant, never derived from model output, so
 * the visual contract (cyan outline, green move marks) cannot be restyled by
 * untrusted data.
 */
export const OVERLAY_OUTLINE_COLOR = "#22d3ee";

/** Green from/to squares and arrow. See `OVERLAY_OUTLINE_COLOR`. */
export const OVERLAY_MOVE_COLOR = "#22c55e";

const NEUTRAL_TEXT_COLOR = "#e2e8f0";
const DIM_TEXT_COLOR = "#cbd5e1";
const HIDDEN_BACKDROP_COLOR = "#000000";
const HIDDEN_BACKDROP_OPACITY = "0.72";
const MOVE_FILL_OPACITY = "0.45";

/**
 * XML-escape a string destined for an SVG text node. `&`, `<` and `>` are
 * the only characters that can change text-node parsing; escaping `>` also
 * defuses the `]]>` CDATA terminator sequence.
 */
export function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * XML-escape a string destined for a double- or single-quoted attribute. On
 * top of the text-node set, both quote forms are escaped so a hostile value
 * can never close the attribute and inject new markup.
 */
export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/**
 * Everything the SVG builder draws, already validated and quantized. The
 * discriminated kinds mirror `OverlayDisplay`; free-form strings (labels,
 * status, details) are sanitized by the display layer and escaped here, at
 * the last point before markup exists.
 */
export type OverlaySvgSpec =
  | Readonly<{
      kind: "move";
      width: number;
      height: number;
      outline: readonly Point[];
      from: readonly Point[];
      to: readonly Point[];
      arrow: { from: Point; to: Point };
      label: string;
      status: string;
    }>
  | Readonly<{
      kind: "tracking";
      width: number;
      height: number;
      outline: readonly Point[];
      status: string;
    }>
  | Readonly<{
      kind: "hidden";
      width: number;
      height: number;
      headline: string;
      details: readonly string[];
    }>;

/** Largest absolute coordinate the builder accepts for a projected point. */
const MAX_ABSOLUTE_COORDINATE = 1_000_000;

/**
 * Round one projected coordinate to an integer pixel. Non-finite or absurd
 * values are caller bugs at this layer (the renderer validates first), so
 * they throw rather than quietly producing noise in the markup.
 */
function quantize(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  if (Math.abs(value) > MAX_ABSOLUTE_COORDINATE) {
    throw new TypeError(`${name} must stay within ${MAX_ABSOLUTE_COORDINATE} pixels`);
  }
  return Math.round(value);
}

function requireDimension(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function pointsAttribute(quad: readonly Point[]): string {
  return quad
    .map(([x, y]) => `${quantize(x, "point x")},${quantize(y, "point y")}`)
    .join(" ");
}

function polygon(quad: readonly Point[], attributes: string): string {
  return `<polygon points="${escapeXmlAttribute(pointsAttribute(quad))}" ${attributes}/>`;
}

function fontScale(width: number, height: number, divisor: number, floor: number): number {
  return Math.max(floor, Math.round(Math.min(width, height) / divisor));
}

/**
 * Build the overlay SVG markup. Every dynamic string is XML-escaped here —
 * the security boundary — and every number is validated and rounded, so the
 * output is deterministic byte-for-byte for identical specs and never
 * contains markup derived from model or provider output.
 */
export function buildOverlaySvg(spec: OverlaySvgSpec): string {
  const width = requireDimension(spec.width, "width");
  const height = requireDimension(spec.height, "height");
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  const body = (() => {
    switch (spec.kind) {
      case "move":
        return moveBody(spec, width, height);
      case "tracking":
        return trackingBody(spec, width, height);
      case "hidden":
        return hiddenBody(spec, width, height);
    }
  })();
  return `${open}${body}</svg>`;
}

function moveBody(
  spec: Extract<OverlaySvgSpec, { kind: "move" }>,
  width: number,
  height: number
): string {
  const fontSize = fontScale(width, height, 24, 14);
  const stroke = Math.max(2, Math.round(Math.min(width, height) / 120));
  const parts: string[] = [
    polygon(spec.outline, `fill="none" stroke="${OVERLAY_OUTLINE_COLOR}" stroke-width="${stroke}"`),
    polygon(spec.from, `fill="${OVERLAY_MOVE_COLOR}" fill-opacity="${MOVE_FILL_OPACITY}"`),
    polygon(spec.to, `fill="${OVERLAY_MOVE_COLOR}" fill-opacity="${MOVE_FILL_OPACITY}"`)
  ];
  parts.push(...arrowShapes(spec.arrow, OVERLAY_MOVE_COLOR));
  parts.push(
    `<text x="16" y="${16 + fontSize}" font-family="monospace" font-size="${fontSize}" fill="${OVERLAY_MOVE_COLOR}">${escapeXmlText(spec.label)}</text>`
  );
  parts.push(
    `<text x="16" y="${height - 16}" font-family="monospace" font-size="${fontSize}" fill="${NEUTRAL_TEXT_COLOR}">${escapeXmlText(spec.status)}</text>`
  );
  return parts.join("");
}

function trackingBody(
  spec: Extract<OverlaySvgSpec, { kind: "tracking" }>,
  width: number,
  height: number
): string {
  const fontSize = fontScale(width, height, 24, 14);
  const stroke = Math.max(2, Math.round(Math.min(width, height) / 120));
  return [
    polygon(spec.outline, `fill="none" stroke="${OVERLAY_OUTLINE_COLOR}" stroke-width="${stroke}"`),
    `<text x="16" y="${height - 16}" font-family="monospace" font-size="${fontSize}" fill="${NEUTRAL_TEXT_COLOR}">${escapeXmlText(spec.status)}</text>`
  ].join("");
}

function hiddenBody(
  spec: Extract<OverlaySvgSpec, { kind: "hidden" }>,
  width: number,
  height: number
): string {
  const headlineSize = fontScale(width, height, 16, 18);
  const detailSize = fontScale(width, height, 32, 12);
  const centerX = Math.round(width / 2);
  const centerY = Math.round(height / 2);
  const parts: string[] = [
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${HIDDEN_BACKDROP_COLOR}" fill-opacity="${HIDDEN_BACKDROP_OPACITY}"/>`,
    `<text x="${centerX}" y="${centerY - 12}" text-anchor="middle" font-family="monospace" font-size="${headlineSize}" fill="${NEUTRAL_TEXT_COLOR}">${escapeXmlText(spec.headline)}</text>`
  ];
  // Detail lines are bounded: at most the first few sanitized strings fit a
  // readable status frame.
  spec.details.slice(0, 4).forEach((detail, index) => {
    parts.push(
      `<text x="${centerX}" y="${centerY + 18 + index * (detailSize + 6)}" text-anchor="middle" font-family="monospace" font-size="${detailSize}" fill="${DIM_TEXT_COLOR}">${escapeXmlText(detail)}</text>`
    );
  });
  return parts.join("");
}

/**
 * Arrow shaft plus a filled triangular head, computed from the quantized
 * from/to centres. Degenerate arrows (zero length) draw nothing rather than
 * dividing by zero.
 */
function arrowShapes(arrow: { from: Point; to: Point }, color: string): string[] {
  const fromX = quantize(arrow.from[0], "arrow x");
  const fromY = quantize(arrow.from[1], "arrow y");
  const toX = quantize(arrow.to[0], "arrow x");
  const toY = quantize(arrow.to[1], "arrow y");
  const dx = toX - fromX;
  const dy = toY - fromY;
  const length = Math.hypot(dx, dy);
  if (length < 1) {
    return [];
  }
  const headLength = Math.max(8, Math.round(length / 5));
  const headHalfWidth = Math.max(4, Math.round(headLength / 2));
  const unitX = dx / length;
  const unitY = dy / length;
  const baseX = toX - unitX * headLength;
  const baseY = toY - unitY * headLength;
  const leftX = Math.round(baseX - unitY * headHalfWidth);
  const leftY = Math.round(baseY + unitX * headHalfWidth);
  const rightX = Math.round(baseX + unitY * headHalfWidth);
  const rightY = Math.round(baseY - unitX * headHalfWidth);
  return [
    `<line x1="${fromX}" y1="${fromY}" x2="${Math.round(baseX)}" y2="${Math.round(baseY)}" stroke="${color}" stroke-width="${Math.max(3, Math.round(headHalfWidth / 2))}" stroke-opacity="0.9"/>`,
    `<polygon points="${toX},${toY} ${leftX},${leftY} ${rightX},${rightY}" fill="${color}" fill-opacity="0.9"/>`
  ];
}

/**
 * Map an overlay display to its SVG spec. Geometry-dependent kinds need
 * projection callbacks (already bound to a validated transform); when a
 * projection fails they degrade to the hidden status frame instead of
 * guessing coordinates.
 *
 * `projectSquare` projects with the display's side; `projectBoardCorner`
 * projects board-frame coordinates directly, which is side-free — the board
 * outline is the same physical quad whichever color stands near the camera.
 */
export function overlaySpecForDisplay(
  display: OverlayDisplay,
  width: number,
  height: number,
  projectSquare: (square: number) => readonly Point[] | null,
  projectBoardCorner: (u: number, v: number) => Point | null
): OverlaySvgSpec {
  switch (display.kind) {
    case "move": {
      const outline = projectOutline(projectBoardCorner);
      const from = projectSquare(display.fromSquare);
      const to = projectSquare(display.toSquare);
      if (outline === null || from === null || to === null) {
        return hiddenSpec(display, width, height, "invalid-geometry");
      }
      return {
        kind: "move",
        width,
        height,
        outline,
        from,
        to,
        arrow: { from: centre(from), to: centre(to) },
        label: display.moveUci,
        status: display.statusLabel
      };
    }
    case "tracking": {
      const outline = projectOutline(projectBoardCorner);
      if (outline === null) {
        return hiddenSpec(display, width, height, "invalid-geometry");
      }
      return { kind: "tracking", width, height, outline, status: display.statusLabel };
    }
    case "hidden":
      return {
        kind: "hidden",
        width,
        height,
        headline: display.headline,
        details: display.details
      };
  }
}

function hiddenSpec(
  display: OverlayDisplay,
  width: number,
  height: number,
  reason: string
): Extract<OverlaySvgSpec, { kind: "hidden" }> {
  const details = display.kind === "hidden" ? display.details : [reason, display.statusLabel];
  return {
    kind: "hidden",
    width,
    height,
    headline: display.kind === "hidden" ? display.headline : "Overlay hidden",
    details
  };
}

/**
 * The board outline quad in image space, in BoardCorners order (near-left,
 * near-right, far-right, far-left), from the board-frame corners (0,0),
 * (8,0), (8,8), (0,8). Null when any corner fails to project.
 */
function projectOutline(
  projectBoardCorner: (u: number, v: number) => Point | null
): readonly Point[] | null {
  const nearLeft = projectBoardCorner(0, 0);
  const nearRight = projectBoardCorner(8, 0);
  const farRight = projectBoardCorner(8, 8);
  const farLeft = projectBoardCorner(0, 8);
  if (nearLeft === null || nearRight === null || farRight === null || farLeft === null) {
    return null;
  }
  return [nearLeft, nearRight, farRight, farLeft];
}

function centre(quad: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const point of quad) {
    x += point[0];
    y += point[1];
  }
  return [x / quad.length, y / quad.length];
}
