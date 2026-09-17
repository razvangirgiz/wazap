/**
 * The reads a catch-up digest is built from (catch_up, F2-2): aggregates over a
 * window of message ids, never a protobuf. Every read is bounded above by the
 * `untilId` the digest fixed when it started, so a message that arrives while a
 * digest is paged changes none of its pages; below by the window's start or a
 * chat's own floor (the user's last word, the phone's read mark).
 *
 *   const until = db.digest.maxId();
 *   for (const chat of db.digest.chatsActiveSince(ts)) {
 *     const family = families.get(chat.id) ?? [chat.id];
 *     db.digest.inbound(family, floor, until, now);   // counts, senders, media, mentions, replies
 *   }
 *
 * A chat still folding into another reads as part of it: callers pass the
 * chat's family (itself and the chats folding into it), and window-wide reads
 * name the chat a message reads under. "Inbound" is someone else's message a
 * reader may see — not a tombstone, not expired, not under the clear barrier —
 * that is not one of WhatsApp's own notices.
 */
import type { Connection } from "./connection.js";
import { chatFromRow, type ChatRow } from "./rows.js";
import type { ChatRecord } from "./types.js";

/** `m` a reader may see and someone else sent, not a notice; needs `m` and its chat `c`, binds now. */
const INBOUND = `m.from_me = 0 AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?)
  AND m.ts > coalesce(c.cleared_through_ts, 0) AND m.type <> 'system'`;

/** Media kinds a digest counts by type. */
export const DIGEST_MEDIA = ["image", "video", "voice", "audio", "document", "sticker", "location", "contact"] as const;
export type DigestMedia = (typeof DIGEST_MEDIA)[number];

export interface InboundAggregate {
  /** Inbound messages, calls left out (a call is its own section). */
  count: number;
  senders: number;
  newestId: number | null;
  newestTs: number | null;
  media: Partial<Record<DigestMedia, number>>;
  /** Polls and events. */
  polls: number;
  mentions: number;
  lastMentionId: number | null;
  replies: number;
  lastReplyId: number | null;
  /** Voice notes without a transcript. */
  voiceUntranscribed: number;
}

export interface TailMessage {
  id: number;
  keyId: string;
  ts: number;
  type: string;
  flags: number;
  quotedFromMe: boolean;
  senderId: number | null;
  text: string;
  transcript: string | null;
}

export interface WindowMessage {
  id: number;
  keyId: string;
  /** The chat it reads under: the one its chat folds into, while that fold runs. */
  chatId: number;
  chatJid: string;
  fromMe: boolean;
  senderId: number | null;
  ts: number;
  type: string;
  text: string;
}

export interface DigestContact {
  id: number;
  jid: string | null;
  name: string | null;
  verifiedName: string | null;
  listed: number | null;
}

function familyCondition(family: readonly number[]): { sql: string; params: Array<number | string> } {
  return family.length === 1
    ? { sql: "m.chat_id = ?", params: [family[0]!] }
    : { sql: "m.chat_id IN (SELECT value FROM json_each(?))", params: [JSON.stringify(family)] };
}

export class Digest {
  constructor(private readonly c: Connection) {}

  /** The newest message id the account holds, whatever it is: the top a digest fixes when it starts. */
  maxId(): number {
    return this.c.get<{ id: number | null }>("SELECT max(id) AS id FROM messages")?.id ?? 0;
  }

  /** Chats (not folding into another) whose newest visible message is at or after `ts`, newest first. */
  chatsActiveSince(ts: number): ChatRecord[] {
    return this.c
      .all<ChatRow>(
        `SELECT * FROM chats INDEXED BY chats_recent WHERE last_ts >= ? AND merged_into IS NULL ORDER BY last_ts DESC, id DESC`,
        ts
      )
      .map(chatFromRow);
  }

  /** Each chat with others still folding into it, and those others: whose messages read as its own. */
  families(): Map<number, number[]> {
    const families = new Map<number, number[]>();
    for (const row of this.c.all<{ id: number; merged_into: number }>(
      "SELECT id, merged_into FROM chats INDEXED BY chats_merging WHERE merged_into IS NOT NULL ORDER BY id"
    )) {
      const family = families.get(row.merged_into) ?? [row.merged_into];
      family.push(row.id);
      families.set(row.merged_into, family);
    }
    return families;
  }

  /** The newest message of the user's own in the chat at or before `untilId`, walked back off messages_own. */
  ownThrough(family: readonly number[], untilId: number): number | null {
    const inChat = familyCondition(family);
    return (
      this.c.get<{ id: number | null }>(
        `SELECT max(m.id) AS id FROM messages m INDEXED BY messages_own
         WHERE ${inChat.sql} AND m.from_me = 1 AND m.deleted_at IS NULL AND m.id <= ?`,
        ...inChat.params,
        untilId
      )?.id ?? null
    );
  }

  /** Whether the user wrote in the chat in (afterId, untilId] — a message, not a call — off messages_own. */
  ownWroteIn(family: readonly number[], afterId: number, untilId: number): boolean {
    const inChat = familyCondition(family);
    return (
      this.c.get(
        `SELECT 1 FROM messages m INDEXED BY messages_own
         WHERE ${inChat.sql} AND m.from_me = 1 AND m.deleted_at IS NULL AND m.id > ? AND m.id <= ? AND m.type NOT IN ('call', 'system')
         LIMIT 1`,
        ...inChat.params,
        afterId,
        untilId
      ) !== undefined
    );
  }

  /** What someone else sent in the chat in (afterId, untilId], in one pass over its (chat_id, id) index. */
  inbound(family: readonly number[], afterId: number, untilId: number, now: number): InboundAggregate {
    const inChat = familyCondition(family);
    const row = this.c.get<Record<string, number | null>>(
      `SELECT sum(m.type <> 'call') AS count, count(DISTINCT CASE WHEN m.type <> 'call' THEN m.sender_id END) AS senders,
         max(CASE WHEN m.type <> 'call' THEN m.id END) AS newest_id, max(CASE WHEN m.type <> 'call' THEN m.ts END) AS newest_ts,
         ${DIGEST_MEDIA.map((type) => `sum(m.type = '${type}') AS media_${type}`).join(", ")},
         sum(m.type IN ('poll', 'event')) AS polls,
         sum((m.flags & 1) <> 0) AS mentions, max(CASE WHEN (m.flags & 1) <> 0 THEN m.id END) AS last_mention,
         sum(m.quoted_from_me = 1) AS replies, max(CASE WHEN m.quoted_from_me = 1 THEN m.id END) AS last_reply,
         sum(m.type = 'voice' AND m.transcript IS NULL) AS voice_untranscribed
       FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
       WHERE ${inChat.sql} AND m.id > ? AND m.id <= ? AND ${INBOUND}`,
      ...inChat.params,
      afterId,
      untilId,
      now
    )!;
    const media: Partial<Record<DigestMedia, number>> = {};
    for (const type of DIGEST_MEDIA) {
      const n = row[`media_${type}`] ?? 0;
      if (n > 0) media[type] = n;
    }
    return {
      count: row.count ?? 0,
      senders: row.senders ?? 0,
      newestId: row.newest_id ?? null,
      newestTs: row.newest_ts ?? null,
      media,
      polls: row.polls ?? 0,
      mentions: row.mentions ?? 0,
      lastMentionId: row.last_mention ?? null,
      replies: row.replies ?? 0,
      lastReplyId: row.last_reply ?? null,
      voiceUntranscribed: row.voice_untranscribed ?? 0,
    };
  }

  /** How many inbound messages the chat holds in (afterId, untilId], counting at most `cap`. */
  inboundCount(family: readonly number[], afterId: number, untilId: number, now: number, cap: number): number {
    const inChat = familyCondition(family);
    return (
      this.c.get<{ n: number }>(
        `SELECT count(*) AS n FROM (SELECT 1 FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
           WHERE ${inChat.sql} AND m.id > ? AND m.id <= ? AND ${INBOUND} AND m.type <> 'call' LIMIT ?)`,
        ...inChat.params,
        afterId,
        untilId,
        now,
        cap
      )?.n ?? 0
    );
  }

  /**
   * The newest inbound messages of the chat in (afterId, untilId], newest
   * first, with the words they read as: `text` is the stored rendering, cut to
   * `maxChars`, and a voice note's transcript rides along.
   */
  inboundTail(family: readonly number[], afterId: number, untilId: number, now: number, limit: number, maxChars = 2000): TailMessage[] {
    const inChat = familyCondition(family);
    return this.c
      .all<{
        id: number;
        key_id: string;
        ts: number;
        type: string;
        flags: number;
        quoted_from_me: number | null;
        sender_id: number | null;
        text: string | null;
        transcript: string | null;
      }>(
        `SELECT m.id, m.key_id, m.ts, m.type, m.flags, m.quoted_from_me, m.sender_id, substr(m.text, 1, ?) AS text, substr(m.transcript, 1, ?) AS transcript
         FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
         WHERE ${inChat.sql} AND m.id > ? AND m.id <= ? AND ${INBOUND} AND m.type <> 'call'
         ORDER BY m.id DESC LIMIT ?`,
        maxChars,
        maxChars,
        ...inChat.params,
        afterId,
        untilId,
        now,
        limit
      )
      .map((row) => ({
        id: row.id,
        keyId: row.key_id,
        ts: row.ts,
        type: row.type,
        flags: row.flags,
        quotedFromMe: row.quoted_from_me === 1,
        senderId: row.sender_id,
        text: row.text ?? "",
        transcript: row.transcript,
      }));
  }

  /** Who wrote most in the chat in (afterId, untilId], at most `limit`, the most recent first among equals. */
  topSenders(family: readonly number[], afterId: number, untilId: number, now: number, limit = 3): Array<{ senderId: number; count: number }> {
    const inChat = familyCondition(family);
    return this.c
      .all<{ sender_id: number; n: number }>(
        `SELECT m.sender_id, count(*) AS n FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
         WHERE ${inChat.sql} AND m.id > ? AND m.id <= ? AND ${INBOUND} AND m.type <> 'call' AND m.sender_id IS NOT NULL
         GROUP BY m.sender_id ORDER BY n DESC, max(m.id) DESC LIMIT ?`,
        ...inChat.params,
        afterId,
        untilId,
        now,
        limit
      )
      .map((row) => ({ senderId: row.sender_id, count: row.n }));
  }

  /** The inbound message in (afterId, untilId] with the most reactions, when at least `min` people reacted. */
  mostReacted(family: readonly number[], afterId: number, untilId: number, now: number, min = 2): number | null {
    const inChat = familyCondition(family);
    return (
      this.c.get<{ id: number }>(
        `SELECT m.id FROM messages m CROSS JOIN chats c ON c.id = m.chat_id CROSS JOIN reactions r ON r.message_id = m.id
         WHERE ${inChat.sql} AND m.id > ? AND m.id <= ? AND ${INBOUND}
         GROUP BY m.id HAVING count(*) >= ? ORDER BY count(*) DESC, m.id DESC LIMIT 1`,
        ...inChat.params,
        afterId,
        untilId,
        now,
        min
      )?.id ?? null
    );
  }

  /** Voice notes someone sent in (afterId, untilId] that have no transcript, newest first. */
  untranscribedVoice(family: readonly number[], afterId: number, untilId: number, now: number, limit: number): Array<{ id: number; keyId: string }> {
    const inChat = familyCondition(family);
    return this.c
      .all<{ id: number; key_id: string }>(
        `SELECT m.id, m.key_id FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
         WHERE ${inChat.sql} AND m.id > ? AND m.id <= ? AND ${INBOUND} AND m.type = 'voice' AND m.transcript IS NULL
         ORDER BY m.id DESC LIMIT ?`,
        ...inChat.params,
        afterId,
        untilId,
        now,
        limit
      )
      .map((row) => ({ id: row.id, keyId: row.key_id }));
  }

  /** Every handled mark, by the chat it was filed under. */
  handled(): Map<number, { askId: number | null; at: number }> {
    return new Map(
      this.c
        .all<{ chat_id: number; ask_message_id: number | null; at: number }>("SELECT chat_id, ask_message_id, at FROM handled")
        .map((row) => [row.chat_id, { askId: row.ask_message_id, at: row.at }])
    );
  }

  /** The calls in (afterId, untilId], both ways, oldest first, off the messages_calls index. */
  calls(afterId: number, untilId: number, now: number): WindowMessage[] {
    return this.windowRows("messages_calls", "m.type = 'call'", afterId, untilId, now);
  }

  /** Polls and events someone else posted in (afterId, untilId] that `voterId` has not answered, oldest first. */
  openPolls(afterId: number, untilId: number, now: number, voterId: number | null): WindowMessage[] {
    return this.windowRows(
      "messages_polls",
      "m.type IN ('poll', 'event') AND m.from_me = 0 AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.message_id = m.id AND v.contact_id = ?)",
      afterId,
      untilId,
      now,
      [voterId ?? -1]
    );
  }

  private windowRows(index: string, where: string, afterId: number, untilId: number, now: number, params: number[] = []): WindowMessage[] {
    return this.c
      .all<{
        id: number;
        key_id: string;
        chat_id: number;
        chat_jid: string;
        from_me: number;
        sender_id: number | null;
        ts: number;
        type: string;
        text: string | null;
      }>(
        `SELECT m.id, m.key_id, coalesce(ck.id, c.id) AS chat_id, coalesce(ck.jid, c.jid) AS chat_jid, m.from_me, m.sender_id, m.ts, m.type,
           substr(m.text, 1, 300) AS text
         FROM messages m INDEXED BY ${index} CROSS JOIN chats c ON c.id = m.chat_id LEFT JOIN chats ck ON ck.id = c.merged_into
         WHERE m.id > ? AND m.id <= ? AND ${where} AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?)
           AND m.ts > coalesce(c.cleared_through_ts, 0)
         ORDER BY m.id`,
        afterId,
        untilId,
        ...params,
        now
      )
      .map((row) => ({
        id: row.id,
        keyId: row.key_id,
        chatId: row.chat_id,
        chatJid: row.chat_jid,
        fromMe: row.from_me === 1,
        senderId: row.sender_id,
        ts: row.ts,
        type: row.type,
        text: row.text ?? "",
      }));
  }

  /** The stories someone posted in (afterId, untilId]: how many, and their authors, the most recent first. */
  stories(statusChatId: number, afterId: number, untilId: number, now: number): { count: number; authors: number[] } {
    const rows = this.c.all<{ sender_id: number | null; n: number }>(
      `SELECT m.sender_id, count(*) AS n FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
       WHERE m.chat_id = ? AND m.id > ? AND m.id <= ? AND ${INBOUND}
       GROUP BY m.sender_id ORDER BY max(m.id) DESC`,
      statusChatId,
      afterId,
      untilId,
      now
    );
    return {
      count: rows.reduce((n, row) => n + row.n, 0),
      authors: rows.flatMap((row) => (row.sender_id === null ? [] : [row.sender_id])),
    };
  }

  /** People by contact id, the rows they merge into read in their place. */
  contacts(ids: readonly number[]): Map<number, DigestContact> {
    const out = new Map<number, DigestContact>();
    if (ids.length === 0) return out;
    for (const row of this.c.all<{
      asked: number;
      id: number;
      phone_jid: string | null;
      lid: string | null;
      name: string | null;
      verified_name: string | null;
      listed: number | null;
    }>(
      `SELECT j.value AS asked, k.id, k.phone_jid, k.lid, k.name, k.verified_name, k.listed
       FROM json_each(?) j CROSS JOIN contacts o ON o.id = j.value CROSS JOIN contacts k ON k.id = coalesce(o.merged_into, o.id)`,
      JSON.stringify([...new Set(ids)])
    )) {
      out.set(row.asked, { id: row.id, jid: row.phone_jid ?? row.lid, name: row.name, verifiedName: row.verified_name, listed: row.listed });
    }
    return out;
  }

  /** The contacts (people, and the rows groups keep notes on) filed under `tag`: their ids and jids. */
  tagged(tag: string): { contactIds: Set<number>; jids: Set<string> } {
    const contactIds = new Set<number>();
    const jids = new Set<string>();
    const needle = JSON.stringify(tag);
    for (const row of this.c.all<{ id: number; phone_jid: string | null; lid: string | null; tags: string }>(
      `SELECT k.id, k.phone_jid, k.lid, n.tags FROM contact_notes n CROSS JOIN contacts k ON k.id = n.contact_id
       WHERE n.tags IS NOT NULL AND instr(n.tags, ?) > 0`,
      needle
    )) {
      let tags: unknown;
      try {
        tags = JSON.parse(row.tags);
      } catch {
        continue;
      }
      if (!Array.isArray(tags) || !tags.includes(tag)) continue;
      contactIds.add(row.id);
      if (row.phone_jid !== null) jids.add(row.phone_jid);
      if (row.lid !== null) jids.add(row.lid);
    }
    return { contactIds, jids };
  }

  /** The status feed's chat row, if any story ever arrived. */
  statusChatId(): number | null {
    return this.c.get<{ id: number }>("SELECT id FROM chats WHERE jid = 'status@broadcast'")?.id ?? null;
  }
}
