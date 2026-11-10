#!/usr/bin/env node
/**
 * Speech smoke: list installed System.Speech voices through the owned helper
 * and optionally speak one short sentence. Text goes over stdin; there is no
 * network call and no online TTS fallback. Whether sound is actually audible
 * is a human check on the reference machine.
 *
 * Run: node packages/app/scripts/smoke-speech.ts [--say "short sentence"]
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SystemSpeechEngine } from "../dist/speech/system-speech-engine.js";

const engineModule = fileURLToPath(
  new URL("../dist/speech/system-speech-engine.js", import.meta.url)
);
if (!existsSync(engineModule)) {
  console.error("speech smoke: build the app first (npm run build)");
  process.exit(2);
}

const helperPath = join(
  fileURLToPath(new URL("../native/speech/bin/SpeechHelper.exe", import.meta.url))
);
if (!existsSync(helperPath)) {
  console.error(
    `speech smoke: helper not built at ${helperPath}; run node packages/app/scripts/build-speech-helper.mjs`
  );
  process.exit(2);
}

const engine = new SystemSpeechEngine({ helperPath });
try {
  const voices = await engine.listVoices(new AbortController().signal);
  const sayIndex = process.argv.indexOf("--say");
  const text = sayIndex >= 0 ? process.argv[sayIndex + 1] : undefined;

  let spoken = false;
  if (text !== undefined && text.trim() !== "") {
    await engine.speak({
      text,
      voiceId: null,
      signal: new AbortController().signal
    });
    spoken = true;
  }

  console.log(
    JSON.stringify(
      {
        helperPath,
        voiceCount: voices.length,
        vietnameseVoice:
          voices.find((voice) => voice.locale.toLowerCase() === "vi-vn") ?? null,
        voices: voices.map((voice) => ({
          name: voice.name,
          locale: voice.locale
        })),
        spoken,
        note: "voice listing is verified; audibility is a human check"
      },
      null,
      2
    )
  );
} finally {
  await engine.close();
}
