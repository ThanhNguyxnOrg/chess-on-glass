/**
 * Reviewed, immutable tool manifest for ChessOnGlass release setup.
 *
 * Every record must carry version, download URL, sha256, license, source,
 * build flags and the single executable member to install. A record whose
 * digest is not yet pinned carries the placeholder "unverified": it stays
 * visible here so release engineering can complete it, and `selectArtifact`
 * fails closed if anyone tries to install it. Nothing in this file is
 * downloaded at npm-install time; installation happens only through the
 * explicit setup command.
 *
 * Verification evidence for pinned records:
 * - stockfish/win32/x64: downloaded 2026-11-20 from the official
 *   Stockfish GitHub release (sf_19), size 81,431,614 bytes (matches the
 *   release asset listing), digest computed over the full download.
 */
export const TOOL_MANIFEST = {
  schemaVersion: 1,
  artifacts: [
    {
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
    },
    {
      id: "stockfish",
      version: "19",
      url: "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-windows-arm64-universal.zip",
      sha256: "unverified",
      os: "win32",
      arch: "arm64",
      license: "GPL-3.0-or-later",
      sourceUrl: "https://github.com/official-stockfish/Stockfish",
      buildFlags: ["universal"],
      executable: "stockfish/stockfish-windows-arm64-universal.exe"
    },
    {
      id: "stockfish",
      version: "19",
      url: "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-linux-x86-64-universal.tar.gz",
      sha256: "unverified",
      os: "linux",
      arch: "x64",
      license: "GPL-3.0-or-later",
      sourceUrl: "https://github.com/official-stockfish/Stockfish",
      buildFlags: ["universal"],
      executable: "stockfish/stockfish-linux-x86-64-universal"
    },
    {
      id: "stockfish",
      version: "19",
      url: "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-macos-universal.tar.gz",
      sha256: "unverified",
      os: "darwin",
      arch: "x64",
      license: "GPL-3.0-or-later",
      sourceUrl: "https://github.com/official-stockfish/Stockfish",
      buildFlags: ["universal"],
      executable: "stockfish/stockfish-universal"
    },
    {
      id: "stockfish",
      version: "19",
      url: "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-macos-universal.tar.gz",
      sha256: "unverified",
      os: "darwin",
      arch: "arm64",
      license: "GPL-3.0-or-later",
      sourceUrl: "https://github.com/official-stockfish/Stockfish",
      buildFlags: ["universal"],
      executable: "stockfish/stockfish-universal"
    },
    {
      id: "ffmpeg",
      version: "7.1.1",
      url: "https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-essentials_build.zip",
      sha256: "unverified",
      os: "win32",
      arch: "x64",
      license: "GPL-3.0-or-later",
      sourceUrl: "https://www.ffmpeg.org/download.html",
      buildFlags: ["essentials", "static"],
      executable: "ffmpeg-7.1.1-essentials_build/bin/ffmpeg.exe"
    }
  ]
} as const;
