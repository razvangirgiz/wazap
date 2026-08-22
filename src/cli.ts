import { mkdirSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import makeWASocket, {
  DisconnectReason,
  type UserFacingSocketConfig,
  type WASocket,
} from "baileys";
import qrcode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";
import { clearAuth, readLinkedAccount, useAtomicAuthState, type LinkedAccount } from "./auth-state.js";
import { BANNER } from "./banner.js";
import { BAILEYS_VERSION, WAZAP_VERSION, paths, type Config } from "./config.js";
import { CONNECT_HINT } from "./connect.js";
import { checkLine, runChecks, type Check } from "./doctor.js";
import { RELINK_FIX, WazapError, asWazapError } from "./errors.js";
import { normalizePhone } from "./ids.js";
import { lockHolder, releaseLock, writeLock } from "./lock.js";
import { log, logError, say } from "./logger.js";
import { formatAge } from "./messages.js";
import { runHttp, runStdio } from "./server.js";
import { applyWrites } from "./settings.js";
import type { ChatSummary, ConnectionStatus } from "./wa-types.js";
import { WA_BROWSER, WhatsAppService } from "./whatsapp.js";

const LOGIN_TIMEOUT_MS = 120_000;
const LIVE_TIMEOUT_MS = 15_000;
/** Connection states the probe stops waiting on. */
const SETTLED_STATUSES: readonly ConnectionStatus[] = [
  "connected",
  "not_linked",
  "logged_out",
  "session_corrupt",
  "auth_failure",
];
const LOGOUT_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];

/** Baileys' default logger is a pino instance writing JSON to stdout. */
type SocketLogger = NonNullable<UserFacingSocketConfig["logger"]>;
const SILENT_LOGGER: SocketLogger = {
  level: "silent",
  child: () => SILENT_LOGGER,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface LiveReport {
  reachable: boolean;
  chats: number | null;
  last_message_age: string | null;
  reason: string | null;
}

interface StatusReport {
  data_dir: string;
  linked: boolean;
  account: LinkedAccount | null;
  wazap_version: string;
  baileys_version: string;
  server_pid: number | null;
  checks: Check[];
  live?: LiveReport;
}

export async function runStatus(config: Config): Promise<void> {
  const p = paths(config.dataDir);

  let account: LinkedAccount | null = null;
  let unreadable = false;
  try {
    account = readLinkedAccount(p.authDir);
  } catch {
    unreadable = true;
  }

  const report: StatusReport = {
    data_dir: config.dataDir,
    linked: account !== null,
    account,
    wazap_version: WAZAP_VERSION,
    baileys_version: BAILEYS_VERSION,
    server_pid: lockHolder(p.lockFile),
    checks: await runChecks(config),
  };
  if (config.live) report.live = await runLiveProbe(config);

  if (config.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (config.live) process.exit(0);
    return;
  }

  say(`data dir: ${report.data_dir}`);
  if (unreadable) {
    say("linked: no (credentials unreadable — run `wazap logout` then `wazap login`)");
  } else if (account) {
    say("linked: yes");
    say(`account: ${describeAccount(account)}`);
  } else {
    say("linked: no");
  }
  say(`wazap: ${report.wazap_version}`);
  say(`baileys: ${report.baileys_version}`);
  say(report.server_pid === null ? "server: not running" : `server: running (pid ${report.server_pid})`);

  say("");
  say("checks:");
  for (const check of report.checks) say(checkLine(check));

  if (report.live) {
    say("");
    for (const line of liveLines(report.live)) say(line);
    process.exit(0);
  }
}

function liveLines(live: LiveReport): string[] {
  if (!live.reachable) return [`live: no connection (${live.reason ?? "unknown"})`];
  return [
    "live: phone reachable",
    `live: ${live.chats === null ? "chats not synced in time" : `${live.chats} chats synced`}`,
    `live: last message ${live.last_message_age ?? "unknown"}`,
  ];
}

/** One process owns the session, so a probe only runs when no server holds the lock. */
async function runLiveProbe(config: Config): Promise<LiveReport> {
  const p = paths(config.dataDir);
  const running = lockHolder(p.lockFile);
  if (running !== null) {
    throw new WazapError(
      "WHATSAPP_ERROR",
      `A server (pid ${running}) already owns this session.`,
      "Ask it through your MCP client instead: call get_status",
    );
  }

  const wa = new WhatsAppService(config);
  const deadline = Date.now() + LIVE_TIMEOUT_MS;
  try {
    await wa.start();
    let info = wa.getStatus();
    while (!SETTLED_STATUSES.includes(info.status) && Date.now() < deadline) {
      await sleep(250);
      info = wa.getStatus();
    }
    if (info.status !== "connected") {
      return { reachable: false, chats: null, last_message_age: null, reason: info.last_error ?? info.status };
    }

    let chats: ChatSummary[] | null = null;
    try {
      chats = (await wa.listChats("all", 100_000)).data;
    } catch {
      /* the history sync did not finish inside the deadline */
    }
    const newest = (chats ?? [])
      .map((chat) => (chat.last_message === null ? 0 : Date.parse(chat.last_message.timestamp)))
      .reduce((a, b) => Math.max(a, b), 0);
    return {
      reachable: true,
      chats: chats === null ? null : chats.length,
      last_message_age: newest === 0 ? null : formatAge(newest),
      reason: null,
    };
  } finally {
    await wa.stop();
  }
}

/** Bare `wazap` at a terminal: where you stand, and the one command to run next. */
export async function runGreet(config: Config): Promise<void> {
  say(BANNER);
  say("");
  await runStatus(config);
  say("");

  const p = paths(config.dataDir);
  const running = lockHolder(p.lockFile);
  if (running !== null) {
    say(`A server is already running (pid ${running}).`);
    return;
  }
  let linked = false;
  try {
    linked = readLinkedAccount(p.authDir) !== null;
  } catch {
    linked = false;
  }
  say(
    linked
      ? 'Next: wazap connect claude-code   (then ask your agent: "what did I miss on WhatsApp today?")'
      : "Next: wazap login",
  );
}

export async function runServe(config: Config): Promise<void> {
  const p = paths(config.dataDir);

  const running = lockHolder(p.lockFile);
  if (running !== null) {
    say(`wazap is already running (pid ${running}) using ${config.dataDir}. Stop it first or use --data-dir.`);
    process.exit(2);
  }

  // Loopback with no token only gets runHttp's warning; off-loopback is refused.
  if (config.transport === "http" && !config.readToken && !LOOPBACK_HOSTS.includes(config.httpHost)) {
    say(`Refusing to serve ${config.httpHost} without a token. Set WAZAP_READ_TOKEN, or bind 127.0.0.1.`);
    process.exit(1);
  }

  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  writeLock(p.lockFile);
  process.on("exit", () => releaseLock(p.lockFile));

  const wa = new WhatsAppService(config);
  const shutdown = (signal: string): void => {
    log(`received ${signal}, shutting down`);
    // A wedged socket must not cost the user a kill -9; the lock goes on "exit".
    setTimeout(() => process.exit(0), 3_000).unref();
    void wa.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Connecting in the background: MCP startup never waits on WhatsApp, and the
  // tools answer NOT_LINKED until a session exists.
  wa.start().catch((err: unknown) => logError("whatsapp start", err));

  if (config.transport === "http") await runHttp(wa, config);
  else await runStdio(wa, config);
}

export async function runLogin(config: Config): Promise<void> {
  const p = paths(config.dataDir);
  const linked = readLinkedAccount(p.authDir);
  if (linked) {
    say(`Already linked as ${describeAccount(linked)}. Run \`wazap logout\` to relink.`);
    return;
  }

  const phone = config.loginQr ? null : normalizePhone(config.loginPhone ?? (await askPhone()));

  let requested = false;
  const onQr = async (qr: string, sock: WASocket): Promise<void> => {
    if (phone === null) {
      qrcodeTerminal.generate(qr, { small: true }, (art: string) => say(art));
      await qrcode.toFile(p.qrFile, qr);
      say(`WhatsApp → Settings → Linked devices → Link a device, then scan the code above (also saved to ${p.qrFile}).`);
      return;
    }
    if (requested) return;
    requested = true;
    const code = await sock.requestPairingCode(phone);
    say("");
    say("WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead");
    say("");
    say(`    ${code.slice(0, 4)}-${code.slice(4)}`);
    say("");
  };

  const sock = await linkSession(p.authDir, { deadline: Date.now() + LOGIN_TIMEOUT_MS, onQr });
  const account = await settledAccount(sock, p.authDir);
  say(`Linked ✅ as ${describeAccount(account)}`);
  await sock.end(undefined);
  await offerWrites(config);
  say(CONNECT_HINT);
  process.exit(0);
}

export async function runLogout(config: Config): Promise<void> {
  const p = paths(config.dataDir);

  const running = lockHolder(p.lockFile);
  if (running !== null) {
    say(`wazap is running (pid ${running}). Stop it first, then run \`wazap logout\`.`);
    process.exit(1);
  }

  let linked: LinkedAccount | null = null;
  let unreadable = false;
  try {
    linked = readLinkedAccount(p.authDir);
  } catch {
    // Unreadable creds are exactly what logout exists to clear, so keep going.
    unreadable = true;
  }
  if (!linked && !unreadable) {
    say("Not linked.");
    return;
  }

  if (linked) {
    const deadline = Date.now() + LOGOUT_TIMEOUT_MS;
    try {
      const sock = await linkSession(p.authDir, { deadline });
      await withDeadline(sock.logout(), deadline, "WhatsApp did not confirm the unlink in time.");
    } catch (err: unknown) {
      logError("unlink from WhatsApp", err);
      say("Could not tell WhatsApp to unlink; remove this device from your phone if it is still listed.");
    }
  }

  clearAuth(p.authDir);
  rmSync(p.storeFile, { force: true });
  say("Logged out. Local credentials deleted.");
  process.exit(0);
}

function describeAccount(account: LinkedAccount): string {
  return account.name ? `${account.name} (${account.number})` : account.number;
}

/**
 * Writes stay off unless the user says otherwise, so a fresh link cannot message
 * anyone. A non-interactive login leaves the setting alone rather than guessing.
 */
async function offerWrites(config: Config): Promise<void> {
  if (config.writesAnswer !== null) {
    applyWrites(config, config.writesAnswer);
    return;
  }
  if (config.assumeYes || !process.stdin.isTTY) return;
  const answer = await ask("Allow the agent to send messages, react and manage chats? [y/N] ");
  applyWrites(config, /^y(es)?$/i.test(answer.trim()));
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function askPhone(): Promise<string> {
  return ask("Phone number in international format (e.g. +40722123456): ");
}

type Attempt =
  | { kind: "open" }
  | { kind: "restart" }
  | { kind: "closed"; statusCode?: number }
  | { kind: "failed"; error: unknown };

interface LinkOptions {
  deadline: number;
  /** Every QR the server offers. Absent when the caller only reuses stored credentials. */
  onQr?: (qr: string, sock: WASocket) => Promise<void>;
}

/**
 * A socket run until it is open, retrying across the restart WhatsApp demands
 * right after a successful pairing. The returned socket is the caller's to end.
 */
async function linkSession(authDir: string, opts: LinkOptions): Promise<WASocket> {
  let current: WASocket | null = null;
  let expired = false;
  const timer = setTimeout(
    () => {
      expired = true;
      void current?.end(undefined);
    },
    Math.max(0, opts.deadline - Date.now()),
  );

  try {
    for (;;) {
      // Also checked here: a restart landing just before the deadline would
      // otherwise open a socket the timer can no longer reach.
      if (expired) throw timedOut();
      const { state, saveCreds } = await useAtomicAuthState(authDir);
      const sock = makeWASocket({
        auth: state,
        browser: WA_BROWSER,
        markOnlineOnConnect: false,
        logger: SILENT_LOGGER,
      });
      current = sock;
      sock.ev.on("creds.update", () => void saveCreds());

      const attempt = await new Promise<Attempt>((resolve) => {
        sock.ev.on("connection.update", (update) => {
          if (update.qr && opts.onQr) {
            void opts.onQr(update.qr, sock).catch((error: unknown) => resolve({ kind: "failed", error }));
          }
          if (update.connection === "open") resolve({ kind: "open" });
          if (update.connection === "close") {
            const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
              ?.output?.statusCode;
            resolve(statusCode === DisconnectReason.restartRequired ? { kind: "restart" } : { kind: "closed", statusCode });
          }
        });
      });

      if (attempt.kind === "open") return sock;
      await sock.end(undefined);
      current = null;
      if (attempt.kind === "restart") continue;
      if (expired) throw timedOut();
      if (attempt.kind === "failed") throw asWazapError(attempt.error);
      if (attempt.statusCode === DisconnectReason.loggedOut) {
        throw new WazapError(
          "SESSION_EXPIRED",
          "WhatsApp rejected the link. The code may have expired or been entered wrong.",
          RELINK_FIX,
        );
      }
      throw new WazapError("WHATSAPP_ERROR", `WhatsApp closed the connection (code ${attempt.statusCode ?? "unknown"}).`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function timedOut(): WazapError {
  return new WazapError("TIMEOUT", "WhatsApp did not answer in time.", "Check your connection and try again");
}

function withDeadline<T>(work: Promise<T>, deadline: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new WazapError("TIMEOUT", message)), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

/** The freshly linked account. `creds.update` can land a beat after the connection opens. */
async function settledAccount(sock: WASocket, authDir: string): Promise<LinkedAccount> {
  const number = (sock.user?.id ?? "").split(":")[0]!.split("@")[0]!;
  const fromSocket: LinkedAccount = { id: `${number}@s.whatsapp.net`, name: sock.user?.name ?? "", number };
  if (fromSocket.name) return fromSocket;
  await sleep(750);
  return readLinkedAccount(authDir) ?? fromSocket;
}
