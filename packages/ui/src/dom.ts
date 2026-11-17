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
export function boardSvg(fen: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 400 400");
  svg.setAttribute("width", "100%");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Chess board: ${fen}`);

  const darkSquare = "#3d3a33";
  const lightSquare = "#b8a988";

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String(col * 50));
      rect.setAttribute("y", String(row * 50));
      rect.setAttribute("width", "50");
      rect.setAttribute("height", "50");
      rect.setAttribute("fill", (row + col) % 2 === 0 ? lightSquare : darkSquare);
      svg.append(rect);
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
    text.setAttribute("fill", piece.color === "white" ? "#f0d9b5" : "#2b2b2b");
    text.textContent = piece.unicode;
    svg.append(text);
  }

  return svg;
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
