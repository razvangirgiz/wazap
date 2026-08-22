import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { WazapError } from "./errors.js";

const require = createRequire(import.meta.url);
export const WAZAP_VERSION: string = (require("../package.json") as { version: string }).version;
export const BAILEYS_VERSION: string = (require("baileys/package.json") as { version: string }).version;

/** Where an effective setting came from, in precedence order. */
export type Source = "flag" | "env" | ".env" | "default";

export type Command = "serve" | "login" | "status" | "logout" | "connect" | "config";

export interface Config {
  dataDir: string;
  readOnly: boolean;
  syncFullHistory: boolean;
  /** Persist chats and messages under the data dir so they survive a restart. */
  persistHistory: boolean;
  transport: "stdio" | "http";
  httpHost: string;
  httpPort: number;
  readToken: string | null;
  writeToken: string | null;
  /** Write-tool token bucket, per minute. 0 disables the limit. */
  rateLimitPerMinute: number;
  sources: Record<"dataDir" | "readOnly" | "transport" | "rateLimit", Source>;
  command: Command;
  /** The command was named on the command line rather than defaulted to serve. */
  explicitCommand: boolean;
  /** Positionals after the command: the client for `connect`, the setting for `config`. */
  args: string[];
  dryRun: boolean;
  /** `status` only: probe WhatsApp, and print the report as JSON. */
  live: boolean;
  json: boolean;
  loginPhone?: string;
  loginQr: boolean;
  /** `login` asks about writes unless a flag already answered. */
  writesAnswer: boolean | null;
  assumeYes: boolean;
}

export interface Paths {
  dataDir: string;
  authDir: string;
  mediaDir: string;
  historyDir: string;
  storeFile: string;
  lockFile: string;
  envFile: string;
  qrFile: string;
}

export function paths(dataDir: string): Paths {
  return {
    dataDir,
    authDir: join(dataDir, "auth"),
    mediaDir: join(dataDir, "media"),
    historyDir: join(dataDir, "history"),
    storeFile: join(dataDir, "store.json"),
    lockFile: join(dataDir, "server.lock"),
    envFile: join(dataDir, ".env"),
    qrFile: join(dataDir, "qr.png"),
  };
}

export type CliInvocation = { kind: "help" } | { kind: "version" } | { kind: "run"; config: Config };

/** How many positionals each command takes after its own name. */
const COMMAND_ARGS: Record<Command, readonly number[]> = {
  serve: [0],
  login: [0],
  status: [0],
  logout: [0],
  connect: [1],
  config: [0, 2],
};

const COMMANDS = Object.keys(COMMAND_ARGS) as readonly Command[];

export function defaultDataDir(): string {
  return resolve(join(homedir(), ".wazap"));
}

function asBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function asInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

export type DefaultAction = "serve" | "greet";

/**
 * A human at a terminal running bare `wazap` wants to see where they stand, not
 * a silent MCP server on stdin. Everything else serves, including `wazap serve`.
 */
export function pickDefaultAction(
  config: Pick<Config, "command" | "explicitCommand" | "transport">,
  stdinTTY: boolean,
  stderrTTY: boolean,
): DefaultAction {
  const human =
    config.command === "serve" && !config.explicitCommand && config.transport === "stdio" && stdinTTY && stderrTTY;
  return human ? "greet" : "serve";
}

export function parseCli(argv: string[] = process.argv.slice(2)): CliInvocation {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "data-dir": { type: "string" },
        "read-only": { type: "boolean" },
        http: { type: "boolean" },
        host: { type: "string" },
        port: { type: "string" },
        phone: { type: "string" },
        qr: { type: "boolean" },
        "dry-run": { type: "boolean" },
        live: { type: "boolean" },
        json: { type: "boolean" },
        writes: { type: "boolean" },
        "no-writes": { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    throw new WazapError("INVALID_ID", err instanceof Error ? err.message : String(err), "Run `wazap --help`");
  }

  const { values, positionals } = parsed;
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };

  const [first, ...args] = positionals;
  if (first !== undefined && !COMMANDS.includes(first as Command)) {
    throw new WazapError("INVALID_ID", `Unknown command "${first}".`, "Run `wazap --help`");
  }
  const command = (first as Command | undefined) ?? "serve";
  if (!COMMAND_ARGS[command].includes(args.length)) {
    throw new WazapError("INVALID_ID", `Wrong arguments for \`wazap ${command}\`.`, "Run `wazap --help`");
  }

  const dataDir = resolve(values["data-dir"] ?? process.env.WAZAP_DATA_DIR ?? defaultDataDir());

  // Snapshot before dotenv, which fills process.env from the data dir's .env
  // without overriding what the real environment already set.
  const shell = new Set(Object.keys(process.env).filter((key) => key.startsWith("WAZAP_")));
  dotenv.config({ path: paths(dataDir).envFile, quiet: true });
  const sourceOf = (key: string, flagged: boolean): Source => {
    if (flagged) return "flag";
    if (shell.has(key)) return "env";
    return process.env[key] === undefined ? "default" : ".env";
  };

  const httpFromEnv = process.env.WAZAP_TRANSPORT?.trim().toLowerCase() === "http";

  return {
    kind: "run",
    config: {
      dataDir,
      readOnly: values["read-only"] === true || asBool(process.env.WAZAP_READ_ONLY, false),
      syncFullHistory: asBool(process.env.WAZAP_SYNC_FULL_HISTORY, false),
      persistHistory: asBool(process.env.WAZAP_PERSIST_HISTORY, true),
      transport: values.http === true || httpFromEnv ? "http" : "stdio",
      httpHost: values.host ?? (process.env.WAZAP_HOST?.trim() || "127.0.0.1"),
      httpPort: values.port ? asInt(values.port, 8766) : asInt(process.env.WAZAP_PORT, 8766),
      readToken: (process.env.WAZAP_READ_TOKEN ?? "").trim() || null,
      writeToken: (process.env.WAZAP_WRITE_TOKEN ?? "").trim() || null,
      rateLimitPerMinute: asInt(process.env.WAZAP_RATE_LIMIT, 20),
      sources: {
        // Resolved before dotenv runs, so the data dir's own .env cannot name it.
        dataDir: values["data-dir"] !== undefined ? "flag" : shell.has("WAZAP_DATA_DIR") ? "env" : "default",
        readOnly: sourceOf("WAZAP_READ_ONLY", values["read-only"] === true),
        transport: sourceOf("WAZAP_TRANSPORT", values.http === true),
        rateLimit: sourceOf("WAZAP_RATE_LIMIT", false),
      },
      command,
      explicitCommand: first !== undefined,
      args,
      dryRun: values["dry-run"] === true,
      live: values.live === true,
      json: values.json === true,
      loginPhone: values.phone,
      loginQr: values.qr === true,
      writesAnswer: values.writes === true ? true : values["no-writes"] === true ? false : null,
      assumeYes: values.yes === true,
    },
  };
}
