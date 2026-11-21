import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { PlatformServices } from "@chessonglass/platform";
import { installTool } from "../../src/setup/install-tools.js";

class FakePlatform implements PlatformServices {
  readonly platform = "win32" as const;

  constructor(readonly root: string) {}

  userDataDir(): string {
    return join(this.root, "userdata");
  }

  async readSecret(): Promise<string | null> {
    return null;
  }

  async writeSecret(): Promise<void> {
    return undefined;
  }

  async openExternal(): Promise<void> {
    return undefined;
  }
}

let crcTable: number[] | undefined;

function crc32(data: Uint8Array): number {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0 ^ -1;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable![(crc ^ byte) & 0xff]!;
  return (crc ^ -1) >>> 0;
}

function zipEntry(name: string, data: Uint8Array, offset: number): { local: Buffer; central: Buffer; size: number } {
  const nameBytes = Buffer.from(name, "utf8");
  const compressed = new Uint8Array(deflateRawSync(Buffer.from(data)));
  const crc = crc32(data);
  const local = Buffer.alloc(30 + nameBytes.byteLength + compressed.byteLength);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.byteLength, 18);
  local.writeUInt32LE(data.byteLength, 22);
  local.writeUInt16LE(nameBytes.byteLength, 26);
  nameBytes.copy(local, 30);
  Buffer.from(compressed).copy(local, 30 + nameBytes.byteLength);

  const central = Buffer.alloc(46 + nameBytes.byteLength);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.byteLength, 20);
  central.writeUInt32LE(data.byteLength, 24);
  central.writeUInt16LE(nameBytes.byteLength, 28);
  central.writeUInt32LE((0o100755 << 16) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  nameBytes.copy(central, 46);
  return { local, central, size: local.byteLength };
}

/** Minimal valid zip containing one executable member. */
function zipWith(exeName: string, exeBytes: Uint8Array): Uint8Array {
  const entry = zipEntry(exeName, exeBytes, 0);
  const centralSize = entry.central.byteLength;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(entry.size, 16);
  return new Uint8Array(Buffer.concat([entry.local, entry.central, eocd]));
}

const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 1, 2, 3]);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("installTool", () => {
  it("installs a manifest-selected artifact into the user data directory", async () => {
    const zip = zipWith("engine/stockfish.exe", EXE);
    const root = await mkdtemp(join(tmpdir(), "chessonglass-app-install-"));
    temporaryDirectories.push(root);
    const platform = new FakePlatform(root);
    const manifest = {
      schemaVersion: 1,
      artifacts: [
        {
          id: "stockfish",
          version: "test",
          url: "https://example.invalid/stockfish.zip",
          sha256: createHash("sha256").update(zip).digest("hex"),
          os: "win32",
          arch: "x64",
          license: "GPL-3.0-or-later",
          sourceUrl: "https://github.com/official-stockfish/Stockfish",
          buildFlags: ["test"],
          executable: "engine/stockfish.exe"
        }
      ]
    };
    const fetchImpl = (async () => new Response(zip as unknown as BodyInit, { status: 200 })) as typeof fetch;

    const path = await installTool("stockfish", { platform, arch: "x64", manifest, fetchImpl });
    expect(path).toBe(join(root, "userdata", "tools", "stockfish", "stockfish.exe"));
    expect(new Uint8Array(await readFile(path))).toEqual(EXE);
  });

  it("fails closed when the manifest has no verified artifact for this OS or architecture", async () => {
    const root = await mkdtemp(join(tmpdir(), "chessonglass-app-install-"));
    temporaryDirectories.push(root);
    const platform = new FakePlatform(root);
    const manifest = { schemaVersion: 1, artifacts: [] };
    await expect(installTool("stockfish", { platform, manifest })).rejects.toThrow(
      /no verified artifact/i
    );
    const tools = await readdir(join(root, "userdata", "tools")).then(
      (entries) => entries,
      () => ["missing"]
    );
    expect(tools).toEqual(["missing"]);
  });

  it("rejects an unpinned artifact instead of downloading unverified bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "chessonglass-app-install-"));
    temporaryDirectories.push(root);
    const platform = new FakePlatform(root);
    const manifest = {
      schemaVersion: 1,
      artifacts: [
        {
          id: "stockfish",
          version: "19",
          url: "https://example.invalid/stockfish.zip",
          sha256: "unverified",
          os: "win32",
          arch: "x64",
          license: "GPL-3.0-or-later",
          sourceUrl: "https://github.com/official-stockfish/Stockfish",
          buildFlags: ["universal"],
          executable: "stockfish/stockfish.exe"
        }
      ]
    };
    await expect(installTool("stockfish", { platform, arch: "x64", manifest })).rejects.toThrow(/sha256/i);
    const tools = await readdir(join(root, "userdata", "tools")).then(
      (entries) => entries,
      () => ["missing"]
    );
    expect(tools).toEqual(["missing"]);
  });
});
