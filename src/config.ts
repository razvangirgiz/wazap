import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { WazapError } from "./errors.js";

const require = createRequire(import.meta.url);
export const WAZAP_VERSION: string = (require("../package.json") as { version: string }).version;
export const BAILEYS_VERSION: string = (require("baileys/package.json") as { version: string }).version;

export type Command = "serve" | "login" | "status" | "logout";

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

const COMMANDS: readonly Command[] = ["serve", "login", "status", "logout"];

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

  const [first, ...rest] = positionals;
  if (rest.length > 0) {
    throw new WazapError("INVALID_ID", `Unexpected argument "${rest[0]}".`, "Run `wazap --help`");
  }
  if (first !== undefined && !COMMANDS.includes(first as Command)) {
    throw new WazapError("INVALID_ID", `Unknown command "${first}".`, "Run `wazap --help`");
  }
  const command = (first as Command | undefined) ?? "serve";

  const dataDir = resolve(values["data-dir"] ?? process.env.WAZAP_DATA_DIR ?? join(homedir(), ".wazap"));
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
      loginPhone: values.phone,
      loginQr: values.qr === true,
    },
  };
}
