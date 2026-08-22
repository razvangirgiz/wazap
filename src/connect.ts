import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { defaultDataDir, type Config } from "./config.js";
import { WazapError } from "./errors.js";
import { say } from "./logger.js";

export interface McpEntry {
  command: string;
  args: string[];
}

/** `command` shells out to the client's own CLI; the other two edit a config file. */
type Format = "command" | "json" | "toml";

interface ClientSpec {
  name: string;
  describe: string;
  file: () => string | null;
  format: Format;
  keyPath: readonly string[];
  /** Fields the client wants alongside command and args. */
  extra?: Record<string, string>;
  next: string;
}

function claudeDesktopFile(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

export const CLIENTS: readonly ClientSpec[] = [
  {
    name: "claude-code",
    describe: "Claude Code",
    file: () => null,
    format: "command",
    keyPath: [],
    next: "Run `claude mcp list` to confirm.",
  },
  {
    name: "claude-desktop",
    describe: "Claude Desktop",
    file: claudeDesktopFile,
    format: "json",
    keyPath: ["mcpServers", "whatsapp"],
    next: "Restart Claude Desktop.",
  },
  {
    name: "cursor",
    describe: "Cursor",
    file: () => join(homedir(), ".cursor", "mcp.json"),
    format: "json",
    keyPath: ["mcpServers", "whatsapp"],
    next: "Reload the Cursor window.",
  },
  {
    name: "codex",
    describe: "Codex CLI",
    file: () => join(homedir(), ".codex", "config.toml"),
    format: "toml",
    keyPath: ["mcp_servers", "whatsapp"],
    next: "Restart Codex.",
  },
  {
    name: "vscode",
    describe: "VS Code",
    file: () => join(process.cwd(), ".vscode", "mcp.json"),
    format: "json",
    keyPath: ["servers", "whatsapp"],
    extra: { type: "stdio" },
    next: "Written to ./.vscode/mcp.json for this workspace. Reload the VS Code window.",
  },
  {
    name: "gemini",
    describe: "Gemini CLI",
    file: () => join(homedir(), ".gemini", "settings.json"),
    format: "json",
    keyPath: ["mcpServers", "whatsapp"],
    next: "Restart the Gemini CLI.",
  },
];

export const CLIENT_NAMES: string = CLIENTS.map((client) => client.name).join(", ");

export const CONNECT_HINT: string = `Next: wazap connect claude-code   (or ${CLIENTS.slice(1)
  .map((client) => client.name)
  .join(", ")})`;

export function isNpxPath(binPath: string): boolean {
  return /[\\/]_npx[\\/]/.test(binPath);
}

const PATH_NAMES = process.platform === "win32" ? ["wazap.cmd", "wazap"] : ["wazap"];

export function onPath(pathEnv: string, exists: (p: string) => boolean = existsSync): boolean {
  return pathEnv
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => PATH_NAMES.some((name) => exists(join(dir, name))));
}

/**
 * How the client should launch wazap, from how it was launched now: through
 * npx, as a global binary on PATH, or straight from a checkout that is on
 * neither. A checkout written as `wazap` would point the client at a command
 * that does not exist.
 */
export function launcher(binPath: string, pathEnv: string, exists?: (p: string) => boolean): McpEntry {
  if (isNpxPath(binPath)) return { command: "npx", args: ["-y", "wazap-mcp"] };
  if (onPath(pathEnv, exists)) return { command: "wazap", args: [] };
  return { command: "node", args: [resolve(binPath)] };
}

export function mcpEntry(config: Config): McpEntry {
  const entry = launcher(process.argv[1] ?? "", process.env.PATH ?? "");
  if (config.dataDir !== defaultDataDir()) entry.args.push("--data-dir", config.dataDir);
  if (config.readOnly) entry.args.push("--read-only");
  return entry;
}

type Writer = (spec: ClientSpec, entry: McpEntry, dryRun: boolean) => void;

const WRITERS: Record<Format, Writer> = {
  command: runClientCommand,
  json: writeJsonEntry,
  toml: writeTomlEntry,
};

export function runConnect(config: Config): void {
  const name = config.args[0] ?? "";
  const spec = CLIENTS.find((client) => client.name === name);
  if (!spec) {
    throw new WazapError("INVALID_ID", `Unknown client "${name}".`, `Pick one of: ${CLIENT_NAMES}`);
  }
  WRITERS[spec.format](spec, mcpEntry(config), config.dryRun);
}

/** Null only when the file is absent; an unreadable file must never be overwritten. */
function readTextOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WazapError("INVALID_ID", `${file} cannot be read.`, "Fix its permissions or move the file aside, then run this again.");
  }
}

function setIn(doc: Record<string, unknown>, keyPath: readonly string[], value: unknown): void {
  let node = doc;
  for (const key of keyPath.slice(0, -1)) {
    const child = node[key];
    if (child === null || typeof child !== "object" || Array.isArray(child)) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keyPath[keyPath.length - 1]!] = value;
}

function writeJsonEntry(spec: ClientSpec, entry: McpEntry, dryRun: boolean): void {
  const file = spec.file()!;
  const current = readTextOrNull(file);
  let doc: Record<string, unknown> = {};
  if (current !== null && current.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      throw new WazapError("INVALID_ID", `${file} is not valid JSON.`, "Fix the JSON or move the file aside, then run this again.");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new WazapError("INVALID_ID", `${file} is not a JSON object.`, "Fix the JSON or move the file aside, then run this again.");
    }
    doc = parsed as Record<string, unknown>;
  }

  const value = { ...spec.extra, command: entry.command, args: entry.args };
  setIn(doc, spec.keyPath, value);
  apply(spec, file, `${JSON.stringify(doc, null, 2)}\n`, current, dryRun, JSON.stringify(value, null, 2));
}

function writeTomlEntry(spec: ClientSpec, entry: McpEntry, dryRun: boolean): void {
  const file = spec.file()!;
  const current = readTextOrNull(file);
  const header = `[${spec.keyPath.join(".")}]`;
  const args = entry.args.map((arg) => JSON.stringify(arg)).join(", ");
  const block = `${header}\ncommand = ${JSON.stringify(entry.command)}\nargs = [${args}]\n`;
  apply(spec, file, spliceTomlTable(current ?? "", header, block), current, dryRun, block.trimEnd());
}

/** Replace the table under `header`, from its header line to the next one, or append it. */
function spliceTomlTable(text: string, header: string, block: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    const base = text.trimEnd();
    return base === "" ? block : `${base}\n\n${block}`;
  }
  let end = start + 1;
  while (end < lines.length && !lines[end]!.trimStart().startsWith("[")) end++;
  // Blank lines and comments just above the next header introduce that table.
  while (end > start + 1 && /^\s*(#|$)/.test(lines[end - 1]!)) end--;
  const merged = [...lines.slice(0, start), ...block.trimEnd().split("\n"), ...lines.slice(end)].join("\n");
  return merged.endsWith("\n") ? merged : `${merged}\n`;
}

function apply(
  spec: ClientSpec,
  file: string,
  next: string,
  current: string | null,
  dryRun: boolean,
  shown: string,
): void {
  if (dryRun) {
    say(`${spec.describe}: would write ${file}`);
    say(shown);
    say(`Next: ${spec.next}`);
    return;
  }
  if (next === current) {
    say(`${spec.describe}: ${file} already has this entry.`);
    say(`Next: ${spec.next}`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  if (current !== null && !existsSync(`${file}.bak`)) copyFileSync(file, `${file}.bak`);
  writeFileSync(file, next);
  say(`${spec.describe}: wrote ${file}`);
  say(shown);
  say(`Next: ${spec.next}`);
}

function runClientCommand(spec: ClientSpec, entry: McpEntry, dryRun: boolean): void {
  const argv = ["mcp", "add", "whatsapp", "--", entry.command, ...entry.args];
  const shown = `claude ${argv.join(" ")}`;
  if (dryRun) {
    say(`${spec.describe}: would run`);
    say(shown);
    say(`Next: ${spec.next}`);
    return;
  }

  const result = spawnSync("claude", argv, { stdio: "inherit" });
  if (result.error !== undefined) {
    say("`claude` is not on PATH. Run this yourself where Claude Code is installed:");
    say(shown);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  say(`${spec.describe}: registered the whatsapp MCP server.`);
  say(`Next: ${spec.next}`);
}
