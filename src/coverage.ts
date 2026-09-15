/**
 * How much of the local history a keyword search actually covered. A search
 * that answers "no messages found" must still say how much was looked through,
 * so an empty result never reads as an empty history.
 *
 * The scan mirrors searchMessages exactly — every held message of a real chat,
 * inside the scope and the time filters — so `searched` is literally the count
 * whose text was matched, and the bounds are the window the cap leaves on disk
 * and in memory.
 */

import { isNoiseJid } from "./ids.js";
import { isoWithOffset, messageTimestampMs } from "./messages.js";
import type { RecallStatus } from "./recall/index.js";
import { MAX_MESSAGES_PER_CHAT, Store } from "./store.js";
import type { WhatsAppApi } from "./wa-types.js";

export interface SearchCoverage {
  /** Held messages the scan ran over: in scope, and inside the time filters. */
  searched: number;
  /** Distinct chats those messages span. */
  chats: number;
  /** ISO bounds of the searched window; null when the scope held nothing. */
  oldest_at: string | null;
  newest_at: string | null;
  /** The newest slice of each chat that memory and disk both keep. */
  per_chat_cap: number;
}

/**
 * The coverage of one search_messages call, or null when `wa` is a stand-in
 * that does not carry the live store — the interface has no coverage call yet,
 * so the real service's own store is what gets counted. Never throws: a
 * coverage miss must not take a working search down with it.
 */
export function searchCoverage(
  wa: WhatsAppApi,
  chatId: string | undefined,
  opts: { sinceMs?: number; untilMs?: number } = {}
): SearchCoverage | null {
  try {
    const store = (wa as unknown as { store?: Store }).store;
    if (!(store instanceof Store)) return null;
    const scope = chatId === undefined ? undefined : store.lids.resolve(chatId);

    let searched = 0;
    let oldest = Number.POSITIVE_INFINITY;
    let newest = Number.NEGATIVE_INFINITY;
    const chats = new Set<string>();
    for (const [sid, raw] of store.messages) {
      const jid = store.chatOf.get(sid);
      if (!jid || isNoiseJid(jid) || (scope !== undefined && jid !== scope)) continue;
      const at = messageTimestampMs(raw);
      if ((opts.sinceMs !== undefined && at < opts.sinceMs) || (opts.untilMs !== undefined && at > opts.untilMs))
        continue;
      searched++;
      chats.add(jid);
      if (at < oldest) oldest = at;
      if (at > newest) newest = at;
    }
    return {
      searched,
      chats: chats.size,
      oldest_at: searched > 0 ? isoWithOffset(oldest) : null,
      newest_at: searched > 0 ? isoWithOffset(newest) : null,
      per_chat_cap: MAX_MESSAGES_PER_CHAT,
    };
  } catch {
    return null;
  }
}

const thousands = (n: number): string => n.toLocaleString("en-US");

/**
 * The line a keyword-search result carries: how many held messages were
 * scanned, over what span, and the cap that bounds each chat. With no store to
 * count, the cap alone is still declared.
 */
export function coverageNote(cov: SearchCoverage | null, scoped: boolean): string {
  const cap = `each chat keeps its newest ${thousands(MAX_MESSAGES_PER_CHAT)}`;
  if (cov === null) return `Searched the messages wazap holds locally; ${cap}.`;
  if (cov.searched === 0) return `Searched 0 held messages; ${cap}.`;
  const span =
    cov.oldest_at === null || cov.newest_at === null
      ? ""
      : `, ${cov.oldest_at.slice(0, 10)} → ${cov.newest_at.slice(0, 10)}`;
  const what = scoped ? "of this chat" : `across ${cov.chats} ${cov.chats === 1 ? "chat" : "chats"}`;
  return `Searched ${thousands(cov.searched)} held messages ${what}${span}; ${cap}.`;
}

/** The recall counterpart: the index is the window, and pending rows are still landing. */
export function indexCoverageNote(index: RecallStatus): string {
  const pending = index.pending > 0 ? ` (${thousands(index.pending)} still indexing)` : "";
  return `The recall index covers ${thousands(index.indexed)} messages${pending}.`;
}
