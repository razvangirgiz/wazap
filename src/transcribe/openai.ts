/**
 * Any OpenAI-compatible /audio/transcriptions endpoint, over plain fetch.
 * The audio leaves the machine here, and the API key must not: every string
 * this module throws goes through redact() first.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WazapError } from "../errors.js";
import { redact } from "./settings.js";
import type { Provider, Readiness, TranscribeOpts, TranscribeSettings, Transcript } from "./types.js";

const TIMEOUT_MS = 2 * 60 * 1000;
const RETRY_AFTER_MS = 2000;
const KEY_FIX = "Run `wazap config transcribe openai`";

const MIME: Record<string, string> = {
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
};

function failed(message: string, key: string | null, fix?: string): WazapError {
  return new WazapError("TRANSCRIBE_FAILED", redact(message, key), fix === undefined ? undefined : redact(fix, key));
}

/** The body may echo the key back, so only a redacted excerpt is ever quoted. */
async function bodyExcerpt(response: Response, key: string | null): Promise<string> {
  try {
    const text = await response.text();
    return redact(text, key).replace(/\s+/g, " ").trim().slice(0, 200);
  } catch {
    return "";
  }
}

async function post(settings: TranscribeSettings, key: string, file: string, language: string): Promise<Response> {
  const bytes = await readFile(file);
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), basename(file));
  form.append("model", settings.apiModel);
  form.append("response_format", "json");
  if (language !== "auto") form.append("language", language);
  return fetch(`${settings.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export const openaiProvider: Provider = {
  async transcribe(settings: TranscribeSettings, file: string, opts: TranscribeOpts): Promise<Transcript> {
    if (!existsSync(file)) throw new WazapError("FILE_NOT_FOUND", `No such file: ${file}`);
    const key = settings.apiKey;
    if (key === null) throw new WazapError("TRANSCRIBE_UNAVAILABLE", "No transcription API key is set.", KEY_FIX);
    const language = opts.language ?? settings.language;

    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await post(settings, key, file, language);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        throw failed(timedOut ? "Transcription request timed out after 2 minutes." : `Transcription request failed: ${message}`, key);
      }
      if (response.ok) break;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt > 0) {
        const excerpt = await bodyExcerpt(response, key);
        throw failed(
          `Transcription API returned ${response.status}${excerpt === "" ? "" : `: ${excerpt}`}`,
          key,
          response.status === 401 || response.status === 403 ? KEY_FIX : undefined,
        );
      }
      await response.body?.cancel().catch(() => {});
      await sleep(RETRY_AFTER_MS);
    }

    let parsed: { text?: unknown; language?: unknown; duration?: unknown };
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch (err) {
      throw failed(`Transcription API sent no readable JSON: ${err instanceof Error ? err.message : String(err)}`, key);
    }
    if (typeof parsed.text !== "string") throw failed("Transcription API sent no text field.", key);
    return {
      text: parsed.text.replace(/\s+/g, " ").trim(),
      ...(typeof parsed.language === "string" ? { language: parsed.language } : {}),
      ...(typeof parsed.duration === "number" ? { duration_seconds: Math.round(parsed.duration) } : {}),
    };
  },

  async ready(settings: TranscribeSettings): Promise<Readiness> {
    if (settings.apiKey === null) return { ok: false, detail: "no transcription API key is set", fix: KEY_FIX };
    return { ok: true, detail: `${settings.apiModel} at ${settings.baseUrl}` };
  },
};
