#!/usr/bin/env node
import { resolve } from "node:path";
import { NodePlatformServices } from "@chessonglass/platform";
import { runDoctor } from "./doctor/doctor.js";
import { startWindowsApplication } from "./runtime/windows-application.js";
import { installTool } from "./setup/install-tools.js";

const args = process.argv.slice(2);
const command = args[0] ?? "run";

if (command === "doctor") {
  const platform = new NodePlatformServices();
  const checks = await runDoctor({ platform });
  console.log(JSON.stringify(checks, null, 2));
  process.exit(checks.every((check) => check.ok) ? 0 : 1);
}

if (command === "install-tools") {
  const requested = args.slice(1);
  const targets =
    requested.length > 0 ? requested : (["stockfish", "ffmpeg"] as const);
  for (const id of targets) {
    if (id !== "stockfish" && id !== "ffmpeg") {
      console.error(`unknown tool "${id}"; expected "stockfish" or "ffmpeg"`);
      process.exit(2);
    }
    console.log(`Installing verified ${id}…`);
    const installedPath = await installTool(id);
    console.log(`Installed ${id}: ${installedPath}`);
  }
  process.exit(0);
}

if (command !== "run") {
  console.error(
    "usage: chessonglass <run [--replay path] | doctor | install-tools [stockfish|ffmpeg]>"
  );
  process.exit(2);
}

const replayIndex = args.indexOf("--replay");
const replayPath = replayIndex >= 0 ? args[replayIndex + 1] : undefined;
const staticDir = resolve(import.meta.dirname, "../../ui/dist");

const app = await startWindowsApplication({
  staticDir,
  ...(replayPath !== undefined ? { replayPath } : {})
});
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
    console.error(
      `Could not launch your browser automatically. Re-run in a desktop session or check ${app.url}.`
    );
  });
} else {
  const platform = new NodePlatformServices();
  await platform.openExternal(app.launchUrl).catch(() => {
    console.error(
      `Could not launch your browser automatically. Open ${app.url} in a desktop session.`
    );
  });
}

process.on("SIGINT", async () => {
  console.log("\nShutting down…");
  await app.close();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  console.log("\nShutting down…");
  await app.close();
  process.exit(0);
});
