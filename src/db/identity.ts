/**
 * Who and where: contacts (one row per person, phone jid and lid together),
 * chats under their canonical jid with every other spelling as an alias, the
 * resolution of any sid spelling to its stored message, and what the user
 * filed about people and threads (notes, tags, fields, handled marks).
 */
import type { Connection } from "./connection.js";
import { StorageError } from "./errors.js";
import { chatFromRow, contactFromRow, type ChatRow, type ContactRow } from "./rows.js";
import type {
  ChatInput,
  ChatKind,
  ChatRecord,
  ContactInput,
  ContactNotes,
  ContactRecord,
  FieldEdit,
  HandledRecord,
} from "./types.js";

export function isLidJid(jid: string): boolean {
  return jid.endsWith("@lid") || jid.endsWith("@hosted.lid");
}

export function chatKindOf(jid: string): ChatKind {
  if (jid === "status@broadcast") return "status";
  if (jid.endsWith("@g.us")) return "group";
  if (jid.endsWith("@newsletter")) return "newsletter";
  if (jid.endsWith("@broadcast")) return "broadcast";
  return "direct";
}

export function sidOf(fromMe: boolean, chatJid: string, keyId: string): string {
  return `${fromMe}_${chatJid}_${keyId}`;
}

/** Same grammar as message-ref.ts: `<true|false>_<chat jid>_<stanza id>`. */
const FULL_SID = /^(true|false)_([^_\s]+@[^_\s]+)_(.+)$/s;

export function parseSid(sid: string): { fromMe: boolean; chatJid: string; keyId: string } | null {
  const match = FULL_SID.exec(sid);
  return match === null ? null : { fromMe: match[1] === "true", chatJid: match[2]!, keyId: match[3]! };
}

/** The columns every write decision about an existing message needs, and no content. */
export interface MessageKey {
  id: number;
  sid: string;
  chat_id: number;
  key_id: string;
  from_me: number;
  ts: number;
  edited_at: number | null;
  expires_at: number | null;
  deleted_at: number | null;
}

const KEY_COLUMNS = "m.id, m.sid, m.chat_id, m.key_id, m.from_me, m.ts, m.edited_at, m.expires_at, m.deleted_at";

interface NotesRow {
  note: string | null;
  tags: string | null;
  fields: string | null;
  updated_at: number;
}

function notesFromRow(row: NotesRow): ContactNotes {
  return {
    note: row.note,
    tags: row.tags === null ? [] : (JSON.parse(row.tags) as string[]),
    fields: row.fields === null ? {} : (JSON.parse(row.fields) as Record<string, string>),
    updatedAt: row.updated_at,
  };
}

export class Identity {
  constructor(private readonly c: Connection) {}

  contactById(id: number): ContactRecord | null {
    const row = this.c.get<ContactRow>("SELECT * FROM contacts WHERE id = ?", id);
    return row === undefined ? null : contactFromRow(row);
  }

  contactIdOf(jid: string): number | null {
    const byPhone = this.c.get<{ id: number }>("SELECT id FROM contacts WHERE phone_jid = ?", jid);
    if (byPhone !== undefined) return byPhone.id;
    const byLid = this.c.get<{ id: number }>("SELECT id FROM contacts WHERE lid = ?", jid);
    return byLid?.id ?? null;
  }

  contact(jid: string): ContactRecord | null {
    const id = this.contactIdOf(jid);
    return id === null ? null : this.contactById(id);
  }

  ensureContact(jid: string): number {
    const found = this.contactIdOf(jid);
    if (found !== null) return found;
    const column = isLidJid(jid) ? "lid" : "phone_jid";
    return this.c.write(
      () => this.c.get<{ id: number }>(`INSERT INTO contacts(${column}, updated_at) VALUES (?, ?) RETURNING id`, jid, this.c.now())!.id
    );
  }

  upsertContact(input: ContactInput): ContactRecord {
    return this.c.write(() => {
      const id = this.ensureContact(input.jid);
      const sets: string[] = [];
      const values: Array<string | number | null> = [];
      const assign = (column: string, value: string | number | null | undefined): void => {
        if (value === undefined) return;
        sets.push(`${column} = ?`);
        values.push(value);
      };
      assign("name", input.name);
      assign("push_name", input.pushName);
      assign("verified_name", input.verifiedName);
      assign("is_business", input.isBusiness === undefined ? undefined : input.isBusiness === null ? null : input.isBusiness ? 1 : 0);
      if (sets.length > 0) {
        this.c.run(`UPDATE contacts SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...values, this.c.now(), id);
      }
      return this.contactById(id)!;
    });
  }

  chatById(id: number): ChatRecord | null {
    const row = this.c.get<ChatRow>("SELECT * FROM chats WHERE id = ?", id);
    return row === undefined ? null : chatFromRow(row);
  }

  /** A chat by any spelling: its jid, an alias, or the other half of a known lid/phone pair. */
  chat(jid: string): ChatRecord | null {
    const row =
      this.c.get<ChatRow>("SELECT * FROM chats WHERE jid = ?", jid) ??
      this.c.get<ChatRow>("SELECT c.* FROM chat_aliases a JOIN chats c ON c.id = a.chat_id WHERE a.jid = ?", jid);
    if (row !== undefined) return chatFromRow(row);
    if (chatKindOf(jid) !== "direct") return null;
    const contact = this.contact(jid);
    if (contact === null) return null;
    for (const other of [contact.phoneJid, contact.lid]) {
      if (other === null || other === jid) continue;
      const found = this.c.get<ChatRow>("SELECT * FROM chats WHERE jid = ?", other);
      if (found !== undefined) return chatFromRow(found);
    }
    return null;
  }

  /**
   * The chat for `jid`, created when unknown. A direct chat is filed under
   * the contact's phone jid when the number is known, and the spelling it
   * arrived under becomes an alias.
   */
  ensureChat(jid: string, kind?: ChatKind): ChatRecord {
    const existing = this.chat(jid);
    if (existing !== null) return existing;
    return this.c.write(() => {
      const chatKind = kind ?? chatKindOf(jid);
      let canonical = jid;
      let contactId: number | null = null;
      if (chatKind === "direct") {
        contactId = this.ensureContact(jid);
        canonical = this.contactById(contactId)!.phoneJid ?? jid;
      }
      const row = this.c.get<ChatRow>(
        "INSERT INTO chats(jid, kind, contact_id) VALUES (?, ?, ?) RETURNING *",
        canonical,
        chatKind,
        contactId
      )!;
      if (canonical !== jid) this.c.run("INSERT OR IGNORE INTO chat_aliases(jid, chat_id) VALUES (?, ?)", jid, row.id);
      return chatFromRow(row);
    });
  }

  upsertChat(input: ChatInput): ChatRecord {
    return this.c.write(() => {
      const chat = this.ensureChat(input.jid, input.kind);
      const sets: string[] = [];
      const values: Array<string | number | Uint8Array | null> = [];
      const assign = (column: string, value: string | number | Uint8Array | null | undefined): void => {
        if (value === undefined) return;
        sets.push(`${column} = ?`);
        values.push(value);
      };
      assign("name", input.name);
      assign("archived", input.archived === undefined ? undefined : input.archived ? 1 : 0);
      assign("pinned", input.pinned);
      assign("muted_until", input.mutedUntil);
      assign("unread", input.unread);
      assign("proto", input.proto);
      if (sets.length > 0) this.c.run(`UPDATE chats SET ${sets.join(", ")} WHERE id = ?`, ...values, chat.id);
      return this.chatById(chat.id)!;
    });
  }

  /**
   * The stored message a sid names, in any spelling: the row's own sid, a
   * recorded alias, or the sid rebuilt over the chat's canonical jid — a lid
   * spelling for a message filed after the number became known.
   */
  findMessage(sid: string): MessageKey | null {
    const direct =
      this.c.get<MessageKey>(`SELECT ${KEY_COLUMNS} FROM messages m WHERE m.sid = ?`, sid) ??
      this.c.get<MessageKey>(`SELECT ${KEY_COLUMNS} FROM message_aliases a JOIN messages m ON m.id = a.message_id WHERE a.sid = ?`, sid);
    if (direct !== undefined) return direct;
    const parsed = parseSid(sid);
    if (parsed === null) return null;
    const chat = this.chat(parsed.chatJid);
    if (chat === null || chat.jid === parsed.chatJid) return null;
    const canonical = sidOf(parsed.fromMe, chat.jid, parsed.keyId);
    return (
      this.c.get<MessageKey>(`SELECT ${KEY_COLUMNS} FROM messages m WHERE m.sid = ?`, canonical) ??
      this.c.get<MessageKey>(`SELECT ${KEY_COLUMNS} FROM message_aliases a JOIN messages m ON m.id = a.message_id WHERE a.sid = ?`, canonical) ??
      null
    );
  }

  /** Every spelling a message is known by: its sid, its aliases, and the sid over its chat's canonical jid. */
  sidVariants(messageId: number): string[] {
    const row = this.c.get<{ sid: string; from_me: number; key_id: string; jid: string }>(
      "SELECT m.sid, m.from_me, m.key_id, c.jid FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ?",
      messageId
    );
    if (row === undefined) return [];
    const variants = new Set([row.sid, sidOf(row.from_me === 1, row.jid, row.key_id)]);
    for (const alias of this.c.all<{ sid: string }>("SELECT sid FROM message_aliases WHERE message_id = ?", messageId)) {
      variants.add(alias.sid);
    }
    return [...variants];
  }

  notes(jid: string): ContactNotes | null {
    const id = this.contactIdOf(jid);
    if (id === null) return null;
    const row = this.c.get<NotesRow>("SELECT note, tags, fields, updated_at FROM contact_notes WHERE contact_id = ?", id);
    return row === undefined ? null : notesFromRow(row);
  }

  /** An empty note clears it; a contact left with no note, tags or fields loses the row. */
  setNote(jid: string, note: string): ContactNotes | null {
    return this.c.write(() => {
      const trimmed = note.trim();
      const current = this.notes(jid);
      return this.saveNotes(jid, trimmed === "" ? null : trimmed, current?.tags ?? [], current?.fields ?? {});
    });
  }

  updateFields(jid: string, edit: FieldEdit): ContactNotes | null {
    return this.c.write(() => {
      const current = this.notes(jid);
      const tags = new Set(current?.tags ?? []);
      for (const tag of edit.removeTags ?? []) tags.delete(tag);
      for (const tag of edit.addTags ?? []) tags.add(tag);
      const fields = { ...(current?.fields ?? {}) };
      for (const key of edit.removeFields ?? []) delete fields[key];
      Object.assign(fields, edit.set ?? {});
      return this.saveNotes(jid, current?.note ?? null, [...tags], fields);
    });
  }

  private saveNotes(jid: string, note: string | null, tags: string[], fields: Record<string, string>): ContactNotes | null {
    const id = this.ensureContact(jid);
    if (note === null && tags.length === 0 && Object.keys(fields).length === 0) {
      this.c.run("DELETE FROM contact_notes WHERE contact_id = ?", id);
      return null;
    }
    const at = this.c.now();
    this.c.run(
      `INSERT INTO contact_notes(contact_id, note, tags, fields, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(contact_id) DO UPDATE SET note = excluded.note, tags = excluded.tags, fields = excluded.fields,
         updated_at = excluded.updated_at`,
      id,
      note,
      tags.length === 0 ? null : JSON.stringify(tags),
      Object.keys(fields).length === 0 ? null : JSON.stringify(fields),
      at
    );
    return { note, tags, fields, updatedAt: at };
  }

  /** "I dealt with that": the ask open now is handled; a newer message from them reopens the chat. */
  markHandled(chatJid: string, askSid: string | null, at: number = this.c.now()): HandledRecord {
    return this.c.write(() => {
      const chat = this.ensureChat(chatJid);
      const ask = askSid === null ? null : this.findMessage(askSid);
      if (askSid !== null && ask === null) {
        throw new StorageError("INVALID_INPUT", `No stored message is filed under ${askSid}.`);
      }
      this.c.run(
        `INSERT INTO handled(chat_id, ask_message_id, at) VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET ask_message_id = excluded.ask_message_id, at = excluded.at`,
        chat.id,
        ask?.id ?? null,
        at
      );
      return { askMessageId: ask?.id ?? null, askSid: ask?.sid ?? null, at };
    });
  }

  handled(chatJid: string): HandledRecord | null {
    const chat = this.chat(chatJid);
    return chat === null ? null : this.handledByChatId(chat.id);
  }

  handledByChatId(chatId: number): HandledRecord | null {
    const row = this.c.get<{ ask_message_id: number | null; sid: string | null; at: number }>(
      "SELECT h.ask_message_id, m.sid, h.at FROM handled h LEFT JOIN messages m ON m.id = h.ask_message_id WHERE h.chat_id = ?",
      chatId
    );
    return row === undefined ? null : { askMessageId: row.ask_message_id, askSid: row.sid, at: row.at };
  }
}
