/**
 * Messages and everything hanging off them: the upsert with its barriers,
 * tombstones, expiry, clearing and deleting chats, reactions, votes,
 * receipts, derived media files, and the reads the tools page through.
 *
 * The barriers, in the order a write meets them:
 * 1. a tombstone is final — no upsert touches a deleted row again;
 * 2. a chat cleared through T refuses every message at or before T;
 * 3. an expiry only ever moves earlier, and a message past it is stored as a
 *    tombstone so a replay without the ephemeral marker cannot revive it;
 * 4. an older version never overwrites a newer stored edit.
 */
import { performance } from "node:perf_hooks";
import type { Connection } from "./connection.js";
import { StorageError } from "./errors.js";
import { checkInstant, checkTimestamp, firstIdOfSecond, idLowerBound, idUpperBound, SEQ_SPAN } from "./ids.js";
import { parseSid, sidOf, type Identity, type MessageKey } from "./identity.js";
import {
  chatFromRow,
  MESSAGE_COLUMNS,
  MESSAGE_FROM,
  messageFromRow,
  RECOMPUTE_LAST,
  VISIBLE,
  type ChatRow,
  type MessageRow,
} from "./rows.js";
import type {
  BulkDeleteResult,
  ChatCursor,
  ChatKind,
  ChatListItem,
  ChatRecord,
  Coverage,
  DeleteResult,
  MediaRecord,
  MessageInput,
  Page,
  Reaction,
  Receipt,
  StoredMessage,
  UpsertResult,
  Vote,
  WaitingCandidate,
} from "./types.js";

/**
 * Removes the embedded copy of a quoted message from a quoting message's
 * protobuf. The storage layer does not parse protobuf; the service supplies
 * this, and a retraction then scrubs every quote of the retracted message.
 */
export type ScrubQuote = (raw: Uint8Array, quotedSid: string) => Uint8Array | null;

const MAX_PAGE = 1_000;
/** A message's public sid in SQL, over the canonical jid of the chat it reads as part of; needs `m`, `c` and `ck`. */
const SID_EXPR = `(CASE WHEN m.from_me = 1 THEN 'true' ELSE 'false' END) || '_' || coalesce(ck.jid, c.jid) || '_' || m.key_id`;
const NO_UPPER_BOUND = Number.MAX_SAFE_INTEGER;

/**
 * The single upsert. On a key conflict the row keeps its id, and content only
 * moves when the incoming version is not older than the stored edit; status
 * only rises, expiry only falls, a transcript or sender is never erased. A
 * tombstone matches no update at all.
 */
const FRESH = "(messages.edited_at IS NULL OR (excluded.edited_at IS NOT NULL AND excluded.edited_at >= messages.edited_at))";
const UPSERT_SQL = `
INSERT INTO messages(id, chat_id, key_id, from_me, sender_id, ts, type, quoted_sid, quoted_from_me, quoted_key_id, status,
  edited_at, expires_at, text, transcript, raw)
VALUES (:id, :chat_id, :key_id, :from_me, :sender_id, :ts, :type, :quoted_sid, :quoted_from_me, :quoted_key_id, :status,
  :edited_at, :expires_at, :text, :transcript, :raw)
ON CONFLICT(chat_id, from_me, key_id) DO UPDATE SET
  type = CASE WHEN ${FRESH} THEN excluded.type ELSE messages.type END,
  text = CASE WHEN ${FRESH} THEN coalesce(excluded.text, messages.text) ELSE messages.text END,
  raw = CASE WHEN ${FRESH} THEN coalesce(excluded.raw, messages.raw) ELSE messages.raw END,
  quoted_sid = CASE WHEN ${FRESH} THEN coalesce(excluded.quoted_sid, messages.quoted_sid) ELSE messages.quoted_sid END,
  quoted_from_me = CASE WHEN ${FRESH} AND excluded.quoted_key_id IS NOT NULL THEN excluded.quoted_from_me
    ELSE messages.quoted_from_me END,
  quoted_key_id = CASE WHEN ${FRESH} THEN coalesce(excluded.quoted_key_id, messages.quoted_key_id) ELSE messages.quoted_key_id END,
  edited_at = CASE WHEN ${FRESH} THEN coalesce(excluded.edited_at, messages.edited_at) ELSE messages.edited_at END,
  transcript = coalesce(excluded.transcript, messages.transcript),
  sender_id = coalesce(messages.sender_id, excluded.sender_id),
  status = CASE WHEN excluded.status IS NULL THEN messages.status WHEN messages.status IS NULL THEN excluded.status
    ELSE max(messages.status, excluded.status) END,
  expires_at = CASE WHEN excluded.expires_at IS NULL THEN messages.expires_at WHEN messages.expires_at IS NULL
    THEN excluded.expires_at ELSE min(messages.expires_at, excluded.expires_at) END
WHERE messages.deleted_at IS NULL`;

/** The quoted message's direction and key, parsed once; a quote is matched by these, never by spelling. */
function quoteColumns(quotedSid: string | null): { quoted_sid: string | null; quoted_from_me: number | null; quoted_key_id: string | null } {
  const parsed = quotedSid === null ? null : parseSid(quotedSid);
  return {
    quoted_sid: quotedSid,
    quoted_from_me: parsed === null || parsed.fromMe === null ? null : parsed.fromMe ? 1 : 0,
    quoted_key_id: parsed?.keyId ?? null,
  };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return MAX_PAGE;
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(limit)));
}

function earliest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function pageOf(items: StoredMessage[], limit: number): Page<StoredMessage> {
  const hasMore = items.length > limit;
  const kept = hasMore ? items.slice(0, limit) : items;
  return { items: kept, hasMore, nextBefore: hasMore ? kept[kept.length - 1]!.id : null };
}

function idsJson(ids: readonly number[]): string {
  return JSON.stringify(ids);
}

/** `m.chat_id` against one chat, or against a chat and the chats still folding into it. */
export function chatCondition(ids: readonly number[]): { sql: string; params: Array<number | string> } {
  return ids.length === 1
    ? { sql: "m.chat_id = ?", params: [ids[0]!] }
    : { sql: "m.chat_id IN (SELECT value FROM json_each(?))", params: [JSON.stringify(ids)] };
}

export class Messages {
  constructor(
    private readonly c: Connection,
    private readonly identity: Identity,
    private readonly scrubQuote: ScrubQuote | null = null
  ) {}

  /** The next free id in the message's second: after the newest one, or in a gap when the top is taken. */
  allocateId(ts: number): number {
    const base = firstIdOfSecond(ts);
    const top = base + SEQ_SPAN;
    const newest = this.c.get<{ id: number }>(
      "SELECT id FROM messages WHERE id >= ? AND id < ? ORDER BY id DESC LIMIT 1",
      base,
      top
    );
    if (newest === undefined) return base;
    if (newest.id + 1 < top) return newest.id + 1;
    if (this.c.get("SELECT 1 FROM messages WHERE id = ?", base) === undefined) return base;
    const gap = this.c.get<{ id: number }>(
      `SELECT m.id + 1 AS id FROM messages m WHERE m.id >= ? AND m.id < ?
         AND NOT EXISTS (SELECT 1 FROM messages n WHERE n.id = m.id + 1) ORDER BY m.id LIMIT 1`,
      base,
      top - 1
    );
    if (gap !== undefined) return gap.id;
    throw new StorageError("ID_SPACE_EXHAUSTED", `Second ${Math.floor(ts / 1000)} already holds ${SEQ_SPAN} messages.`);
  }

  upsert(input: MessageInput): UpsertResult {
    return this.c.write(() => this.upsertOne(input));
  }

  /** Many messages in one transaction: the import and history-sync path. */
  upsertMany(inputs: readonly MessageInput[]): UpsertResult[] {
    return this.c.write(() => inputs.map((input) => this.upsertOne(input)));
  }

  private upsertOne(input: MessageInput): UpsertResult {
    const ts = checkTimestamp(input.ts, "ts");
    const expiresAt = checkInstant(input.expiresAt, "expiresAt");
    const editedAt = checkInstant(input.editedAt, "editedAt");
    if (!input.chatJid || !input.keyId || !input.type || typeof input.fromMe !== "boolean") {
      throw new StorageError("INVALID_INPUT", "A message needs a chat jid, a key id, a direction and a type.");
    }
    const now = this.c.now();
    let chat = this.identity.chat(input.chatJid);
    const existing = chat === null ? null : this.identity.findByKey(chat, input.fromMe, input.keyId);
    if (existing !== null) return this.mergeExisting(existing, input, expiresAt, editedAt, now);

    if (chat !== null && chat.clearedThroughTs !== null && ts <= chat.clearedThroughTs) {
      return { outcome: "cleared", id: null, sid: null };
    }
    chat ??= this.identity.ensureChat(input.chatJid);
    const sid = sidOf(input.fromMe, chat.jid, input.keyId);
    const id = this.allocateId(ts);
    const senderId = this.senderIdFor(input, chat);

    const gone = this.wasRetracted(chat, input.fromMe, input.keyId);
    if (gone !== null) {
      // Its tombstone was purged with a clear, but the message stays gone.
      this.c.run(
        `INSERT INTO messages(id, chat_id, key_id, from_me, sender_id, ts, type, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        chat.id,
        input.keyId,
        input.fromMe ? 1 : 0,
        senderId,
        ts,
        input.type,
        gone
      );
      return { outcome: "deleted", id, sid };
    }

    if (expiresAt !== null && expiresAt <= now) {
      this.c.run(
        `INSERT INTO messages(id, chat_id, key_id, from_me, sender_id, ts, type, expires_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        chat.id,
        input.keyId,
        input.fromMe ? 1 : 0,
        senderId,
        ts,
        input.type,
        expiresAt,
        now
      );
      this.recordRetracted(chat.id, input.fromMe, input.keyId, now);
      return { outcome: "expired", id, sid };
    }

    this.c.stmt(UPSERT_SQL).run({
      id,
      chat_id: chat.id,
      key_id: input.keyId,
      from_me: input.fromMe ? 1 : 0,
      sender_id: senderId,
      ts,
      type: input.type,
      ...quoteColumns(input.quotedSid ?? null),
      status: input.status ?? null,
      edited_at: editedAt,
      expires_at: expiresAt,
      text: input.text ?? null,
      transcript: input.transcript ?? null,
      raw: this.scrubbedRaw(input.raw ?? null, input.quotedSid ?? null),
    });
    return { outcome: "inserted", id, sid };
  }

  private mergeExisting(
    existing: MessageKey,
    input: MessageInput,
    expiresAt: number | null,
    editedAt: number | null,
    now: number
  ): UpsertResult {
    if (existing.deleted_at !== null) return { outcome: "deleted", id: existing.id, sid: existing.sid };
    const chat = existing.chat;
    if (chat.clearedThroughTs !== null && existing.ts <= chat.clearedThroughTs) {
      return { outcome: "cleared", id: null, sid: null };
    }
    const deadline = earliest(existing.expires_at, expiresAt);
    if (deadline !== null && deadline <= now) {
      // Past its deadline: the expiry sweep tombstones it and hands back its files.
      if (deadline !== existing.expires_at) {
        this.c.run("UPDATE messages SET expires_at = ? WHERE id = ?", deadline, existing.id);
      }
      return { outcome: "expired", id: existing.id, sid: existing.sid };
    }
    const stale = existing.edited_at !== null && (editedAt === null || editedAt < existing.edited_at);
    this.c.stmt(UPSERT_SQL).run({
      id: existing.id,
      chat_id: existing.chat_id,
      key_id: existing.key_id,
      from_me: existing.from_me,
      sender_id: this.senderIdFor(input, chat),
      ts: existing.ts,
      type: input.type,
      ...quoteColumns(input.quotedSid ?? null),
      status: input.status ?? null,
      edited_at: editedAt,
      expires_at: expiresAt,
      text: input.text ?? null,
      transcript: input.transcript ?? null,
      raw: this.scrubbedRaw(input.raw ?? null, input.quotedSid ?? null),
    });
    return { outcome: stale ? "stale" : "updated", id: existing.id, sid: existing.sid };
  }

  private senderIdFor(input: MessageInput, chat: ChatRecord): number | null {
    if (input.senderJid) return this.identity.ensureContact(input.senderJid);
    return !input.fromMe && chat.kind === "direct" ? chat.contactId : null;
  }

  /** When the message with this key in this chat was deleted, retracted or expired; null when it never was. */
  private wasRetracted(chat: ChatRecord, fromMe: boolean, keyId: string): number | null {
    const inChat = chatCondition(this.identity.chatIdsOf(chat));
    const row = this.c.get<{ at: number }>(
      `SELECT at FROM retracted m WHERE key_id = ? AND from_me = ? AND ${inChat.sql} LIMIT 1`,
      keyId,
      fromMe ? 1 : 0,
      ...inChat.params
    );
    return row?.at ?? null;
  }

  /** The content-free record of a message gone for good. Call inside write(). */
  private recordRetracted(chatId: number, fromMe: boolean | number, keyId: string, at: number): void {
    this.c.run(
      "INSERT OR IGNORE INTO retracted(key_id, from_me, chat_id, at) VALUES (?, ?, ?, ?)",
      keyId,
      fromMe === true || fromMe === 1 ? 1 : 0,
      chatId,
      at
    );
  }

  /**
   * A quote of a deleted message arrives without its embedded copy. The quote
   * is matched by the quoted message's direction and WhatsApp key, whichever
   * address spelled it; stanza ids are random enough that the chat is not
   * needed, and a false match only ever removes a copy.
   */
  private scrubbedRaw(raw: Uint8Array | null, quotedSid: string | null): Uint8Array | null {
    if (raw === null || quotedSid === null || this.scrubQuote === null) return raw;
    const { quoted_from_me: fromMe, quoted_key_id: keyId } = quoteColumns(quotedSid);
    if (keyId === null) return raw;
    const gone =
      fromMe === null
        ? this.c.get("SELECT 1 FROM retracted WHERE key_id = ? LIMIT 1", keyId)
        : this.c.get("SELECT 1 FROM retracted WHERE key_id = ? AND from_me = ? LIMIT 1", keyId, fromMe);
    return gone === undefined ? raw : this.scrubQuote(raw, quotedSid);
  }

  /** Every live quote of `messageId`, however its address was spelled, loses its embedded copy of it. */
  private scrubQuotesOf(messageId: number): void {
    if (this.scrubQuote === null) return;
    const target = this.c.get<{ from_me: number; key_id: string }>("SELECT from_me, key_id FROM messages WHERE id = ?", messageId);
    if (target === undefined) return;
    const quoting = this.c.all<{ id: number; raw: Uint8Array; quoted_sid: string }>(
      `SELECT id, raw, quoted_sid FROM messages
       WHERE quoted_key_id = ? AND (quoted_from_me IS NULL OR quoted_from_me = ?) AND raw IS NOT NULL AND deleted_at IS NULL`,
      target.key_id,
      target.from_me
    );
    for (const row of quoting) {
      this.c.run("UPDATE messages SET raw = ? WHERE id = ?", this.scrubQuote(row.raw, row.quoted_sid), row.id);
    }
  }

  /** The row becomes a tombstone; returns the derived files to unlink after commit. Call inside write(). */
  tombstone(messageId: number, at: number): string[] {
    const paths = this.c.all<{ path: string }>("SELECT path FROM media WHERE message_id = ?", messageId).map((r) => r.path);
    this.c.run("DELETE FROM media WHERE message_id = ?", messageId);
    this.c.run(
      "UPDATE messages SET deleted_at = ?, text = NULL, transcript = NULL, raw = NULL WHERE id = ? AND deleted_at IS NULL",
      at,
      messageId
    );
    this.c.run(
      "INSERT OR IGNORE INTO retracted(key_id, from_me, chat_id, at) SELECT key_id, from_me, chat_id, ? FROM messages WHERE id = ?",
      at,
      messageId
    );
    this.scrubQuotesOf(messageId);
    return this.released(paths);
  }

  /** The paths no media row references any more: the ones the delete queued for unlinking. */
  private released(paths: readonly string[]): string[] {
    return [...new Set(paths)].filter((path) => this.c.get("SELECT 1 FROM media WHERE path = ?", path) === undefined);
  }

  /**
   * Delete for me, or a retraction for everyone: the message becomes a
   * tombstone. A retraction for a message not seen yet stores the tombstone
   * ahead of it, at the protocol timestamp (`ts`), never at 0.
   */
  delete(
    sid: string,
    options: { at?: number; ts?: number; chatJid?: string; keyId?: string; fromMe?: boolean } = {}
  ): DeleteResult {
    const result = this.c.write((): DeleteResult => {
      const at = checkInstant(options.at, "at") ?? this.c.now();
      const parsed = parseSid(sid);
      const chatJid = options.chatJid ?? parsed?.chatJid;
      const keyId = options.keyId ?? parsed?.keyId;
      const fromMe = options.fromMe ?? parsed?.fromMe ?? undefined;
      const existing =
        chatJid !== undefined && keyId !== undefined && fromMe !== undefined
          ? this.findKey(chatJid, fromMe, keyId)
          : this.identity.findMessage(sid);
      if (existing !== null) {
        if (existing.deleted_at !== null) return { outcome: "already", id: existing.id, mediaPaths: [] };
        return { outcome: "deleted", id: existing.id, mediaPaths: this.tombstone(existing.id, at) };
      }
      if (chatJid === undefined || keyId === undefined || fromMe === undefined) {
        throw new StorageError("INVALID_INPUT", `A tombstone for the unseen ${sid} needs its chat, key and direction.`);
      }
      const ts = checkTimestamp(options.ts, "ts");
      let chat = this.identity.chat(chatJid);
      if (chat !== null && chat.clearedThroughTs !== null && ts <= chat.clearedThroughTs) {
        return { outcome: "cleared", id: null, mediaPaths: [] };
      }
      chat ??= this.identity.ensureChat(chatJid);
      const id = this.allocateId(ts);
      this.c.run(
        `INSERT INTO messages(id, chat_id, key_id, from_me, ts, type, deleted_at) VALUES (?, ?, ?, ?, ?, 'deleted', ?)`,
        id,
        chat.id,
        keyId,
        fromMe ? 1 : 0,
        ts,
        at
      );
      this.recordRetracted(chat.id, fromMe, keyId, at);
      this.scrubQuotesOf(id);
      return { outcome: "placeholder", id, mediaPaths: [] };
    });
    if (result.outcome === "deleted") this.c.scheduleCheckpoint();
    return result;
  }

  private findKey(chatJid: string, fromMe: boolean, keyId: string): MessageKey | null {
    const chat = this.identity.chat(chatJid);
    return chat === null ? null : this.identity.findByKey(chat, fromMe, keyId);
  }

  /** A transcript arrived for a live message; it joins the search index and drops a stale embedding. */
  setTranscript(sid: string, transcript: string): boolean {
    return this.c.write(() => {
      const key = this.identity.findMessage(sid);
      if (key === null) return false;
      return this.c.run("UPDATE messages SET transcript = ? WHERE id = ? AND deleted_at IS NULL", transcript, key.id) > 0;
    });
  }

  /** Delivery status only rises. */
  setStatus(sid: string, status: number): boolean {
    return this.c.write(() => {
      const key = this.identity.findMessage(sid);
      if (key === null) return false;
      return (
        this.c.run(
          "UPDATE messages SET status = ? WHERE id = ? AND deleted_at IS NULL AND (status IS NULL OR status < ?)",
          status,
          key.id,
          status
        ) > 0
      );
    });
  }

  /** A deadline only ever moves earlier; a later one is ignored. */
  setExpiry(sid: string, at: number): boolean {
    const deadline = checkInstant(at, "at")!;
    return this.c.write(() => {
      const key = this.identity.findMessage(sid);
      if (key === null) return false;
      return (
        this.c.run(
          "UPDATE messages SET expires_at = ? WHERE id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
          deadline,
          key.id,
          deadline
        ) > 0
      );
    });
  }

  /** The earliest pending deadline, for the expiry timer. */
  nextExpiry(): number | null {
    const row = this.c.get<{ expires_at: number }>(
      `SELECT expires_at FROM messages INDEXED BY messages_expiry
       WHERE expires_at IS NOT NULL AND deleted_at IS NULL ORDER BY expires_at LIMIT 1`
    );
    return row?.expires_at ?? null;
  }

  /** Every message past its deadline becomes a tombstone, a chunk per transaction. */
  expireDue(): Promise<BulkDeleteResult> {
    return this.c.bulk(async () => {
      const result: BulkDeleteResult = { count: 0, sids: [], mediaPaths: [] };
      await this.c.chunked(() => {
        const now = this.c.now();
        const started = performance.now();
        const due = this.c.all<{ id: number; sid: string }>(
          `SELECT m.id, ${SID_EXPR} AS sid FROM messages m INDEXED BY messages_expiry
             JOIN chats c ON c.id = m.chat_id LEFT JOIN chats ck ON ck.id = c.merged_into
           WHERE m.expires_at IS NOT NULL AND m.deleted_at IS NULL AND m.expires_at <= ? ORDER BY m.expires_at LIMIT ?`,
          now,
          this.c.chunkSize
        );
        let done = 0;
        for (const row of due) {
          result.mediaPaths.push(...this.tombstone(row.id, now));
          result.sids.push(row.sid);
          done++;
          if (performance.now() - started > this.c.chunkBudgetMs) break;
        }
        result.count += done;
        return due.length === this.c.chunkSize || done < due.length;
      });
      if (result.count > 0) this.c.checkpoint();
      return result;
    });
  }

  /**
   * Clear a chat through `throughTs`, inclusive: the barrier is stored first,
   * so nothing at or before it can come back, then the rows go in chunks.
   */
  clearChat(chatJid: string, throughTs: number): Promise<BulkDeleteResult> {
    const through = checkTimestamp(throughTs, "throughTs");
    // Raised now, not when the queued purge starts: from this call on nothing at or before it is accepted.
    const chat = this.raiseBarrier(chatJid, through);
    return this.c.bulk(() => this.purgeCleared(chat.id));
  }

  /** Clear, then drop what made the chat a list entry: it leaves the chat list until a new message arrives. */
  deleteChat(chatJid: string, throughTs: number): Promise<BulkDeleteResult> {
    const through = checkTimestamp(throughTs, "throughTs");
    const chat = this.raiseBarrier(chatJid, through);
    return this.c.bulk(async () => {
      const result = await this.purgeCleared(chat.id);
      this.c.write(() => {
        this.c.run("UPDATE chats SET archived = 0, pinned = NULL, unread = 0, proto = NULL WHERE id = ?", chat.id);
        this.c.run("DELETE FROM handled WHERE chat_id = ?", chat.id);
      });
      return result;
    });
  }

  /**
   * Stores the barrier and hides everything under it in the same transaction:
   * the chat's last message is recomputed from what stays visible, and every
   * read filters on the barrier, so a purge that a crash interrupts leaves
   * nothing readable behind. `resumePurges()` finishes the physical delete.
   */
  private raiseBarrier(chatJid: string, through: number): ChatRecord {
    return this.c.write(() => {
      const chat = this.identity.ensureChat(chatJid);
      for (const chatId of this.identity.chatIdsOf(chat)) {
        this.c.run("UPDATE chats SET cleared_through_ts = max(coalesce(cleared_through_ts, 0), ?) WHERE id = ?", through, chatId);
        this.c.run(RECOMPUTE_LAST, chatId);
      }
      return chat;
    });
  }

  /** Physically removes rows a stored barrier already hides, for every chat a crash or a close left mid-purge. */
  resumePurges(): Promise<BulkDeleteResult> {
    this.c.assertWritable();
    return this.c.bulk(async () => {
      const result: BulkDeleteResult = { count: 0, sids: [], mediaPaths: [] };
      const pending = this.c.all<{ id: number }>(
        `SELECT c.id FROM chats c WHERE c.cleared_through_ts IS NOT NULL AND EXISTS (
           SELECT 1 FROM messages m WHERE m.chat_id = c.id
             AND m.id < ((c.cleared_through_ts / 1000) + 1) * 1048576 AND m.ts <= c.cleared_through_ts)`
      );
      for (const chat of pending) {
        const purged = await this.purgeCleared(chat.id);
        result.count += purged.count;
        result.sids.push(...purged.sids);
        result.mediaPaths.push(...purged.mediaPaths);
      }
      return result;
    });
  }

  /** Deletes every row of the chat at or before its barrier, tombstones included. Runs inside bulk(). */
  async purgeCleared(chatId: number): Promise<BulkDeleteResult> {
    const result: BulkDeleteResult = { count: 0, sids: [], mediaPaths: [] };
    await this.c.chunked(() => {
      const barrier = this.c.get<{ through: number | null }>(
        "SELECT cleared_through_ts AS through FROM chats WHERE id = ?",
        chatId
      )?.through;
      if (barrier === null || barrier === undefined) return false;
      const rows = this.c.all<{ id: number; sid: string }>(
        `SELECT m.id, ${SID_EXPR} AS sid FROM messages m JOIN chats c ON c.id = m.chat_id
           LEFT JOIN chats ck ON ck.id = c.merged_into
         WHERE m.chat_id = ? AND m.id < ? AND m.ts <= ? ORDER BY m.id LIMIT ?`,
        chatId,
        idUpperBound(barrier),
        barrier,
        this.c.chunkSize
      );
      const started = performance.now();
      let done = 0;
      // One row per statement: the budget is checked between rows, because
      // one indexed row can cost milliseconds on a large account.
      while (done < rows.length) {
        this.deleteRows([rows[done]!], result);
        done++;
        if (performance.now() - started > this.c.chunkBudgetMs) break;
      }
      return rows.length === this.c.chunkSize || done < rows.length;
    });
    if (result.count > 0) this.c.checkpoint();
    return result;
  }

  /** Physically removes rows; cascades take reactions, votes, receipts, media rows and embeddings. */
  deleteRows(rows: ReadonlyArray<{ id: number; sid: string }>, into: BulkDeleteResult): void {
    if (rows.length === 0) return;
    const ids = idsJson(rows.map((row) => row.id));
    const paths = this.c
      .all<{ path: string }>("SELECT path FROM media WHERE message_id IN (SELECT value FROM json_each(?))", ids)
      .map((row) => row.path);
    // A clear is not a retraction: quotes of cleared messages keep their copy, as they do on the phone.
    this.c.run("DELETE FROM messages WHERE id IN (SELECT value FROM json_each(?))", ids);
    into.mediaPaths.push(...this.released(paths));
    into.count += rows.length;
    for (const row of rows) into.sids.push(row.sid);
  }

  /** A live message's key, or null for an unknown or deleted one. */
  private liveKey(sid: string): MessageKey | null {
    const key = this.identity.findMessage(sid);
    return key === null || key.deleted_at !== null ? null : key;
  }

  /** A reaction, or its removal (empty emoji). An older event never overrides a newer one. */
  react(sid: string, reactorJid: string, emoji: string | null, ts: number): boolean {
    const at = checkTimestamp(ts, "ts");
    return this.c.write(() => {
      const key = this.liveKey(sid);
      if (key === null) return false;
      const contactId = this.identity.ensureContact(reactorJid);
      if (!emoji) {
        this.c.run("DELETE FROM reactions WHERE message_id = ? AND contact_id = ? AND ts <= ?", key.id, contactId, at);
      } else {
        this.c.run(
          `INSERT INTO reactions(message_id, contact_id, emoji, ts) VALUES (?, ?, ?, ?)
           ON CONFLICT(message_id, contact_id) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts
           WHERE excluded.ts >= reactions.ts`,
          key.id,
          contactId,
          emoji,
          at
        );
      }
      return true;
    });
  }

  /** A poll vote: the voter's current choice (serialized by the caller), or its withdrawal (null). */
  vote(sid: string, voterJid: string, choice: string | null, ts: number): boolean {
    const at = checkTimestamp(ts, "ts");
    return this.c.write(() => {
      const key = this.liveKey(sid);
      if (key === null) return false;
      const contactId = this.identity.ensureContact(voterJid);
      if (choice === null) {
        this.c.run("DELETE FROM votes WHERE message_id = ? AND contact_id = ? AND ts <= ?", key.id, contactId, at);
      } else {
        this.c.run(
          `INSERT INTO votes(message_id, contact_id, choice, ts) VALUES (?, ?, ?, ?)
           ON CONFLICT(message_id, contact_id) DO UPDATE SET choice = excluded.choice, ts = excluded.ts
           WHERE excluded.ts >= votes.ts`,
          key.id,
          contactId,
          choice,
          at
        );
      }
      return true;
    });
  }

  /** Delivery, read and played times; each keeps the earliest one seen. */
  receipt(
    sid: string,
    contactJid: string,
    times: { deliveredAt?: number | null; readAt?: number | null; playedAt?: number | null }
  ): boolean {
    const delivered = checkInstant(times.deliveredAt, "deliveredAt");
    const read = checkInstant(times.readAt, "readAt");
    const played = checkInstant(times.playedAt, "playedAt");
    return this.c.write(() => {
      const key = this.liveKey(sid);
      if (key === null) return false;
      const contactId = this.identity.ensureContact(contactJid);
      this.c.run(
        `INSERT INTO receipts(message_id, contact_id, delivered_at, read_at, played_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(message_id, contact_id) DO UPDATE SET
           delivered_at = coalesce(min(receipts.delivered_at, excluded.delivered_at), receipts.delivered_at, excluded.delivered_at),
           read_at = coalesce(min(receipts.read_at, excluded.read_at), receipts.read_at, excluded.read_at),
           played_at = coalesce(min(receipts.played_at, excluded.played_at), receipts.played_at, excluded.played_at)`,
        key.id,
        contactId,
        delivered,
        read,
        played
      );
      return true;
    });
  }

  reactions(sid: string): Reaction[] {
    const key = this.liveKey(sid);
    if (key === null) return [];
    return this.c
      .all<{ contact_id: number; jid: string | null; emoji: string; ts: number }>(
        `SELECT r.contact_id, coalesce(k.phone_jid, k.lid) AS jid, r.emoji, r.ts
         FROM reactions r JOIN contacts k ON k.id = r.contact_id WHERE r.message_id = ? ORDER BY r.ts`,
        key.id
      )
      .map((row) => ({ contactId: row.contact_id, jid: row.jid, emoji: row.emoji, ts: row.ts }));
  }

  votes(sid: string): Vote[] {
    const key = this.liveKey(sid);
    if (key === null) return [];
    return this.c
      .all<{ contact_id: number; jid: string | null; choice: string; ts: number }>(
        `SELECT v.contact_id, coalesce(k.phone_jid, k.lid) AS jid, v.choice, v.ts
         FROM votes v JOIN contacts k ON k.id = v.contact_id WHERE v.message_id = ? ORDER BY v.ts`,
        key.id
      )
      .map((row) => ({ contactId: row.contact_id, jid: row.jid, choice: row.choice, ts: row.ts }));
  }

  receipts(sid: string): Receipt[] {
    const key = this.liveKey(sid);
    if (key === null) return [];
    return this.c
      .all<{
        contact_id: number;
        jid: string | null;
        delivered_at: number | null;
        read_at: number | null;
        played_at: number | null;
      }>(
        `SELECT r.contact_id, coalesce(k.phone_jid, k.lid) AS jid, r.delivered_at, r.read_at, r.played_at
         FROM receipts r JOIN contacts k ON k.id = r.contact_id WHERE r.message_id = ? ORDER BY r.contact_id`,
        key.id
      )
      .map((row) => ({
        contactId: row.contact_id,
        jid: row.jid,
        deliveredAt: row.delivered_at,
        readAt: row.read_at,
        playedAt: row.played_at,
      }));
  }

  /** Records a derived file; returns the path it replaced, which the caller unlinks. */
  setMedia(sid: string, kind: string, path: string): { stored: boolean; replaced: string | null } {
    return this.c.write(() => {
      const key = this.liveKey(sid);
      if (key === null) return { stored: false, replaced: null };
      const previous = this.c.get<{ path: string }>(
        "SELECT path FROM media WHERE message_id = ? AND kind = ?",
        key.id,
        kind
      )?.path;
      this.c.run(
        `INSERT INTO media(message_id, kind, path, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id, kind) DO UPDATE SET path = excluded.path, created_at = excluded.created_at`,
        key.id,
        kind,
        path,
        this.c.now()
      );
      const replaced = previous !== undefined && previous !== path ? this.released([previous]) : [];
      return { stored: true, replaced: replaced[0] ?? null };
    });
  }

  media(sid: string): MediaRecord[] {
    const key = this.liveKey(sid);
    if (key === null) return [];
    return this.c
      .all<{ kind: string; path: string; created_at: number }>(
        "SELECT kind, path, created_at FROM media WHERE message_id = ? ORDER BY kind",
        key.id
      )
      .map((row) => ({ kind: row.kind, path: row.path, createdAt: row.created_at }));
  }

  /** A message by any sid spelling; tombstones and expired rows only when asked for. */
  get(sid: string, options: { includeHidden?: boolean } = {}): StoredMessage | null {
    const key = this.identity.findMessage(sid);
    if (key === null) return null;
    const row =
      options.includeHidden === true
        ? this.c.get<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.id = ?`, key.id)
        : this.c.get<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.id = ? AND ${VISIBLE}`, key.id, this.c.now());
    return row === undefined ? null : messageFromRow(row);
  }

  /** Visible messages by id, newest first. */
  byIds(ids: readonly number[]): StoredMessage[] {
    if (ids.length === 0) return [];
    return this.c
      .all<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM}
         WHERE m.id IN (SELECT value FROM json_each(?)) AND ${VISIBLE} ORDER BY m.id DESC`,
        idsJson(ids),
        this.c.now()
      )
      .map(messageFromRow);
  }

  /** One page of a chat, newest first; `before` is the previous page's nextBefore. */
  chatPage(chatJid: string, options: { before?: number; limit: number }): Page<StoredMessage> {
    const limit = clampLimit(options.limit);
    const chat = this.identity.chat(chatJid);
    if (chat === null) return { items: [], hasMore: false, nextBefore: null };
    const inChat = chatCondition(this.identity.chatIdsOf(chat));
    const rows = this.c.all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM}
       WHERE ${inChat.sql} AND m.id < ? AND ${VISIBLE} ORDER BY m.id DESC LIMIT ?`,
      ...inChat.params,
      options.before ?? NO_UPPER_BOUND,
      this.c.now(),
      limit + 1
    );
    return pageOf(rows.map(messageFromRow), limit);
  }

  /** Messages across every chat since a time, newest first, walked straight off the primary key. */
  recent(options: {
    since: number;
    until?: number;
    before?: number;
    limit: number;
    excludeKinds?: readonly ChatKind[];
  }): Page<StoredMessage> {
    const limit = clampLimit(options.limit);
    const upper = Math.min(options.before ?? NO_UPPER_BOUND, options.until === undefined ? NO_UPPER_BOUND : idUpperBound(options.until));
    const excluded = options.excludeKinds ?? [];
    const kindFilter = excluded.length === 0 ? "" : "AND c.kind NOT IN (SELECT value FROM json_each(?))";
    const params = [idLowerBound(options.since), upper, options.since, options.until ?? NO_UPPER_BOUND, this.c.now()];
    const rows = this.c.all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM}
       WHERE m.id >= ? AND m.id < ? AND m.ts >= ? AND m.ts <= ? AND ${VISIBLE} ${kindFilter}
       ORDER BY m.id DESC LIMIT ?`,
      ...params,
      ...(excluded.length === 0 ? [] : [JSON.stringify(excluded)]),
      limit + 1
    );
    return pageOf(rows.map(messageFromRow), limit);
  }

  /** The newest visible message of a chat, walked back from the end of its index range. */
  lastVisible(chatId: number): StoredMessage | null {
    const inChat = chatCondition(this.c.all<{ id: number }>("SELECT id FROM chats WHERE id = ? OR merged_into = ?", chatId, chatId).map((r) => r.id));
    const row = this.c.get<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE ${inChat.sql} AND ${VISIBLE} ORDER BY m.id DESC LIMIT 1`,
      ...inChat.params,
      this.c.now()
    );
    return row === undefined ? null : messageFromRow(row);
  }

  /**
   * The denormalized last message, unless its deadline passed before the
   * sweep ran — then the chat's newest visible message instead.
   */
  private lastOf(chat: ChatRecord, row: MessageRow | undefined): StoredMessage | null {
    if (chat.lastMessageId === null) return null;
    if (row !== undefined && row.deleted_at === null && (row.expires_at === null || row.expires_at > this.c.now())) {
      return messageFromRow(row);
    }
    return this.lastVisible(chat.id);
  }

  /** Chats that have a message, most recent first. */
  listChats(options: { limit: number; before?: ChatCursor; includeArchived?: boolean }): {
    items: ChatListItem[];
    next: ChatCursor | null;
  } {
    const limit = clampLimit(options.limit);
    const cursor = options.before;
    const archived = options.includeArchived === false ? "AND ch.archived = 0" : "";
    const rows = this.c.all<ChatRow & { m_id: number | null }>(
      `SELECT ch.*, ch.last_message_id AS m_id FROM chats ch INDEXED BY chats_recent
       WHERE ch.last_ts IS NOT NULL AND ch.merged_into IS NULL AND (ch.last_ts < ? OR (ch.last_ts = ? AND ch.id < ?)) ${archived}
       ORDER BY ch.last_ts DESC, ch.id DESC LIMIT ?`,
      cursor?.lastTs ?? NO_UPPER_BOUND,
      cursor?.lastTs ?? NO_UPPER_BOUND,
      cursor?.id ?? NO_UPPER_BOUND,
      limit + 1
    );
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const lasts = new Map(
      this.c
        .all<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.id IN (SELECT value FROM json_each(?))`,
          idsJson(kept.flatMap((row) => (row.m_id === null ? [] : [row.m_id])))
        )
        .map((row) => [row.id, row])
    );
    const items = kept.map((row) => {
      const chat = chatFromRow(row);
      return { chat, last: this.lastOf(chat, row.m_id === null ? undefined : lasts.get(row.m_id)) };
    });
    const tail = kept[kept.length - 1];
    return { items, next: hasMore && tail !== undefined ? { lastTs: tail.last_ts!, id: tail.id } : null };
  }

  /**
   * Chats whose last word is theirs, with that word between `since` and
   * `until`, oldest wait first — read off the denormalized columns. Whether
   * the word asks for something is the caller's judgment.
   */
  waiting(options: { since: number; until: number; limit: number; includeArchived?: boolean }): WaitingCandidate[] {
    const limit = clampLimit(options.limit);
    const archived = options.includeArchived === true ? "" : "AND ch.archived = 0";
    const rows = this.c.all<ChatRow>(
      `SELECT ch.* FROM chats ch INDEXED BY chats_waiting
       WHERE ch.last_from_me = 0 AND ch.last_ts >= ? AND ch.last_ts <= ? AND ch.merged_into IS NULL ${archived}
       ORDER BY ch.last_ts ASC LIMIT ?`,
      options.since,
      options.until,
      limit
    );
    const lasts = new Map(
      this.c
        .all<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.id IN (SELECT value FROM json_each(?))`,
          idsJson(rows.map((row) => row.last_message_id!))
        )
        .map((row) => [row.id, row])
    );
    const candidates: WaitingCandidate[] = [];
    for (const row of rows) {
      const chat = chatFromRow(row);
      const last = this.lastOf(chat, lasts.get(row.last_message_id!));
      if (last === null || last.fromMe || last.ts < options.since || last.ts > options.until) continue;
      candidates.push({ chat, last, handled: this.identity.handledByChatId(chat.id) });
    }
    return candidates;
  }

  /** The oldest and newest visible message, of one chat or of the account, read off an index. */
  coverage(chatJid?: string): Coverage {
    const now = this.c.now();
    type Edge = { id: number; sid: string; ts: number };
    let inChat = { sql: "1", params: [] as Array<number | string> };
    if (chatJid !== undefined) {
      const chat = this.identity.chat(chatJid);
      if (chat === null) return { oldest: null, newest: null };
      inChat = chatCondition(this.identity.chatIdsOf(chat));
    }
    const edge = (order: "ASC" | "DESC"): Edge | null =>
      this.c.get<Edge>(
        `SELECT m.id, ${SID_EXPR} AS sid, m.ts FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
           LEFT JOIN chats ck ON ck.id = c.merged_into
         WHERE ${inChat.sql} AND ${VISIBLE} ORDER BY m.id ${order} LIMIT 1`,
        ...inChat.params,
        now
      ) ?? null;
    return { oldest: edge("ASC"), newest: edge("DESC") };
  }

  /** Rows and tombstones of one chat above its clear barrier; what an import compares against its source. */
  countInChat(chatJid: string): { messages: number; tombstones: number } {
    const chat = this.identity.chat(chatJid);
    if (chat === null) return { messages: 0, tombstones: 0 };
    const inChat = chatCondition(this.identity.chatIdsOf(chat));
    const row = this.c.get<{ total: number; tombstones: number }>(
      `SELECT count(*) AS total, count(m.deleted_at) AS tombstones FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
       WHERE ${inChat.sql} AND m.ts > coalesce(c.cleared_through_ts, 0)`,
      ...inChat.params
    )!;
    return { messages: row.total - row.tombstones, tombstones: row.tombstones };
  }
}
