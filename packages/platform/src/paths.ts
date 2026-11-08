import { join } from "node:path";

/**
 * Resolve the per-user data directory without assuming a POSIX host.
 * `CHESSONGLASS_DATA_DIR` is an explicit operator override and wins only when
 * it contains a non-whitespace value.
 */
export function userDataDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string
): string {
  const override = env.CHESSONGLASS_DATA_DIR;
  if (override !== undefined && override.trim() !== "") {
    return override;
  }

  if (platform === "win32") {
    const appData = env.APPDATA;
    if (appData === undefined || appData.trim() === "") {
      throw new Error("APPDATA is required to resolve the Windows user data directory");
    }
    return join(appData, "ChessOnGlass");
  }

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "ChessOnGlass");
  }

  const stateHome = env.XDG_STATE_HOME;
  if (stateHome !== undefined && stateHome.trim() !== "") {
    return join(stateHome, "ChessOnGlass");
  }
  return join(home, ".local", "state", "ChessOnGlass");
}
