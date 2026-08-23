/**
 * The one place the transcription environment becomes typed. Nothing downstream
 * reads process.env, so a bad URL or provider name is refused once, here, and
 * the API key is handled by these helpers alone.
 */
import { join } from "node:path";
import { WazapError } from "../errors.js";
import type { ModelAlias, ProviderName, TranscribeSettings } from "./types.js";

const DEFAULT_URL = "https://api.openai.com/v1";
const DEFAULT_API_MODEL = "gpt-4o-mini-transcribe";
const MODEL_ALIASES: readonly ModelAlias[] = ["turbo", "large-v3", "medium"];
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const OFF = new Set(["", "off", "0", "no", "none", "false"]);

/** Trims whitespace, then one matching pair of surrounding quotes, then again. */
export function stripPasted(raw: string): string {
  const trimmed = raw.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const quoted = trimmed.length >= 2 && (first === '"' || first === "'") && first === last;
  return quoted ? trimmed.slice(1, -1).trim() : trimmed;
}

/** `set (…abcd)` or `not set`. Never the key, whatever its length. */
export function maskKey(key: string | null | undefined): string {
  if (key === null || key === undefined || key === "") return "not set";
  return key.length < 4 ? "set" : `set (…${key.slice(-4)})`;
}

/** Deletes every occurrence of the key, so no error can carry it outward. */
export function redact(text: string, key: string | null | undefined): string {
  if (key === null || key === undefined || key === "") return text;
  return text.split(key).join("");
}

/**
 * Audio leaves the machine over this URL and the key rides with it, so plain
 * http is refused unless it points back at this machine.
 */
export function requireSafeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WazapError("INVALID_ID", `Not a URL: ${url}`, "Set WAZAP_TRANSCRIBE_URL to an https:// URL");
  }
  if (parsed.protocol === "https:") return url;
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (parsed.protocol === "http:" && LOOPBACK.has(host)) return url;
  throw new WazapError(
    "INVALID_ID",
    `Refusing a non-https transcription URL: ${url}`,
    "Use an https:// URL, or http:// on 127.0.0.1 for a local server",
  );
}

function parseProvider(raw: string | undefined): ProviderName | null {
  const value = stripPasted(raw ?? "").toLowerCase();
  if (OFF.has(value)) return null;
  if (value === "local" || value === "openai") return value;
  throw new WazapError(
    "INVALID_ID",
    `Unknown transcription provider "${value}".`,
    "Set WAZAP_TRANSCRIBE to local, openai or off",
  );
}

function parseModel(raw: string | undefined): ModelAlias {
  const value = stripPasted(raw ?? "").toLowerCase();
  if (value === "") return "turbo";
  if ((MODEL_ALIASES as readonly string[]).includes(value)) return value as ModelAlias;
  throw new WazapError(
    "INVALID_ID",
    `Unknown whisper model "${value}".`,
    `Set WAZAP_WHISPER_MODEL to one of: ${MODEL_ALIASES.join(", ")}`,
  );
}

function asBool(raw: string | undefined, fallback: boolean): boolean {
  const value = stripPasted(raw ?? "");
  if (value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function orNull(raw: string | undefined): string | null {
  const value = stripPasted(raw ?? "");
  return value === "" ? null : value;
}

export function readTranscribeSettings(env: NodeJS.ProcessEnv, dataDir: string): TranscribeSettings {
  const provider = parseProvider(env.WAZAP_TRANSCRIBE);
  const url = orNull(env.WAZAP_TRANSCRIBE_URL) ?? DEFAULT_URL;
  return {
    provider,
    language: orNull(env.WAZAP_TRANSCRIBE_LANGUAGE) ?? "auto",
    auto: provider !== null && asBool(env.WAZAP_TRANSCRIBE_AUTO, true),
    model: parseModel(env.WAZAP_WHISPER_MODEL),
    whisperBin: orNull(env.WAZAP_WHISPER_BIN),
    apiKey: orNull(env.WAZAP_TRANSCRIBE_API_KEY) ?? orNull(env.OPENAI_API_KEY),
    baseUrl: requireSafeUrl(url.replace(/\/+$/, "")),
    apiModel: orNull(env.WAZAP_TRANSCRIBE_MODEL) ?? DEFAULT_API_MODEL,
    modelsDir: join(dataDir, "models"),
  };
}
