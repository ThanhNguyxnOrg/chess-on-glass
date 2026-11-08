/**
 * Portable platform boundaries for ChessOnGlass.
 *
 * OS-specific behaviour is injected behind interfaces; shared code never
 * imports macOS commands or shell utilities.
 */
export const PACKAGE_NAME = "@chessonglass/platform";
