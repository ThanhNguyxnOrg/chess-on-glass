#!/usr/bin/env node
/**
 * Real-machine smoke for the verified tool installer: installs Stockfish and
 * FFmpeg from their pinned releases through installVerifiedArtifact (streamed
 * SHA-256 verification, allowlisted extraction, atomic rename) into the user
 * data directory. It then proves the installed engine answers UCI and the
 * installed FFmpeg starts and encodes one second of synthetic video.
 * `--clean` removes the installed tools afterwards.
 *
 * Run: node packages/app/scripts/smoke-install-tools.ts [--clean]
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  installVerifiedArtifact,
  NodePlatformServices,
  parseArtifactManifest,
  selectArtifact
} from "@chessonglass/platform";
import { TOOL_MANIFEST } from "../src/setup/tool-manifest.ts";

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

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

try {
  const records = parseArtifactManifest(TOOL_MANIFEST);
  const stockfishRecord = selectArtifact(records, "stockfish", process.platform, process.arch);
  const ffmpegRecord = selectArtifact(records, "ffmpeg", process.platform, process.arch);
  const platform = new NodePlatformServices();
  const stockfishDestination = join(platform.userDataDir(), "tools", stockfishRecord.id);
  const ffmpegDestination = join(platform.userDataDir(), "tools", ffmpegRecord.id);

  const stockfishPath = await installVerifiedArtifact(
    stockfishRecord,
    stockfishDestination,
    new AbortController().signal
  );
  const stockfishSha256 = fileSha256(stockfishPath);
  const uci = execFileSync(stockfishPath, [], {
    input: "uci\nquit\n",
    encoding: "utf8",
    timeout: 30_000
  });
  const uciHandshake = uci.includes("id name Stockfish") && uci.includes("uciok");

  const ffmpegPath = await installVerifiedArtifact(
    ffmpegRecord,
    ffmpegDestination,
    new AbortController().signal
  );
  const ffmpegSha256 = fileSha256(ffmpegPath);
  const versionOutput = execFileSync(ffmpegPath, ["-version"], {
    encoding: "utf8",
    timeout: 30_000
  });
  const ffmpegVersion = versionOutput.split("\n")[0]?.trim() ?? "";
  const mediaPath = join(ffmpegDestination, `.ffmpeg-smoke-${randomUUID()}.mkv`);
  let mediaBytes = 0;
  let mediaContainerValid = false;
  try {
    execFileSync(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=64x64:rate=30",
        "-t",
        "1",
        "-c:v",
        "ffv1",
        "-f",
        "matroska",
        mediaPath
      ],
      { encoding: "utf8", timeout: 60_000 }
    );
    const media = readFileSync(mediaPath);
    mediaBytes = media.byteLength;
    mediaContainerValid =
      media.byteLength > 4 && media.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  } finally {
    rmSync(mediaPath, { force: true });
  }

  const ffmpegEncode = mediaBytes > 4 && mediaContainerValid;
  report(uciHandshake && ffmpegVersion.includes("ffmpeg version 7.1.1") && ffmpegEncode, {
    installedPath: stockfishPath,
    installedSha256: stockfishSha256,
    uciId: uci.split("\n").find((line) => line.startsWith("id name"))?.trim() ?? null,
    uciHandshake,
    ffmpegInstalledPath: ffmpegPath,
    ffmpegInstalledSha256: ffmpegSha256,
    ffmpegVersion,
    ffmpegEncode,
    ffmpegEncodedBytes: mediaBytes,
    ffmpegTemporaryMediaRemoved: true
  });
  if (process.argv.includes("--clean")) {
    rmSync(stockfishDestination, { recursive: true, force: true });
    rmSync(ffmpegDestination, { recursive: true, force: true });
  }
} catch (error) {
  report(false, { detail: error instanceof Error ? error.message : String(error) });
}
