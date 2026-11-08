/**
 * Portable platform boundaries for ChessOnGlass.
 *
 * OS-specific behaviour is injected behind interfaces; shared code never
 * imports macOS commands or shell utilities.
 */
export const PACKAGE_NAME = "@chessonglass/platform";

export { userDataDir } from "./paths.js";
export { ProcessFailure, runProcess } from "./process.js";
export type { ProcessFailureCode, ProcessResult } from "./process.js";
export { redactLog } from "./log.js";
export type { PlatformServices } from "./services.js";
