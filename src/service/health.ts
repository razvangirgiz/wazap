/**
 * What WhatsApp says about the account itself, as opposed to the link: a ban,
 * a temporary ban, a session another client took over, a client too old to be
 * let in, and the "reachout timelock" that stops a restricted account starting
 * chats with people it has never written to. Part of WhatsAppService
 * (src/whatsapp.ts), which feeds it the close codes, the timelock updates and
 * the refused sends it sees, and asks it before a send whether one may start.
 *
 * The close codes follow what WhatsApp's own web client and whatsmeow read off
 * the same wire: 401 logged out, 402 temporarily banned (with `code` and
 * `expire` on the failure node), 403 locked or banned (with WhatsApp's words in
 * `logout_message_header`), 406 banned, 440 replaced, 405 and 409 a client
 * WhatsApp no longer takes. Everything else is a dropped link, retried.
 */

import { WazapError } from "../errors.js";
import { isoWithOffset } from "../messages.js";
import type { HealthInfo, HealthState } from "../wa-types.js";

/** How a close is handled. */
export type CloseVerdict =
  | { kind: "logged_out" }
  | { kind: "transient" }
  | { kind: "banned" | "session_replaced" | "client_outdated"; detail: string | null; code: number }
  | { kind: "temporarily_banned"; until: number | null; reason: string | null; code: number };

/** The reachout timelock as Baileys reports it (fetchAccountReachoutTimelock, connection.update). */
export interface ReachoutLock {
  isActive?: boolean;
  timeEnforcementEnds?: Date | string | number;
  enforcementType?: string;
}

/** A temporary ban longer than this is treated as a ban: no reconnect is scheduled for it. */
export const TEMP_BAN_RETRY_MAX_MS = 7 * 24 * 3_600_000;

/** The Boom error Baileys closes with: `output.statusCode`, and the failure node's attributes on `data`. */
function codeOf(error: unknown): number | undefined {
  const code = (error as { output?: { statusCode?: unknown } } | undefined)?.output?.statusCode;
  return typeof code === "number" ? code : undefined;
}

function dataOf(error: unknown): Record<string, unknown> {
  const data = (error as { data?: unknown } | undefined)?.data;
  if (data === null || typeof data !== "object") return {};
  // A stream error carries the child node ({ tag, attrs }); a failure node carries its attributes directly.
  const attrs = (data as { attrs?: unknown }).attrs;
  return attrs !== null && typeof attrs === "object" ? { ...(data as object), ...(attrs as object) } : (data as Record<string, unknown>);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Reads a close the way WhatsApp's own clients do. Unknown codes are a dropped link. */
export function classifyClose(error: unknown, now: number = Date.now()): CloseVerdict {
  const code = codeOf(error);
  const data = dataOf(error);
  if (code === 401) return { kind: "logged_out" };
  if (code === 402) {
    const expire = Number(data.expire);
    return {
      kind: "temporarily_banned",
      until: Number.isFinite(expire) && expire > 0 ? now + expire * 1000 : null,
      reason: text(data.code) ?? (typeof data.code === "number" ? String(data.code) : null),
      code,
    };
  }
  if (code === 403 || code === 406) {
    const words = [text(data.logout_message_header), text(data.logout_message_subtext)].filter((part) => part !== null);
    return { kind: "banned", detail: words.length > 0 ? words.join(" ") : null, code };
  }
  if (code === 440 || data.type === "replaced") return { kind: "session_replaced", detail: null, code: code ?? 440 };
  if (code === 405 || code === 409) return { kind: "client_outdated", detail: null, code };
  return { kind: "transient" };
}

/** What the account can and cannot do right now, as far as WhatsApp has told this process. */
export class AccountHealth {
  private state: HealthState = "ok";
  private since: number | null = null;
  private until: number | null = null;
  private reason: string | null = null;
  private detail: string | null = null;
  private lastSendError: { code: string; at: number } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** A close that is about the account: its state until something says otherwise. */
  noteClose(verdict: CloseVerdict): void {
    if (verdict.kind === "logged_out" || verdict.kind === "transient") return;
    this.set(verdict.kind, {
      until: verdict.kind === "temporarily_banned" ? verdict.until : null,
      reason: verdict.kind === "temporarily_banned" ? verdict.reason : null,
      detail: verdict.kind === "temporarily_banned" ? null : verdict.detail,
    });
  }

  /** The link came up: a ban or a replaced session is over; a reachout timelock is not, it has its own clock. */
  noteOpen(): void {
    if (this.state !== "ok" && this.state !== "reachout_restricted") this.clear();
  }

  noteReachout(lock: ReachoutLock | null | undefined): void {
    if (!lock) return;
    if (lock.isActive === true) {
      const ends = lock.timeEnforcementEnds === undefined ? NaN : new Date(lock.timeEnforcementEnds).getTime();
      this.set("reachout_restricted", {
        until: Number.isFinite(ends) ? ends : null,
        reason: text(lock.enforcementType),
        detail: null,
      });
    } else if (lock.isActive === false && this.state === "reachout_restricted") {
      this.clear();
    }
  }

  /** A send WhatsApp refused after it left: kept for get_status, whatever the code. */
  noteSendError(code: string): void {
    this.lastSendError = { code, at: this.now() };
  }

  /** A state that stops every write: the account is banned, temporarily banned, taken over, or too old. */
  blocksWrites(): boolean {
    return this.state !== "ok" && this.state !== "reachout_restricted";
  }

  /** Whether a first message to someone never written to would be refused, and add to the restriction. */
  blocksNewChats(): boolean {
    if (this.state !== "reachout_restricted") return false;
    if (this.until !== null && this.until <= this.now()) {
      this.clear();
      return false;
    }
    return true;
  }

  /** The refusal a write gets while the account is restricted: nothing left wazap, and retrying is what not to do. */
  refusal(what: "write" | "new_chat"): WazapError {
    const until = this.until === null ? "" : ` until ${isoWithOffset(this.until)}`;
    const said = this.detail === null ? "" : ` WhatsApp says: "${this.detail}"`;
    switch (this.state) {
      case "reachout_restricted":
        return new WazapError(
          "ACCOUNT_RESTRICTED",
          `WhatsApp restricts this account from starting chats with people it has not written to${until}; nothing was sent.`,
          what === "new_chat"
            ? "Do not retry: reply only in chats that already have messages, and wait for the restriction to end"
            : "Wait for the restriction to end"
        );
      case "temporarily_banned":
        return new WazapError(
          "ACCOUNT_RESTRICTED",
          `WhatsApp has temporarily banned this account${until}; nothing was sent.${said}`,
          "Stop sending until the ban ends; wazap tries the link once more when it does"
        );
      case "banned":
        return new WazapError(
          "ACCOUNT_RESTRICTED",
          `WhatsApp has banned or locked this account; nothing was sent.${said}`,
          "Open WhatsApp on the phone to see what it says; wazap will not reconnect on its own"
        );
      case "session_replaced":
        return new WazapError(
          "ACCOUNT_RESTRICTED",
          "Another client took over this account's session; nothing was sent.",
          "Stop the other wazap or WhatsApp Web using these credentials, then restart this one"
        );
      case "client_outdated":
        return new WazapError(
          "ACCOUNT_RESTRICTED",
          "WhatsApp no longer accepts this version of the client; nothing was sent.",
          "Update wazap (`npx wazap-mcp update`), then restart it"
        );
      default:
        return new WazapError("ACCOUNT_RESTRICTED", "WhatsApp restricts this account; nothing was sent.");
    }
  }

  /** When a temporary ban ends, if it said. */
  banEndsAt(): number | null {
    return this.state === "temporarily_banned" ? this.until : null;
  }

  info(): HealthInfo {
    // A timelock whose end passed is over, whoever asks first.
    if (this.state === "reachout_restricted") this.blocksNewChats();
    return {
      state: this.state,
      since: this.since === null ? null : isoWithOffset(this.since),
      until: this.until === null ? null : isoWithOffset(this.until),
      reason: this.reason,
      detail: this.detail,
      last_send_error: this.lastSendError === null ? null : { code: this.lastSendError.code, at: isoWithOffset(this.lastSendError.at) },
    };
  }

  /** One line for get_status's hint, or null while nothing is wrong. */
  hint(): string | null {
    return this.info().state === "ok" ? null : this.refusal("write").message;
  }

  private set(state: HealthState, fields: { until: number | null; reason: string | null; detail: string | null }): void {
    if (this.state !== state) this.since = this.now();
    this.state = state;
    this.until = fields.until;
    this.reason = fields.reason;
    this.detail = fields.detail;
  }

  private clear(): void {
    this.state = "ok";
    this.since = null;
    this.until = null;
    this.reason = null;
    this.detail = null;
  }
}
