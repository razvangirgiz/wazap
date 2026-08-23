/**
 * The only entry point the rest of wazap imports. Every branch on the provider
 * goes through PROVIDERS, never through an `if` on the name.
 */
import { WazapError } from "../errors.js";
import { localProvider } from "./local.js";
import { openaiProvider } from "./openai.js";
import type { Provider, ProviderName, Readiness, TranscribeOpts, TranscribeSettings, Transcript } from "./types.js";

export const PROVIDERS: Record<ProviderName, Provider> = {
  local: localProvider,
  openai: openaiProvider,
};

const OFF_FIX = "Run `wazap config transcribe local` or `wazap config transcribe openai`";

export async function transcribeFile(
  settings: TranscribeSettings,
  file: string,
  opts: TranscribeOpts = {},
): Promise<Transcript> {
  if (settings.provider === null) {
    throw new WazapError("TRANSCRIBE_UNAVAILABLE", "Transcription is not configured.", OFF_FIX);
  }
  return PROVIDERS[settings.provider].transcribe(settings, file, opts);
}

export async function transcribeReady(settings: TranscribeSettings): Promise<Readiness> {
  if (settings.provider === null) return { ok: false, detail: "transcription is off", fix: OFF_FIX };
  return PROVIDERS[settings.provider].ready(settings);
}

export { localProvider } from "./local.js";
export { openaiProvider } from "./openai.js";
export { TranscribeQueue } from "./queue.js";
export {
  maskKey,
  readTranscribeSettings,
  redact,
  requireSafeUrl,
  stripPasted,
} from "./settings.js";
export {
  downloadFile,
  downloadModel,
  MODELS,
  modelPath,
  modelSpec,
  modelUrl,
  type DownloadOpts,
  type DownloadProgress,
  type DownloadResult,
  type ModelSpec,
} from "./models.js";
export type {
  ModelAlias,
  Provider,
  ProviderName,
  Readiness,
  TranscribeOpts,
  TranscribeSettings,
  Transcript,
  TranscriptRecord,
} from "./types.js";
