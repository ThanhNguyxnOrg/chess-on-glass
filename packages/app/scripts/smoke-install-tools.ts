#!/usr/bin/env node
/**
 * Real-machine smoke for the verified tool installer: installs Stockfish from
 * the official GitHub release through installVerifiedArtifact (streamed
 * SHA-256 verification, allowlisted extraction, atomic rename) into the user
 * data directory, then proves the installed engine starts by answering the
 * UCI handshake. `--clean` removes the installed tool afterwards.
 *
 * Run: node packages/app/scripts/smoke-install-tools.ts [--clean]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installVerifiedArtifact, NodePlatformServices } from "@chessonglass/platform";

// Mirrors the stockfish win32/x64 record in packages/app/src/setup/tool-manifest.ts.
const record = {
  id: "stockfish",
  version: "19",
  url: "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-windows-x86-64-universal.zip",
  sha256: "3c8bf1f9ea66a09350a40df4f632288285ac206d99f33ab5842c408fc30b48a7",
  os: "win32",
  arch: "x64",
  license: "GPL-3.0-or-later",
  sourceUrl: "https://github.com/official-stockfish/Stockfish",
  buildFlags: ["universal"],
  executable: "stockfish/stockfish-windows-x86-64-universal.exe"
} as const;

function report(ok: boolean, data: Record<string, unknown>): void {
  console.log(
    JSON.stringify(
      {
        command: "install-tools",
        ok,
        ...data,
        date: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        node: process.version
      },
      null,
      2
    )
  );
  process.exit(ok ? 0 : 1);
}

try {
  const platform = new NodePlatformServices();
  const destination = join(platform.userDataDir(), "tools", record.id);
  const path = await installVerifiedArtifact(
    record,
    destination,
    new AbortController().signal
  );
  const installedSha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  const uci = execFileSync(path, [], {
    input: "uci\nquit\n",
    encoding: "utf8",
    timeout: 30_000
  });
  const handshake = uci.includes("id name Stockfish") && uci.includes("uciok");
  report(handshake, {
    installedPath: path,
    installedSha256,
    uciId: uci.split("\n").find((line) => line.startsWith("id name"))?.trim() ?? null,
    uciHandshake: handshake
  });
  if (process.argv.includes("--clean")) {
    rmSync(destination, { recursive: true, force: true });
  }
} catch (error) {
  report(false, { detail: error instanceof Error ? error.message : String(error) });
}
