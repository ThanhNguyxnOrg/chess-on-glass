#!/usr/bin/env node
/**
 * Builds the minimal System.Speech helper. Prefers the .NET SDK; falls back
 * to the in-box Framework compiler so a plain Windows machine can build it.
 * Only fixed paths and argument arrays are used; no shell strings.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const speechDir = fileURLToPath(new URL("../native/speech", import.meta.url));
const project = join(speechDir, "SpeechHelper.csproj");
const output = join(speechDir, "bin");
mkdirSync(output, { recursive: true });

function canRun(command, args) {
  try {
    execFileSync(command, args, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

if (canRun("dotnet", ["--version"])) {
  execFileSync("dotnet", ["build", project, "-c", "Release", "-o", output], {
    stdio: "inherit",
    cwd: speechDir
  });
  console.log(`speech helper: built with dotnet -> ${join(output, "SpeechHelper.exe")}`);
  process.exit(0);
}

const frameworkDir = `${process.env.WINDIR ?? "C:\\Windows"}\\Microsoft.NET\\Framework64\\v4.0.30319`;
const csc = join(frameworkDir, "csc.exe");
const speechAssembly = join(frameworkDir, "WPF", "System.Speech.dll");
const webExtensions = join(frameworkDir, "System.Web.Extensions.dll");
const target = join(output, "SpeechHelper.exe");

if (!existsSync(csc) || !existsSync(speechAssembly) || !existsSync(webExtensions)) {
  console.error(
    "speech helper: neither the .NET SDK nor the in-box Framework compiler/System.Speech could be found"
  );
  process.exit(1);
}

execFileSync(
  csc,
  [
    "/nologo",
    "/target:exe",
    "/platform:x64",
    `/out:${target}`,
    `/r:${speechAssembly}`,
    `/r:${webExtensions}`,
    join(speechDir, "Program.cs")
  ],
  { stdio: "inherit", cwd: speechDir }
);
console.log(`speech helper: built with csc -> ${target}`);
