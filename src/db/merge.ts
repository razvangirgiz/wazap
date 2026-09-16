/**
 * Learning that a lid and a phone number are one person. The two contact
 * rows become one (the older id stays, so contact_id is stable), and the two
 * direct chats become one under the phone jid, with every message that moves
 * answering to both sid spellings from then on.
 *
 * It is a chunked operation: references move 200 rows per transaction with
 * the event loop running between chunks. The intent is written to `meta`
 * first and removed last, so a crash mid-merge is finished by
 * `resumeMerges()` on the next start; every step is safe to run twice.
 */
import type { Connection } from "./connection.js";
import { StorageError } from "./errors.js";
import { chatKindOf, isLidJid, sidOf, type Identity } from "./identity.js";
import type { Messages } from "./messages.js";
import type { ChatRow } from "./rows.js";
import type { BulkDeleteResult, MergeReport } from "./types.js";

const PENDING_PREFIX = "merge_pending:";

interface ContactPair {
  keep: number;
  drop: number | null;
}

export class Merger {
  constructor(
    private readonly c: Connection,
    private readonly identity: Identity,
    private readonly messages: Messages
  ) {}

  async learnLidPhone(lid: string, phoneJid: string): Promise<MergeReport> {
    if (!isLidJid(lid) || isLidJid(phoneJid) || chatKindOf(lid) !== "direct" || chatKindOf(phoneJid) !== "direct") {
      throw new StorageError("INVALID_INPUT", `Expected a lid and a phone jid, got ${lid} and ${phoneJid}.`);
    }
    this.c.assertWritable();
    return this.c.bulk(() => this.merge(lid, phoneJid));
  }

  /** Finishes merges a crash interrupted; call once after opening. */
  async resumeMerges(): Promise<MergeReport[]> {
    const pending = this.c.all<{ key: string; value: string }>(
      "SELECT key, value FROM meta WHERE substr(key, 1, ?) = ? ORDER BY key",
      PENDING_PREFIX.length,
      PENDING_PREFIX
    );
    const reports: MergeReport[] = [];
    for (const row of pending) reports.push(await this.learnLidPhone(row.key.slice(PENDING_PREFIX.length), row.value));
    return reports;
  }

  private async merge(lid: string, phoneJid: string): Promise<MergeReport> {
    const pendingKey = `${PENDING_PREFIX}${lid}`;
    this.c.write(() => this.c.run("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", pendingKey, phoneJid));
    const report: MergeReport = { contactId: 0, chatId: null, movedMessages: 0, aliasedMessages: 0, mediaPaths: [] };

    const pair = this.c.write(() => this.pairContacts(lid, phoneJid));
    report.contactId = pair.keep;
    if (pair.drop !== null) {
      const drop = pair.drop;
      await this.c.chunked(() => this.moveContactRefs(pair.keep, drop, this.c.chunkSize));
      this.c.write(() => this.finishContacts(pair.keep, drop, lid, phoneJid));
    }

    const phoneChat = this.chatRow(phoneJid);
    const lidChat = this.chatRow(lid);
    if (lidChat !== null && phoneChat !== null && lidChat.id !== phoneChat.id) {
      report.chatId = phoneChat.id;
      await this.mergeChats(phoneChat.id, lidChat.id, lid, phoneJid, report);
    } else if (lidChat !== null && phoneChat === null) {
      report.chatId = lidChat.id;
      await this.renameChat(lidChat.id, lid, phoneJid, pair.keep, report);
    } else if (phoneChat !== null) {
      report.chatId = phoneChat.id;
      this.c.write(() => {
        this.c.run("INSERT OR REPLACE INTO chat_aliases(jid, chat_id) VALUES (?, ?)", lid, phoneChat.id);
        this.c.run("UPDATE chats SET contact_id = ? WHERE id = ?", pair.keep, phoneChat.id);
      });
    }

    this.c.write(() => this.c.run("DELETE FROM meta WHERE key = ?", pendingKey));
    if (report.mediaPaths.length > 0 || report.movedMessages > 0) this.c.checkpoint();
    return report;
  }

  /** A chat by its own jid or an alias only — never through the contact pair being built. */
  private chatRow(jid: string): ChatRow | null {
    return (
      this.c.get<ChatRow>("SELECT * FROM chats WHERE jid = ?", jid) ??
      this.c.get<ChatRow>("SELECT c.* FROM chat_aliases a JOIN chats c ON c.id = a.chat_id WHERE a.jid = ?", jid) ??
      null
    );
  }

  /** Decides which contact row survives. With one row or none, it is completed right here. */
  private pairContacts(lid: string, phoneJid: string): ContactPair {
    const byPhone = this.c.get<{ id: number; lid: string | null }>("SELECT id, lid FROM contacts WHERE phone_jid = ?", phoneJid);
    const byLid = this.c.get<{ id: number; phone_jid: string | null }>("SELECT id, phone_jid FROM contacts WHERE lid = ?", lid);
    const now = this.c.now();
    if (byPhone === undefined && byLid === undefined) {
      const id = this.c.get<{ id: number }>(
        "INSERT INTO contacts(phone_jid, lid, updated_at) VALUES (?, ?, ?) RETURNING id",
        phoneJid,
        lid,
        now
      )!.id;
      return { keep: id, drop: null };
    }
    if (byPhone !== undefined && byLid !== undefined && byPhone.id === byLid.id) return { keep: byPhone.id, drop: null };
    if (byPhone !== undefined && byLid !== undefined) {
      return { keep: Math.min(byPhone.id, byLid.id), drop: Math.max(byPhone.id, byLid.id) };
    }
    if (byPhone !== undefined) {
      this.c.run("UPDATE contacts SET lid = ?, updated_at = ? WHERE id = ?", lid, now, byPhone.id);
      return { keep: byPhone.id, drop: null };
    }
    this.c.run("UPDATE contacts SET phone_jid = ?, updated_at = ? WHERE id = ?", phoneJid, now, byLid!.id);
    return { keep: byLid!.id, drop: null };
  }

  /**
   * One chunk of references from `drop` to `keep`; `limit` null moves the
   * rest at once (the final pass, for rows that arrived between chunks). Where
   * both people reacted, voted or got a receipt on one message, the newer
   * reaction or vote wins and receipts keep the earliest times.
   */
  private moveContactRefs(keep: number, drop: number, limit: number | null): boolean {
    const cap = limit ?? -1;
    let more = false;
    const moved = this.c.run(
      "UPDATE messages SET sender_id = ? WHERE id IN (SELECT id FROM messages WHERE sender_id = ? LIMIT ?)",
      keep,
      drop,
      cap
    );
    more ||= limit !== null && moved === limit;

    for (const table of ["reactions", "votes"] as const) {
      const ids = this.c
        .all<{ message_id: number }>(`SELECT message_id FROM ${table} WHERE contact_id = ? LIMIT ?`, drop, cap)
        .map((row) => row.message_id);
      if (ids.length === 0) continue;
      const json = JSON.stringify(ids);
      this.c.run(
        `DELETE FROM ${table} WHERE contact_id = ? AND message_id IN (SELECT value FROM json_each(?))
           AND ts < (SELECT d.ts FROM ${table} d WHERE d.contact_id = ? AND d.message_id = ${table}.message_id)`,
        keep,
        json,
        drop
      );
      this.c.run(
        `DELETE FROM ${table} WHERE contact_id = ? AND message_id IN (SELECT value FROM json_each(?))
           AND EXISTS (SELECT 1 FROM ${table} k WHERE k.contact_id = ? AND k.message_id = ${table}.message_id)`,
        drop,
        json,
        keep
      );
      this.c.run(
        `UPDATE ${table} SET contact_id = ? WHERE contact_id = ? AND message_id IN (SELECT value FROM json_each(?))`,
        keep,
        drop,
        json
      );
      more ||= limit !== null && ids.length === limit;
    }

    const receiptIds = this.c
      .all<{ message_id: number }>("SELECT message_id FROM receipts WHERE contact_id = ? LIMIT ?", drop, cap)
      .map((row) => row.message_id);
    if (receiptIds.length > 0) {
      const json = JSON.stringify(receiptIds);
      this.c.run(
        `UPDATE receipts AS k SET
           delivered_at = coalesce(min(k.delivered_at, d.delivered_at), k.delivered_at, d.delivered_at),
           read_at = coalesce(min(k.read_at, d.read_at), k.read_at, d.read_at),
           played_at = coalesce(min(k.played_at, d.played_at), k.played_at, d.played_at)
         FROM receipts AS d
         WHERE k.contact_id = ? AND d.contact_id = ? AND d.message_id = k.message_id
           AND d.message_id IN (SELECT value FROM json_each(?))`,
        keep,
        drop,
        json
      );
      this.c.run(
        `DELETE FROM receipts WHERE contact_id = ? AND message_id IN (SELECT value FROM json_each(?))
           AND EXISTS (SELECT 1 FROM receipts k WHERE k.contact_id = ? AND k.message_id = receipts.message_id)`,
        drop,
        json,
        keep
      );
      this.c.run(
        "UPDATE receipts SET contact_id = ? WHERE contact_id = ? AND message_id IN (SELECT value FROM json_each(?))",
        keep,
        drop,
        json
      );
      more ||= limit !== null && receiptIds.length === limit;
    }
    return more;
  }

  /** The last transaction of a contact merge: residual references, notes, names, then the row itself. */
  private finishContacts(keep: number, drop: number, lid: string, phoneJid: string): void {
    this.moveContactRefs(keep, drop, null);
    const notes = this.c.all<{ contact_id: number; note: string | null; tags: string | null; fields: string | null }>(
      "SELECT contact_id, note, tags, fields FROM contact_notes WHERE contact_id IN (?, ?)",
      keep,
      drop
    );
    const kept = notes.find((row) => row.contact_id === keep);
    const dropped = notes.find((row) => row.contact_id === drop);
    if (dropped !== undefined) {
      const tags = [
        ...new Set([...(JSON.parse(kept?.tags ?? "[]") as string[]), ...(JSON.parse(dropped.tags ?? "[]") as string[])]),
      ];
      const fields = {
        ...(JSON.parse(dropped.fields ?? "{}") as Record<string, string>),
        ...(JSON.parse(kept?.fields ?? "{}") as Record<string, string>),
      };
      this.c.run("DELETE FROM contact_notes WHERE contact_id = ?", drop);
      this.c.run(
        `INSERT INTO contact_notes(contact_id, note, tags, fields, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(contact_id) DO UPDATE SET note = excluded.note, tags = excluded.tags, fields = excluded.fields,
           updated_at = excluded.updated_at`,
        keep,
        kept?.note ?? dropped.note,
        tags.length === 0 ? null : JSON.stringify(tags),
        Object.keys(fields).length === 0 ? null : JSON.stringify(fields),
        this.c.now()
      );
    }
    this.c.run("UPDATE chats SET contact_id = ? WHERE contact_id = ?", keep, drop);
    const names = this.c.get<{ name: string | null; push_name: string | null; verified_name: string | null; is_business: number | null }>(
      "SELECT name, push_name, verified_name, is_business FROM contacts WHERE id = ?",
      drop
    );
    this.c.run("DELETE FROM contacts WHERE id = ?", drop);
    this.c.run(
      `UPDATE contacts SET phone_jid = ?, lid = ?, name = coalesce(name, ?), push_name = coalesce(push_name, ?),
         verified_name = coalesce(verified_name, ?), is_business = coalesce(is_business, ?), updated_at = ?
       WHERE id = ?`,
      phoneJid,
      lid,
      names?.name ?? null,
      names?.push_name ?? null,
      names?.verified_name ?? null,
      names?.is_business ?? null,
      this.c.now(),
      keep
    );
  }

  /**
   * Only the lid chat exists: its messages first learn their phone spelling,
   * then the chat takes the phone jid and keeps the lid as an alias.
   */
  private async renameChat(chatId: number, lid: string, phoneJid: string, contactId: number, report: MergeReport): Promise<void> {
    let cursor = -1;
    await this.c.chunked(() => {
      const rows = this.c.all<{ id: number; from_me: number; key_id: string }>(
        "SELECT id, from_me, key_id FROM messages WHERE chat_id = ? AND id > ? ORDER BY id LIMIT ?",
        chatId,
        cursor,
        this.c.chunkSize
      );
      for (const row of rows) report.aliasedMessages += this.aliasPhoneSpelling(row, phoneJid);
      if (rows.length > 0) cursor = rows[rows.length - 1]!.id;
      return rows.length === this.c.chunkSize;
    });
    this.c.write(() => {
      for (const row of this.c.all<{ id: number; from_me: number; key_id: string }>(
        "SELECT id, from_me, key_id FROM messages WHERE chat_id = ? AND id > ?",
        chatId,
        cursor
      )) {
        report.aliasedMessages += this.aliasPhoneSpelling(row, phoneJid);
      }
      this.c.run("UPDATE chats SET jid = ?, contact_id = ? WHERE id = ?", phoneJid, contactId, chatId);
      this.c.run("INSERT OR REPLACE INTO chat_aliases(jid, chat_id) VALUES (?, ?)", lid, chatId);
    });
  }

  private aliasPhoneSpelling(row: { id: number; from_me: number; key_id: string }, phoneJid: string): number {
    const spelling = sidOf(row.from_me === 1, phoneJid, row.key_id);
    if (this.c.get("SELECT 1 FROM messages WHERE sid = ?", spelling) !== undefined) return 0;
    return this.c.run("INSERT OR IGNORE INTO message_aliases(sid, message_id) VALUES (?, ?)", spelling, row.id);
  }

  /**
   * Both chats exist. The later barrier covers both, rows under it go, then
   * the lid chat's messages move over. A message filed under both spellings
   * keeps the phone row; if either copy was deleted, the survivor is too.
   */
  private async mergeChats(keepId: number, dropId: number, lid: string, phoneJid: string, report: MergeReport): Promise<void> {
    this.c.write(() => {
      const barrier = this.c.get<{ through: number | null }>(
        "SELECT max(coalesce(cleared_through_ts, 0)) AS through FROM chats WHERE id IN (?, ?)",
        keepId,
        dropId
      )!.through;
      if (barrier !== null && barrier > 0) {
        this.c.run("UPDATE chats SET cleared_through_ts = ? WHERE id IN (?, ?)", barrier, keepId, dropId);
      }
    });
    const purged: BulkDeleteResult = { count: 0, sids: [], mediaPaths: [] };
    for (const chatId of [keepId, dropId]) {
      const result = await this.messages.purgeCleared(chatId);
      purged.mediaPaths.push(...result.mediaPaths);
    }
    report.mediaPaths.push(...purged.mediaPaths);

    await this.c.chunked(() => this.moveChunk(keepId, dropId, phoneJid, report, this.c.chunkSize));
    this.c.write(() => {
      while (this.moveChunk(keepId, dropId, phoneJid, report, this.c.chunkSize));
      const drop = this.c.get<ChatRow>("SELECT * FROM chats WHERE id = ?", dropId)!;
      this.c.run(
        `UPDATE chats SET name = coalesce(name, ?), pinned = coalesce(pinned, ?), muted_until = coalesce(muted_until, ?),
           unread = unread + ?, proto = coalesce(proto, ?), archived = CASE WHEN ? = 0 THEN 0 ELSE archived END,
           cleared_through_ts = CASE WHEN ? IS NULL THEN cleared_through_ts
             ELSE max(coalesce(cleared_through_ts, 0), ?) END
         WHERE id = ?`,
        drop.name,
        drop.pinned,
        drop.muted_until,
        drop.unread,
        drop.proto,
        drop.archived,
        drop.cleared_through_ts,
        drop.cleared_through_ts,
        keepId
      );
      const handled = this.c.all<{ chat_id: number; ask_message_id: number | null; at: number }>(
        "SELECT chat_id, ask_message_id, at FROM handled WHERE chat_id IN (?, ?) ORDER BY at DESC",
        keepId,
        dropId
      );
      if (handled.length > 0) {
        this.c.run(
          `INSERT INTO handled(chat_id, ask_message_id, at) VALUES (?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET ask_message_id = excluded.ask_message_id, at = excluded.at`,
          keepId,
          handled[0]!.ask_message_id,
          handled[0]!.at
        );
      }
      this.c.run("UPDATE chat_aliases SET chat_id = ? WHERE chat_id = ?", keepId, dropId);
      this.c.run("UPDATE chats SET contact_id = coalesce(contact_id, ?) WHERE id = ?", drop.contact_id, keepId);
      this.c.run("DELETE FROM chats WHERE id = ?", dropId);
      this.c.run("INSERT OR REPLACE INTO chat_aliases(jid, chat_id) VALUES (?, ?)", lid, keepId);
      // The move triggers keep last_* right row by row; recomputing once more costs one index probe.
      this.c.run(
        `UPDATE chats SET (last_message_id, last_ts, last_from_me) = (
           SELECT id, ts, from_me FROM messages WHERE chat_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1)
         WHERE id = ?`,
        keepId,
        keepId
      );
    });
    // A clear of either spelling that landed while the merge ran has raised the barrier since the first purge.
    report.mediaPaths.push(...(await this.messages.purgeCleared(keepId)).mediaPaths);
  }

  /** Moves up to `limit` messages from the lid chat into the phone chat; true while more remain. */
  private moveChunk(keepId: number, dropId: number, phoneJid: string, report: MergeReport, limit: number): boolean {
    const rows = this.c.all<{ id: number; sid: string; from_me: number; key_id: string; deleted_at: number | null }>(
      "SELECT id, sid, from_me, key_id, deleted_at FROM messages WHERE chat_id = ? ORDER BY id LIMIT ?",
      dropId,
      limit
    );
    for (const row of rows) {
      const spelling = sidOf(row.from_me === 1, phoneJid, row.key_id);
      const twin =
        this.c.get<{ id: number; deleted_at: number | null }>(
          "SELECT id, deleted_at FROM messages WHERE sid = ? AND id != ?",
          spelling,
          row.id
        ) ??
        this.c.get<{ id: number; deleted_at: number | null }>(
          "SELECT m.id, m.deleted_at FROM message_aliases a JOIN messages m ON m.id = a.message_id WHERE a.sid = ? AND m.id != ?",
          spelling,
          row.id
        );
      if (twin === undefined) {
        this.c.run("UPDATE messages SET chat_id = ? WHERE id = ?", keepId, row.id);
        report.aliasedMessages += this.aliasPhoneSpelling(row, phoneJid);
        report.movedMessages++;
        continue;
      }
      // One message, two rows: the phone row survives and inherits the other spelling.
      if (row.deleted_at !== null && twin.deleted_at === null) {
        report.mediaPaths.push(...this.messages.tombstone(twin.id, row.deleted_at));
      }
      report.mediaPaths.push(
        ...this.c.all<{ path: string }>("SELECT path FROM media WHERE message_id = ?", row.id).map((m) => m.path)
      );
      this.c.run("UPDATE OR IGNORE message_aliases SET message_id = ? WHERE message_id = ?", twin.id, row.id);
      this.c.run("DELETE FROM messages WHERE id = ?", row.id);
      this.c.run("INSERT OR IGNORE INTO message_aliases(sid, message_id) VALUES (?, ?)", row.sid, twin.id);
      report.movedMessages++;
    }
    return rows.length === limit;
  }
}
