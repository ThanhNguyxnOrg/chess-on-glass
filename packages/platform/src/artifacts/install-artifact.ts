import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { Readable, type Writable } from "node:stream";
import { basename, join } from "node:path";
import { createGunzip, createInflateRaw } from "node:zlib";
import { assertSafeMemberName, type VerifiedArtifact } from "./manifest.js";

export type InstallFailureCode =
  | "aborted"
  | "invalid-record"
  | "http"
  | "size-cap"
  | "digest"
  | "unsupported-archive"
  | "unsafe-member"
  | "corrupt-member"
  | "member-missing"
  | "cleanup"
  | "io";

/** An installer failure callers can classify without parsing text. */
export class InstallFailure extends Error {
  readonly code: InstallFailureCode;

  constructor(code: InstallFailureCode, message: string) {
    super(message);
    this.name = "InstallFailure";
    this.code = code;
  }
}

export type InstallOptions = Readonly<{
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Hard ceiling for the downloaded archive in bytes. */
  maxBytes?: number;
  /** Hard ceiling for one extracted member in bytes (decompression guard). */
  maxMemberBytes?: number;
  /** Test seam; defaults to force-removing a path with fs/promises.rm. */
  removeFileImpl?: (path: string) => Promise<void>;
  /** Test seam used to verify archive descriptors are closed on every exit. */
  createReadStreamImpl?: typeof createReadStream;
}>;

type ExtractionOptions = Readonly<{
  maxMemberBytes: number;
  removeFile: (path: string) => Promise<void>;
  createReadStreamImpl: typeof createReadStream;
}>;

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_MEMBER_BYTES = 1024 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] as const;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

/**
 * Download a reviewed, immutable artifact and install exactly one executable
 * member from its archive. The archive SHA-256 is verified while streaming,
 * so a mismatched or oversized download fails before any executable exists
 * at the destination. Only the allowlisted `record.executable` member is
 * extracted; every archive member is validated first, and symlinks, devices,
 * hard links, traversal names, encryption, data descriptors and zip64
 * markers all fail closed. The executable is written to a sibling temporary
 * file and atomically renamed onto its final path (same directory, hence
 * same volume), so a crash never leaves a half-written tool behind.
 */
export async function installVerifiedArtifact(
  record: VerifiedArtifact,
  destinationDirectory: string,
  signal: AbortSignal,
  options: InstallOptions = {}
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxMemberBytes = options.maxMemberBytes ?? DEFAULT_MAX_MEMBER_BYTES;
  const removeFile =
    options.removeFileImpl ??
    (async (path: string): Promise<void> => {
      await rm(path, { force: true });
    });

  validateRecord(record);
  throwIfAborted(signal);
  await mkdir(destinationDirectory, { recursive: true });

  const downloadTemp = join(destinationDirectory, `.cog-download-${randomUUID()}.tmp`);
  try {
    await download(record, downloadTemp, signal, {
      fetchImpl: options.fetchImpl ?? fetch,
      maxBytes
    });
    throwIfAborted(signal);
    return await extractMember(record, downloadTemp, destinationDirectory, signal, {
      maxMemberBytes,
      removeFile,
      createReadStreamImpl: options.createReadStreamImpl ?? createReadStream
    });
  } finally {
    await removeTemporaryFile(downloadTemp, removeFile);
  }
}

function validateRecord(record: VerifiedArtifact): void {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(record.url);
  } catch {
    throw new InstallFailure(
      "invalid-record",
      `artifact url is not a valid URL: ${JSON.stringify(record.url)}`
    );
  }
  if (parsedUrl.protocol !== "https:") {
    throw new InstallFailure(
      "invalid-record",
      `artifact url must be https, got ${JSON.stringify(record.url)}`
    );
  }
  if (!SHA256_HEX.test(record.sha256)) {
    throw new InstallFailure(
      "invalid-record",
      "artifact sha256 must be a 64-character hexadecimal digest before it can be downloaded"
    );
  }
  if (record.version.trim() === "" || record.license.trim() === "" || record.sourceUrl.trim() === "") {
    throw new InstallFailure("invalid-record", "artifact version, license and sourceUrl must be recorded");
  }
  try {
    assertSafeMemberName(record.executable, "executable");
  } catch (error) {
    throw new InstallFailure("unsafe-member", (error as Error).message);
  }
}

/* ------------------------------------------------------------------ */
/* Download: stream to a sibling temp file, hashing and capping.       */
/* ------------------------------------------------------------------ */

async function download(
  record: VerifiedArtifact,
  tempPath: string,
  signal: AbortSignal,
  dependencies: { fetchImpl: typeof fetch; maxBytes: number }
): Promise<void> {
  let response: Response;
  try {
    response = await dependencies.fetchImpl(record.url, { signal, redirect: "follow" });
  } catch (error) {
    if (signal.aborted) {
      throw abortFailure();
    }
    throw new InstallFailure("http", `download failed for ${record.url}: ${describe(error)}`);
  }
  if (!response.ok) {
    throw new InstallFailure("http", `download failed: HTTP ${response.status} for ${record.url}`);
  }
  if (response.body === null) {
    throw new InstallFailure("http", `download returned an empty body for ${record.url}`);
  }

  const hash = createHash("sha256");
  const write = createWriteStream(tempPath, { flags: "wx" });
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const chunk = await nextChunk(reader, signal);
      if (chunk.done) {
        break;
      }
      received += chunk.value.byteLength;
      if (received > dependencies.maxBytes) {
        throw new InstallFailure(
          "size-cap",
          `download exceeded the ${dependencies.maxBytes} byte cap for ${record.url}`
        );
      }
      hash.update(chunk.value);
      await writeChunk(write, chunk.value, signal);
    }
    await closeWrite(write, signal);
  } catch (error) {
    // The caller removes the temporary file only after the real close event;
    // destroyed/writable flags do not prove that the descriptor is closed.
    await destroyAndClose(write);
    throw error;
  }

  const actual = hash.digest("hex");
  if (actual !== record.sha256.toLowerCase()) {
    throw new InstallFailure(
      "digest",
      `digest mismatch for ${record.url}: expected ${record.sha256.toLowerCase()}, got ${actual}`
    );
  }
}

type ChunkResult = { done: true } | { done: false; value: Uint8Array };

/** Read one web-stream chunk, resolving early (with cancellation) on abort. */
function nextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ChunkResult> {
  return new Promise<ChunkResult>((resolve, reject) => {
    if (signal.aborted) {
      void reader.cancel().catch(() => undefined);
      reject(abortFailure());
      return;
    }
    const onAbort = (): void => {
      cleanup();
      void reader.cancel().catch(() => undefined);
      reject(abortFailure());
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        cleanup();
        if (result.done) {
          resolve({ done: true });
        } else {
          resolve({ done: false, value: result.value });
        }
      },
      (error: unknown) => {
        cleanup();
        reject(new InstallFailure("http", `download stream failed: ${describe(error)}`));
      }
    );
  });
}

function writeChunk(stream: Writable, chunk: Uint8Array, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      stream.destroy();
      reject(abortFailure());
      return;
    }
    const onAbort = (): void => {
      cleanup();
      stream.destroy();
      reject(abortFailure());
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      stream.off("error", onError);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    stream.once("error", onError);
    stream.write(chunk, (error) => {
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function closeWrite(stream: Writable, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onClose = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      stream.destroy();
      reject(abortFailure());
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      stream.off("close", onClose);
      stream.off("error", onError);
    };
    if (stream.closed) {
      resolve();
      return;
    }
    if (signal.aborted) {
      stream.destroy();
      reject(abortFailure());
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    stream.once("close", onClose);
    stream.once("error", onError);
    stream.end();
  });
}

/** Destroy a stream and wait for its actual close event before file removal. */
function destroyAndClose(stream: Readable | Writable): Promise<void> {
  if (stream.closed) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const onClose = (): void => resolve();
    stream.once("close", onClose);
    if (stream.closed) {
      stream.off("close", onClose);
      resolve();
      return;
    }
    stream.destroy();
  });
}

async function removeTemporaryFile(
  path: string,
  removeFile: (path: string) => Promise<void>,
  stream?: Readable | Writable
): Promise<void> {
  try {
    if (stream !== undefined) {
      await destroyAndClose(stream);
    }
    await removeFile(path);
  } catch (error) {
    throw new InstallFailure(
      "cleanup",
      `failed to close and remove temporary file ${path}: ${describe(error)}`
    );
  }
}

/* ------------------------------------------------------------------ */
/* Extraction: sniff the format, validate every member, extract one.   */
/* ------------------------------------------------------------------ */

async function extractMember(
  record: VerifiedArtifact,
  archivePath: string,
  destinationDirectory: string,
  signal: AbortSignal,
  limits: ExtractionOptions
): Promise<string> {
  try {
    const head = new Uint8Array(6);
    const handle = await open(archivePath, "r");
    try {
      const headRead = await handle.read(head, 0, head.byteLength, 0);
      if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
        return await extractZipMember(record, handle, destinationDirectory, signal, limits);
      }
      if (headRead.bytesRead >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
        return await extractTarMember(record, archivePath, destinationDirectory, signal, limits);
      }
      if (startsWith(head, XZ_MAGIC)) {
        throw new InstallFailure(
          "unsupported-archive",
          "xz archives are not supported; pin a .zip or .tar.gz artifact instead"
        );
      }
      if (startsWith(head, ZSTD_MAGIC)) {
        throw new InstallFailure(
          "unsupported-archive",
          "zstd archives are not supported; pin a .zip or .tar.gz artifact instead"
        );
      }
      throw new InstallFailure("unsupported-archive", "unknown archive format; supported: zip, tar.gz");
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof InstallFailure) {
      throw error;
    }
    throw new InstallFailure("io", `archive processing failed: ${describe(error)}`);
  }
}

function startsWith(buffer: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => buffer[index] === byte);
}

/* ---------------------------- zip ---------------------------------- */

type ZipEntry = Readonly<{
  name: string;
  method: number;
  crc: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
}>;

async function extractZipMember(
  record: VerifiedArtifact,
  handle: FileHandle,
  destinationDirectory: string,
  signal: AbortSignal,
  limits: ExtractionOptions
): Promise<string> {
  const entries = await parseZipDirectory(handle);
  const target = pickZipMember(entries, record.executable);
  if (target.uncompSize > limits.maxMemberBytes) {
    throw new InstallFailure("size-cap", `zip member exceeded the ${limits.maxMemberBytes} byte cap`);
  }
  throwIfAborted(signal);

  const stat = await handle.stat();
  const localHeader = Buffer.alloc(30);
  await readSliceInto(handle, localHeader, target.localOffset, "zip local header");
  if (localHeader.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
    throw new InstallFailure("corrupt-member", "zip local header signature mismatch");
  }
  const localNameLength = localHeader.readUInt16LE(26);
  const extraLength = localHeader.readUInt16LE(28);
  const localName = Buffer.alloc(localNameLength);
  await readSliceInto(handle, localName, target.localOffset + 30, "zip local name");
  if (localName.toString("utf8") !== target.name) {
    throw new InstallFailure("corrupt-member", "zip local and central directory names disagree");
  }
  const dataStart = target.localOffset + 30 + localNameLength + extraLength;
  if (dataStart + target.compSize > stat.size) {
    throw new InstallFailure("corrupt-member", "zip member data extends beyond the archive");
  }

  const compressed = Buffer.alloc(target.compSize);
  await readSliceInto(handle, compressed, dataStart, "zip member data");

  let payload: Buffer;
  if (target.method === 8) {
    try {
      payload = await inflateRawBounded(compressed, limits.maxMemberBytes, signal);
    } catch (error) {
      if (error instanceof InstallFailure) {
        throw error;
      }
      throw new InstallFailure("corrupt-member", `zip member failed to inflate: ${describe(error)}`);
    }
  } else {
    payload = compressed;
  }
  if (payload.byteLength > limits.maxMemberBytes) {
    throw new InstallFailure("size-cap", `zip member exceeded the ${limits.maxMemberBytes} byte cap`);
  }
  if (payload.byteLength !== target.uncompSize) {
    throw new InstallFailure(
      "corrupt-member",
      `zip member size mismatch: declared ${target.uncompSize}, got ${payload.byteLength}`
    );
  }
  if (crc32(payload) !== target.crc) {
    throw new InstallFailure("corrupt-member", "zip member CRC-32 mismatch");
  }
  throwIfAborted(signal);

  const finalPath = join(destinationDirectory, basename(record.executable));
  const memberTemp = join(destinationDirectory, `.cog-member-${randomUUID()}.tmp`);
  try {
    await writeFile(memberTemp, payload, { mode: 0o755, flag: "wx" });
    await rename(memberTemp, finalPath);
  } catch (error) {
    await removeTemporaryFile(memberTemp, limits.removeFile);
    throw new InstallFailure("io", `failed to install ${finalPath}: ${describe(error)}`);
  }
  if (process.platform !== "win32") {
    await chmod(finalPath, 0o755).catch(() => undefined);
  }
  return finalPath;
}

/**
 * Inflate through zlib's streaming API and destroy the inflater as soon as
 * output crosses the hard cap. Only bounded chunks are retained; a small
 * deflate bomb can never materialize its full declared payload in memory.
 */
async function inflateRawBounded(
  compressed: Buffer,
  maxMemberBytes: number,
  signal: AbortSignal
): Promise<Buffer> {
  throwIfAborted(signal);
  const inflater = createInflateRaw({
    chunkSize: Math.max(64, Math.min(16 * 1024, maxMemberBytes + 1))
  });
  const input = Readable.from([compressed]);
  const chunks: Buffer[] = [];
  let total = 0;
  const onAbort = (): void => {
    inflater.destroy(abortFailure());
  };
  signal.addEventListener("abort", onAbort, { once: true });
  input.pipe(inflater);
  try {
    for await (const value of inflater) {
      const chunk = value as Buffer;
      total += chunk.byteLength;
      if (total > maxMemberBytes) {
        inflater.destroy();
        throw new InstallFailure(
          "size-cap",
          `zip member exceeded the ${maxMemberBytes} byte cap`
        );
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    signal.removeEventListener("abort", onAbort);
    input.destroy();
    inflater.destroy();
  }
}

/**
 * Load and validate every central-directory entry. All member names are
 * validated (not just the allowlisted one) so a hostile archive is rejected
 * wholesale rather than extracted selectively.
 */
async function parseZipDirectory(handle: FileHandle): Promise<readonly ZipEntry[]> {
  const { buffer, entryCount } = await loadZipDirectory(handle);
  const entries: ZipEntry[] = [];
  let offset = 0;
  let recordCount = 0;
  while (offset < buffer.byteLength) {
    if (buffer.byteLength - offset < 46) {
      throw new InstallFailure("corrupt-member", "zip central directory header is truncated");
    }
    if (buffer.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) {
      throw new InstallFailure("corrupt-member", "zip central directory signature mismatch");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compSize = buffer.readUInt32LE(offset + 20);
    const uncompSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttrs = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (recordLength > buffer.byteLength - offset) {
      throw new InstallFailure("corrupt-member", "zip central directory record is truncated");
    }
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += recordLength;
    recordCount += 1;

    if ((flags & 0x0001) !== 0) {
      throw new InstallFailure("unsupported-archive", `zip member ${JSON.stringify(name)} is encrypted`);
    }
    if ((flags & 0x0008) !== 0) {
      throw new InstallFailure(
        "unsupported-archive",
        `zip member ${JSON.stringify(name)} uses data descriptors, which are not supported`
      );
    }
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new InstallFailure(
        "unsupported-archive",
        `zip member ${JSON.stringify(name)} uses zip64 markers, which are not supported`
      );
    }
    if (method !== 0 && method !== 8) {
      throw new InstallFailure(
        "unsupported-archive",
        `zip member ${JSON.stringify(name)} uses unsupported compression method ${method}`
      );
    }
    if (name.endsWith("/")) {
      // Directory marker: validated (minus the slash) but never extracted.
      try {
        assertSafeMemberName(name.slice(0, -1), "archive directory");
      } catch (error) {
        throw new InstallFailure("unsafe-member", (error as Error).message);
      }
      continue;
    }
    try {
      assertSafeMemberName(name, "archive");
    } catch (error) {
      throw new InstallFailure("unsafe-member", (error as Error).message);
    }
    if (((externalAttrs >>> 16) & 0o170000) === 0o120000) {
      throw new InstallFailure(
        "unsafe-member",
        `zip member ${JSON.stringify(name)} is a symlink; symlinks are never extracted`
      );
    }
    entries.push({ name, method, crc, compSize, uncompSize, localOffset });
  }
  if (offset !== buffer.byteLength || recordCount !== entryCount) {
    throw new InstallFailure(
      "corrupt-member",
      `zip central directory entry count mismatch: declared ${entryCount}, parsed ${recordCount}`
    );
  }
  return entries;
}

/**
 * Locate the end-of-central-directory record and load the whole central
 * directory into memory. The downloaded archive is already size-capped, so
 * this buffer is bounded; the EOCD scan walks backwards to tolerate a
 * trailing archive comment.
 */
async function loadZipDirectory(
  handle: FileHandle
): Promise<{ buffer: Buffer; entryCount: number }> {
  const stat = await handle.stat();
  const tailLength = Math.min(stat.size, 66_557); // maximum EOCD footprint incl. comment
  const tail = Buffer.alloc(tailLength);
  await readSliceInto(handle, tail, stat.size - tailLength, "zip end-of-central-directory");

  let eocd = -1;
  for (let index = tail.byteLength - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== EOCD_SIGNATURE) {
      continue;
    }
    const commentLength = tail.readUInt16LE(index + 20);
    if (index + 22 + commentLength === tail.byteLength) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) {
    throw new InstallFailure(
      "corrupt-member",
      "zip end-of-central-directory record not found or has an inconsistent comment length"
    );
  }
  const diskNumber = tail.readUInt16LE(eocd + 4);
  const directoryDisk = tail.readUInt16LE(eocd + 6);
  if (diskNumber !== 0 || directoryDisk !== 0) {
    throw new InstallFailure("unsupported-archive", "multi-disk zip archives are not supported");
  }
  const entriesOnDisk = tail.readUInt16LE(eocd + 8);
  const entryCount = tail.readUInt16LE(eocd + 10);
  if (entriesOnDisk !== entryCount) {
    throw new InstallFailure("corrupt-member", "zip end-record entry counts disagree");
  }
  const directorySize = tail.readUInt32LE(eocd + 12);
  const directoryOffset = tail.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new InstallFailure("unsupported-archive", "zip64 end records are not supported");
  }
  const eocdPosition = stat.size - tailLength + eocd;
  if (directoryOffset + directorySize !== eocdPosition) {
    throw new InstallFailure(
      "corrupt-member",
      "zip central directory does not end exactly at the end record"
    );
  }
  const directory = Buffer.alloc(directorySize);
  await readSliceInto(handle, directory, directoryOffset, "zip central directory");
  return { buffer: directory, entryCount };
}

function pickZipMember(entries: readonly ZipEntry[], executable: string): ZipEntry {
  const matches = entries.filter((entry) => entry.name === executable);
  if (matches.length === 0) {
    throw new InstallFailure(
      "member-missing",
      `allowlisted member ${JSON.stringify(executable)} is not present in the archive`
    );
  }
  if (matches.length > 1) {
    throw new InstallFailure(
      "corrupt-member",
      `archive contains duplicate member ${JSON.stringify(executable)}`
    );
  }
  return matches[0]!;
}

/* ---------------------------- tar ---------------------------------- */

type TarHeader = Readonly<{
  name: string;
  size: number;
  type: string;
}>;

async function extractTarMember(
  record: VerifiedArtifact,
  archivePath: string,
  destinationDirectory: string,
  signal: AbortSignal,
  limits: ExtractionOptions
): Promise<string> {
  const decoded = decodeTarStream(archivePath, limits.createReadStreamImpl);
  const reader = new BlockReader(decoded.output, signal);
  const finalPath = join(destinationDirectory, basename(record.executable));
  const memberTemp = join(destinationDirectory, `.cog-member-${randomUUID()}.tmp`);
  let out: Writable | undefined;
  let found = false;
  let firstHeader = true;

  try {
    out = createWriteStream(memberTemp, { flags: "wx", mode: 0o755 });
    try {
      for (;;) {
        const header = await reader.readBlock(512);
        if (header === null) {
          break; // Clean EOF terminates the member list.
        }
        if (isZeroBlock(header)) {
          // ustar ends with two full zero blocks; require both.
          const trailer = await reader.readBlock(512);
          if (trailer === null || trailer.byteLength < 512 || !isZeroBlock(trailer)) {
            throw new InstallFailure("corrupt-member", "tar archive is truncated before its end marker");
          }
          break;
        }
        const entry = parseTarHeader(header, firstHeader);
        firstHeader = false;
        if (entry.size > limits.maxMemberBytes) {
          throw new InstallFailure(
            "size-cap",
            `tar member ${JSON.stringify(entry.name)} exceeded the ${limits.maxMemberBytes} byte cap`
          );
        }
        // Number arithmetic remains exact for the 11-octal-digit ustar size
        // field; unlike bitwise operators it never truncates to 32 bits.
        const aligned = entry.size + ((512 - (entry.size % 512)) % 512);
        if (entry.name === record.executable) {
          if (found) {
            throw new InstallFailure(
              "corrupt-member",
              `archive contains duplicate member ${JSON.stringify(record.executable)}`
            );
          }
          await streamTarMember(reader, out, entry.size, limits.maxMemberBytes);
          found = true;
        } else {
          await reader.discard(aligned);
        }
        throwIfAborted(signal);
      }
      if (!found) {
        throw new InstallFailure(
          "member-missing",
          `allowlisted member ${JSON.stringify(record.executable)} is not present in the archive`
        );
      }
      await closeWrite(out, signal);
    } catch (error) {
      await removeTemporaryFile(memberTemp, limits.removeFile, out);
      if (error instanceof InstallFailure) {
        throw error;
      }
      // zlib and filesystem failures surface as raw errors; classify them.
      throw new InstallFailure("corrupt-member", `tar stream failed: ${describe(error)}`);
    }

    try {
      await rename(memberTemp, finalPath);
    } catch (error) {
      await removeTemporaryFile(memberTemp, limits.removeFile);
      throw new InstallFailure("io", `failed to install ${finalPath}: ${describe(error)}`);
    }
    if (process.platform !== "win32") {
      await chmod(finalPath, 0o755).catch(() => undefined);
    }
    return finalPath;
  } finally {
    decoded.output.destroy();
    await destroyAndClose(decoded.input);
  }
}

/**
 * Decompress the gzip stream into Node readables. The input uses autoClose:
 * false deliberately: the caller explicitly destroys and awaits it on every
 * success, failure and abort path so no archive descriptor can leak.
 */
function decodeTarStream(
  archivePath: string,
  createStream: typeof createReadStream
): { input: Readable; output: Readable } {
  const fileStream = createStream(archivePath, { autoClose: false });
  const gunzip = createGunzip();
  fileStream.on("error", (error: Error) => gunzip.destroy(error));
  fileStream.pipe(gunzip);
  return { input: fileStream, output: gunzip };
}

function parseTarHeader(header: Buffer, first: boolean): TarHeader {
  const declared = parseTarOctal(header.toString("ascii", 148, 156));
  let sum = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  if (declared === null || declared !== sum) {
    if (first) {
      throw new InstallFailure("unsupported-archive", "unknown archive format: not a tar archive");
    }
    throw new InstallFailure("corrupt-member", "tar header checksum mismatch");
  }
  if (header.toString("ascii", 257, 262) !== "ustar") {
    if (first) {
      throw new InstallFailure("unsupported-archive", "unknown archive format: not a ustar archive");
    }
    throw new InstallFailure("corrupt-member", "tar member uses a non-ustar header");
  }

  const type = header.toString("ascii", 156, 157);
  const rawName = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
  const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");
  const name = prefix === "" ? rawName : `${prefix}/${rawName}`;

  if (type === "x" || type === "g" || type === "L" || type === "K") {
    throw new InstallFailure(
      "unsupported-archive",
      `tar extension headers (type ${JSON.stringify(type)}) are not supported; pin a plain ustar archive`
    );
  }
  if (type === "1" || type === "2" || type === "3" || type === "4" || type === "6") {
    throw new InstallFailure(
      "unsafe-member",
      `tar member ${JSON.stringify(name)} is a link or device (type ${JSON.stringify(type)}); only regular files are extracted`
    );
  }
  if (type !== "0" && type !== "\0" && type !== "5") {
    throw new InstallFailure("unsafe-member", `tar member type ${JSON.stringify(type)} is not supported`);
  }

  try {
    assertSafeMemberName(type === "5" && name.endsWith("/") ? name.slice(0, -1) : name, "archive");
  } catch (error) {
    throw new InstallFailure("unsafe-member", (error as Error).message);
  }

  return { name, size: parseTarSize(header), type };
}

function parseTarSize(header: Buffer): number {
  if ((header[124]! & 0x80) !== 0) {
    throw new InstallFailure(
      "unsupported-archive",
      "tar base-256 sizes are not supported; pin an archive with octal sizes"
    );
  }
  const size = parseTarOctal(header.toString("ascii", 124, 136));
  if (size === null) {
    throw new InstallFailure("corrupt-member", "tar header has a malformed size field");
  }
  return size;
}

function parseTarOctal(field: string): number | null {
  const trimmed = field.replace(/[\0 ]+$/, "").replace(/^[ ]+/, "");
  if (trimmed === "" || !/^[0-7]+$/.test(trimmed)) {
    return null;
  }
  return parseInt(trimmed, 8);
}

async function streamTarMember(
  reader: BlockReader,
  out: Writable,
  size: number,
  maxMemberBytes: number
): Promise<void> {
  let written = 0;
  while (written < size) {
    const want = Math.min(size - written, 1 << 20);
    const block = await reader.readBlock(want);
    if (block === null || block.byteLength < want) {
      throw new InstallFailure("corrupt-member", "tar member payload is truncated");
    }
    written += block.byteLength;
    if (written > maxMemberBytes) {
      throw new InstallFailure("size-cap", `tar member exceeded the ${maxMemberBytes} byte cap`);
    }
    await writeChunk(out, block, reader.signal);
  }
  const padding = (512 - (size % 512)) % 512;
  if (padding > 0) {
    await reader.discard(padding);
  }
}

/**
 * Buffering block reader over the decoded tar stream. Chunk boundaries from
 * gunzip are arbitrary, so reads accumulate until the requested size is
 * available; abort destroys the stream immediately.
 */
class BlockReader {
  private buffer: Buffer = Buffer.alloc(0);
  private eof = false;

  readonly signal: AbortSignal;

  private readonly source: Readable;

  constructor(source: Readable, signal: AbortSignal) {
    this.source = source;
    this.signal = signal;
  }

  /** Returns exactly `length` bytes, fewer at EOF, or null at clean EOF. */
  async readBlock(length: number): Promise<Buffer | null> {
    while (this.buffer.byteLength < length) {
      if (this.eof) {
        const partial = this.buffer;
        this.buffer = Buffer.alloc(0);
        return partial.byteLength === 0 ? null : Buffer.from(partial);
      }
      const chunk = await nextReadableChunk(this.source, this.signal);
      if (chunk === null) {
        this.eof = true;
        continue;
      }
      this.buffer =
        this.buffer.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    }
    const out = Buffer.from(this.buffer.subarray(0, length));
    this.buffer = this.buffer.subarray(length);
    return out;
  }

  async discard(length: number): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      const block = await this.readBlock(Math.min(remaining, 1 << 20));
      if (block === null) {
        throw new InstallFailure("corrupt-member", "tar archive ended in the middle of a member");
      }
      remaining -= block.byteLength;
    }
  }
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

/** Read one Node-stream chunk, resolving early on abort. */
function nextReadableChunk(stream: Readable, signal: AbortSignal): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve, reject) => {
    if (stream.readableEnded) {
      resolve(null);
      return;
    }
    if (signal.aborted) {
      stream.destroy();
      reject(abortFailure());
      return;
    }
    const onAbort = (): void => {
      cleanup();
      stream.destroy();
      reject(abortFailure());
    };
    const onData = (chunk: Buffer): void => {
      cleanup();
      stream.pause();
      resolve(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(null);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    stream.once("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.resume();
  });
}

/* ---------------------------- shared -------------------------------- */

async function readSliceInto(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
  what: string
): Promise<void> {
  let read = 0;
  while (read < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, read, buffer.byteLength - read, position + read);
    if (bytesRead === 0) {
      throw new InstallFailure("corrupt-member", `${what} is truncated`);
    }
    read += bytesRead;
  }
}

let CRC32_TABLE: readonly number[] | undefined;

function crc32(data: Buffer): number {
  CRC32_TABLE ??= Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return crc >>> 0;
  });
  let crc = -1;
  for (let index = 0; index < data.byteLength; index += 1) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[index]!) & 0xff]!;
  }
  return (crc ^ -1) >>> 0;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortFailure();
  }
}

function abortFailure(): InstallFailure {
  return new InstallFailure("aborted", "artifact installation was aborted");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
