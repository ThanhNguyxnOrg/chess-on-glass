const root = document.querySelector<HTMLDivElement>("#app");

if (root !== null) {
  const heading = document.createElement("h1");
  heading.textContent = "ChessOnGlass";
  root.append(heading);
}
