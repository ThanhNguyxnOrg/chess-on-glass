import {
  installVerifiedArtifact,
  NodePlatformServices,
  parseArtifactManifest,
  selectArtifact,
  type Artifact,
  type PlatformServices
} from "@chessonglass/platform";
import { join } from "node:path";
import { TOOL_MANIFEST } from "./tool-manifest.js";

export type InstallToolOptions = Readonly<{
  /** Defaults to the real Node platform services. */
  platform?: PlatformServices;
  /** Defaults to the reviewed TOOL_MANIFEST; injectable for tests. */
  manifest?: unknown;
  /** Defaults to process.arch. */
  arch?: string;
  /** Test seam; forwarded to the installer. */
  fetchImpl?: typeof fetch;
}>;

/**
 * Explicit setup command: download and install one reviewed tool into the
 * user data directory. Nothing is downloaded at npm-install time and there
 * is no PATH or global-executable fallback — a missing or unpinned artifact
 * is a loud error, because release integration must never silently skip a
 * native tool.
 */
export async function installTool(
  id: Artifact["id"],
  options: InstallToolOptions = {}
): Promise<string> {
  const platform = options.platform ?? new NodePlatformServices();
  const records = parseArtifactManifest(options.manifest ?? TOOL_MANIFEST);
  const artifact = selectArtifact(records, id, platform.platform, options.arch ?? process.arch);
  const destinationDirectory = join(platform.userDataDir(), "tools", id);
  return installVerifiedArtifact(artifact, destinationDirectory, new AbortController().signal, {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
  });
}
