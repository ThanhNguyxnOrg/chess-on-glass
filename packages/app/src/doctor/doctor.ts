import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { isSupported as wgcSupported } from "@screen-capture/node";
import type { PlatformServices } from "@chessonglass/platform";

export type DoctorCheckStatus = "ok" | "fail" | "not-run";

export type DoctorCheck = Readonly<{
  id: string;
  status: DoctorCheckStatus;
  ok: boolean;
  detail: string;
}>;

function check(
  id: string,
  ok: boolean,
  detail: string,
  status?: DoctorCheckStatus
): DoctorCheck {
  return { id, ok, detail, status: status ?? (ok ? "ok" : "fail") };
}

function findTool(name: string): string | null {
  const paths = (process.env["PATH"] ?? "").split(/[;:]/);
  for (const dir of paths) {
    if (dir.trim() === "") continue;
    for (const ext of process.platform === "win32" ? [".exe", ""] : [""]) {
      const candidate = join(dir.trim(), `${name}${ext}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Local-only capability diagnostics. No provider calls; the cloud check is
 * `not-run` unless explicitly opted in with `cloudSmoke: true` (and even then
 * it requires a separately approved key and bounded fixture).
 */
export async function runDoctor(options?: {
  platform?: PlatformServices;
  cloudSmoke?: boolean;
}): Promise<readonly DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const platform = options?.platform;

  checks.push(
    check(
      "runtime",
      Number(process.version.match(/^v(\d+)/)?.[1] ?? 0) >= 20,
      `Node ${process.version} on ${process.platform} ${process.arch}`
    )
  );

  if (platform !== undefined) {
    try {
      const probe = join(platform.userDataDir(), `cog-doctor-${Date.now()}.probe`);
      const { writeFile, rm } = await import("node:fs/promises");
      await mkdir(dirname(probe), { recursive: true });
      await writeFile(probe, "ok");
      await rm(probe, { force: true });
      checks.push(check("user-data", true, `writes work in ${platform.userDataDir()}`));
    } catch {
      checks.push(check("user-data", false, "cannot write to user data directory"));
    }

    const testAccount = "chessonglass.doctor.probe";
    try {
      const testSecret = `probe-${Date.now()}`;
      await platform.writeSecret(testAccount, testSecret);
      const readback = await platform.readSecret(testAccount);
      await platform.writeSecret(testAccount, "\0CLEANUP");
      checks.push(
        check(
          "credential-store",
          readback === testSecret,
          readback === testSecret ? "write/read round-trip succeeded" : "readback mismatch"
        )
      );
    } catch {
      checks.push(check("credential-store", false, "credential write/read failed"));
    }
  } else {
    checks.push(check("user-data", true, "platform services not injected; skipping", "not-run"));
    checks.push(check("credential-store", false, "platform services not injected; skipping", "not-run"));
  }

  const ffmpeg = findTool("ffmpeg");
  checks.push(
    check("ffmpeg", ffmpeg !== null, ffmpeg ? `found at ${ffmpeg}` : "not found on PATH")
  );

  const stockfish = findTool("stockfish");
  checks.push(
    check(
      "stockfish",
      stockfish !== null,
      stockfish ? `found at ${stockfish}` : "not found on PATH"
    )
  );

  checks.push(
    check("wgc", wgcSupported(), wgcSupported() ? "WGC is supported" : "WGC is not supported")
  );

  const speechHelper = join(
    fileURLToPath(new URL("../../native/speech/bin/SpeechHelper.exe", import.meta.url))
  );
  checks.push(
    check(
      "speech",
      existsSync(speechHelper),
      existsSync(speechHelper) ? "SpeechHelper.exe is built" : "SpeechHelper.exe is not built"
    )
  );

  checks.push(
    check("cloud", false, "cloud smoke requires owner opt-in and a cost limit", "not-run")
  );

  return checks;
}
