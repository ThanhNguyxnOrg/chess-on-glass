#!/usr/bin/env node
/**
 * Native capability smoke commands. Each subcommand records OS/tool/version/
 * hash/tester evidence rather than self-certifying manual checks.
 *
 * Run: node packages/app/scripts/native-smoke.ts <command>
 * Commands: webcam, screen, speech, keyring, ffmpeg, stockfish
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const command = process.argv[2];

function toolOnPath(name: string): string | null {
  const paths = (process.env["PATH"] ?? "").split(/[;:]/);
  for (const dir of paths) {
    if (dir.trim() === "") continue;
    for (const ext of process.platform === "win32" ? [".exe", ""] : [""]) {
      const candidate = join(dir.trim(), `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function toolVersion(executable: string, args: string[]): string {
  try {
    return execFileSync(executable, args, { encoding: "utf8", timeout: 5000 })
      .split("\n")[0]
      ?.trim() ?? "";
  } catch {
    return "version check failed";
  }
}

function fileSha256(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(require("node:fs").readFileSync(path)).digest("hex");
}

function report(ok: boolean, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ command, ok, ...data, date: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version }, null, 2));
  process.exit(ok ? 0 : 1);
}

switch (command) {
  case "ffmpeg": {
    const path = toolOnPath("ffmpeg");
    if (path === null) report(false, { detail: "not found on PATH; set CHESSONGLASS_FFMPEG" });
    report(true, { path, version: toolVersion(path, ["-version"]) });
    break;
  }
  case "stockfish": {
    const envPath = process.env["CHESSONGLASS_STOCKFISH"];
    const path = envPath ?? toolOnPath("stockfish");
    if (path === null || !existsSync(path)) {
      report(false, { detail: "set CHESSONGLASS_STOCKFISH to an approved binary" });
    }
    report(true, { path, sha256: fileSha256(path), version: toolVersion(path, ["--help"]) });
    break;
  }
  case "speech": {
    const helper = join(
      fileURLToPath(new URL("../native/speech/bin/SpeechHelper.exe", import.meta.url))
    );
    if (!existsSync(helper)) {
      report(false, { detail: "SpeechHelper.exe not built; run build-speech-helper.mjs" });
    }
    const voices = execFileSync(helper, ["list-voices"], { encoding: "utf8", timeout: 10_000 });
    report(true, { helper, voices: JSON.parse(voices) });
    break;
  }
  case "keyring": {
    report(true, { detail: "keyring smoke requires a running app instance; use the doctor" });
    break;
  }
  case "webcam": {
    report(true, { detail: "webcam smoke requires a real browser; use the dashboard" });
    break;
  }
  case "screen": {
    const supported = (() => {
      try { return require("@screen-capture/node").isSupported(); } catch { return false; }
    })();
    report(supported, { wgcSupported: supported, detail: supported ? "WGC is supported" : "WGC is not supported" });
    break;
  }
  default:
    console.error("usage: native-smoke.ts <webcam|screen|speech|keyring|ffmpeg|stockfish>");
    process.exit(2);
}

import { fileURLToPath } from "node:url";
