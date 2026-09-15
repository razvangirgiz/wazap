/**
 * How fresh the local WhatsApp history is, from what the service already
 * reports: the initial-sync state, the newest inbound message it knows and a
 * staleness flag on the same 24 h line getStatus uses for its hint. A scoped
 * query adds the newest message wazap holds for that chat, so "nothing found"
 * can be told apart from "nothing synced".
 */

import { formatAge } from "./messages.js";
import type { StatusInfo, SyncState } from "./wa-types.js";
import type { WhatsAppApi } from "./wa-types.js";

/** Same horizon as STALE_INBOUND_MS in whatsapp.ts: 24 h quiet while connected reads as a phone offline. */
export const STALE_AFTER_MS = 24 * 3_600_000;

export interface ChatFreshness {
  chat_id: string;
  /** ISO of the newest message wazap holds for this chat, or null when it holds none. */
  newest_local_at: string | null;
  newest_local_age_ms: number | null;
}

export interface HistoryFreshness {
  /** "in_progress" means the initial sync is still delivering — results may be partial. */
  sync: SyncState;
  /** ISO of the newest inbound message known to this account, store included. */
  last_message_received_at: string | null;
  last_message_age_ms: number | null;
  /** Connected but quiet longer than a day — the phone is probably offline. */
  stale: boolean;
  /** Present only on calls scoped to one chat: how far that chat's local history reaches. */
  chat?: ChatFreshness;
}

export function historyFreshness(status: StatusInfo, now = Date.now()): HistoryFreshness {
  const at = status.last_message_received_at === null ? null : Date.parse(status.last_message_received_at);
  const ageMs = at === null || Number.isNaN(at) ? null : Math.max(0, now - at);
  return {
    sync: status.sync,
    last_message_received_at: status.last_message_received_at,
    last_message_age_ms: ageMs,
    stale: status.status === "connected" && ageMs !== null && ageMs > STALE_AFTER_MS,
  };
}

/** The newest message wazap holds for one chat; a chat it has never seen reports null. */
export async function chatFreshness(wa: WhatsAppApi, chatId: string, now = Date.now()): Promise<ChatFreshness> {
  const newest = (await wa.readMessages?.(chatId, 1).catch(() => undefined))?.data.at(-1);
  const at = newest === undefined ? null : Date.parse(newest.timestamp);
  return {
    chat_id: newest?.chat_id ?? chatId,
    newest_local_at: newest?.timestamp ?? null,
    newest_local_age_ms: at === null || at === undefined || Number.isNaN(at) ? null : Math.max(0, now - at),
  };
}

/**
 * The compact block search and recall attach to their results, so an answer
 * carries its own freshness instead of sending the agent to get_status.
 * Status itself is a sync, cheap call; the per-chat read happens only when
 * the query named a chat.
 */
export async function readFreshness(wa: WhatsAppApi, chatId: string | undefined): Promise<HistoryFreshness | null> {
  if (typeof wa.getStatus !== "function") return null;
  let status: StatusInfo;
  try {
    status = wa.getStatus();
  } catch {
    return null;
  }
  const fresh = historyFreshness(status);
  if (chatId !== undefined) fresh.chat = await chatFreshness(wa, chatId);
  return fresh;
}

/** The one warning line a result deserves, or null when the history looks current. */
export function freshnessNote(fresh: HistoryFreshness | null, now = Date.now()): string | null {
  if (fresh === null) return null;
  if (fresh.sync === "in_progress") {
    return "History sync is still running — earlier messages may be missing from these results.";
  }
  if (fresh.stale) {
    const at = fresh.last_message_age_ms === null ? null : now - fresh.last_message_age_ms;
    return `Local history may be stale: nothing received${at === null ? "" : ` for ${formatAge(at, now).replace(/ ago$/, "")}`}; the phone may be offline.`;
  }
  return null;
}

/** The get_status line: sync state, then how long the newest inbound message has been on disk. */
export function historyLine(fresh: HistoryFreshness, now = Date.now()): string {
  const at = fresh.last_message_age_ms === null ? null : now - fresh.last_message_age_ms;
  const inbound =
    fresh.last_message_received_at === null
      ? "nothing inbound yet"
      : at === null
        ? `last inbound ${fresh.last_message_received_at}`
        : `last inbound ${fresh.last_message_received_at} (${formatAge(at, now)})`;
  const flag = fresh.stale ? " · stale" : "";
  return `sync ${fresh.sync} · ${inbound}${flag}`;
}
