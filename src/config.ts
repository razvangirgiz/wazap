import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { WazapError } from "./errors.js";

const require = createRequire(import.meta.url);
export const WAZAP_VERSION: string = (
  require("../package.json") as { version: string }
).version;
export const BAILEYS_VERSION: string = (
  require("baileys/package.json") as { version: string }
).version;

/** Where an effective setting came from, in precedence order. */
export type Source = "flag" | "env" | ".env" | "default";

export type Command =
  | "accounts"
  | "serve"
  | "login"
  | "setup"
  | "status"
  | "logout"
  | "connect"
  | "config"
  | "contacts"
  | "skills"
  | "service"
  | "expose"
  | "transcribe"
  | "update";

export interface Config {
  dataDir: string;
  rootDataDir?: string;
  accountId?: string;
  accountName?: string;
  accountOwner?: string;
  accountEnv?: NodeJS.ProcessEnv;
  offline?: boolean;
  cacheLimit?: number;
  validateAccount?: (owner: string) => void;
  allowedAccountIds?: string[];
  readAccountIds?: string[];
  writeAccountIds?: string[];
  readOnly: boolean;
  exportDir?: string;
  syncFullHistory: boolean;
  /** Persist chats and messages under the data dir so they survive a restart. */
  persistHistory: boolean;
  transport: "stdio" | "http";
  httpHost: string;
  httpPort: number;
  /** False when CLI defaults the port; a service update then preserves its existing port. */
  httpPortConfigured?: boolean;
  readToken: string | null;
  writeToken: string | null;
  /** Where clients reach the HTTP endpoint from outside; with the password, turns OAuth on. */
  publicUrl: string | null;
  oauthPassword: string | null;
  /** Publish a loopback endpoint and a daemon.json sidecar so a bridge can reach this session. */
  share: boolean;
  /** Write-tool token bucket, per minute. 0 disables the limit. */
  rateLimitPerMinute: number;
  sources: Record<
    "dataDir" | "readOnly" | "transport" | "rateLimit" | "transcribe",
    Source
  >;
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
  /** Pair with an 8-character code instead of the QR; implied by --phone. */
  loginCode: boolean;
  /** `login` asks about writes unless a flag already answered. */
  writesAnswer: boolean | null;
  /** `setup` only: print the agent procedure and exit. */
  agent: boolean;
  /** `setup` only, repeatable, overrides detection. */
  clients: string[];
  /** `setup` only: refuse the global install an npx run would otherwise offer. */
  noGlobal: boolean;
  /** Answer no to the `brew install` a missing dependency would otherwise offer. */
  noBrew: boolean;
  /** `setup` only: refuse the Claude Desktop restart it would otherwise offer. */
  relaunch: boolean;
  assumeYes: boolean;
  /** `transcribe download` only: the whisper model alias from --model. */
  modelName?: string;
  /** `setup` only: the answer to the transcription question, from --transcribe. */
  transcribeChoice?: string;
  /** `setup` only: the answer to the "keep running" question, from --service / --expose. */
  keepRunning: KeepRunning | null;
}

export interface Paths {
  dataDir: string;
  authDir: string;
  mediaDir: string;
  historyDir: string;
  previewsDir: string;
  notesFile: string;
  storeFile: string;
  lockFile: string;
  daemonFile: string;
  serviceFile: string;
  oauthFile: string;
  envFile: string;
  qrFile: string;
}

export function paths(dataDir: string): Paths {
  return {
    dataDir,
    authDir: join(dataDir, "auth"),
    mediaDir: join(dataDir, "media"),
    historyDir: join(dataDir, "history"),
    previewsDir: join(dataDir, "previews"),
    notesFile: join(dataDir, "notes.json"),
    storeFile: join(dataDir, "store.json"),
    lockFile: join(dataDir, "server.lock"),
    daemonFile: join(dataDir, "daemon.json"),
    serviceFile: join(dataDir, "service.json"),
    oauthFile: join(dataDir, "oauth.json"),
    envFile: join(dataDir, ".env"),
    qrFile: join(dataDir, "qr.png"),
  };
}

/** The answer to `setup`'s "keep running" question. */
export type KeepRunning = "client" | "service" | "expose";

export type CliInvocation =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; config: Config };

/** How many positionals each command takes after its own name. */
const COMMAND_ARGS: Record<Command, readonly number[]> = {
  accounts: [1, 2],
  serve: [0],
  login: [0],
  setup: [0],
  status: [0],
  logout: [0],
  connect: [1],
  // A third positional is only ever someone typing the API key after
  // `config transcribe openai`. It is accepted here so runConfig can refuse it
  // with the reason, rather than with a generic arity complaint.
  config: [0, 2, 3],
  contacts: [1],
  // One positional is `skills install`, which finds the harnesses itself.
  skills: [1, 2],
  service: [1],
  // No positional means the first available provider; `off` takes the tunnel down.
  expose: [0, 1],
  transcribe: [1, 2],
  update: [0],
};

const COMMANDS = Object.keys(COMMAND_ARGS) as readonly Command[];

/**
 * What to type instead of `--help` when the arity is wrong. Literals, not
 * imports: this file cannot reach `connect` or `service` without a cycle.
 */
const COMMAND_USAGE: Partial<Record<Command, string>> = {
  connect:
    "Pick one of: claude-code, claude-desktop, cursor, codex, vscode, gemini, windsurf, opencode, chatgpt",
  skills: "Run `wazap skills install [<harness>]`",
  service:
    "Run `wazap service install|status|start|stop|restart|logs|uninstall`",
  transcribe:
    "Run `wazap transcribe download` or `wazap transcribe test <audio file>`",
  contacts: "Run `wazap contacts resync`",
  config:
    "Run `wazap config`, `wazap config writes on|off`, or `wazap config transcribe local|openai|off`",
};

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

/**
 * A user_config slot the person never filled in reaches us as the literal
 * `${user_config.data_dir}`: the Claude Desktop bundle substitutes what it has
 * and leaves the rest alone. An unanswered question is not a data directory.
 */
function dropUnfilledTemplates(): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("WAZAP_") && /^\$\{[^}]*\}$/.test(value ?? ""))
      delete process.env[key];
  }
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
    config.command === "serve" &&
    !config.explicitCommand &&
    config.transport === "stdio" &&
    stdinTTY &&
    stderrTTY;
  return human ? "greet" : "serve";
}

export function parseCli(
  argv: string[] = process.argv.slice(2),
): CliInvocation {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        account: { type: "string" },
        name: { type: "string" },
        "data-dir": { type: "string" },
        "read-only": { type: "boolean" },
        http: { type: "boolean" },
        host: { type: "string" },
        port: { type: "string" },
        phone: { type: "string" },
        qr: { type: "boolean" },
        code: { type: "boolean" },
        "dry-run": { type: "boolean" },
        live: { type: "boolean" },
        json: { type: "boolean" },
        writes: { type: "boolean" },
        "no-writes": { type: "boolean" },
        agent: { type: "boolean" },
        client: { type: "string", multiple: true },
        "no-global": { type: "boolean" },
        "no-brew": { type: "boolean" },
        relaunch: { type: "boolean" },
        model: { type: "string" },
        transcribe: { type: "string" },
        service: { type: "boolean" },
        expose: { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    throw new WazapError(
      "INVALID_ID",
      err instanceof Error ? err.message : String(err),
      "Run `wazap --help`",
    );
  }

  const { values, positionals } = parsed;
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };

  dropUnfilledTemplates();

  const [first, ...args] = positionals;
  if (first !== undefined && !COMMANDS.includes(first as Command)) {
    throw new WazapError(
      "INVALID_ID",
      `Unknown command "${first}".`,
      "Run `wazap --help`",
    );
  }
  const command = (first as Command | undefined) ?? "serve";
  if (!COMMAND_ARGS[command].includes(args.length)) {
    throw new WazapError(
      "INVALID_ID",
      `Wrong arguments for \`wazap ${command}\`.`,
      COMMAND_USAGE[command] ?? "Run `wazap --help`",
    );
  }

  const dataDir = resolve(
    values["data-dir"] ?? process.env.WAZAP_DATA_DIR ?? defaultDataDir(),
  );

  // Snapshot before dotenv, which fills process.env from the data dir's .env
  // without overriding what the real environment already set.
  const shell = new Set(
    Object.keys(process.env).filter((key) => key.startsWith("WAZAP_")),
  );
  dotenv.config({ path: paths(dataDir).envFile, quiet: true });
  const sourceOf = (key: string, flagged: boolean): Source => {
    if (flagged) return "flag";
    if (shell.has(key)) return "env";
    return process.env[key] === undefined ? "default" : ".env";
  };

  const configuredReadOnly = readOnlySetting(process.env.WAZAP_READ_ONLY);
  const httpFromEnv =
    process.env.WAZAP_TRANSPORT?.trim().toLowerCase() === "http";

  return {
    kind: "run",
    config: {
      dataDir,
      accountId: values.account,
      accountName: values.name,
      allowedAccountIds: process.env.WAZAP_ACCOUNTS?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      readAccountIds: process.env.WAZAP_READ_ACCOUNTS?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      writeAccountIds: process.env.WAZAP_WRITE_ACCOUNTS?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      exportDir: process.env.WAZAP_EXPORT_DIR
        ? resolve(process.env.WAZAP_EXPORT_DIR)
        : undefined,
      readOnly: values["read-only"] === true || configuredReadOnly,
      syncFullHistory: asBool(process.env.WAZAP_SYNC_FULL_HISTORY, false),
      persistHistory: asBool(process.env.WAZAP_PERSIST_HISTORY, true),
      transport: values.http === true || httpFromEnv ? "http" : "stdio",
      httpHost: values.host ?? (process.env.WAZAP_HOST?.trim() || "127.0.0.1"),
      httpPortConfigured: values.port !== undefined || process.env.WAZAP_PORT !== undefined,
      httpPort: values.port
        ? asInt(values.port, 8766)
        : asInt(process.env.WAZAP_PORT, 8766),
      readToken: (process.env.WAZAP_READ_TOKEN ?? "").trim() || null,
      writeToken: (process.env.WAZAP_WRITE_TOKEN ?? "").trim() || null,
      publicUrl:
        (process.env.WAZAP_PUBLIC_URL ?? "").trim().replace(/\/+$/, "") || null,
      oauthPassword: process.env.WAZAP_OAUTH_PASSWORD || null,
      share: !asBool(process.env.WAZAP_NO_SHARE, false),
      rateLimitPerMinute: asInt(process.env.WAZAP_RATE_LIMIT, 20),
      sources: {
        // Resolved before dotenv runs, so the data dir's own .env cannot name it.
        dataDir:
          values["data-dir"] !== undefined
            ? "flag"
            : shell.has("WAZAP_DATA_DIR")
              ? "env"
              : "default",
        readOnly: sourceOf("WAZAP_READ_ONLY", values["read-only"] === true),
        transport: sourceOf("WAZAP_TRANSPORT", values.http === true),
        rateLimit: sourceOf("WAZAP_RATE_LIMIT", false),
        transcribe: sourceOf("WAZAP_TRANSCRIBE", false),
      },
      command,
      explicitCommand: first !== undefined,
      args,
      dryRun: values["dry-run"] === true,
      live: values.live === true,
      json: values.json === true,
      loginPhone: values.phone,
      loginCode: values.code === true || values.phone !== undefined,
      writesAnswer:
        values.writes === true
          ? true
          : values["no-writes"] === true
            ? false
            : null,
      agent: values.agent === true,
      clients: values.client ?? [],
      noGlobal: values["no-global"] === true,
      noBrew: values["no-brew"] === true,
      relaunch: values.relaunch === true,
      assumeYes: values.yes === true,
      modelName: values.model,
      transcribeChoice: values.transcribe,
      keepRunning:
        values.expose === true
          ? "expose"
          : values.service === true
            ? "service"
            : null,
    },
  };
}

export function readOnlySetting(value: string | undefined): boolean {
  if (value === undefined) return true;
  const clean = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(clean)) return true;
  if (["0", "false", "no", "off"].includes(clean)) return false;
  throw new WazapError("INVALID_ID", "Invalid WAZAP_READ_ONLY. Use 1 or 0.");
}
