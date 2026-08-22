import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths, type Config } from "./config.js";
import { WazapError } from "./errors.js";
import { lockHolder } from "./lock.js";
import { say } from "./logger.js";

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

export function runConfig(config: Config): void {
  if (config.args.length === 0) {
    for (const row of SETTINGS) say(`${row.label}: ${row.value(config)} (${config.sources[row.source]})`);
    say("");
    say("Change writes with `wazap config writes on|off`.");
    return;
  }

  const [setting, value] = config.args;
  if (setting !== "writes" || (value !== "on" && value !== "off")) {
    throw new WazapError("INVALID_ID", `Cannot set "${setting} ${value}".`, "Run `wazap config writes on|off`");
  }
  applyWrites(config, value === "on");
}

/** Persist the writes answer, then say what is now true and how to change it. */
export function applyWrites(config: Config, allowWrites: boolean): void {
  const p = paths(config.dataDir);
  setEnvSetting(p.envFile, "WAZAP_READ_ONLY", allowWrites ? "0" : "1");
  say(
    allowWrites
      ? `writes: on — the agent can send messages, react and manage chats. Turn it off with \`wazap config writes off\`.`
      : `writes: off — the agent can only read. Turn it on with \`wazap config writes on\`.`,
  );
  say(`Stored in ${p.envFile}.`);

  const running = lockHolder(p.lockFile);
  if (running !== null) say(`A server is running (pid ${running}); restart it for this to apply.`);
}
