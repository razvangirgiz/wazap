/**
 * main's boot path over an account's legacy files, replayed in memory and
 * read-only: the snapshot, the lid pairings and folds, the history files with
 * their revokes, tombstones, caps and call dedupe, the deferred reactions and
 * votes, and the retention barriers and deadlines, in the order and with the
 * rules WhatsAppService applied before it moved to the account database.
 *
 * This is the oracle the import is verified against, so it is main's code, not
 * a re-derivation of main's rules: the methods below are the service's, with
 * the writes taken out (no history rewrite, no snapshot, no notes save, no
 * recall feed) and the clock passed in, so a verification reads the same view
 * whenever it runs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { proto, type Contact as BaileysContact, type WAMessage, type WAMessageKey } from "baileys";
import type { AccountPaths } from "../config.js";
import { historyRecords } from "../history-records.js";
import { lidKey } from "../identity.js";
import { isGroupId, isNoiseJid } from "../ids.js";
import { messageExpiry } from "../message-expiry.js";
import { MessageRetention } from "../message-retention.js";
import {
  callInfo,
  isCallPlaceholder,
  isControlMessage,
  isEvent,
  isStubEvent,
  messageIdFor,
  messageTimestampMs,
  pollOf,
  reactionOf,
  revokedTargetKey,
  voteOf,
  type EncryptedVote,
} from "../messages.js";
import { Notes } from "../notes.js";
import { readVote } from "../polls.js";
import { isTrackedCall } from "../calls.js";
import { decodeMessage, Store, type StoreSnapshot } from "../store.js";
import type { CallInfo } from "../wa-types.js";

/** The legacy reload's per-file and per-ring window. */
const HISTORY_STORE_CAP_PER_CHAT = 2_000;
const CALL_DEDUPE_WINDOW_MS = 60_000;
const CALL_DEDUPE_SCAN = 20;

export interface LegacyReplayOptions {
  /** The linked account, as the service's `account`; null for an unlinked one. */
  owner: { id: string; name: string; number: string } | null;
  /** WAZAP_RETENTION. */
  retention: boolean;
  now: () => number;
}

function callDetail(raw: WAMessage, info: CallInfo): number {
  if (info.duration_seconds !== undefined) return 2;
  return isCallPlaceholder(raw) ? 0 : 1;
}

/** The own enumerable fields whose value is not undefined, so a spread cannot erase with "unknown". */
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export class LegacyReplay {
  readonly store = new Store();
  readonly retention: MessageRetention;
  readonly notes: Notes;
  private loading = false;

  constructor(
    private readonly paths: AccountPaths,
    private readonly options: LegacyReplayOptions
  ) {
    this.retention = new MessageRetention(options.retention);
    this.notes = new Notes(paths.notesFile, { persist: false });
  }

  /** What start() ran before the socket, then the cleanup and expiry it queued behind. */
  async load(): Promise<void> {
    await this.retention.load(join(this.paths.root, "retention.json"));
    this.loading = true;
    try {
      this.loadStoreSnapshot();
      await this.loadHistoryStore();
      this.foldVotes();
    } finally {
      this.loading = false;
    }
    // The boot's own expiry, then what the retention cleanup did in memory, until nothing changes.
    for (let changed = true; changed; ) {
      changed = this.expireMessages();
      for (const [sid, raw] of [...this.store.messages]) {
        if (this.retains(raw, sid)) continue;
        this.store.dropMessage(sid);
        changed = true;
      }
    }
  }

  ownJid(): string {
    return this.options.owner?.id ?? "";
  }

  canonical(jid: string): string {
    return this.store.lids.canonical(jid);
  }

  isMe(jid: string): boolean {
    return this.store.lids.isSelf(jid, this.ownJid(), undefined);
  }

  hasMessage(id: string): boolean {
    this.expireMessages();
    const raw = this.store.messages.get(id);
    return raw !== undefined && this.retains(raw, id);
  }

  private now(): number {
    return this.options.now();
  }

  private loadStoreSnapshot(): void {
    let snapshot: StoreSnapshot;
    try {
      snapshot = JSON.parse(readFileSync(this.paths.storeFile, "utf8")) as StoreSnapshot;
    } catch {
      // Absent, or unreadable: the service booted past both with an empty store.
      return;
    }
    try {
      this.store.hydrate(snapshot);
      for (const [sid, at] of Object.entries(snapshot.expires ?? {})) this.savedExpiry(sid, at);
      for (const [sid, raw] of this.store.messages) {
        this.observeExpiry(raw, sid);
        if (!this.retains(raw, sid)) this.store.dropMessage(sid);
      }
      for (const contact of this.store.contacts.values()) this.relearnLid(contact);
      for (const [lid, pn] of this.store.lids) this.learnLid(lid, pn);
      for (const key of [...this.store.byChat.keys(), ...this.store.chats.keys(), ...this.store.contacts.keys()]) {
        if (key.endsWith("@lid")) this.foldAlias(key);
      }
      this.foldReactions();
    } catch {
      // The service logged a snapshot it could not load and booted past it.
    }
  }

  private async loadHistoryStore(): Promise<void> {
    let files: string[];
    try {
      files = readdirSync(this.paths.historyDir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      return;
    }
    for (const name of files) {
      this.loadHistoryFile(join(this.paths.historyDir, name));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private loadHistoryFile(path: string): void {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return;
    }
    const { newest, tombstones } = historyRecords(text, (record) => {
      if (record.expiresAt !== undefined) this.savedExpiry(record.sid, record.expiresAt);
      if (record.raw) {
        const raw = decodeMessage(record.raw);
        if (raw) this.observeExpiry(raw, record.sid);
      }
    });
    const decoded = new Map<string, WAMessage>();
    const revoked = new Set<string>(tombstones.keys());
    for (const record of newest.values()) {
      const raw = decodeMessage(record.raw);
      if (!raw) continue;
      decoded.set(record.sid, raw);
      for (const sid of this.revokedSids(raw)) revoked.add(sid);
    }
    for (const sid of revoked) {
      newest.delete(sid);
      this.retention.deleted.set(sid, this.store.chatOf.get(sid) ?? sid.split("_")[1] ?? "");
      this.store.dropMessage(sid);
    }
    for (const [sid, raw] of decoded) {
      if (this.retains(raw, sid)) continue;
      newest.delete(sid);
      this.store.dropMessage(sid);
    }
    const kept = [...newest.values()].sort((a, b) => a.ts - b.ts).slice(-HISTORY_STORE_CAP_PER_CHAT);
    for (const record of kept) {
      const raw = decoded.get(record.sid);
      if (!raw?.key?.remoteJid || (!raw.message && !isStubEvent(raw))) continue;
      const jid = this.canonical(raw.key.remoteJid);
      if (isNoiseJid(jid) || isControlMessage(raw)) continue;
      if (this.store.messages.has(record.sid)) continue;
      if (this.applyReaction(raw, jid)) continue;
      if (this.applyVote(raw, jid)) continue;
      if (!this.keepOverEarlierCall(raw, jid, record.sid)) continue;
      this.store.putMessage(record.sid, jid, raw);
      if (record.tr) this.store.setTranscript(record.sid, record.tr);
    }
  }

  private relearnLid(contact: BaileysContact): void {
    if (!contact.lid) return;
    if (contact.phoneNumber) this.learnLid(contact.lid, contact.phoneNumber);
    else if (contact.id?.endsWith("@s.whatsapp.net")) this.learnLid(contact.lid, contact.id);
  }

  private learnLid(lid: string, pn: string): void {
    if (!lid || !pn) return;
    const paired = this.store.lids.learn(lid, pn);
    if (paired || this.loading) this.retention.alias(lidKey(lid), this.canonical(pn));
    const key = lidKey(lid);
    const phone = this.store.lids.phoneOf(key)!;
    const pushed = this.store.pushNames.get(key) ?? this.store.pushNames.get(phone);
    if (pushed) {
      this.store.pushNames.set(key, pushed);
      this.store.pushNames.set(phone, pushed);
    }
    this.foldAlias(key, paired);
  }

  private foldAlias(lid: string, newlyPaired = false): void {
    const jid = this.canonical(lid);
    if (jid === lid) return;
    const ring = this.store.byChat.get(lid);
    if (ring) {
      for (const sid of [...ring]) {
        const raw = this.store.messages.get(sid);
        if (raw && !this.retains(raw, sid)) this.store.dropMessage(sid);
        else if (raw) this.store.putMessage(sid, jid, raw);
      }
      this.store.byChat.delete(lid);
    }
    if (newlyPaired && (this.retention.deleted.size || this.retention.cleared.size)) {
      for (const sid of [...(this.store.byChat.get(jid) ?? [])]) {
        const raw = this.store.messages.get(sid);
        if (raw && !this.retains(raw, sid)) this.store.dropMessage(sid);
      }
    }
    const alias = this.store.chats.get(lid);
    if (alias) {
      const existing = this.store.chats.get(jid);
      const unreadCount = Math.max(alias.unreadCount ?? 0, existing?.unreadCount ?? 0);
      this.store.chats.set(jid, { ...alias, ...(existing ?? {}), id: jid, unreadCount });
      this.store.chats.delete(lid);
    }
    const contact = this.store.contacts.get(lid);
    if (contact) {
      const existing = this.store.contacts.get(jid);
      this.store.contacts.set(jid, { ...definedOnly(contact), ...definedOnly(existing ?? {}), id: jid });
      this.store.contacts.delete(lid);
    }
    this.notes.mergeInto(lid, jid);
  }

  private revokedTarget(raw: WAMessage): WAMessageKey | undefined {
    const target = revokedTargetKey(raw);
    if (!target || !raw.key?.remoteJid) return undefined;
    if (raw.messageStubType === proto.WebMessageInfo.StubType.REVOKE) return target;
    const author = target.participant || target.remoteJid;
    const fromMe = raw.key.fromMe ? !!target.fromMe : !target.fromMe && !!author && this.isMe(author);
    return { ...target, remoteJid: raw.key.remoteJid, fromMe };
  }

  private revokedSids(raw: WAMessage): string[] {
    const target = this.revokedTarget(raw);
    if (!target) return [];
    const jid = raw.key.remoteJid!;
    const keys =
      raw.messageStubType === proto.WebMessageInfo.StubType.REVOKE && isGroupId(jid)
        ? [
            { ...target, fromMe: false },
            { ...target, fromMe: true },
          ]
        : [target];
    return keys.flatMap((key) => this.targetSids(key, jid));
  }

  private targetSids(target: WAMessageKey, fallbackJid: string): string[] {
    const jid = target.remoteJid ?? fallbackJid;
    const raw = messageIdFor(target, jid);
    const canonical = messageIdFor(target, this.canonical(jid));
    const lid = this.store.lids.lidOf(this.canonical(jid));
    return [...new Set([raw, canonical, ...(lid ? [messageIdFor(target, lid)] : [])])];
  }

  private forgetMessages(sids: string[], chat?: string): void {
    for (const sid of sids) {
      this.retention.deleted.set(sid, this.store.chatOf.get(sid) ?? chat ?? sid.split("_")[1] ?? "");
      this.retention.expires.delete(sid);
      this.store.dropMessage(sid);
    }
    const chats = new Set(sids.map((sid) => this.canonical(this.retention.deleted.get(sid) ?? "")));
    for (const jid of chats) {
      for (const sid of [...(this.store.byChat.get(jid) ?? [])]) {
        const raw = this.store.messages.get(sid);
        if (raw && !this.retains(raw, sid)) this.store.dropMessage(sid);
      }
    }
  }

  private applyReaction(raw: WAMessage, chatJid: string): boolean {
    const reaction = reactionOf(raw);
    if (!reaction) return false;
    const author = raw.key.fromMe ? this.ownJid() : this.canonical(raw.key.participant || raw.key.remoteJid || chatJid);
    const target = messageIdFor(reaction.targetKey, chatJid);
    if (author) this.store.react(target, author, reaction.text);
    return true;
  }

  private foldReactions(): void {
    for (const [sid, raw] of [...this.store.messages]) {
      const jid = this.store.chatOf.get(sid);
      if (jid !== undefined && this.applyReaction(raw, jid)) this.store.dropMessage(sid);
    }
  }

  private applyVote(raw: WAMessage, chatJid: string): boolean {
    const vote = voteOf(raw);
    if (!vote) return false;
    const target = this.voteTarget(vote, chatJid);
    if (!target) return false;
    const reading = readVote(vote, target.raw, this.voteSpellings(target.raw), this.voteSpellings(raw));
    if (!reading) return false;
    const voter = raw.key.fromMe
      ? this.ownJid()
      : this.canonical(raw.key.participant || raw.participant || raw.key.remoteJid || chatJid);
    if (voter) this.store.vote(target.sid, voter, reading.choice, vote.at);
    return true;
  }

  private voteTarget(vote: EncryptedVote, chatJid: string): { sid: string; raw: WAMessage } | undefined {
    const remote = vote.targetKey.remoteJid;
    const lids = this.store.lids;
    const chats = [chatJid, remote ? this.canonical(remote) : "", lids.phoneOf(chatJid), lids.lidOf(chatJid)];
    const mine = Boolean(vote.targetKey.fromMe);
    for (const chat of new Set(chats)) {
      if (!chat) continue;
      for (const fromMe of [mine, !mine]) {
        const sid = messageIdFor({ ...vote.targetKey, fromMe }, chat);
        const raw = this.store.messages.get(sid);
        if (raw && (vote.kind === "poll" ? pollOf(raw) !== undefined : isEvent(raw))) return { sid, raw };
      }
    }
    return undefined;
  }

  private voteSpellings(raw: WAMessage): string[] {
    const key = raw.key;
    return this.store.lids.spellings(
      key.fromMe ? [this.ownJid()] : [key.participant, key.participantAlt, raw.participant, key.remoteJid, key.remoteJidAlt]
    );
  }

  private foldVotes(): void {
    for (const [sid, raw] of [...this.store.messages]) {
      const jid = this.store.chatOf.get(sid);
      if (jid === undefined || !this.applyVote(raw, jid)) continue;
      this.store.dropMessage(sid);
    }
  }

  private keepOverEarlierCall(raw: WAMessage, chatJid: string, sid: string): boolean {
    const info = callInfo(raw);
    if (!info) return true;
    const at = messageTimestampMs(raw);
    for (const known of this.store.recent(chatJid, CALL_DEDUPE_SCAN)) {
      if (known.sid === sid) continue;
      const other = callInfo(known.raw);
      if (!other) continue;
      if (isTrackedCall(raw) && isTrackedCall(known.raw)) continue;
      if (Math.abs(messageTimestampMs(known.raw) - at) > CALL_DEDUPE_WINDOW_MS) continue;
      if (callDetail(raw, info) <= callDetail(known.raw, other)) return false;
      this.store.dropMessage(known.sid);
      return true;
    }
    return true;
  }

  /** True when something expired. */
  private expireMessages(): boolean {
    if (this.loading) return false;
    const expired = this.retention.expire(this.now());
    if (expired.length > 0) this.forgetMessages(expired);
    return expired.length > 0;
  }

  private retainsRecord(item: { sid: string; jid: string; ts: number; expiresAt?: number }): boolean {
    if (this.options.retention && this.now() >= (item.expiresAt ?? Infinity)) return false;
    const parts = /^(true|false)_([^_]+)_([\s\S]*)$/.exec(item.sid);
    const jid = this.canonical(item.jid);
    const sids = parts ? this.targetSids({ fromMe: parts[1] === "true", remoteJid: parts[2], id: parts[3] }, jid) : [item.sid];
    const chats = [item.jid, jid, this.store.lids.lidOf(jid), parts?.[2]].filter((id): id is string => id !== undefined);
    return sids.every((sid) => chats.every((chat) => this.retention.allows(sid, chat, item.ts, this.now())));
  }

  private retains(raw: WAMessage, sid?: string): boolean {
    const jid = this.canonical(raw.key.remoteJid ?? "");
    return this.retainsRecord({
      sid: sid ?? messageIdFor(raw.key, jid),
      jid: raw.key.remoteJid ?? jid,
      ts: messageTimestampMs(raw),
      expiresAt: this.expiryFor(raw, sid),
    });
  }

  private savedExpiry(sid: string, at: number): void {
    const deadline = Number.isSafeInteger(at) && at >= 0 ? at : 0;
    this.retention.noteExpiry(sid, this.canonical(sid.split("_")[1] ?? ""), deadline);
  }

  private expiryFor(raw: WAMessage, sid?: string): number | undefined {
    if (!this.options.retention) return undefined;
    let deadline = messageExpiry(raw) ?? Infinity;
    const ids = [...this.targetSids(raw.key, raw.key.remoteJid ?? ""), ...(sid ? [sid] : [])];
    for (const id of ids) deadline = Math.min(deadline, this.retention.expires.get(id)?.at ?? Infinity);
    return deadline === Infinity ? undefined : deadline;
  }

  private observeExpiry(raw: WAMessage, sid?: string): void {
    if (!raw.key?.remoteJid) return;
    const at = this.expiryFor(raw, sid);
    if (at === undefined) return;
    const jid = this.canonical(raw.key.remoteJid);
    for (const id of [...this.targetSids(raw.key, jid), ...(sid ? [sid] : [])]) this.retention.noteExpiry(id, jid, at);
  }
}
