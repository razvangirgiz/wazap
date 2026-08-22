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
import { banner } from "./banner.js";
import { BAILEYS_VERSION, WAZAP_VERSION, paths, type Config } from "./config.js";
import { connectNext } from "./connect.js";
import { checkLine, checkLines, runChecks, type Check } from "./doctor.js";
import { RELINK_FIX, WazapError, asWazapError } from "./errors.js";
import { normalizePhone } from "./ids.js";
import { lockHolder, releaseLock, writeLock } from "./lock.js";
import { log, logError, say } from "./logger.js";
import { formatAge } from "./messages.js";
import { runHttp, runStdio } from "./server.js";
import { applyWrites } from "./settings.js";
import {
  bold,
  box,
  brand,
  humanLayout,
  dim,
  fail,
  info,
  maskNumber,
  next,
  ok,
  shortPath,
  spinner,
  step,
  tilde,
  warn,
  type Spinner,
} from "./ui.js";
import type { ConnectionStatus } from "./wa-types.js";
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
  credentials_readable: boolean;
  account: LinkedAccount | null;
  wazap_version: string;
  baileys_version: string;
  server_pid: number | null;
  checks: Check[];
  live?: LiveReport;
}

export async function runStatus(config: Config): Promise<StatusReport> {
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
    credentials_readable: !unreadable,
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
    return report;
  }

  for (const line of humanLayout() ? richStatus(report) : plainStatus(report)) say(line);

  if (report.live) {
    say("");
    for (const line of liveLines(report.live)) say(line);
    process.exit(0);
  }
  return report;
}

/** Today's phrasing, kept verbatim so pipes and log captures keep parsing. */
function plainStatus(report: StatusReport): string[] {
  const lines = [`data dir: ${report.data_dir}`];
  if (!report.credentials_readable) {
    lines.push("linked: no (credentials unreadable — run `wazap logout` then `wazap login`)");
  } else if (report.account) {
    lines.push("linked: yes", `account: ${describeAccount(report.account)}`);
  } else {
    lines.push("linked: no");
  }
  lines.push(
    `wazap: ${report.wazap_version}`,
    `baileys: ${report.baileys_version}`,
    report.server_pid === null ? "server: not running" : `server: running (pid ${report.server_pid})`,
    "",
    "checks:",
    ...report.checks.map(checkLine),
  );
  return lines;
}

const LABEL_WIDTH = 8;

function row(label: string, value: string): string {
  return `${dim(label.padEnd(LABEL_WIDTH))}  ${value}`;
}

function richStatus(report: StatusReport): string[] {
  const account = !report.credentials_readable
    ? "credentials unreadable"
    : report.account
      ? describeAccount(report.account)
      : "not linked";
  return [
    `${bold(`wazap ${report.wazap_version}`)}${dim(` · baileys ${report.baileys_version}`)}`,
    row("data dir", tilde(report.data_dir)),
    row("account", account),
    row("server", report.server_pid === null ? "not running" : `running (pid ${report.server_pid})`),
    "",
    ...report.checks.flatMap(checkLines),
  ];
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

  // The probe owns the session for as long as it runs, exactly like the server.
  writeLock(p.lockFile);
  const wa = new WhatsAppService(config);
  const deadline = Date.now() + LIVE_TIMEOUT_MS;
  try {
    await wa.start();
    let probe = wa.getStatus();
    while (!SETTLED_STATUSES.includes(probe.status) && Date.now() < deadline) {
      await sleep(250);
      probe = wa.getStatus();
    }
    if (probe.status !== "connected") {
      return { reachable: false, chats: null, last_message_age: null, reason: probe.last_error ?? probe.status };
    }

    // listChats waits on its own sync gate, which would outlast the deadline.
    const chats = await Promise.race([
      wa.listChats("all", 100_000).then((synced) => synced.data),
      sleep(Math.max(0, deadline - Date.now()), null, { ref: false }),
    ]).catch(() => null);
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
    releaseLock(p.lockFile);
  }
}

/** Bare `wazap` at a terminal: where you stand, and the one command to run next. */
export async function runGreet(config: Config): Promise<void> {
  say(banner());
  say("");
  const report = await runStatus(config);
  say("");

  if (report.server_pid !== null) {
    say(info(`A server is already running (pid ${report.server_pid}).`));
    return;
  }
  if (!report.credentials_readable) {
    say(next("wazap logout", "(then wazap login)"));
    return;
  }
  say(
    report.linked
      ? next("wazap connect claude-code", '(then ask your agent: "what did I miss on WhatsApp today?")')
      : next("wazap login"),
  );
}

export async function runServe(config: Config): Promise<void> {
  const p = paths(config.dataDir);

  const running = lockHolder(p.lockFile);
  if (running !== null) {
    say(fail(`wazap is already running (pid ${running}) using ${config.dataDir}. Stop it first or use --data-dir.`));
    process.exit(2);
  }

  // Loopback with no token only gets runHttp's warning; off-loopback is refused.
  if (config.transport === "http" && !config.readToken && !LOOPBACK_HOSTS.includes(config.httpHost)) {
    say(fail(`Refusing to serve ${config.httpHost} without a token. Set WAZAP_READ_TOKEN, or bind 127.0.0.1.`));
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
  say(banner());

  const linked = readLinkedAccount(p.authDir);
  if (linked) {
    say("");
    say(ok(`Already linked as ${describeAccount(linked)}`));
    say(info("Run `wazap logout` to relink."));
    say("");
    say(connectNext());
    return;
  }

  const total = config.loginCode ? 4 : 3;
  let phone: string | null = null;
  if (config.loginCode) {
    say(step(1, total, "Your number"));
    phone = config.loginPhone === undefined ? await askPhone() : normalizePhone(config.loginPhone);
    say(ok(maskNumber(phone)));
  }

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  const waiting = new Countdown(deadline);
  say(step(total - 2, total, "Link your phone"));

  let requested = false;
  const onQr = async (qr: string, sock: WASocket): Promise<void> => {
    if (phone === null) {
      qrcodeTerminal.generate(qr, { small: true }, (art: string) => say(art));
      await qrcode.toFile(p.qrFile, qr);
      say(
        `  Scan it with WhatsApp → Settings → Linked devices → Link a device (also saved to ${shortPath(p.qrFile)})`,
      );
      say(dim("  Prefer typing a code? Press Ctrl+C and run `wazap login --phone +15550100`."));
      say("");
      waiting.start();
      return;
    }
    if (requested) return;
    requested = true;
    const code = await sock.requestPairingCode(phone);
    say("  On your phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead");
    say("");
    say(box(`${code.slice(0, 4)}-${code.slice(4)}`));
    say("");
    waiting.start();
  };

  let account: LinkedAccount;
  try {
    const sock = await linkSession(p.authDir, { deadline, onQr });
    account = await settledAccount(sock, p.authDir);
    await sock.end(undefined);
  } catch (err) {
    waiting.stop();
    throw err;
  }
  waiting.stop(ok(`Linked as ${describeAccount(account)}`));

  say(step(total - 1, total, "Sync your chats"));
  await syncAfterLink(config);

  say(step(total, total, "Permissions"));
  await offerWrites(config);
  say("");
  say(connectNext());
  process.exit(0);
}

const HISTORY_WAIT_MS = 90_000;
const HISTORY_QUIET_MS = 3_000;

/**
 * WhatsApp sends the chat history exactly once, right after pairing, to the
 * socket that paired. The link socket has no store, so the real service takes
 * over here and stays up until the history has landed and gone quiet.
 */
async function syncAfterLink(config: Config): Promise<void> {
  const wa = new WhatsAppService(config);
  const spin = spinner("Syncing your chats…");
  try {
    await wa.start();
    const deadline = Date.now() + HISTORY_WAIT_MS;
    let seen = "";
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const counts = wa.storeCounts();
      const key = `${counts.chats}/${counts.contacts}/${counts.messages}`;
      spin.update(`Syncing your chats…  ${counts.chats} chats, ${counts.contacts} contacts, ${counts.messages} messages`);
      if (!wa.hasHistory()) continue;
      if (key !== seen) {
        seen = key;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= HISTORY_QUIET_MS) {
        break;
      }
    }
  } finally {
    const counts = wa.storeCounts();
    const got = wa.hasHistory();
    await wa.stop();
    spin.stop(
      got
        ? ok(`Synced ${counts.chats} chats, ${counts.contacts} contacts, ${counts.messages} messages`)
        : warn("No history arrived in 90s. The server keeps listening; if chats stay empty, run `wazap logout` then `wazap login`."),
    );
  }
}

/**
 * The spinner shown while WhatsApp is asked to accept the code, counting the
 * pairing code down to the deadline it expires on.
 */
class Countdown {
  #spinner: Spinner | null = null;
  #ticker: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(private readonly deadline: number) {}

  /** No-op once stopped: the socket can settle while the code request is still in flight. */
  start(): void {
    if (this.#stopped) return;
    this.#spinner = spinner(this.#line());
    this.#ticker = setInterval(() => this.#spinner?.update(this.#line()), 1_000);
    this.#ticker.unref();
  }

  stop(final?: string): void {
    this.#stopped = true;
    if (this.#ticker !== null) clearInterval(this.#ticker);
    this.#ticker = null;
    if (this.#spinner === null) {
      if (final !== undefined) say(final);
      return;
    }
    this.#spinner.stop(final);
    this.#spinner = null;
  }

  #line(): string {
    const left = Math.max(0, Math.round((this.deadline - Date.now()) / 1_000));
    return `Waiting for your phone…  (expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")})`;
  }
}

export async function runLogout(config: Config): Promise<void> {
  const p = paths(config.dataDir);

  const running = lockHolder(p.lockFile);
  if (running !== null) {
    say(fail(`wazap is running (pid ${running}). Stop it first.`));
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
    say(info("Not linked."));
    return;
  }

  if (linked) {
    const deadline = Date.now() + LOGOUT_TIMEOUT_MS;
    try {
      const sock = await linkSession(p.authDir, { deadline });
      await withDeadline(sock.logout(), deadline, "WhatsApp did not confirm the unlink in time.");
    } catch (err: unknown) {
      logError("unlink from WhatsApp", err);
      say(warn("Could not tell WhatsApp to unlink; remove this device from your phone if it is still listed."));
    }
  }

  clearAuth(p.authDir);
  rmSync(p.storeFile, { force: true });
  say(ok("Logged out. Local credentials deleted."));
  process.exit(0);
}

/** The number is masked: a status screenshot should not carry it. */
function describeAccount(account: LinkedAccount): string {
  const number = maskNumber(account.number);
  return account.name ? `${account.name} (${number})` : number;
}

/**
 * Writes stay off unless the user says otherwise, so a fresh link cannot message
 * anyone. A non-interactive login leaves the setting alone rather than guessing.
 */
export async function offerWrites(config: Config): Promise<void> {
  if (config.writesAnswer !== null) {
    applyWrites(config, config.writesAnswer);
    return;
  }
  if (config.assumeYes || !process.stdin.isTTY) return;
  const answer = await ask(`${brand("?")} Allow the agent to send messages, react and manage chats? [y/N] `);
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

const PHONE_ATTEMPTS = 3;

/** A typo costs another prompt, not the whole login. */
async function askPhone(): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const answer = await ask(`${brand("?")} WhatsApp number, international format (e.g. +15550100): `);
    try {
      return normalizePhone(answer);
    } catch (err) {
      if (attempt === PHONE_ATTEMPTS) throw err;
      say(fail("Use international format, e.g. +15550100"));
    }
  }
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
