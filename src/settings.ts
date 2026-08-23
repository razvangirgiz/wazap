import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ask, askSecret } from "./cli.js";
import { paths, type Config } from "./config.js";
import { WazapError, asWazapError } from "./errors.js";
import { lockHolder } from "./lock.js";
import { say } from "./logger.js";
import {
  maskKey,
  readTranscribeSettings,
  requireSafeUrl,
  stripPasted,
  transcribeReady,
  type Readiness,
  type TranscribeSettings,
} from "./transcribe/index.js";
import { brand, dim, fix, ok, shortPath, warn } from "./ui.js";

/** Replace `KEY=` in place, keeping every other line, or append it. */
export function setEnvSetting(envFile: string, key: string, value: string): void {
  let text = "";
  try {
    text = readFileSync(envFile, "utf8");
  } catch {
    /* a data dir without an .env yet */
  }

  const line = `${key}=${value}`;
  const lines = text === "" ? [] : text.split("\n");
  // dotenv trims around `=` and applies last-wins, so every spelling of the key
  // has to go: leaving a later duplicate behind would silently outrank the edit.
  const assignment = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
  const hits = lines.flatMap((existing, index) => (assignment.test(existing) ? [index] : []));
  if (hits.length === 0) {
    const body = text.trimEnd();
    text = body === "" ? `${line}\n` : `${body}\n${line}\n`;
  } else {
    lines[hits[0]!] = line;
    text = lines.filter((_, index) => index === hits[0] || !hits.includes(index)).join("\n");
    if (!text.endsWith("\n")) text += "\n";
  }

  mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 });
  writeFileSync(envFile, text, { mode: 0o600 });
}

interface SettingRow {
  label: string;
  source: keyof Config["sources"];
  value: (config: Config) => string;
}

const SETTINGS: readonly SettingRow[] = [
  { label: "data dir", source: "dataDir", value: (config) => config.dataDir },
  { label: "writes", source: "readOnly", value: (config) => (config.readOnly ? "off" : "on") },
  {
    label: "transport",
    source: "transport",
    value: (config) => (config.transport === "http" ? `http ${config.httpHost}:${config.httpPort}` : "stdio"),
  },
  {
    label: "rate limit",
    source: "rateLimit",
    value: (config) => (config.rateLimitPerMinute === 0 ? "off" : `${config.rateLimitPerMinute} writes/minute`),
  },
];

/** Every setting `wazap config <name> <value>` can change, and what each accepts. */
const COMMANDS: Record<string, { values: readonly string[]; apply: (config: Config, value: string) => Promise<void> }> = {
  writes: {
    values: ["on", "off"],
    apply: async (config, value) => applyWrites(config, value === "on"),
  },
  transcribe: {
    values: ["local", "openai", "off"],
    apply: applyTranscribe,
  },
};

const USAGE_FIX = "Run `wazap config writes on|off` or `wazap config transcribe local|openai|off`";

export async function runConfig(config: Config): Promise<void> {
  if (config.args.length === 0) {
    for (const row of SETTINGS) say(`${row.label}: ${row.value(config)} (${config.sources[row.source]})`);
    for (const line of transcribeRows(config)) say(line);
    say("");
    say(dim("Change writes with `wazap config writes on|off`, transcription with `wazap config transcribe`."));
    return;
  }

  const [setting, value, extra] = config.args;
  if (extra !== undefined && setting === "transcribe") {
    throw new WazapError(
      "INVALID_ID",
      "The API key is never a command-line argument: it would be kept in your shell history and readable in `ps` by anyone on this machine.",
      "Run `wazap config transcribe openai` and paste the key at the prompt, which does not echo it",
    );
  }

  const spec = setting === undefined ? undefined : COMMANDS[setting];
  if (spec === undefined || value === undefined || extra !== undefined || !spec.values.includes(value)) {
    throw new WazapError("INVALID_ID", `Cannot set "${config.args.join(" ")}".`, USAGE_FIX);
  }
  await spec.apply(config, value);
}

/**
 * A stale `.env` is refused by readTranscribeSettings, and neither `config` nor
 * `status` may go down with it: the complaint is a line, not a crash.
 */
function transcribeSettings(env: NodeJS.ProcessEnv, dataDir: string): TranscribeSettings | WazapError {
  try {
    return readTranscribeSettings(env, dataDir);
  } catch (err) {
    return asWazapError(err);
  }
}

function transcribeRows(config: Config): string[] {
  const settings = transcribeSettings(process.env, config.dataDir);
  if (settings instanceof WazapError) {
    return [`transcribe: ${settings.message}${settings.fix === undefined ? "" : ` — ${settings.fix}`}`];
  }
  const rows = [`transcribe: ${settings.provider ?? "off"} (${config.sources.transcribe})`];
  if (settings.provider === "openai") rows.push(`api key: ${maskKey(settings.apiKey)}`);
  return rows;
}

const DEFAULT_URL = "https://api.openai.com/v1";

const TRANSCRIBE_SAID: Record<string, string> = {
  local: "transcribe: local — whisper.cpp runs here, and the audio never leaves this machine.",
  openai: "transcribe: openai — voice messages are uploaded to the API to be transcribed.",
  off: "transcribe: off — voice messages stay as `[voice message]`.",
};

/**
 * The openai path asks for everything before it writes anything, so a refused
 * URL leaves .env as it was rather than half configured. `report` is off for
 * `setup`, which fetches the model itself and would otherwise announce a gap it
 * is about to close.
 */
export async function applyTranscribe(config: Config, choice: string, report = true): Promise<void> {
  const p = paths(config.dataDir);
  const writes: Record<string, string> = { WAZAP_TRANSCRIBE: choice };

  if (choice === "openai") {
    const key = await askSecret(`${brand("?")} Paste the API key (it is not echoed): `);
    if (key === "") {
      throw new WazapError("INVALID_ID", "No API key was typed.", "Run `wazap config transcribe openai` again");
    }
    writes.WAZAP_TRANSCRIBE_API_KEY = key;
    // A piped stdin was consumed whole by the reader above, so the second question
    // is only put to a person; a script sets WAZAP_TRANSCRIBE_URL itself, and
    // whatever it set is left alone here.
    if (process.stdin.isTTY === true) {
      const typed = stripPasted(await ask(`${brand("?")} Base URL [${DEFAULT_URL}]: `));
      // Written even when the default is accepted: an earlier answer's URL must
      // not outlive the answer that replaced it.
      writes.WAZAP_TRANSCRIBE_URL = typed === "" ? DEFAULT_URL : requireSafeUrl(typed.replace(/\/+$/, ""));
    }
  }

  for (const [name, value] of Object.entries(writes)) setEnvSetting(p.envFile, name, value);
  say(ok(TRANSCRIBE_SAID[choice]!));
  say(dim(`Stored in ${shortPath(p.envFile)}.`));
  if (report && choice !== "off") await reportReadiness({ ...process.env, ...writes }, config.dataDir);

  const running = lockHolder(p.lockFile);
  if (running !== null) say(warn(`A server is running (pid ${running}); restart it for this to apply.`));
}

/** What is still missing prints as a repair line, so a fresh choice never crashes. */
async function reportReadiness(env: NodeJS.ProcessEnv, dataDir: string): Promise<void> {
  const settings = transcribeSettings(env, dataDir);
  const readiness: Readiness =
    settings instanceof WazapError
      ? { ok: false, detail: settings.message, fix: settings.fix }
      : await transcribeReady(settings);
  if (readiness.ok) {
    say(ok(readiness.detail));
    return;
  }
  say(warn(readiness.detail));
  if (readiness.fix !== undefined) say(fix(readiness.fix));
}

/** Persist the writes answer, then say what is now true and how to change it. */
export function applyWrites(config: Config, allowWrites: boolean): void {
  const p = paths(config.dataDir);
  setEnvSetting(p.envFile, "WAZAP_READ_ONLY", allowWrites ? "0" : "1");
  say(
    ok(
      allowWrites
        ? "writes: on — the agent can send messages, react and manage chats. Turn it off with `wazap config writes off`."
        : "writes: off — the agent can only read. Turn it on with `wazap config writes on`.",
    ),
  );
  say(dim(`Stored in ${shortPath(p.envFile)}.`));

  const running = lockHolder(p.lockFile);
  if (running !== null) say(warn(`A server is running (pid ${running}); restart it for this to apply.`));
}
