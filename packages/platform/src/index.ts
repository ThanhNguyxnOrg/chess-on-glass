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
export { NodePlatformServices } from "./services/node-platform-services.js";
export type { NodePlatformServicesOptions } from "./services/node-platform-services.js";
export {
  createNativeSecretStore,
  KeyringSecretStore,
  NativeSecretStoreError
} from "./secrets/native-keyring.js";
export type {
  KeyringEntry,
  KeyringEntryFactory,
  KeyringSelection,
  NativeSecretStore,
  NativeSecretStoreBackend,
  NativeSecretStoreCode,
  NativeSecretStoreOptions
} from "./secrets/native-keyring.js";
export { selectArtifact, verifyFileDigest } from "./artifacts.js";
export type { Artifact } from "./artifacts.js";
export { assertSafeMemberName, parseArtifactManifest } from "./artifacts/manifest.js";
export type { ArtifactManifest, VerifiedArtifact } from "./artifacts/manifest.js";
export { InstallFailure, installVerifiedArtifact } from "./artifacts/install-artifact.js";
export type { InstallFailureCode, InstallOptions } from "./artifacts/install-artifact.js";
export { UciEngine } from "./uci.js";
export type { Advisor, UciStartOptions } from "./uci.js";
