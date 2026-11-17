import { boardSvg, clear, element, text } from "./dom.js";

const root = document.querySelector<HTMLDivElement>("#app");
if (root !== null) {
  mountDashboard(root);
}

function mountDashboard(root: HTMLElement): void {
  clear(root);

  const statusDot = element("span", { class: "status-dot ready" });
  const statusLabel = element("span", {}, text("Ready"));
  const connection = element("span", { class: "connection-label" }, text("127.0.0.1"));

  const statusBar = element("div", { class: "status-bar" }, statusDot, statusLabel, connection);

  const boardContainer = element("div", { class: "board-container" });
  boardContainer.append(boardSvg("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"));

  const suggestionCard = element("div", { class: "suggestion-card" },
    element("div", { class: "move" }, text("—")),
    element("div", { class: "spoken" }, text("Waiting for a move…"))
  );

  const buttons = ["Pause", "Undo", "Repeat", "New game"];
  const controls = element("div", { class: "controls" });
  for (const label of buttons) {
    controls.append(element("button", { type: "button" }, text(label)));
  }

  const history = element("div", { class: "move-history" }, text("No moves yet."));

  root.append(statusBar, boardContainer, suggestionCard, controls, history);
}
