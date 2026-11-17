import {
  spawnHelperProcess,
  type HelperProcessHandle
} from "../native/process-client.js";

export type SpeechVoice = Readonly<{
  id: string;
  name: string;
  locale: string;
}>;

/** Every helper failure maps to this sanitized error; no raw helper text. */
export class SpeechUnavailableError extends Error {
  readonly code = "speech_unavailable";

  constructor() {
    super("speech is unavailable");
    this.name = "SpeechUnavailableError";
  }
}

export interface SpeechEngine {
  listVoices(signal: AbortSignal): Promise<readonly SpeechVoice[]>;
  speak(input: {
    text: string;
    voiceId: string | null;
    signal: AbortSignal;
  }): Promise<void>;
  close(): Promise<void>;
}

export type SpeechSpawn = (options: {
  executable: string;
  args: readonly string[];
  stderrLimitBytes?: number;
}) => HelperProcessHandle;

export type SystemSpeechEngineOptions = {
  helperPath: string;
  spawn?: SpeechSpawn;
  listTimeoutMs?: number;
  speakTimeoutMs?: number;
};

const DEFAULT_LIST_TIMEOUT_MS = 10_000;
const DEFAULT_SPEAK_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARACTERS = 4 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_VOICES = 64;

function abortError(): Error {
  const error = new Error("speech cancelled");
  error.name = "AbortError";
  return error;
}

function parseVoices(raw: string): readonly SpeechVoice[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SpeechUnavailableError();
  }
  if (typeof value !== "object" || value === null) {
    throw new SpeechUnavailableError();
  }
  const voices = (value as { voices?: unknown }).voices;
  if (!Array.isArray(voices) || voices.length > MAX_VOICES) {
    throw new SpeechUnavailableError();
  }
  return voices.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new SpeechUnavailableError();
    }
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    const name = record["name"];
    const locale = record["locale"];
    if (
      typeof id !== "string" ||
      id === "" ||
      typeof name !== "string" ||
      name === "" ||
      typeof locale !== "string" ||
      locale === ""
    ) {
      throw new SpeechUnavailableError();
    }
    return { id, name, locale };
  });
}

/**
 * Owns short-lived SpeechHelper processes: one per operation, so abort or
 * close kills only the utterance it owns and never a shared shell. Text is
 * capped and sent on stdin; the helper never receives it as an argument.
 */
export class SystemSpeechEngine implements SpeechEngine {
  private readonly helperPath: string;
  private readonly spawnFn: SpeechSpawn;
  private readonly listTimeoutMs: number;
  private readonly speakTimeoutMs: number;
  private readonly active = new Set<HelperProcessHandle>();
  private closed = false;

  constructor(options: SystemSpeechEngineOptions) {
    if (
      typeof options.helperPath !== "string" ||
      options.helperPath.trim() === ""
    ) {
      throw new TypeError("helperPath must be a non-empty string");
    }
    this.helperPath = options.helperPath;
    this.spawnFn =
      options.spawn ?? ((spawnOptions) => spawnHelperProcess(spawnOptions));
    this.listTimeoutMs = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this.speakTimeoutMs = options.speakTimeoutMs ?? DEFAULT_SPEAK_TIMEOUT_MS;
  }

  async listVoices(signal: AbortSignal): Promise<readonly SpeechVoice[]> {
    const raw = await this.run(["list-voices"], null, this.listTimeoutMs, signal);
    return parseVoices(raw);
  }

  async speak(input: {
    text: string;
    voiceId: string | null;
    signal: AbortSignal;
  }): Promise<void> {
    if (typeof input.text !== "string" || input.text.trim() === "") {
      throw new RangeError("speech text must be a non-empty string");
    }
    if (input.text.length > MAX_TEXT_CHARACTERS) {
      throw new RangeError(
        `speech text must be at most ${MAX_TEXT_CHARACTERS} characters`
      );
    }
    const payload = JSON.stringify({
      text: input.text,
      voiceId: input.voiceId
    });
    await this.run(["speak"], payload, this.speakTimeoutMs, input.signal);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const handle of this.active) {
      handle.kill();
    }
    this.active.clear();
  }

  private run(
    args: readonly string[],
    stdin: string | null,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<string> {
    if (this.closed) {
      return Promise.reject(new SpeechUnavailableError());
    }
    if (signal.aborted) {
      return Promise.reject(abortError());
    }

    let handle: HelperProcessHandle;
    try {
      handle = this.spawnFn({
        executable: this.helperPath,
        args,
        stderrLimitBytes: 8 * 1024
      });
    } catch {
      return Promise.reject(new SpeechUnavailableError());
    }
    this.active.add(handle);

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const chunks: Buffer[] = [];
      let bytes = 0;

      const finish = (error: Error | null, value = ""): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        signal.removeEventListener("abort", onAbort);
        this.active.delete(handle);
        if (error !== null) {
          handle.kill();
          reject(error);
        } else {
          resolve(value);
        }
      };

      const onAbort = (): void => finish(abortError());

      handle.stdin.on("error", () => finish(new SpeechUnavailableError()));
      handle.stdout.on("error", () => finish(new SpeechUnavailableError()));
      handle.stdout.on("data", (chunk: Buffer) => {
        if (bytes >= MAX_OUTPUT_BYTES) {
          return;
        }
        const remaining = MAX_OUTPUT_BYTES - bytes;
        const slice =
          chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(slice);
        bytes += slice.byteLength;
      });
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish(new SpeechUnavailableError()), timeoutMs);
      timer.unref?.();

      void handle.closed.then(({ code }) => {
        if (code === 0) {
          finish(null, Buffer.concat(chunks).toString("utf8"));
        } else {
          finish(new SpeechUnavailableError());
        }
      });

      if (stdin !== null) {
        handle.stdin.write(stdin);
      }
      handle.stdin.end();
    });
  }
}
