/**
 * The CLI's private line to a running `wazap serve`. Commands that change the
 * account roster (`account add|enable|disable|default|remove`) and `logout` ask
 * the process that holds the data dir to do the part only it can do, instead
 * of asking the user to stop it.
 *
 * The line is its own listener on an ephemeral 127.0.0.1 port, never the MCP
 * listener: a tunnel or a proxy pointed at WAZAP_PORT does not reach it, and
 * nothing on it speaks MCP. One credential opens it, a random token the server
 * writes to `control.json` (0600, in the 0700 data dir) and nowhere else. The
 * static WAZAP_READ_TOKEN/WAZAP_WRITE_TOKEN, OAuth grants and the bridge token
 * in daemon.json are not that token, and anonymous callers get nothing. Anyone
 * able to read control.json can already read or delete the credentials this
 * line would log out, so the token grants nothing a file read does not.
 *
 * It exists whether or not the session is shared (WAZAP_NO_SHARE): sharing is
 * about other MCP clients, this is about the CLI.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseAccountId } from "./accounts.js";
import type { RosterChange } from "./account-hub.js";
import { readDaemon, type DaemonInfo } from "./daemon.js";
import { withCode } from "./error-code.js";
import { ERROR_GUIDE, WazapError, type ErrorCode } from "./errors.js";
import { lockHolder } from "./lock.js";
import { log } from "./logger.js";
import { LOGOUT_OUTCOMES, LOGOUT_TIMEOUT_MS, type LogoutOutcome } from "./logout.js";

/** What the control line can ask of the running server. */
export interface ControlTarget {
  reload(): RosterChange;
  settled(): Promise<void>;
  logout(id: string): Promise<LogoutOutcome>;
  remove(id: string): Promise<void>;
}

export const CONTROL_ROUTES = {
  reload: "/v1/accounts/reload",
  logout: "/v1/accounts/logout",
  remove: "/v1/accounts/remove",
} as const;

const MAX_BODY_BYTES = 4 * 1024;
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

function authorized(header: string | undefined, token: string): boolean {
  const prefix = "Bearer ";
  if (header === undefined || !header.startsWith(prefix)) return false;
  const got = Buffer.from(header.slice(prefix.length).trim());
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function refuse(res: ServerResponse, status: number, message: string): void {
  send(res, status, { error: "SERVICE_ERROR", message });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new WazapError("INVALID_ID", "The request body is too large.");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new WazapError("INVALID_ID", "The request body is not JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WazapError("INVALID_ID", "The request body is not a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function accountOf(body: Record<string, unknown>): string {
  const id = body.account_id;
  if (typeof id !== "string") throw new WazapError("INVALID_ID", "account_id is missing.");
  return parseAccountId(id);
}

/**
 * Answer the control routes for `target`. Every refusal happens before the
 * body is read: a Host that is not a loopback name (DNS rebinding), any Origin
 * (a browser page; the CLI sends none), a missing or wrong token, a method
 * other than POST, a body that is not JSON.
 */
export async function startControlEndpoint(
  target: ControlTarget,
  token: string,
  signal?: AbortSignal
): Promise<number> {
  const server = createServer(async (req, res) => {
    let route: keyof typeof CONTROL_ROUTES | undefined;
    try {
      const host = req.headers.host?.toLowerCase().replace(/:\d{1,5}$/, "");
      if (host === undefined || !LOOPBACK_NAMES.includes(host) || req.headers.origin !== undefined) {
        refuse(res, 403, "This endpoint only answers the wazap CLI on this machine.");
        return;
      }
      if (!authorized(req.headers.authorization, token)) {
        refuse(res, 401, "Unauthorized.");
        return;
      }
      route = (Object.keys(CONTROL_ROUTES) as (keyof typeof CONTROL_ROUTES)[]).find(
        (name) => CONTROL_ROUTES[name] === req.url
      );
      if (route === undefined) {
        refuse(res, 404, "Not found.");
        return;
      }
      if (req.method !== "POST") {
        refuse(res, 405, "Use POST.");
        return;
      }
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
        refuse(res, 415, "Send application/json.");
        return;
      }
      const body = await readJson(req);
      switch (route) {
        case "reload": {
          const change = target.reload();
          await target.settled();
          send(res, 200, { ok: true, ...change });
          return;
        }
        case "logout": {
          const id = accountOf(body);
          log(`control: logout ${id}`);
          send(res, 200, { ok: true, account_id: id, outcome: await target.logout(id) });
          return;
        }
        case "remove": {
          const id = accountOf(body);
          log(`control: remove ${id}`);
          await target.remove(id);
          send(res, 200, { ok: true, account_id: id });
          return;
        }
      }
    } catch (err) {
      if (err instanceof WazapError) {
        send(res, 409, { error: err.code, message: err.message, ...(err.fix ? { fix: err.fix } : {}) });
        return;
      }
      log(`control: ${route ?? "request"} failed${withCode(err)}`);
      send(res, 500, { error: "SERVICE_ERROR", message: "The running server could not do that." });
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 60_000;
  server.maxConnections = 16;

  const onAbort = (): void => {
    server.closeAllConnections();
    server.close();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.removeListener("error", reject);
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        server.close();
        reject(new Error("control listen returned no AddressInfo"));
        return;
      }
      resolve(bound.port);
    });
  });
  // The process lives for its MCP transport, never for this listener.
  server.unref();
  return port;
}

/** The control line `pid` published, or null: none, a stale one, or someone else's. */
export function publishedControl(controlFile: string, pid: number): DaemonInfo | null {
  const info = readDaemon(controlFile);
  return info !== null && info.pid === pid ? info : null;
}

/** Nobody to ask: no live lock holder, or one that publishes no control line (an older wazap). */
export interface NoServer {
  kind: "none" | "unreachable";
  /** The live lock holder, when there is one. */
  pid: number | null;
}

export type ControlResult<T> = { kind: "answered"; pid: number; body: T } | NoServer;

/**
 * Ask the server holding `dataDir` to run a control route. A connection that
 * never opened is `unreachable`: nothing was done. A server that answered with
 * an error throws it. A timeout throws too, since the work may still be under way.
 */
export async function askRunningServer<T extends Record<string, unknown>>(
  controlFile: string,
  lockFile: string,
  route: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<ControlResult<T>> {
  const pid = lockHolder(lockFile);
  if (pid === null) return { kind: "none", pid: null };
  const info = publishedControl(controlFile, pid);
  if (info === null) return { kind: "unreachable", pid };

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // AbortSignal.timeout rejects with a DOMException named TimeoutError.
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new WazapError(
        "TIMEOUT",
        `The running server (pid ${pid}) did not answer in time; it may still be working on it.`,
        "Run `wazap status` to see where it stands"
      );
    }
    return { kind: "unreachable", pid };
  }

  let answer: Record<string, unknown> = {};
  try {
    answer = (await res.json()) as Record<string, unknown>;
  } catch {
    /* an empty or broken body is judged by its status below */
  }
  if (res.ok && answer.ok === true) return { kind: "answered", pid, body: answer as T };
  const code = typeof answer.error === "string" && answer.error in ERROR_GUIDE ? (answer.error as ErrorCode) : "SERVICE_ERROR";
  const message =
    typeof answer.message === "string" ? answer.message : `The running server (pid ${pid}) refused it (HTTP ${res.status}).`;
  throw new WazapError(code, message, typeof answer.fix === "string" ? answer.fix : undefined);
}

/** How long the CLI waits on a roster reload: the stops of what it took off. */
export const RELOAD_TIMEOUT_MS = 15_000;
/** A logout stops the account, then gives WhatsApp as long as the offline path does. */
export const LOGOUT_WAIT_MS = LOGOUT_TIMEOUT_MS + 20_000;

export function isLogoutOutcome(value: unknown): value is LogoutOutcome {
  return typeof value === "string" && (LOGOUT_OUTCOMES as readonly string[]).includes(value);
}
