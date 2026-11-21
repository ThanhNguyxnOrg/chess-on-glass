export type DashboardSnapshot = {
  sessionId: string;
  positionVersion: number;
  status: string;
  position: {
    initialFen: string;
    fen: string;
    history: readonly string[];
    uncertainty: {
      castlingRights: boolean;
      enPassant: boolean;
      promotion: boolean;
    };
  } | null;
  suggestion: {
    moveUci: string | null;
    spokenText: string | null;
    status: string;
    reason: string | null;
  } | null;
  frameAgeMs: number | null;
  error: string | null;
};

export type AppSettingsDto = {
  provider: "openai" | "anthropic" | null;
  visionModel: string | null;
  cloudEnabled: boolean;
  speechEnabled: boolean;
  voiceId: string | null;
  browserFps: number;
  replayFps: number;
  maxCostUsd: number;
};

export type CatalogEntryDto = {
  provider: "openai" | "anthropic";
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
  effectiveAt: string;
};

export type SettingsResponse = {
  settings: AppSettingsDto;
  secrets: Record<"openai" | "anthropic", { configured: boolean; source: "keyring" | "environment" | null }>;
  catalog: readonly CatalogEntryDto[];
  ledger: { reservedUsd: number; actualUsd: number; paused: boolean };
  capabilities: { stockfish: boolean; ffmpeg: boolean; speech: boolean; wgc: boolean };
};

export type CaptureTargetDto = {
  id: string;
  title: string;
  processName: string;
};

/**
 * Extracts the 256-bit launch token from the URL fragment (`#token=...`) and
 * strips the fragment from the browser address bar so it is never leaked via
 * history or screenshots.
 */
export function extractLaunchToken(
  locationLike: Pick<Location, "hash" | "pathname" | "search"> = window.location,
  historyLike: Pick<History, "replaceState"> = window.history
): string | null {
  const hash = locationLike.hash.replace(/^#/, "");
  if (hash === "") {
    return null;
  }
  const params = new URLSearchParams(hash);
  const token = params.get("token");
  if (token === null || token.trim() === "") {
    return null;
  }
  try {
    historyLike.replaceState(null, "", `${locationLike.pathname}${locationLike.search}`);
  } catch {
    // ignore in non-browser test environments
  }
  return token.trim();
}

export class DashboardClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: { baseUrl: string; token: string; fetch?: typeof fetch }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchFn = options.fetch ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      ...extra
    };
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(
        body === undefined ? {} : { "Content-Type": "application/json" }
      ),
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const msg =
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof (parsed as { error?: { message?: unknown } }).error?.message === "string"
          ? (parsed as { error: { message: string } }).error.message
          : `Request failed (${response.status})`;
      throw new Error(msg);
    }
    return parsed as T;
  }

  getSnapshot(): Promise<DashboardSnapshot> {
    return this.requestJson("GET", "/api/snapshot");
  }

  sendCommand(command: { type: string; [key: string]: unknown }): Promise<{ accepted: boolean }> {
    return this.requestJson("POST", "/api/command", command);
  }

  getSettings(): Promise<SettingsResponse> {
    return this.requestJson("GET", "/api/settings");
  }

  updateSettings(patch: Partial<AppSettingsDto>): Promise<SettingsResponse> {
    return this.requestJson("PUT", "/api/settings", patch);
  }

  saveSecret(
    provider: "openai" | "anthropic",
    secret: string
  ): Promise<{ provider: string; status: { configured: boolean; source: string | null } }> {
    return this.requestJson("POST", "/api/secrets", { provider, secret });
  }

  startBrowserSource(): Promise<{ sessionId: string; sourceId: string }> {
    return this.requestJson("POST", "/api/source/browser/start", {});
  }

  stopBrowserSource(): Promise<{ stopped: boolean }> {
    return this.requestJson("POST", "/api/source/browser/stop", {});
  }

  listScreenTargets(): Promise<{ targets: readonly CaptureTargetDto[] }> {
    return this.requestJson("GET", "/api/source/screen/targets");
  }

  startScreenSource(targetId: string): Promise<{ started: boolean }> {
    return this.requestJson("POST", "/api/source/screen/start", { targetId });
  }

  stopScreenSource(): Promise<{ stopped: boolean }> {
    return this.requestJson("POST", "/api/source/screen/stop", {});
  }

  startReplay(path: string, fps?: number, speed?: number): Promise<{ started: boolean }> {
    return this.requestJson("POST", "/api/source/replay/start", {
      path,
      ...(fps === undefined ? {} : { fps }),
      ...(speed === undefined ? {} : { speed })
    });
  }

  stopReplay(): Promise<{ stopped: boolean }> {
    return this.requestJson("POST", "/api/source/replay/stop", {});
  }

  /**
   * Streams `/api/events` over fetch so the Bearer token stays strictly in
   * the Authorization header (never in a query string).
   */
  subscribeEvents(
    onSnapshot: (snapshot: DashboardSnapshot) => void,
    onError: (error: Error) => void
  ): () => void {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await this.fetchFn(`${this.baseUrl}/api/events`, {
          method: "GET",
          headers: this.headers({ Accept: "text/event-stream" }),
          signal: controller.signal
        });
        if (!response.ok || response.body === null) {
          throw new Error(`SSE connection failed (${response.status})`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const eventBlock = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            for (const line of eventBlock.split("\n")) {
              if (line.startsWith("data:")) {
                const payload = line.slice(5).trim();
                if (payload !== "") {
                  try {
                    onSnapshot(JSON.parse(payload) as DashboardSnapshot);
                  } catch {
                    // ignore malformed SSE chunk
                  }
                }
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          onError(error instanceof Error ? error : new Error("SSE stream ended"));
        }
      }
    })();
    return () => controller.abort();
  }
}
