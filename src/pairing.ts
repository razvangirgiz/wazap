/** Opening a WhatsApp socket for the sole purpose of linking a device. */

import { setTimeout as sleep } from "node:timers/promises";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  type UserFacingSocketConfig,
  type WASocket,
} from "baileys";
import {
  readLinkedAccount,
  useAtomicAuthState,
  withoutAppStateSync,
  type LinkedAccount,
} from "./auth-state.js";
import { RELINK_FIX, WazapError, asWazapError } from "./errors.js";

/**
 * The browser identity sent at handshake. WhatsApp closes the socket with 428
 * before offering a QR for Browsers.macOS("Desktop") (verified 2026-08-22 on
 * baileys 7.0.0-rc14); "Chrome" is accepted.
 */
export const WA_BROWSER = Browsers.macOS("Chrome");

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

type Attempt =
  | { kind: "open" }
  | { kind: "restart" }
  | { kind: "closed"; statusCode?: number }
  | { kind: "failed"; error: unknown };

export interface LinkOptions {
  deadline: number;
  /** Every QR the server offers. Absent when the caller only reuses stored credentials. */
  onQr?: (qr: string, sock: WASocket) => Promise<void>;
}

/**
 * A socket run until it is open, retrying across the restart WhatsApp demands
 * right after a successful pairing. The returned socket is the caller's to end.
 */
export async function linkSession(authDir: string, opts: LinkOptions): Promise<WASocket> {
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
      // This socket pairs and nothing else. It has no store, so anything it
      // syncs is thrown away — and WhatsApp sends the history and the address
      // book once. Refusing the history keeps it out of Baileys' sync state
      // machine, which is what would otherwise bump `accountSyncCounter` and
      // leave the service permanently past its own first sync.
      const sock = makeWASocket({
        auth: withoutAppStateSync(state),
        browser: WA_BROWSER,
        markOnlineOnConnect: false,
        shouldSyncHistoryMessage: () => false,
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

/** The freshly linked account. `creds.update` can land a beat after the connection opens. */
export async function settledAccount(sock: WASocket, authDir: string): Promise<LinkedAccount> {
  const number = (sock.user?.id ?? "").split(":")[0]!.split("@")[0]!;
  const fromSocket: LinkedAccount = { id: `${number}@s.whatsapp.net`, name: sock.user?.name ?? "", number };
  if (fromSocket.name) return fromSocket;
  await sleep(750);
  return readLinkedAccount(authDir) ?? fromSocket;
}
