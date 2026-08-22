import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { WazapError } from "./errors.js";

const require = createRequire(import.meta.url);
export const WAZAP_VERSION: string = (require("../package.json") as { version: string }).version;
export const BAILEYS_VERSION: string = (require("baileys/package.json") as { version: string }).version;

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
  command: Command;
  /** Positionals after the command: the client for `connect`, the setting for `config`. */
  args: string[];
  dryRun: boolean;
  loginPhone?: string;
  loginQr: boolean;
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
  dotenv.config({ path: paths(dataDir).envFile, quiet: true });

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
      command,
      args,
      dryRun: values["dry-run"] === true,
      loginPhone: values.phone,
      loginQr: values.qr === true,
    },
  };
}
