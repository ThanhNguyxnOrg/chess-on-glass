import { describe, expect, it } from "vitest";
import {
  OVERLAY_MOVE_COLOR,
  OVERLAY_OUTLINE_COLOR,
  buildOverlaySvg,
  escapeXmlAttribute,
  escapeXmlText,
  sanitizeOverlayText,
  type OverlaySvgSpec
} from "@chessonglass/perception";
import type { Point } from "@chessonglass/perception";

const HOSTILE_STRINGS: ReadonlyArray<{ payload: string; carriesMarkup: boolean }> = [
  { payload: '<script>alert(1)</script>', carriesMarkup: true },
  { payload: '<img src=x onerror=alert(1)>', carriesMarkup: true },
  { payload: '" onmouseover="alert(1)', carriesMarkup: true },
  { payload: "' onmouseover='alert(1)", carriesMarkup: true },
  { payload: "&", carriesMarkup: true },
  // ">" escaping defuses the CDATA terminator sequence.
  { payload: "]]>", carriesMarkup: true },
  { payload: "</svg><svg onload='alert(1)'>", carriesMarkup: true },
  { payload: "<![CDATA[<script>alert(1)</script>]]>", carriesMarkup: true },
  // Template payloads carry no XML-significant characters: they are inert in
  // text/attribute positions, so they must round-trip unchanged.
  { payload: "${window.location.href}", carriesMarkup: false },
  { payload: "{{7*7}}", carriesMarkup: false }
];

/** A full board quad in a 320x240 frame, near edge at the bottom. */
const OUTLINE: readonly Point[] = [
  [10, 230],
  [310, 230],
  [310, 10],
  [10, 10]
];

const FROM_SQUARE: readonly Point[] = [
  [10, 230],
  [45, 230],
  [45, 195],
  [10, 195]
];

const TO_SQUARE: readonly Point[] = [
  [275, 45],
  [310, 45],
  [310, 10],
  [275, 10]
];

function moveSpec(overrides: Partial<Extract<OverlaySvgSpec, { kind: "move" }>> = {}): OverlaySvgSpec {
  return {
    kind: "move",
    width: 320,
    height: 240,
    outline: OUTLINE,
    from: FROM_SQUARE,
    to: TO_SQUARE,
    arrow: { from: [27, 212], to: [292, 27] },
    label: "e2e4",
    status: "Ready",
    ...overrides
  };
}

describe("XML escaping helpers", () => {
  it("escapes markup-significant characters in text nodes", () => {
    expect(escapeXmlText("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeXmlText("a & b > c")).toBe("a &amp; b &gt; c");
    expect(escapeXmlText("]]>")).toBe("]]&gt;");
  });

  it("escapes attribute delimiters so hostile values cannot break out", () => {
    expect(escapeXmlAttribute('" onmouseover="alert(1)')).toBe(
      "&quot; onmouseover=&quot;alert(1)"
    );
    expect(escapeXmlAttribute("' onmouseover='alert(1)")).toBe(
      "&apos; onmouseover=&apos;alert(1)"
    );
    expect(escapeXmlAttribute("<img src=x>")).toBe("&lt;img src=x&gt;");
  });

  it("escapes every hostile payload without leaving raw markup", () => {
    for (const { payload, carriesMarkup } of HOSTILE_STRINGS) {
      const asText = escapeXmlText(payload);
      const asAttribute = escapeXmlAttribute(payload);
      // Quotes are inert inside text nodes (escaping them there is allowed
      // but not required); `<`, `>` and `&` are significant in both contexts.
      const textSignificant = /[<>&]/.test(payload);
      for (const [escaped, significant] of [
        [asText, textSignificant],
        [asAttribute, true]
      ] as const) {
        expect(escaped).not.toContain("<script");
        expect(escaped).not.toContain("<img");
        expect(escaped).not.toContain("</svg");
        expect(escaped.startsWith("<")).toBe(false);
        if (carriesMarkup && significant) {
          // A payload carrying significant characters must have been changed
          // by escaping; identity output would mean it passed through.
          expect(escaped).not.toBe(payload);
        }
        if (!carriesMarkup) {
          expect(escaped).toBe(payload);
        }
      }
      if (carriesMarkup && textSignificant) {
        expect(asText).toContain("&");
        expect(asAttribute).toContain("&");
      }
    }
  });

  it("sanitizes control characters and caps length before escaping", () => {
    expect(sanitizeOverlayText("a\u0000b\u0007c\u001fd")).toBe("abcd");
    expect(sanitizeOverlayText("ok\u001b[31mtext")).toBe("ok[31mtext");
    expect(sanitizeOverlayText(42 as unknown as string)).toBeNull();
    expect(sanitizeOverlayText(null as unknown as string)).toBeNull();
    const long = "x".repeat(500);
    expect(sanitizeOverlayText(long)?.length).toBe(200);
  });
});

describe("buildOverlaySvg", () => {
  it("draws a cyan board outline, green from/to squares and arrow with a move label", () => {
    const svg = buildOverlaySvg(moveSpec());
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);

    // Cyan outline around the whole board.
    expect(svg).toContain(`stroke="${OVERLAY_OUTLINE_COLOR}"`);
    expect(svg).toContain('points="10,230 310,230 310,10 10,10"');

    // Green from/to square fills.
    const greenFills = svg.split(`fill="${OVERLAY_MOVE_COLOR}"`).length - 1;
    expect(greenFills).toBeGreaterThanOrEqual(2);
    expect(svg).toContain('points="10,230 45,230 45,195 10,195"');
    expect(svg).toContain('points="275,45 310,45 310,10 275,10"');

    // Arrow from the from-square centre towards the to-square centre.
    expect(svg).toContain("<line");
    expect(svg).toContain(`stroke="${OVERLAY_MOVE_COLOR}"`);

    // Piece/move label and status text survive as escaped text nodes.
    expect(svg).toContain(">e2e4<");
    expect(svg).toContain(">Ready<");
  });

  it("produces byte-identical SVG for identical specs (deterministic dimensions)", () => {
    const first = buildOverlaySvg(moveSpec());
    const second = buildOverlaySvg(moveSpec());
    expect(first).toBe(second);
    expect(first).toContain('width="320"');
    expect(first).toContain('height="240"');
  });

  it("quantizes coordinates so float noise never reaches the markup", () => {
    const svg = buildOverlaySvg(
      moveSpec({
        outline: [
          [10.4, 230.6],
          [310.2, 229.8],
          [309.5, 10.1],
          [10.9, 10.7]
        ]
      })
    );
    expect(svg).not.toMatch(/points="[^"]*\.\d/);
    expect(svg).toContain('points="10,231 310,230 310,10 11,11"');
  });

  it("keeps a hostile move label and status as escaped text only", () => {
    const svg = buildOverlaySvg(
      moveSpec({
        label: '<script>alert(1)</script>',
        status: '</svg><svg onload="alert(1)">'
      })
    );
    expect(svg).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<svg onload");
    // Only the one trusted root element opens an <svg>.
    expect(svg.indexOf("<svg")).toBe(0);
    expect(svg.split("<svg").length - 1).toBe(1);
  });

  it("draws outline plus status without move marks when tracking has no move yet", () => {
    const svg = buildOverlaySvg({
      kind: "tracking",
      width: 320,
      height: 240,
      outline: OUTLINE,
      status: "Waiting for a move"
    });
    expect(svg).toContain(`stroke="${OVERLAY_OUTLINE_COLOR}"`);
    expect(svg).toContain(">Waiting for a move<");
    expect(svg).not.toContain("<line");
    expect(svg).not.toContain(`fill="${OVERLAY_MOVE_COLOR}"`);
  });

  it("renders the hidden state as a clearly labeled status-only frame", () => {
    const svg = buildOverlaySvg({
      kind: "hidden",
      width: 320,
      height: 240,
      headline: "Overlay hidden",
      details: ["geometry-expired", '<img src=x onerror=alert(1)>']
    });
    expect(svg).toContain(">Overlay hidden<");
    expect(svg).toContain(">geometry-expired<");
    expect(svg).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(svg).not.toContain("<img");
    // The dimming backdrop keeps the label readable and marks the frame as
    // status-only rather than a stale drawing.
    expect(svg).toMatch(/<rect [^>]*fill="#000000"/);
  });
});
