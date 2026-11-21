import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { ChessState } from "@chessonglass/chess";
import type { BoardReader } from "@chessonglass/perception";
import type { PlatformServices } from "@chessonglass/platform";
import { startWindowsApplication } from "../../src/runtime/windows-application.js";

function piecesFromFen(fen: string) {
  const pieces = ChessState.fromConfirmed({ fen, history: [] }).pieces();
  return Array.from({ length: 64 }, (_, square) => {
    const piece = pieces[square] ?? null;
    return {
      square,
      color: piece === null ? ("empty" as const) : piece.color,
      kind: piece === null ? ("unknown" as const) : piece.kind,
      confidence: 0.99
    };
  });
}

async function makeTinyJpeg(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({
    create: { width: 16, height: 16, channels: 3, background: { r, g, b } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

function createMemoryPlatform(dataDir: string): PlatformServices {
  const store = new Map<string, string>();
  return {
    platform: "win32",
    userDataDir: () => dataDir,
    readSecret: async (account) => store.get(account) ?? null,
    writeSecret: async (account, secret) => {
      store.set(account, secret);
    },
    openExternal: async () => undefined
  };
}

describe("startWindowsApplication end-to-end workflow", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop()!;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("connects browser camera frames -> AI vision -> Stockfish -> speech & snapshot", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cog-e2e-"));
    dirs.push(tempDir);
    const staticDir = join(tempDir, "static");
    const dataDir = join(tempDir, "data");
    await writeFile(join(tempDir, "index.html"), "<html></html>").catch(() => undefined);

    const { mkdir } = await import("node:fs/promises");
    await mkdir(staticDir, { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html><html><body>ok</body></html>");

    const fenAfterE4 = ChessState.fromConfirmed({
      fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      history: ["e2e4"]
    }).position().fen;

    const spoken: string[] = [];
    const reader: BoardReader = {
      async read({ context }) {
        return {
          ok: true,
          observation: {
            context,
            boardVisible: true,
            handOverBoard: false,
            squares: piecesFromFen(fenAfterE4),
            provider: "openai",
            model: "gpt-4.1-mini",
            inputTokens: 100,
            outputTokens: 50
          }
        };
      }
    };

    const app = await startWindowsApplication({
      staticDir,
      dataDir,
      platform: createMemoryPlatform(dataDir),
      reader,
      advisor: {
        async best() {
          return { uci: "e7e5", score: { cp: 25 } };
        },
        async close() {
          return undefined;
        }
      },
      speechEngine: {
        async listVoices() {
          return [];
        },
        async speak({ text }) {
          spoken.push(text);
        },
        async close() {
          return undefined;
        }
      },
      stockfishPath: null,
      ffmpegPath: null
    });

    try {
      const baseUrl = app.url.replace(/\/+$/, "");
      const token = new URL(app.launchUrl).hash.replace(/^#token=/, "");
      expect(token.length).toBeGreaterThan(20);
      const authHeaders = {
        Authorization: `Bearer ${token}`,
        Origin: baseUrl
      };

      // 1. Settings & Secret persistence without echoing secrets
      const settingsRes = await fetch(`${baseUrl}/api/settings`, { headers: authHeaders });
      expect(settingsRes.status).toBe(200);
      const settingsBody = (await settingsRes.json()) as {
        settings: { speechEnabled: boolean };
        capabilities: { speech: boolean };
      };
      expect(settingsBody.settings.speechEnabled).toBe(true);
      expect(settingsBody.capabilities.speech).toBe(true);

      const secretRes = await fetch(`${baseUrl}/api/secrets`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "openai", secret: "sk-test-secret-12345" })
      });
      expect(secretRes.status).toBe(200);
      const secretText = await secretRes.text();
      expect(secretText).not.toContain("sk-test-secret-12345");
      expect(secretText).toContain("keyring");

      // 2. Start browser camera source
      const startRes = await fetch(`${baseUrl}/api/source/browser/start`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: "{}"
      });
      expect(startRes.status).toBe(202);
      const allocated = (await startRes.json()) as { sessionId: string; sourceId: string };

      // 3. Send two distinct fresh JPEG frames showing e2e4
      const jpeg1 = await makeTinyJpeg(200, 100, 50);
      const jpeg2 = await makeTinyJpeg(190, 110, 60);

      for (const [idx, jpeg] of [jpeg1, jpeg2].entries()) {
        const snap = app.snapshot();
        const frameRes = await fetch(`${baseUrl}/api/source/browser/frame`, {
          method: "POST",
          headers: {
            ...authHeaders,
            "Content-Type": "image/jpeg",
            "x-frame-session": allocated.sessionId,
            "x-frame-source": allocated.sourceId,
            "x-frame-sequence": String(idx + 1),
            "x-frame-wall-ms": String(Date.now()),
            "x-frame-request-id": `req-${idx + 1}`,
            "x-frame-position-version": String(snap.positionVersion)
          },
          body: new Uint8Array(jpeg)
        });
        expect(frameRes.status).toBe(202);
        // Wait briefly for the first read to finish before pushing the corroborating frame
        await new Promise((r) => setTimeout(r, 40));
      }

      // 4. Wait for coordinator to corroborate e2e4 and suggest e7e5
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && app.snapshot().suggestion?.moveUci !== "e7e5") {
        await new Promise((r) => setTimeout(r, 25));
      }

      const finalSnap = app.snapshot();
      expect(finalSnap.position?.history).toEqual(["e2e4"]);
      expect(finalSnap.suggestion?.moveUci).toBe("e7e5");
      expect(spoken.some((line) => line.includes("e7e5") || line.toLowerCase().includes("e5"))).toBe(true);

      // 5. Verify overlay & export routes are mounted
      const overlayStatus = await fetch(`${baseUrl}/api/overlay/status`, { headers: authHeaders });
      expect(overlayStatus.status).toBe(200);
      const exportStatus = await fetch(`${baseUrl}/api/export/overlay/status`, { headers: authHeaders });
      expect(exportStatus.status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
