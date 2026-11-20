import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installVerifiedArtifact,
  InstallFailure,
  type VerifiedArtifact
} from "@chessonglass/platform";

/* ------------------------------------------------------------------ */
/* Fixture builders: zip and tar.gz archives with fault-injection.     */
/* ------------------------------------------------------------------ */

let crcTable: number[] | undefined;

function crc32(data: Uint8Array): number {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
  });
  let crc = 0 ^ -1;
  for (const byte of data) {
    crc = (crc >>> 8) ^ crcTable![(crc ^ byte) & 0xff]!;
  }
  return (crc ^ -1) >>> 0;
}

type ZipEntry = {
  name: string;
  data?: Uint8Array;
  method?: 0 | 8;
  mode?: number;
  flags?: number;
  zip64Sizes?: boolean;
  corruptDeflate?: boolean;
  wrongCrc?: boolean;
};

/** Build a minimal but structurally valid zip archive (stored/deflate). */
function zipArchive(entries: readonly ZipEntry[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = entry.data ?? new Uint8Array(0);
    const method = entry.method ?? 0;
    const corrupted = entry.corruptDeflate === true;
    const compressed =
      method === 8 && !corrupted ? new Uint8Array(deflateRawSync(Buffer.from(raw))) : raw;
    const crc = entry.wrongCrc === true ? 0xdeadbeef : crc32(raw);
    const flags = entry.flags ?? 0;
    const compSize = entry.zip64Sizes === true ? 0xffffffff : compressed.byteLength;
    const uncompSize = entry.zip64Sizes === true ? 0xffffffff : raw.byteLength;
    const mode = entry.mode ?? 0o100644;

    const local = Buffer.alloc(30 + name.byteLength);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compSize, 18);
    local.writeUInt32LE(uncompSize, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    Buffer.from(name).copy(local, 30);
    parts.push(local, Buffer.from(compressed));

    const dir = Buffer.alloc(46 + name.byteLength);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE((3 << 8) | 20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(flags, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compSize, 20);
    dir.writeUInt32LE(uncompSize, 24);
    dir.writeUInt16LE(name.byteLength, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE((mode << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    Buffer.from(name).copy(dir, 46);
    central.push(dir);

    offset += local.byteLength + compressed.byteLength;
  }

  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.byteLength, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([...parts, centralBytes, eocd]));
}

type TarEntry = {
  name: string;
  data?: Uint8Array;
  type?: "0" | "1" | "2" | "3" | "5";
  linkName?: string;
  mode?: string;
};

function tarHeader(entry: TarEntry, size: number): Buffer {
  const header = Buffer.alloc(512, 0);
  const write = (value: string, offset: number, length: number): void => {
    Buffer.from(value, "utf8").copy(header, offset, 0, Math.min(value.length, length));
  };
  write(entry.name, 0, 100);
  write(entry.mode ?? "0000644\0", 100, 8);
  write("0000000\0", 108, 8);
  write("0000000\0", 116, 8);
  write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  write("00000000000\0", 136, 12);
  header.fill(0x20, 148, 156);
  header.write(entry.type ?? "0", 156, "ascii");
  write(entry.linkName ?? "", 157, 100);
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

function tarArchive(entries: readonly TarEntry[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? new Uint8Array(0));
    parts.push(tarHeader(entry, data.byteLength), data);
    const padding = (512 - (data.byteLength % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  return new Uint8Array(Buffer.concat(parts));
}

function tarGzipArchive(entries: readonly TarEntry[]): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(tarArchive(entries))));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Shared record + fetch plumbing                                      */
/* ------------------------------------------------------------------ */

const EXE_BYTES = new Uint8Array([0x4d, 0x5a, 1, 2, 3, 4, 5, 6, 7, 8]);
const LICENSE_BYTES = new TextEncoder().encode("GPL-3.0-or-later license text");

function recordFor(archive: Uint8Array, overrides: Partial<VerifiedArtifact> = {}): VerifiedArtifact {
  return {
    id: "stockfish",
    version: "19",
    url: "https://example.invalid/stockfish.zip",
    sha256: sha256Hex(archive),
    os: "win32",
    arch: "x64",
    license: "GPL-3.0-or-later",
    sourceUrl: "https://github.com/official-stockfish/Stockfish",
    buildFlags: ["universal"],
    executable: "stockfish/stockfish.exe",
    ...overrides
  };
}

function fetchReturning(bytes: Uint8Array): typeof fetch {
  return vi.fn(async () => new Response(bytes as unknown as BodyInit, { status: 200 })) as typeof fetch;
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chessonglass-install-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

const NO_SIGNAL = new AbortController().signal;

async function install(
  record: VerifiedArtifact,
  destination: string,
  signal: AbortSignal,
  options: Partial<Parameters<typeof installVerifiedArtifact>[3]> = {}
): Promise<unknown> {
  return installVerifiedArtifact(record, destination, signal, {
    fetchImpl: fetchReturning(new Uint8Array(0)),
    ...options
  });
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("installVerifiedArtifact", () => {
  it("extracts only the allowlisted executable member from a zip archive", async () => {
    const zip = zipArchive([
      { name: "stockfish/", mode: 0o040755 },
      { name: "stockfish/stockfish.exe", data: EXE_BYTES, method: 8 },
      { name: "stockfish/Copying.txt", data: LICENSE_BYTES, method: 0 }
    ]);
    const destination = await temporaryDirectory();
    const path = (await install(
      recordFor(zip),
      destination,
      NO_SIGNAL,
      { fetchImpl: fetchReturning(zip) }
    )) as string;

    expect(path).toBe(join(destination, "stockfish.exe"));
    expect(new Uint8Array(await readFile(path))).toEqual(EXE_BYTES);
    expect((await readdir(destination)).sort()).toEqual(["stockfish.exe"]);
  });

  it("extracts only the allowlisted executable member from a tar.gz archive", async () => {
    const tarGz = tarGzipArchive([
      { name: "stockfish/", type: "5", mode: "0000755\0" },
      { name: "stockfish/stockfish", data: EXE_BYTES, mode: "0000755\0" },
      { name: "stockfish/AUTHORS", data: LICENSE_BYTES }
    ]);
    const destination = await temporaryDirectory();
    const path = (await install(
      recordFor(tarGz, { executable: "stockfish/stockfish", url: "https://example.invalid/stockfish.tar.gz" }),
      destination,
      NO_SIGNAL,
      { fetchImpl: fetchReturning(tarGz) }
    )) as string;

    expect(path).toBe(join(destination, "stockfish"));
    expect(new Uint8Array(await readFile(path))).toEqual(EXE_BYTES);
    expect((await readdir(destination)).sort()).toEqual(["stockfish"]);
    if (process.platform !== "win32") {
      const mode = (await stat(path)).mode & 0o777;
      expect(mode & 0o111).toBe(0o111);
    }
  });

  it("creates a missing destination directory and replaces an existing executable", async () => {
    const zip = zipArchive([{ name: "stockfish/stockfish.exe", data: EXE_BYTES }]);
    const base = await temporaryDirectory();
    const destination = join(base, "nested", "tools");
    await writeFile(join(base, "sentinel"), "keep");
    (await install(recordFor(zip), destination, NO_SIGNAL, { fetchImpl: fetchReturning(zip) })) as string;
    expect(new Uint8Array(await readFile(join(destination, "stockfish.exe")))).toEqual(EXE_BYTES);

    const stale = new Uint8Array([9, 9, 9]);
    await writeFile(join(destination, "stockfish.exe"), stale);
    (await install(recordFor(zip), destination, NO_SIGNAL, { fetchImpl: fetchReturning(zip) })) as string;
    expect(new Uint8Array(await readFile(join(destination, "stockfish.exe")))).toEqual(EXE_BYTES);
  });

  it("fails on a digest mismatch before any executable exists at the destination", async () => {
    const zip = zipArchive([{ name: "stockfish/stockfish.exe", data: EXE_BYTES }]);
    const destination = await temporaryDirectory();
    const error = await install(
      recordFor(zip, { sha256: "b".repeat(64) }),
      destination,
      NO_SIGNAL,
      { fetchImpl: fetchReturning(zip) }
    ).then(
      () => null,
      (thrown) => thrown
    );
    expect(error).toBeInstanceOf(InstallFailure);
    expect((error as InstallFailure).code).toBe("digest");
    expect(await readdir(destination)).toEqual([]);
  });

  it("fails on a malformed expected digest without downloading", async () => {
    const zip = zipArchive([{ name: "stockfish/stockfish.exe", data: EXE_BYTES }]);
    const fetchImpl = fetchReturning(zip);
    const destination = await temporaryDirectory();
    await expect(
      install(recordFor(zip, { sha256: "unverified" }), destination, NO_SIGNAL, { fetchImpl })
    ).rejects.toMatchObject({ code: "invalid-record" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(destination)).toEqual([]);
  });

  it("rejects non-https record URLs without downloading", async () => {
    const zip = zipArchive([{ name: "stockfish/stockfish.exe", data: EXE_BYTES }]);
    const fetchImpl = fetchReturning(zip);
    const destination = await temporaryDirectory();
    await expect(
      install(recordFor(zip, { url: "http://example.invalid/a.zip" }), destination, NO_SIGNAL, { fetchImpl })
    ).rejects.toMatchObject({ code: "invalid-record" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("enforces the download size cap and leaves nothing behind", async () => {
    const bytes = new Uint8Array(64).fill(7);
    const destination = await temporaryDirectory();
    const error = await install(
      recordFor(bytes),
      destination,
      NO_SIGNAL,
      { fetchImpl: fetchReturning(bytes), maxBytes: 32 }
    ).then(
      () => null,
      (thrown) => thrown
    );
    expect(error).toBeInstanceOf(InstallFailure);
    expect((error as InstallFailure).code).toBe("size-cap");
    expect(await readdir(destination)).toEqual([]);
  });

  it("fails on non-2xx responses", async () => {
    const destination = await temporaryDirectory();
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const error = await install(recordFor(new Uint8Array(8)), destination, NO_SIGNAL, { fetchImpl }).then(
      () => null,
      (thrown) => thrown
    );
    expect((error as InstallFailure).code).toBe("http");
    expect((error as Error).message).toContain("404");
    expect(await readdir(destination)).toEqual([]);
  });

  it("rejects an already-aborted signal before any request", async () => {
    const fetchImpl = fetchReturning(new Uint8Array(8));
    const destination = await temporaryDirectory();
    const controller = new AbortController();
    controller.abort();
    await expect(
      install(recordFor(new Uint8Array(8)), destination, controller.signal, { fetchImpl })
    ).rejects.toMatchObject({ code: "aborted" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(destination)).toEqual([]);
  });

  it("honours abort during a stalled download and cleans the partial file", async () => {
    let pulls = 0;
    const stalled = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls === 0) {
          pulls += 1;
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        }
        // Never closes: the download stalls forever until aborted.
      }
    });
    const fetchImpl = vi.fn(async () => new Response(stalled, { status: 200 })) as unknown as typeof fetch;
    const destination = await temporaryDirectory();
    const controller = new AbortController();
    const pending = install(recordFor(new Uint8Array(64)), destination, controller.signal, { fetchImpl });
    const settled = pending.then(
      () => "resolved" as const,
      (error: unknown) => ({ error })
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    const outcome = (await settled) as { error?: InstallFailure };
    expect(outcome.error).toBeInstanceOf(InstallFailure);
    expect(outcome.error!.code).toBe("aborted");
    expect(await readdir(destination)).toEqual([]);
  });

  it("rejects traversal member names", async () => {
    for (const unsafe of ["../evil.js", "a/../../evil.js", "/abs/evil.js", "stockfish\\..\\evil.exe"]) {
      const zip = zipArchive([
        { name: unsafe, data: EXE_BYTES },
        { name: "stockfish/stockfish.exe", data: EXE_BYTES }
      ]);
      const destination = await temporaryDirectory();
      const error = await install(recordFor(zip), destination, NO_SIGNAL, { fetchImpl: fetchReturning(zip) }).then(
        () => null,
        (thrown) => thrown
      );
      expect(error, unsafe).toBeInstanceOf(InstallFailure);
      expect((error as InstallFailure).code).toBe("unsafe-member");
      expect(await readdir(destination)).toEqual([]);
    }
  });

  it("rejects symlink and device members instead of extracting through them", async () => {
    const zipWithSymlink = zipArchive([
      { name: "stockfish/stockfish.exe", data: EXE_BYTES },
      { name: "stockfish/link", data: new TextEncoder().encode("/etc/passwd"), mode: 0o120777 }
    ]);
    const destination = await temporaryDirectory();
    const error = await install(recordFor(zipWithSymlink), destination, NO_SIGNAL, {
      fetchImpl: fetchReturning(zipWithSymlink)
    }).then(
      () => null,
      (thrown) => thrown
    );
    expect(error).toBeInstanceOf(InstallFailure);
    expect((error as InstallFailure).code).toBe("unsafe-member");
    expect(await readdir(destination)).toEqual([]);

    for (const type of ["1", "2", "3", "4"] as const) {
      const tarGz = tarGzipArchive([
        { name: "stockfish/stockfish", data: EXE_BYTES },
        { name: "stockfish/link", type, linkName: "/etc/passwd" }
      ]);
      const tarDestination = await temporaryDirectory();
      const tarError = await install(
        recordFor(tarGz, { executable: "stockfish/stockfish" }),
        tarDestination,
        NO_SIGNAL,
        { fetchImpl: fetchReturning(tarGz) }
      ).then(
        () => null,
        (thrown) => thrown
      );
      expect(tarError, `tar type ${type}`).toBeInstanceOf(InstallFailure);
      expect((tarError as InstallFailure).code).toBe("unsafe-member");
      expect(await readdir(tarDestination)).toEqual([]);
    }
  });

  it("rejects a symlink as the allowlisted member itself", async () => {
    const zip = zipArchive([{ name: "stockfish/stockfish.exe", data: EXE_BYTES, mode: 0o120777 }]);
    const destination = await temporaryDirectory();
    await expect(
      install(recordFor(zip), destination, NO_SIGNAL, { fetchImpl: fetchReturning(zip) })
    ).rejects.toMatchObject({ code: "unsafe-member" });
    expect(await readdir(destination)).toEqual([]);
  });

  it("rejects encrypted entries, data descriptors and zip64 markers", async () => {
    for (const entry of [
      { name: "stockfish/stockfish.exe", data: EXE_BYTES, flags: 0x0001 },
      { name: "stockfish/stockfish.exe", data: EXE_BYTES, flags: 0x0008 },
      { name: "stockfish/stockfish.exe", data: EXE_BYTES, zip64Sizes: true }
    ]) {
      const zip = zipArchive([entry]);
      const destination = await temporaryDirectory();
      const error = await install(recordFor(zip), destination, NO_SIGNAL, {
        fetchImpl: fetchReturning(zip)
      }).then(
        () => null,
        (thrown) => thrown
      );
      expect(error, JSON.stringify(entry)).toBeInstanceOf(InstallFailure);
      expect((error as InstallFailure).code).toBe("unsupported-archive");
      expect(await readdir(destination)).toEqual([]);
    }
  });

  it("rejects unknown archive formats including xz with an actionable message", async () => {
    for (const [bytes, pattern] of [
      [new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 1, 2]), /xz/i],
      [new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]), /zstd|unknown/i],
      [new TextEncoder().encode("plain text, not an archive"), /unknown/i]
    ] as const) {
      const destination = await temporaryDirectory();
      const error = await install(recordFor(bytes), destination, NO_SIGNAL, {
        fetchImpl: fetchReturning(bytes)
      }).then(
        () => null,
        (thrown) => thrown
      );
      expect(error).toBeInstanceOf(InstallFailure);
      expect((error as InstallFailure).code).toBe("unsupported-archive");
      expect((error as Error).message).toMatch(pattern);
      expect(await readdir(destination)).toEqual([]);
    }
  });

  it("fails with member-missing when the allowlisted executable is absent", async () => {
    const zip = zipArchive([{ name: "other/tool.exe", data: EXE_BYTES }]);
    const destination = await temporaryDirectory();
    const error = await install(recordFor(zip, { executable: "stockfish/stockfish.exe" }), destination, NO_SIGNAL, {
      fetchImpl: fetchReturning(zip)
    }).then(
      () => null,
      (thrown) => thrown
    );
    expect((error as InstallFailure).code).toBe("member-missing");
    expect(await readdir(destination)).toEqual([]);
  });

  it("fails on a corrupt deflate stream and on CRC mismatch", async () => {
    const corrupt = zipArchive([
      { name: "stockfish/stockfish.exe", data: EXE_BYTES, method: 8, corruptDeflate: true }
    ]);
    const corruptDestination = await temporaryDirectory();
    const corruptError = await install(recordFor(corrupt), corruptDestination, NO_SIGNAL, {
      fetchImpl: fetchReturning(corrupt)
    }).then(
      () => null,
      (thrown) => thrown
    );
    expect((corruptError as InstallFailure).code).toBe("corrupt-member");
    expect(await readdir(corruptDestination)).toEqual([]);

    const badCrc = zipArchive([
      { name: "stockfish/stockfish.exe", data: EXE_BYTES, wrongCrc: true }
    ]);
    const crcDestination = await temporaryDirectory();
    const crcError = await install(recordFor(badCrc), crcDestination, NO_SIGNAL, {
      fetchImpl: fetchReturning(badCrc)
    }).then(
      () => null,
      (thrown) => thrown
    );
    expect((crcError as InstallFailure).code).toBe("corrupt-member");
    expect(await readdir(crcDestination)).toEqual([]);
  });

  it("enforces the extracted member size cap", async () => {
    const zip = zipArchive([{ name: "stockfish/stockfish.exe", data: EXE_BYTES }]);
    const destination = await temporaryDirectory();
    const error = await install(recordFor(zip), destination, NO_SIGNAL, {
      fetchImpl: fetchReturning(zip),
      maxMemberBytes: 4
    }).then(
      () => null,
      (thrown) => thrown
    );
    expect((error as InstallFailure).code).toBe("size-cap");
    expect(await readdir(destination)).toEqual([]);
  });

  it("rejects a truncated tar stream", async () => {
    const tarGz = tarGzipArchive([{ name: "stockfish/stockfish", data: EXE_BYTES }]);
    const truncated = tarGz.slice(0, tarGz.byteLength - 40);
    const destination = await temporaryDirectory();
    const error = await install(
      recordFor(truncated, { executable: "stockfish/stockfish" }),
      destination,
      NO_SIGNAL,
      { fetchImpl: fetchReturning(truncated) }
    ).then(
      () => null,
      (thrown) => thrown
    );
    expect(error).toBeInstanceOf(InstallFailure);
    expect(await readdir(destination)).toEqual([]);
  });

  it("rejects gzip payloads that are not tar archives", async () => {
    const gzip = new Uint8Array(gzipSync(Buffer.from("definitely not a tar archive")));
    const destination = await temporaryDirectory();
    const error = await install(recordFor(gzip), destination, NO_SIGNAL, {
      fetchImpl: fetchReturning(gzip)
    }).then(
      () => null,
      (thrown) => thrown
    );
    expect((error as InstallFailure).code).toBe("unsupported-archive");
    expect(await readdir(destination)).toEqual([]);
  });
});
