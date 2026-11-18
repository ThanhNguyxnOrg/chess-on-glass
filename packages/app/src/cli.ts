#!/usr/bin/env node
import { resolve } from "node:path";
import { startWindowsApplication } from "./runtime/windows-application.js";

const args = process.argv.slice(2);
const command = args[0];

if (command !== "run") {
  console.error("usage: chessonglass run [--replay path]");
  process.exit(2);
}

const replayIndex = args.indexOf("--replay");
const replayPath = replayIndex >= 0 ? args[replayIndex + 1] : undefined;
const staticDir = resolve(import.meta.dirname, "../../ui/dist");

const app = await startWindowsApplication({ staticDir });
console.log(`ChessOnGlass dashboard: ${app.url}`);
console.log("Opening in your browser…");

if (process.platform === "win32") {
  const { spawn } = await import("node:child_process");
  const child = spawn("cmd", ["/c", "start", "", app.launchUrl], {
    shell: false,
    windowsHide: true,
    stdio: "ignore"
  });
  child.on("error", () => {
    console.log(`Open this URL in your browser: ${app.launchUrl}`);
  });
}

process.on("SIGINT", async () => {
  console.log("\nShutting down…");
  await app.close();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await app.close();
  process.exit(0);
});
