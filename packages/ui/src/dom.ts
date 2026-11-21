/** Safe DOM helpers: no innerHTML, no eval, no inline handlers. */

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes?: Record<string, string>,
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attributes) {
    for (const [key, value] of Object.entries(attributes)) {
      el.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

export function text(value: string): Text {
  return document.createTextNode(value);
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

/** Build a chess board as an inline SVG (safe, no innerHTML). */
export function boardSvg(fen: string, highlightUci?: string | null): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 400 400");
  svg.setAttribute("width", "100%");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Chess board: ${fen}`);

  const darkSquare = "#3d3a33";
  const lightSquare = "#b8a988";

  const parsedMove = parseUciMove(highlightUci);

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String(col * 50));
      rect.setAttribute("y", String(row * 50));
      rect.setAttribute("width", "50");
      rect.setAttribute("height", "50");
      rect.setAttribute("fill", (row + col) % 2 === 0 ? lightSquare : darkSquare);
      svg.append(rect);

      if (
        parsedMove !== null &&
        ((parsedMove.fromRow === row && parsedMove.fromCol === col) ||
          (parsedMove.toRow === row && parsedMove.toCol === col))
      ) {
        const hi = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        hi.setAttribute("x", String(col * 50));
        hi.setAttribute("y", String(row * 50));
        hi.setAttribute("width", "50");
        hi.setAttribute("height", "50");
        hi.setAttribute("fill", "rgba(212, 168, 67, 0.42)");
        svg.append(hi);
      }
    }
  }

  const pieces = parseFenPieces(fen);
  for (const piece of pieces) {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", String(piece.col * 50 + 25));
    text.setAttribute("y", String(piece.row * 50 + 34));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", "32");
    text.setAttribute("font-family", "Segoe UI Symbol, sans-serif");
    text.setAttribute("fill", piece.color === "white" ? "#fff6e5" : "#1b1b1b");
    text.textContent = piece.unicode;
    svg.append(text);
  }

  if (parsedMove !== null) {
    const x1 = parsedMove.fromCol * 50 + 25;
    const y1 = parsedMove.fromRow * 50 + 25;
    const x2 = parsedMove.toCol * 50 + 25;
    const y2 = parsedMove.toRow * 50 + 25;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", "#d4a843");
    line.setAttribute("stroke-width", "6");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-opacity", "0.85");
    svg.append(line);

    const tip = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    tip.setAttribute("cx", String(x2));
    tip.setAttribute("cy", String(y2));
    tip.setAttribute("r", "7");
    tip.setAttribute("fill", "#d4a843");
    svg.append(tip);
  }

  return svg;
}

function parseUciMove(
  uci: string | null | undefined
): { fromRow: number; fromCol: number; toRow: number; toCol: number } | null {
  if (typeof uci !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
    return null;
  }
  const fromCol = uci.charCodeAt(0) - 97;
  const fromRow = 8 - Number(uci[1]);
  const toCol = uci.charCodeAt(2) - 97;
  const toRow = 8 - Number(uci[3]);
  return { fromRow, fromCol, toRow, toCol };
}

function parseFenPieces(fen: string): Array<{
  row: number;
  col: number;
  color: "white" | "black";
  unicode: string;
}> {
  const pieces: Array<{ row: number; col: number; color: "white" | "black"; unicode: string }> = [];
  const placement = fen.split(" ")[0] ?? "";
  const rows = placement.split("/");
  const glyphs: Record<string, string> = {
    K: "\u2654", Q: "\u2655", R: "\u2656", B: "\u2657", N: "\u2658", P: "\u2659",
    k: "\u265A", q: "\u265B", r: "\u265C", b: "\u265D", n: "\u265E", p: "\u265F"
  };

  for (let row = 0; row < rows.length && row < 8; row++) {
    let col = 0;
    for (const char of rows[row] ?? "") {
      if (/\d/.test(char)) {
        col += Number(char);
        continue;
      }
      const unicode = glyphs[char];
      if (unicode === undefined) continue;
      pieces.push({
        row,
        col,
        color: char === char.toUpperCase() ? "white" : "black",
        unicode
      });
      col++;
    }
  }
  return pieces;
}
