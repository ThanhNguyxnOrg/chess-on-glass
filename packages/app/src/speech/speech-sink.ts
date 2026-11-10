import { QueuedTextSink, type ResultSink } from "@chessonglass/game";
import type { SpeechEngine } from "./system-speech-engine.js";

export type SpeechSinkOptions = {
  engine: SpeechEngine;
  voiceId?: string | null;
  /** Unstarted utterances retained before the oldest is dropped (default 4). */
  maxQueue?: number;
};

/**
 * Bridges the shared structured ResultSink to a SpeechEngine. The core queue
 * owns ordering, bounding and stale-context dropping; this adapter only maps
 * text to the engine call.
 */
export function createSpeechSink(options: SpeechSinkOptions): ResultSink {
  const speak = async (text: string, signal: AbortSignal): Promise<void> => {
    await options.engine.speak({
      text,
      voiceId: options.voiceId ?? null,
      signal
    });
  };
  return options.maxQueue === undefined
    ? new QueuedTextSink(speak)
    : new QueuedTextSink(speak, { maxQueue: options.maxQueue });
}
