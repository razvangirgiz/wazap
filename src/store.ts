/**
 * The in-memory store fed from Baileys events, and its shape on disk. Baileys
 * emits raw events rather than exposing a queryable store, so wazap keeps
 * chats, contacts and messages itself, keyed by canonical jid, and writes a
 * snapshot under the data dir so a restart does not start blind.
 */
import { proto, type Chat as BaileysChat, type Contact as BaileysContact, type WAMessage } from "baileys";
import { isNoiseJid } from "./ids.js";
import { isControlMessage, messageTimestampMs } from "./messages.js";
import type { TranscriptRecord } from "./transcribe/index.js";

const MAX_MESSAGES_PER_CHAT = 1_000;
const PERSIST_MESSAGES_PER_CHAT = 120;

export interface HistoryRecord {
  sid: string;
  ts: number;
  raw: string;
  /** Added in 0.9.8. The transcript held for this message when the line was written. */
  tr?: TranscriptRecord;
}

export interface StoreSnapshot {
  v: 1;
  chats: Record<string, string>;
  contacts: Record<string, BaileysContact>;
  messages: Record<string, string>;
  byChat: Record<string, string[]>;
  /** Added in 0.9.4; absent in snapshots older wazap versions wrote. */
  pushNames?: Record<string, string>;
  /** Added in 0.9.5. When wazap last asked WhatsApp for the whole address book. */
  contactsResyncedAt?: number;
  /** Added in 0.9.8. Transcripts of the messages this snapshot keeps, by message id. */
  transcripts?: Record<string, TranscriptRecord>;
  /** Added in 0.13.0. Reactions on the messages this snapshot keeps: message id → author jid → emoji. */
  reactions?: Record<string, Record<string, string>>;
  /** Added in 0.13.0. Stories seen in the last day, newest last, by message id; their messages are in `messages`. */
  stories?: string[];
  /** Added in 0.13.0. Pairings learned from WhatsApp's lid table: lid → phone jid. Contacts carry their own; these are the ones only the table knew. */
  lids?: Record<string, string>;
}

/** In-memory state fed from Baileys events, keyed by canonical jid. */
export class Store {
  readonly chats = new Map<string, BaileysChat>();
  readonly contacts = new Map<string, BaileysContact>();
  readonly messages = new Map<string, WAMessage>();
  readonly chatOf = new Map<string, string>();
  readonly byChat = new Map<string, string[]>();
  readonly edited = new Set<string>();
  readonly reactions = new Map<string, Map<string, string>>();
  /**
   * The name a sender publishes on their own profile, as WhatsApp attaches it
   * to their messages. It is the only name we get for someone the user has not
   * saved, and it never arrives through the contact list.
   */
  readonly pushNames = new Map<string, string>();
  /** What a voice note said, keyed by message id. Transcribing is slow and can cost money. */
  readonly transcripts = new Map<string, TranscriptRecord>();
  /** Stories (status updates), newest last. Not a chat: they never join a ring and expire after a day. */
  readonly stories: string[] = [];
  /** lid → phone jid, every pairing learned, so a restart still knows who a lid-filed message is from. */
  readonly lids = new Map<string, string>();

  /** See `needsContactResync`: it keeps a full resync from repeating forever. */
  contactsResyncedAt: number | null = null;

  private seconds(sid: string): number {
    const raw = this.messages.get(sid);
    return raw ? messageTimestampMs(raw) / 1000 : 0;
  }

  putMessage(sid: string, chatJid: string, raw: WAMessage): void {
    const known = this.messages.has(sid);
    this.messages.set(sid, raw);
    this.chatOf.set(sid, chatJid);
    let ring = this.byChat.get(chatJid);
    if (!ring) {
      ring = [];
      this.byChat.set(chatJid, ring);
    }
    if (known && ring.includes(sid)) return;
    // Live messages arrive newest-last, so appending is enough; a history sync
    // delivers older ones out of order and only then is a re-sort needed.
    const ts = messageTimestampMs(raw) / 1000;
    const last = ring.length > 0 ? this.seconds(ring[ring.length - 1]!) : Number.NEGATIVE_INFINITY;
    ring.push(sid);
    if (ts < last) ring.sort((a, b) => this.seconds(a) - this.seconds(b));
    while (ring.length > MAX_MESSAGES_PER_CHAT) {
      const dropped = ring.shift();
      if (dropped) this.forget(dropped);
    }
  }

  putStory(sid: string, chatJid: string, raw: WAMessage): void {
    const known = this.messages.has(sid);
    this.messages.set(sid, raw);
    this.chatOf.set(sid, chatJid);
    if (!known || !this.stories.includes(sid)) this.stories.push(sid);
  }

  /** Stories older than `cutoffMs` go, message and all, the way WhatsApp lets them go after a day. */
  pruneStories(cutoffMs: number): void {
    for (const sid of [...this.stories]) {
      const raw = this.messages.get(sid);
      if (raw && messageTimestampMs(raw) >= cutoffMs) continue;
      this.stories.splice(this.stories.indexOf(sid), 1);
      this.forget(sid);
    }
  }

  /** The tail of a chat, newest first. */
  recent(chatJid: string, count: number): Array<{ sid: string; raw: WAMessage }> {
    const ring = this.byChat.get(chatJid) ?? [];
    const tail: Array<{ sid: string; raw: WAMessage }> = [];
    for (let i = ring.length - 1; i >= 0 && tail.length < count; i--) {
      const sid = ring[i];
      const raw = this.messages.get(sid);
      if (raw) tail.push({ sid, raw });
    }
    return tail;
  }

  /** Forget one message entirely, its place in the chat included. */
  dropMessage(sid: string): void {
    const ring = this.byChat.get(this.chatOf.get(sid) ?? "");
    const at = ring?.indexOf(sid) ?? -1;
    if (ring && at !== -1) ring.splice(at, 1);
    this.forget(sid);
  }

  private forget(sid: string): void {
    this.messages.delete(sid);
    this.chatOf.delete(sid);
    this.edited.delete(sid);
    this.reactions.delete(sid);
    this.transcripts.delete(sid);
  }

  /** Set or withdraw one author's reaction on a message. */
  react(target: string, author: string, emoji: string): void {
    const map = this.reactions.get(target) ?? new Map<string, string>();
    if (emoji) map.set(author, emoji);
    else map.delete(author);
    if (map.size > 0) this.reactions.set(target, map);
    else this.reactions.delete(target);
  }

  reactionsFor(sid: string): Array<{ emoji: string; sender: string }> {
    const map = this.reactions.get(sid);
    if (!map) return [];
    return [...map].map(([sender, emoji]) => ({ emoji, sender }));
  }

  serialize(): StoreSnapshot {
    const snapshot: StoreSnapshot = {
      v: 1,
      chats: {},
      contacts: {},
      messages: {},
      byChat: {},
      pushNames: Object.fromEntries(this.pushNames),
      lids: Object.fromEntries(this.lids),
      ...(this.contactsResyncedAt === null ? {} : { contactsResyncedAt: this.contactsResyncedAt }),
    };
    for (const [jid, chat] of this.chats) {
      const encoded = encode(() => proto.Conversation.encode(chat).finish());
      if (encoded) snapshot.chats[jid] = encoded;
    }
    for (const [jid, contact] of this.contacts) snapshot.contacts[jid] = contact;
    const keep = new Set<string>(this.stories);
    snapshot.stories = [...this.stories];
    for (const [jid, ring] of this.byChat) {
      const capped = ring.slice(-PERSIST_MESSAGES_PER_CHAT);
      snapshot.byChat[jid] = capped;
      for (const sid of capped) keep.add(sid);
    }
    const transcripts: Record<string, TranscriptRecord> = {};
    const reactions: Record<string, Record<string, string>> = {};
    for (const sid of keep) {
      const raw = this.messages.get(sid);
      if (!raw) continue;
      const encoded = encode(() => proto.WebMessageInfo.encode(raw).finish());
      if (encoded) snapshot.messages[sid] = encoded;
      const transcript = this.transcripts.get(sid);
      if (transcript) transcripts[sid] = transcript;
      const reacted = this.reactions.get(sid);
      if (reacted && reacted.size > 0) reactions[sid] = Object.fromEntries(reacted);
    }
    snapshot.transcripts = transcripts;
    snapshot.reactions = reactions;
    return snapshot;
  }

  /** A snapshot an older wazap wrote can still hold noise it used to keep. */
  hydrate(snapshot: StoreSnapshot): void {
    if (snapshot?.v !== 1) return;
    for (const [jid, b64] of Object.entries(snapshot.chats ?? {})) {
      if (isNoiseJid(jid)) continue;
      const chat = decodeChat(b64);
      if (chat) this.chats.set(jid, chat);
    }
    for (const [jid, contact] of Object.entries(snapshot.contacts ?? {})) this.contacts.set(jid, contact);
    for (const [jid, name] of Object.entries(snapshot.pushNames ?? {})) this.pushNames.set(jid, name);
    for (const [lid, pn] of Object.entries(snapshot.lids ?? {})) this.lids.set(lid, pn);
    this.contactsResyncedAt = snapshot.contactsResyncedAt ?? null;
    for (const [sid, b64] of Object.entries(snapshot.messages ?? {})) {
      const raw = decodeMessage(b64);
      if (raw && !isControlMessage(raw)) this.messages.set(sid, raw);
    }
    // A transcript of a message the snapshot no longer carries is a leak, not a cache.
    for (const [sid, transcript] of Object.entries(snapshot.transcripts ?? {})) {
      if (this.messages.has(sid)) this.transcripts.set(sid, transcript);
    }
    for (const [sid, byAuthor] of Object.entries(snapshot.reactions ?? {})) {
      if (this.messages.has(sid)) this.reactions.set(sid, new Map(Object.entries(byAuthor)));
    }
    for (const sid of snapshot.stories ?? []) {
      if (!this.messages.has(sid) || this.stories.includes(sid)) continue;
      this.stories.push(sid);
      this.chatOf.set(sid, "status@broadcast");
    }
    for (const [jid, ring] of Object.entries(snapshot.byChat ?? {})) {
      if (isNoiseJid(jid)) continue;
      const present = ring.filter((sid) => this.messages.has(sid));
      this.byChat.set(jid, present);
      for (const sid of present) this.chatOf.set(sid, jid);
    }
  }
}

/** How long `get_contact` waits for WhatsApp's about text or profile picture. */
export function encode(run: () => Uint8Array): string | null {
  try {
    return Buffer.from(run()).toString("base64");
  } catch {
    return null;
  }
}

export function decodeMessage(b64: string): WAMessage | null {
  try {
    return proto.WebMessageInfo.decode(Buffer.from(b64, "base64")) as unknown as WAMessage;
  } catch {
    return null;
  }
}

export function decodeChat(b64: string): BaileysChat | null {
  try {
    return proto.Conversation.decode(Buffer.from(b64, "base64")) as unknown as BaileysChat;
  } catch {
    return null;
  }
}

