/** SQL rows to records: the only place that knows both spellings of a column. */
import type { ChatKind, ChatRecord, ContactRecord, StoredMessage } from "./types.js";

export interface ContactRow {
  id: number;
  phone_jid: string | null;
  lid: string | null;
  name: string | null;
  push_name: string | null;
  verified_name: string | null;
  is_business: number | null;
  updated_at: number;
}

export interface ChatRow {
  id: number;
  jid: string;
  kind: string;
  contact_id: number | null;
  name: string | null;
  archived: number;
  pinned: number | null;
  muted_until: number | null;
  unread: number;
  cleared_through_ts: number | null;
  last_message_id: number | null;
  last_ts: number | null;
  last_from_me: number | null;
  proto: Uint8Array | null;
}

export interface MessageRow {
  id: number;
  sid: string;
  chat_id: number;
  chat_jid: string;
  key_id: string;
  from_me: number;
  sender_id: number | null;
  sender_jid: string | null;
  ts: number;
  type: string;
  text: string | null;
  transcript: string | null;
  raw: Uint8Array | null;
  quoted_sid: string | null;
  status: number | null;
  edited_at: number | null;
  expires_at: number | null;
  deleted_at: number | null;
}

/** Columns for a full message; pair with MESSAGE_FROM. */
export const MESSAGE_COLUMNS = `m.id, m.sid, m.chat_id, c.jid AS chat_jid, m.key_id, m.from_me, m.sender_id,
  coalesce(s.phone_jid, s.lid) AS sender_jid, m.ts, m.type, m.quoted_sid, m.status, m.edited_at, m.expires_at,
  m.deleted_at, m.text, m.transcript, m.raw`;

/** Messages drive the join, so a range or index scan over them is never reordered behind chats. */
export const MESSAGE_FROM = `messages m CROSS JOIN chats c ON c.id = m.chat_id LEFT JOIN contacts s ON s.id = m.sender_id`;

/** A row a reader may see: not a tombstone and not past its deadline. Binds one parameter, now. */
export const VISIBLE = `m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?)`;

export function contactFromRow(row: ContactRow): ContactRecord {
  return {
    id: row.id,
    phoneJid: row.phone_jid,
    lid: row.lid,
    name: row.name,
    pushName: row.push_name,
    verifiedName: row.verified_name,
    isBusiness: row.is_business === null ? null : row.is_business === 1,
    updatedAt: row.updated_at,
  };
}

export function chatFromRow(row: ChatRow): ChatRecord {
  return {
    id: row.id,
    jid: row.jid,
    kind: row.kind as ChatKind,
    contactId: row.contact_id,
    name: row.name,
    archived: row.archived === 1,
    pinned: row.pinned,
    mutedUntil: row.muted_until,
    unread: row.unread,
    clearedThroughTs: row.cleared_through_ts,
    lastMessageId: row.last_message_id,
    lastTs: row.last_ts,
    lastFromMe: row.last_from_me === null ? null : row.last_from_me === 1,
    proto: row.proto,
  };
}

export function messageFromRow(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    sid: row.sid,
    chatId: row.chat_id,
    chatJid: row.chat_jid,
    keyId: row.key_id,
    fromMe: row.from_me === 1,
    senderId: row.sender_id,
    senderJid: row.sender_jid,
    ts: row.ts,
    type: row.type,
    text: row.text,
    transcript: row.transcript,
    raw: row.raw,
    quotedSid: row.quoted_sid,
    status: row.status,
    editedAt: row.edited_at,
    expiresAt: row.expires_at,
    deletedAt: row.deleted_at,
  };
}
