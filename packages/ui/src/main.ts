import { BrowserSourceClient } from "./api/browser-source-client.js";
import {
  DashboardClient,
  extractLaunchToken,
  type AppSettingsDto,
  type CaptureTargetDto,
  type CatalogEntryDto,
  type DashboardSnapshot,
  type SettingsResponse
} from "./api/dashboard-client.js";
import { boardSvg, clear, element, text } from "./dom.js";
import { createBrowserWebcamCapture } from "./media/browser-webcam-capture.js";
import { WebcamUploader } from "./media/webcam-uploader.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const root = document.querySelector<HTMLDivElement>("#app");
if (root !== null) {
  mountDashboard(root);
}

function formatMoveHistory(moves: readonly string[]): string {
  if (moves.length === 0) {
    return "No moves yet.";
  }
  const parts: string[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    const moveNumber = Math.floor(i / 2) + 1;
    const white = moves[i] ?? "";
    const black = moves[i + 1];
    parts.push(black !== undefined ? `${moveNumber}. ${white} ${black}` : `${moveNumber}. ${white}`);
  }
  return parts.join("  ");
}

function mountDashboard(root: HTMLElement): void {
  clear(root);

  const token = extractLaunchToken();
  const baseUrl = window.location.origin;

  // --- Header / Status Bar ---
  const logoImg = element("img", {
    src: "./logo.png",
    alt: "ChessOnGlass logo",
    class: "brand-logo"
  });
  const brandTitle = element("span", { class: "brand-title" }, text("ChessOnGlass"));
  const statusDot = element("span", { class: "status-dot ready" });
  const statusLabel = element("span", { class: "status-text" }, text(token ? "Connecting…" : "Missing launch token"));
  const budgetBadge = element("span", { class: "budget-badge" }, text("$0.00"));
  const connectionLabel = element("span", { class: "connection-label" }, text("127.0.0.1"));

  const statusBar = element(
    "header",
    { class: "status-bar" },
    logoImg,
    brandTitle,
    statusDot,
    statusLabel,
    budgetBadge,
    connectionLabel
  );

  // --- Error Banner ---
  const errorBanner = element("div", { class: "error-banner hidden", role: "alert" });

  // --- Left Column: Board, Suggestion, Controls, History ---
  const boardContainer = element("div", { class: "board-container" });
  boardContainer.append(boardSvg(START_FEN));

  const moveEl = element("div", { class: "move" }, text("—"));
  const spokenEl = element("div", { class: "spoken" }, text("Waiting for board activity…"));
  const suggestionCard = element("section", { class: "suggestion-card" }, moveEl, spokenEl);

  const pauseBtn = element("button", { type: "button" }, text("Pause"));
  const undoBtn = element("button", { type: "button" }, text("Undo"));
  const repeatBtn = element("button", { type: "button" }, text("Repeat voice"));
  const newGameBtn = element("button", { type: "button" }, text("New game"));
  const controls = element("div", { class: "controls" }, pauseBtn, undoBtn, repeatBtn, newGameBtn);

  const manualInput = element("input", {
    type: "text",
    placeholder: "Manual move (e.g. e2e4)",
    "aria-label": "Manual UCI move"
  });
  const manualBtn = element("button", { type: "button" }, text("Play move"));
  const manualRow = element("div", { class: "inline-row" }, manualInput, manualBtn);

  const historyEl = element("div", { class: "move-history" }, text("No moves yet."));

  const leftCol = element(
    "div",
    { class: "col-main" },
    boardContainer,
    suggestionCard,
    controls,
    manualRow,
    historyEl
  );

  // --- Right Column: Sources & AI Settings ---
  // 1. Camera / Smart Glasses Source
  const camStartBtn = element("button", { type: "button", class: "btn-primary" }, text("Start Camera / Glasses"));
  const camStopBtn = element("button", { type: "button", disabled: "true" }, text("Stop Camera"));
  const camStatus = element("div", { class: "muted-note" }, text("Idle — use webcam or USB smart glasses camera."));
  const camCard = element(
    "section",
    { class: "panel" },
    element("h2", {}, text("1. Glasses / Webcam Feed")),
    element("div", { class: "inline-row" }, camStartBtn, camStopBtn),
    camStatus
  );

  // 2. Window / Screen Capture (WGC)
  const targetSelect = element("select", { "aria-label": "Capture window" });
  targetSelect.append(element("option", { value: "" }, text("Select a window to capture…")));
  const refreshWinBtn = element("button", { type: "button" }, text("Refresh"));
  const winStartBtn = element("button", { type: "button" }, text("Capture Window"));
  const winStopBtn = element("button", { type: "button" }, text("Stop"));
  const winCard = element(
    "section",
    { class: "panel" },
    element("h2", {}, text("2. Window Capture (Glasses Cast / Chess Site)")),
    element("div", { class: "inline-row" }, targetSelect, refreshWinBtn),
    element("div", { class: "inline-row" }, winStartBtn, winStopBtn)
  );

  // 3. Replay Source
  const replayInput = element("input", {
    type: "text",
    placeholder: "Local video path (e.g. C:\\videos\\game.mp4)",
    "aria-label": "Replay video path"
  });
  const replayStartBtn = element("button", { type: "button" }, text("Start Replay"));
  const replayStopBtn = element("button", { type: "button" }, text("Stop"));
  const replayCard = element(
    "section",
    { class: "panel" },
    element("h2", {}, text("3. Video Replay")),
    element("div", { class: "inline-row" }, replayInput),
    element("div", { class: "inline-row" }, replayStartBtn, replayStopBtn)
  );

  // 4. AI Vision, Voice & Tools Settings
  const providerSelect = element("select", { "aria-label": "Vision provider" });
  providerSelect.append(
    element("option", { value: "" }, text("None (Cloud off)")),
    element("option", { value: "openai" }, text("OpenAI")),
    element("option", { value: "anthropic" }, text("Anthropic"))
  );
  const modelSelect = element("select", { "aria-label": "Vision model" });
  const apiKeyInput = element("input", {
    type: "password",
    placeholder: "API Key (saved to OS Keyring)",
    "aria-label": "Provider API key"
  });
  const saveKeyBtn = element("button", { type: "button" }, text("Save Key"));
  const keyStatusEl = element("div", { class: "muted-note" }, text("Key status: checking…"));

  const cloudCheck = element("input", { type: "checkbox", id: "cloud-enabled" });
  const speechCheck = element("input", { type: "checkbox", id: "speech-enabled" });
  const maxCostInput = element("input", {
    type: "number",
    min: "0.5",
    step: "0.5",
    value: "10",
    "aria-label": "Max budget USD"
  });
  const saveSettingsBtn = element("button", { type: "button", class: "btn-primary" }, text("Save Settings"));
  const capBadges = element("div", { class: "cap-badges" });

  const settingsCard = element(
    "section",
    { class: "panel" },
    element("h2", {}, text("AI Vision, Voice & Engine")),
    element("label", { class: "field-label" }, text("Provider"), providerSelect),
    element("label", { class: "field-label" }, text("Model"), modelSelect),
    element("div", { class: "inline-row" }, apiKeyInput, saveKeyBtn),
    keyStatusEl,
    element(
      "div",
      { class: "checkbox-row" },
      element("label", { for: "cloud-enabled" }, cloudCheck, text(" Enable AI Vision")),
      element("label", { for: "speech-enabled" }, speechCheck, text(" Voice Readout"))
    ),
    element("label", { class: "field-label" }, text("Max Budget (USD)"), maxCostInput),
    saveSettingsBtn,
    capBadges
  );

  const rightCol = element("div", { class: "col-side" }, camCard, winCard, replayCard, settingsCard);
  const layout = element("main", { class: "dashboard-grid" }, leftCol, rightCol);

  root.append(statusBar, errorBanner, layout);

  if (token === null) {
    showError("Launch token missing from URL fragment. Start ChessOnGlass via `node packages/app/dist/cli.js run`.");
    return;
  }

  const client = new DashboardClient({ baseUrl, token });
  const browserSourceClient = new BrowserSourceClient({ baseUrl, token });

  let latestSnapshot: DashboardSnapshot | null = null;
  let latestSettings: SettingsResponse | null = null;
  let activeUploader: WebcamUploader | null = null;
  let activeBrowserSession: { sessionId: string; sourceId: string } | null = null;

  function showError(message: string | null): void {
    if (message === null || message.trim() === "") {
      errorBanner.classList.add("hidden");
      errorBanner.textContent = "";
    } else {
      errorBanner.classList.remove("hidden");
      errorBanner.textContent = message;
    }
  }

  function renderSnapshot(snap: DashboardSnapshot): void {
    const versionChanged =
      latestSnapshot !== null &&
      (latestSnapshot.positionVersion !== snap.positionVersion ||
        latestSnapshot.sessionId !== snap.sessionId);
    latestSnapshot = snap;
    statusDot.className = `status-dot ${snap.status}`;
    statusLabel.textContent = snap.status.replace(/-/g, " ");
    pauseBtn.textContent = snap.status === "paused" ? "Resume" : "Pause";

    const fen = snap.position?.fen ?? START_FEN;
    const moveUci = snap.suggestion?.moveUci ?? null;
    clear(boardContainer);
    boardContainer.append(boardSvg(fen, moveUci));

    moveEl.textContent = moveUci ? `Play: ${moveUci}` : "—";
    spokenEl.textContent =
      snap.suggestion?.spokenText ??
      snap.suggestion?.reason ??
      (snap.frameAgeMs !== null ? `Watching board (${Math.round(snap.frameAgeMs)} ms ago)` : "Ready for camera or window feed.");

    historyEl.textContent = formatMoveHistory(snap.position?.history ?? []);
    showError(snap.error);

    if (versionChanged) {
      void client
        .getSettings()
        .then((res) => {
          budgetBadge.textContent = `$${res.ledger.actualUsd.toFixed(3)} / $${res.settings.maxCostUsd.toFixed(2)}`;
        })
        .catch(() => undefined);
    }
  }

  function populateModels(catalog: readonly CatalogEntryDto[], provider: string, selectedModel: string | null): void {
    clear(modelSelect);
    const matching = catalog.filter((entry) => entry.provider === provider);
    if (matching.length === 0) {
      modelSelect.append(element("option", { value: "" }, text("Select a provider first")));
      return;
    }
    for (const entry of matching) {
      const opt = element(
        "option",
        { value: entry.model },
        text(`${entry.model} ($${entry.inputPerMillion}/M in)`)
      );
      if (entry.model === selectedModel) {
        opt.selected = true;
      }
      modelSelect.append(opt);
    }
  }

  function renderSettings(res: SettingsResponse): void {
    latestSettings = res;
    providerSelect.value = res.settings.provider ?? "";
    populateModels(res.catalog, providerSelect.value, res.settings.visionModel);
    cloudCheck.checked = res.settings.cloudEnabled;
    speechCheck.checked = res.settings.speechEnabled;
    maxCostInput.value = String(res.settings.maxCostUsd);

    const openAiBadge = res.secrets.openai.configured ? `OpenAI: ${res.secrets.openai.source}` : "OpenAI: missing";
    const anthropicBadge = res.secrets.anthropic.configured ? `Anthropic: ${res.secrets.anthropic.source}` : "Anthropic: missing";
    keyStatusEl.textContent = `${openAiBadge} · ${anthropicBadge}`;

    budgetBadge.textContent = `$${res.ledger.actualUsd.toFixed(3)} / $${res.settings.maxCostUsd.toFixed(2)}`;

    clear(capBadges);
    const items: Array<[string, boolean]> = [
      ["Stockfish", res.capabilities.stockfish],
      ["FFmpeg", res.capabilities.ffmpeg],
      ["Voice TTS", res.capabilities.speech],
      ["Window Capture", res.capabilities.wgc]
    ];
    for (const [label, ok] of items) {
      capBadges.append(
        element("span", { class: `cap-pill ${ok ? "ok" : "missing"}` }, text(`${ok ? "✓" : "✗"} ${label}`))
      );
    }
  }

  providerSelect.addEventListener("change", () => {
    if (latestSettings !== null) {
      populateModels(latestSettings.catalog, providerSelect.value, null);
    }
  });

  // --- Game Controls ---
  pauseBtn.addEventListener("click", () => {
    const cmd = latestSnapshot?.status === "paused" ? "resume" : "pause";
    void client.sendCommand({ type: cmd }).catch((err: unknown) => showError(String(err)));
  });

  undoBtn.addEventListener("click", () => {
    void client.sendCommand({ type: "undo" }).catch((err: unknown) => showError(String(err)));
  });

  repeatBtn.addEventListener("click", () => {
    void client.sendCommand({ type: "repeat" }).catch((err: unknown) => showError(String(err)));
  });

  newGameBtn.addEventListener("click", () => {
    void client.sendCommand({ type: "new-game" }).catch((err: unknown) => showError(String(err)));
  });

  manualBtn.addEventListener("click", () => {
    const uci = manualInput.value.trim().toLowerCase();
    if (uci === "") return;
    void client
      .sendCommand({ type: "manual-move", uci })
      .then(() => {
        manualInput.value = "";
      })
      .catch((err: unknown) => showError(err instanceof Error ? err.message : String(err)));
  });

  // --- Browser Camera / Glasses Feed ---
  camStartBtn.addEventListener("click", () => {
    void (async () => {
      try {
        showError(null);
        camStartBtn.disabled = true;
        camStatus.textContent = "Requesting camera access…";
        const allocated = await client.startBrowserSource();
        activeBrowserSession = allocated;

        const capture = createBrowserWebcamCapture();
        const fps = latestSettings?.settings.browserFps ?? 2;
        const uploader = new WebcamUploader({
          capture,
          fps,
          send: async (frameInput) => {
            const target = {
              sessionId: latestSnapshot?.sessionId ?? allocated.sessionId,
              sourceId: allocated.sourceId,
              positionVersion: latestSnapshot?.positionVersion ?? 0,
              referenceSequence: null
            };
            const sender = browserSourceClient.createSender(target);
            await sender(frameInput);
          }
        });
        await uploader.start(null);
        activeUploader = uploader;
        camStopBtn.disabled = false;
        camStatus.textContent = `Streaming live (${fps} fps) to AI vision…`;
      } catch (err) {
        camStartBtn.disabled = false;
        camStopBtn.disabled = true;
        camStatus.textContent = "Camera failed to start.";
        showError(err instanceof Error ? err.message : String(err));
        if (activeBrowserSession !== null) {
          activeBrowserSession = null;
          await client.stopBrowserSource().catch(() => undefined);
        }
      }
    })();
  });

  camStopBtn.addEventListener("click", () => {
    void (async () => {
      camStopBtn.disabled = true;
      if (activeUploader !== null) {
        await activeUploader.stop();
        activeUploader = null;
      }
      activeBrowserSession = null;
      await client.stopBrowserSource().catch(() => undefined);
      camStartBtn.disabled = false;
      camStatus.textContent = "Camera stopped.";
    })();
  });

  // --- Window Capture (WGC) ---
  async function refreshWindows(): Promise<void> {
    try {
      const { targets } = await client.listScreenTargets();
      clear(targetSelect);
      targetSelect.append(
        element("option", { value: "" }, text(targets.length > 0 ? "Select a window…" : "No capture windows found"))
      );
      for (const t of targets as readonly CaptureTargetDto[]) {
        targetSelect.append(
          element("option", { value: t.id }, text(`${t.title} (${t.processName})`))
        );
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  }

  refreshWinBtn.addEventListener("click", () => {
    void refreshWindows();
  });

  winStartBtn.addEventListener("click", () => {
    const targetId = targetSelect.value;
    if (targetId === "") {
      showError("Pick a window first.");
      return;
    }
    void client
      .startScreenSource(targetId)
      .then(() => showError(null))
      .catch((err: unknown) => showError(err instanceof Error ? err.message : String(err)));
  });

  winStopBtn.addEventListener("click", () => {
    void client.stopScreenSource().catch((err: unknown) => showError(String(err)));
  });

  // --- Video Replay ---
  replayStartBtn.addEventListener("click", () => {
    const path = replayInput.value.trim();
    if (path === "") {
      showError("Enter a local video path to replay.");
      return;
    }
    void client
      .startReplay(path)
      .then(() => showError(null))
      .catch((err: unknown) => showError(err instanceof Error ? err.message : String(err)));
  });

  replayStopBtn.addEventListener("click", () => {
    void client.stopReplay().catch((err: unknown) => showError(String(err)));
  });

  // --- Settings & Secrets ---
  saveKeyBtn.addEventListener("click", () => {
    const provider = providerSelect.value;
    const secret = apiKeyInput.value.trim();
    if (provider !== "openai" && provider !== "anthropic") {
      showError("Select OpenAI or Anthropic before saving an API key.");
      return;
    }
    if (secret === "") {
      showError("Enter an API key to save.");
      return;
    }
    void client
      .saveSecret(provider, secret)
      .then(async () => {
        apiKeyInput.value = "";
        showError(null);
        renderSettings(await client.getSettings());
      })
      .catch((err: unknown) => showError(err instanceof Error ? err.message : String(err)));
  });

  saveSettingsBtn.addEventListener("click", () => {
    const provider =
      providerSelect.value === "openai" || providerSelect.value === "anthropic"
        ? providerSelect.value
        : null;
    const visionModel = modelSelect.value !== "" ? modelSelect.value : null;
    const maxCostUsd = Number(maxCostInput.value);
    const patch: Partial<AppSettingsDto> = {
      provider,
      visionModel,
      cloudEnabled: cloudCheck.checked,
      speechEnabled: speechCheck.checked,
      ...(Number.isFinite(maxCostUsd) && maxCostUsd > 0 ? { maxCostUsd } : {})
    };
    void client
      .updateSettings(patch)
      .then((updated) => {
        showError(null);
        renderSettings(updated);
      })
      .catch((err: unknown) => showError(err instanceof Error ? err.message : String(err)));
  });

  // --- Initial Boot & Live SSE ---
  void (async () => {
    try {
      const [snap, settingsRes] = await Promise.all([
        client.getSnapshot(),
        client.getSettings()
      ]);
      renderSnapshot(snap);
      renderSettings(settingsRes);
      if (settingsRes.capabilities.wgc) {
        void refreshWindows();
      }
      client.subscribeEvents(
        (nextSnap) => {
          renderSnapshot(nextSnap);
        },
        (err) => {
          connectionLabel.textContent = "Disconnected";
          showError(err.message);
        }
      );
      connectionLabel.textContent = "Live · 127.0.0.1";
    } catch (err) {
      connectionLabel.textContent = "Error";
      showError(err instanceof Error ? err.message : String(err));
    }
  })();
}
