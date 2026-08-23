/**
 * WhatsApp service over Baileys. Baileys emits raw events rather than exposing
 * a queryable store, so this keeps a small in-memory store (chats, contacts,
 * messages by id) fed from those events, optionally persisted under the data
 * dir so a restart does not start blind.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
  proto,
  type AnyMessageContent,
  type Chat as BaileysChat,
  type Contact as BaileysContact,
  type GroupMetadata,
  type GroupParticipant,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from "baileys";
import type { ILogger } from "baileys/lib/Utils/logger.js";
import { readLinkedAccount, useAtomicAuthState } from "./auth-state.js";
import { BAILEYS_VERSION, paths, WAZAP_VERSION, type Config, type Paths } from "./config.js";
import { asWazapError, RELINK_FIX, RESET_FIX, WazapError } from "./errors.js";
import { isAddressableJid, isGroupId, resolveChatId } from "./ids.js";
import { log, logError } from "./logger.js";
import {
  buildMessageView,
  formatAge,
  isControlMessage,
  isoWithOffset,
  mediaInfo,
  messageIdFor,
  messageText,
  messageTimestampMs,
  protoNumber,
} from "./messages.js";
import type {
  ChatAction,
  ChatActionResult,
  ChatFilter,
  ChatSummary,
  ConnectionStatus,
  ContactDetails,
  ContactSummary,
  GroupAction,
  GroupActionResult,
  GroupInfo,
  MediaResult,
  MediaSource,
  MessageView,
  ParticipantResult,
  RecentConversation,
  SentMessage,
  StatusInfo,
  SyncState,
  Synced,
  WhatsAppApi,
} from "./wa-types.js";

/** Reconnect pacing. A closed socket used to be retried instantly, which turns
 * any persistent rejection into a login storm — WhatsApp answers that by
 * throttling the account and refusing to link *any* new device to it, phone
 * included. Retries are spaced, jittered and capped; past the cap we stop and
 * wait for a human instead of hammering. */
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 5 * 60_000;
const RECONNECT_MAX_ATTEMPTS = 10;

const SYNC_WAIT_MS = 10_000;
const HISTORY_FETCH_WAIT_MS = 5_000;
const INLINE_IMAGE_MAX_BYTES = 1_000_000;
const MAX_TEXT_CHARS = 65_536;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const EDIT_WINDOW_MS = 15 * 60_000;
const RETRACT_WINDOW_MS = 2 * 24 * 3_600_000;
const MAX_GROUP_PARTICIPANTS = 500;
const STALE_INBOUND_MS = 24 * 3_600_000;
const MAX_MESSAGES_PER_CHAT = 1_000;
const PERSIST_MESSAGES_PER_CHAT = 120;
const STORE_SAVE_DEBOUNCE_MS = 20_000;
const HISTORY_STORE_CAP_PER_CHAT = 2_000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Baileys logs at info level to stdout by default, which corrupts the MCP
 * JSON-RPC stream on stdio. */
const silentLogger: ILogger = {
  level: "silent",
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface HistoryRecord {
  sid: string;
  ts: number;
  raw: string;
}

interface StoreSnapshot {
  v: 1;
  chats: Record<string, string>;
  contacts: Record<string, BaileysContact>;
  messages: Record<string, string>;
  byChat: Record<string, string[]>;
  /** Added in 0.9.4; absent in snapshots older wazap versions wrote. */
  pushNames?: Record<string, string>;
}

/** In-memory state fed from Baileys events, keyed by canonical jid. */
class Store {
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
      if (dropped) {
        this.messages.delete(dropped);
        this.chatOf.delete(dropped);
        this.edited.delete(dropped);
        this.reactions.delete(dropped);
      }
    }
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
    };
    for (const [jid, chat] of this.chats) {
      const encoded = encode(() => proto.Conversation.encode(chat).finish());
      if (encoded) snapshot.chats[jid] = encoded;
    }
    for (const [jid, contact] of this.contacts) snapshot.contacts[jid] = contact;
    const keep = new Set<string>();
    for (const [jid, ring] of this.byChat) {
      const capped = ring.slice(-PERSIST_MESSAGES_PER_CHAT);
      snapshot.byChat[jid] = capped;
      for (const sid of capped) keep.add(sid);
    }
    for (const sid of keep) {
      const raw = this.messages.get(sid);
      if (!raw) continue;
      const encoded = encode(() => proto.WebMessageInfo.encode(raw).finish());
      if (encoded) snapshot.messages[sid] = encoded;
    }
    return snapshot;
  }

  /** A snapshot an older wazap wrote can still hold noise it used to keep. */
  hydrate(snapshot: StoreSnapshot): void {
    if (snapshot?.v !== 1) return;
    for (const [jid, b64] of Object.entries(snapshot.chats ?? {})) {
      if (!isAddressableJid(jid)) continue;
      const chat = decodeChat(b64);
      if (chat) this.chats.set(jid, chat);
    }
    for (const [jid, contact] of Object.entries(snapshot.contacts ?? {})) this.contacts.set(jid, contact);
    for (const [jid, name] of Object.entries(snapshot.pushNames ?? {})) this.pushNames.set(jid, name);
    for (const [sid, b64] of Object.entries(snapshot.messages ?? {})) {
      const raw = decodeMessage(b64);
      if (raw && !isControlMessage(raw)) this.messages.set(sid, raw);
    }
    for (const [jid, ring] of Object.entries(snapshot.byChat ?? {})) {
      if (!isAddressableJid(jid)) continue;
      const present = ring.filter((sid) => this.messages.has(sid));
      this.byChat.set(jid, present);
      for (const sid of present) this.chatOf.set(sid, jid);
    }
  }
}

/**
 * The browser identity sent at handshake. WhatsApp closes the socket with 428
 * before offering a QR for Browsers.macOS("Desktop") (verified 2026-08-22 on
 * baileys 7.0.0-rc14); "Chrome" is accepted.
 */
export const WA_BROWSER = Browsers.macOS("Chrome");

export class WhatsAppService implements WhatsAppApi {
  private sockClient: WASocket | null = null;
  private saveCreds: (() => Promise<void>) | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private starting = false;
  private stopped = false;
  /** Bumped per socket, so events from a superseded socket are ignored. */
  private generation = 0;
  private status: ConnectionStatus = "connecting";
  private lastError: string | null = null;
  private account: StatusInfo["account"] = null;
  private lastInboundAt: number | null = null;
  private initialSyncDone = false;
  private historyReceived = false;
  private syncDeadline: ReturnType<typeof setTimeout> | null = null;
  private syncWaiters: Array<() => void> = [];
  private historyWaiters: Array<() => void> = [];
  private storeDirty = false;
  private storeSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private persistedLoaded = false;
  private readonly blocked = new Set<string>();
  private readonly groupCache = new Map<string, GroupMetadata>();
  /** `<user>@lid` to the phone-number jid, so ids we hand out stay canonical. */
  private readonly lidToPn = new Map<string, string>();
  private readonly store = new Store();
  private readonly paths: Paths;

  constructor(private readonly config: Config) {
    this.paths = paths(config.dataDir);
  }

  async start(): Promise<void> {
    if (this.stopped || this.starting) return;
    this.starting = true;
    try {
      const linked = this.readAccount();
      if (linked === "corrupt" || linked === null) return;
      this.account = linked;
      await this.loadPersisted();

      let state;
      try {
        ({ state, saveCreds: this.saveCreds } = await useAtomicAuthState(this.paths.authDir));
      } catch (err) {
        this.markCorrupt(err);
        return;
      }

      this.teardownSocket();
      this.initialSyncDone = false;
      this.status = "connecting";
      const generation = ++this.generation;
      const sock = makeWASocket({
        auth: state,
        logger: silentLogger,
        browser: WA_BROWSER,
        syncFullHistory: this.config.syncFullHistory,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
      });
      this.sockClient = sock;
      this.wireEvents(sock, generation);
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of [this.storeSaveTimer, this.reconnectTimer, this.syncDeadline]) {
      if (timer) clearTimeout(timer);
    }
    this.storeSaveTimer = null;
    this.reconnectTimer = null;
    this.syncDeadline = null;
    this.releaseWaiters();
    await this.flushStore();
    this.teardownSocket();
  }

  /** True once WhatsApp has delivered at least one history-sync batch. */
  hasHistory(): boolean {
    return this.historyReceived;
  }

  storeCounts(): { chats: number; contacts: number; messages: number } {
    return { chats: this.store.chats.size, contacts: this.store.contacts.size, messages: this.store.messages.size };
  }

  getStatus(): StatusInfo {
    const info: StatusInfo = {
      status: this.status,
      sync: this.syncState(),
      account: this.account,
      last_message_received_at: this.lastInboundAt === null ? null : isoWithOffset(this.lastInboundAt),
      reconnect_attempts: this.reconnectAttempts,
      wazap_version: WAZAP_VERSION,
      baileys_version: BAILEYS_VERSION,
      data_dir: this.config.dataDir,
      read_only: this.config.readOnly,
      rate_limit: this.config.rateLimitPerMinute,
      last_error: this.lastError,
    };
    const stale = this.lastInboundAt !== null && Date.now() - this.lastInboundAt > STALE_INBOUND_MS;
    if (this.status === "connected" && stale) {
      info.hint = "No messages received for 24h; the phone may be offline.";
    }
    return info;
  }

  listChats(filter: ChatFilter, limit: number): Promise<Synced<ChatSummary[]>> {
    return this.guarded(async () => {
      this.ensureConnected();
      await this.waitForSync();
      const chats = this.knownChats()
        .filter((chat) => this.matchesChatFilter(chat, filter))
        .sort((a, b) => this.chatActivity(b) - this.chatActivity(a))
        .slice(0, limit)
        .map((chat) => this.chatSummary(chat));
      return this.synced(chats);
    });
  }

  readMessages(chatId: string, limit: number, before?: string): Promise<Synced<MessageView[]>> {
    return this.guarded(async () => {
      const sock = this.ensureConnected();
      const jid = this.resolveId(chatId);
      await this.waitForSync();
      await this.learnParticipants(jid);

      if (before === undefined) {
        const ring = this.store.byChat.get(jid) ?? [];
        return this.synced(this.viewsFor(ring.slice(-limit), jid));
      }

      const anchor = this.messageOrThrow(before);
      let older = this.olderThan(jid, before, limit);
      if (older.length === 0) {
        await this.fetchOlder(sock, anchor, limit);
        older = this.olderThan(jid, before, limit);
      }
      return this.synced(this.viewsFor(older, jid));
    });
  }

  getRecentMessages(
    hours: number,
    filter: Exclude<ChatFilter, "archived">,
    includeSystem = false,
  ): Promise<Synced<RecentConversation[]>> {
    return this.guarded(async () => {
      this.ensureConnected();
      await this.waitForSync();
      const cutoff = Date.now() - hours * 3_600_000;
      const conversations: RecentConversation[] = [];

      for (const [jid, ring] of this.store.byChat) {
        if (!isAddressableJid(jid)) continue;
        const chat = this.store.chats.get(jid);
        if (chat && !this.matchesChatFilter(chat, filter)) continue;
        if (!chat && (filter === "unread" || filter === (isGroupId(jid) ? "individual" : "groups"))) continue;

        const recent = ring.filter((sid) => {
          const raw = this.store.messages.get(sid);
          return raw !== undefined && messageTimestampMs(raw) >= cutoff;
        });
        if (recent.length === 0) continue;

        const messages = this.viewsFor(recent, jid).filter((view) => includeSystem || view.type !== "system");
        if (messages.length === 0) continue;
        const last = messages[messages.length - 1];
        conversations.push({
          chat_id: jid,
          chat_name: this.displayName(jid),
          type: isGroupId(jid) ? "group" : "individual",
          last_activity: last ? last.timestamp : isoWithOffset(cutoff),
          messages,
        });
      }

      conversations.sort((a, b) => b.last_activity.localeCompare(a.last_activity));
      return this.synced(conversations);
    });
  }

  searchMessages(query: string, chatId: string | undefined, limit: number): Promise<Synced<MessageView[]>> {
    return this.guarded(async () => {
      this.ensureConnected();
      await this.waitForSync();
      const needle = query.trim().toLowerCase();
      const scope = chatId === undefined ? undefined : this.resolveId(chatId);
      const hits: Array<{ sid: string; jid: string; at: number }> = [];

      for (const [sid, raw] of this.store.messages) {
        const jid = this.store.chatOf.get(sid);
        if (!jid || (scope !== undefined && jid !== scope)) continue;
        if (needle && !messageText(raw).toLowerCase().includes(needle)) continue;
        hits.push({ sid, jid, at: messageTimestampMs(raw) });
      }

      hits.sort((a, b) => b.at - a.at);
      return this.synced(hits.slice(0, limit).map((hit) => this.viewOf(hit.sid, hit.jid)));
    });
  }

  getMessage(messageId: string): Promise<MessageView> {
    return this.guarded(async () => {
      this.ensureConnected();
      this.messageOrThrow(messageId);
      return this.viewOf(messageId, this.store.chatOf.get(messageId) ?? "");
    });
  }

  searchContacts(query: string, limit: number): Promise<ContactSummary[]> {
    return this.guarded(async () => {
      this.ensureConnected();
      await this.waitForSync();
      const needle = query.trim().toLowerCase();
      const digits = needle.replace(/\D/g, "");
      const matches: ContactSummary[] = [];

      for (const [jid, contact] of this.store.contacts) {
        const name = (contact.name ?? "").toLowerCase();
        const notify = (contact.notify ?? "").toLowerCase();
        const number = jid.split("@")[0] ?? "";
        const hit =
          needle === "" ||
          name.includes(needle) ||
          notify.includes(needle) ||
          (digits.length >= 5 && number.includes(digits));
        if (!hit) continue;
        matches.push(this.contactSummary(jid, contact));
        if (matches.length >= limit) break;
      }
      return matches;
    });
  }

  getContact(contactId: string): Promise<ContactDetails> {
    return this.guarded(async () => {
      const sock = this.ensureConnected();
      const jid = this.resolveId(contactId);
      const contact = this.store.contacts.get(jid);
      const [about, picture] = await Promise.all([
        sock
          .fetchStatus(jid)
          .then((entries) => statusTextOf(entries?.[0]))
          .catch(() => null),
        sock.profilePictureUrl(jid, "image").catch(() => null),
      ]);
      return {
        ...this.contactSummary(jid, contact),
        about,
        profile_pic_url: picture ?? null,
        is_blocked: this.blocked.has(jid),
      };
    });
  }

  getGroupInfo(groupId: string): Promise<GroupInfo> {
    return this.guarded(async () => {
      this.ensureConnected();
      const jid = this.resolveId(groupId);
      if (!isGroupId(jid)) {
        throw new WazapError("GROUP_NOT_FOUND", `"${groupId}" is not a group id.`, "Group ids end in @g.us");
      }
      const meta = await this.groupMeta(jid, true);
      const mine = this.myParticipation(meta);
      if (!mine) {
        throw new WazapError("NOT_A_PARTICIPANT", `The linked account is not a participant of ${jid}.`);
      }
      const iAmAdmin = isAdmin(mine);

      const info: GroupInfo = {
        chat_id: jid,
        name: meta.subject,
        description: meta.desc ?? null,
        owner: meta.owner ? this.canonical(meta.owner) : null,
        created_at: meta.creation ? isoWithOffset(meta.creation * 1000) : null,
        participant_count: meta.participants.length,
        participants: meta.participants.slice(0, MAX_GROUP_PARTICIPANTS).map((p) => {
          const id = this.canonical(p.id);
          return { contact_id: id, name: this.displayName(id), is_admin: isAdmin(p) };
        }),
        announcement_only: Boolean(meta.announce),
        i_am_admin: iAmAdmin,
      };

      if (iAmAdmin) {
        const link = await this.inviteLink(jid).catch(() => null);
        if (link) info.invite_link = link;
      }
      return info;
    });
  }

  downloadMedia(messageId: string, saveTo?: string): Promise<MediaResult> {
    return this.guarded(async () => {
      const sock = this.ensureConnected();
      const raw = this.messageOrThrow(messageId);
      const info = mediaInfo(raw);
      if (!info) throw new WazapError("MEDIA_UNAVAILABLE", `Message ${messageId} carries no media.`);

      let buffer: Buffer;
      try {
        buffer = await downloadMediaMessage(raw, "buffer", {}, {
          logger: silentLogger,
          reuploadRequest: sock.updateMediaMessage,
        });
      } catch (err) {
        throw new WazapError(
          "MEDIA_UNAVAILABLE",
          `Could not download the media of ${messageId}: ${describe(err)}`,
          "Ask the sender to resend it",
        );
      }

      const dir = saveTo ?? this.paths.mediaDir;
      if (!isAbsolute(dir)) {
        throw new WazapError("FILE_NOT_FOUND", `"${dir}" is not an absolute directory path.`);
      }
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
      const filename = mediaFilename(info);
      const path = join(dir, filename);
      await writeFile(path, buffer, { mode: FILE_MODE });

      const inline =
        info.mime.startsWith("image/") && buffer.length <= INLINE_IMAGE_MAX_BYTES ? buffer.toString("base64") : null;
      return { path, mime: info.mime, size: buffer.length, filename, inline_base64: inline };
    });
  }

  sendMessage(chatId: string, text: string, replyTo?: string, mentionIds?: string[]): Promise<SentMessage> {
    return this.guarded(async () => {
      this.beginWrite();
      if (text.length > MAX_TEXT_CHARS) {
        throw new WazapError("TEXT_TOO_LONG", `The text is ${text.length} characters; WhatsApp allows ${MAX_TEXT_CHARS}.`);
      }
      const { sock, jid } = await this.prepareSend(chatId);
      const mentions = (mentionIds ?? []).map((id) => this.resolveId(id));
      const quoted = replyTo === undefined ? undefined : this.messageOrThrow(replyTo);
      const sent = await sock.sendMessage(jid, mentions.length > 0 ? { text, mentions } : { text }, quoted ? { quoted } : {});
      return this.sentResult(sent, jid, text);
    });
  }

  sendMedia(
    chatId: string,
    source: MediaSource,
    opts: { caption?: string; asDocument: boolean; asVoice: boolean },
  ): Promise<SentMessage> {
    return this.guarded(async () => {
      const { sock, jid } = await this.prepareSend(chatId);
      const media = await loadMedia(source);
      const content = mediaContent(media, opts);
      const sent = await sock.sendMessage(jid, content);
      return this.sentResult(sent, jid, opts.caption ?? `[${media.mimetype}]`);
    });
  }

  sendPoll(chatId: string, question: string, options: string[], multiSelect: boolean): Promise<SentMessage> {
    return this.guarded(async () => {
      const { sock, jid } = await this.prepareSend(chatId);
      const sent = await sock.sendMessage(jid, {
        poll: { name: question, values: options, selectableCount: multiSelect ? options.length : 1 },
      });
      return this.sentResult(sent, jid, `[poll] ${question}`);
    });
  }

  sendLocation(
    chatId: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string,
  ): Promise<SentMessage> {
    return this.guarded(async () => {
      const { sock, jid } = await this.prepareSend(chatId);
      const sent = await sock.sendMessage(jid, {
        location: { degreesLatitude: latitude, degreesLongitude: longitude, name, address },
      });
      return this.sentResult(sent, jid, `[location] ${name ?? `${latitude}, ${longitude}`}`);
    });
  }

  editMessage(messageId: string, text: string): Promise<SentMessage> {
    return this.guarded(async () => {
      this.beginWrite();
      if (text.length > MAX_TEXT_CHARS) {
        throw new WazapError("TEXT_TOO_LONG", `The text is ${text.length} characters; WhatsApp allows ${MAX_TEXT_CHARS}.`);
      }
      const raw = this.messageOrThrow(messageId);
      if (!raw.key.fromMe) {
        throw new WazapError("NOT_OWN_MESSAGE", `Message ${messageId} was not sent by the linked account.`);
      }
      const age = Date.now() - messageTimestampMs(raw);
      if (age > EDIT_WINDOW_MS) {
        throw new WazapError("EDIT_WINDOW_EXPIRED", `Message ${messageId} is older than 15 minutes.`);
      }
      const { sock, jid } = await this.prepareSend(this.chatOfOrThrow(messageId));
      await sock.sendMessage(jid, { text, edit: raw.key });
      return { message_id: messageId, chat_id: jid, text, timestamp: isoWithOffset(Date.now()) };
    });
  }

  reactToMessage(messageId: string, emoji: string): Promise<{ message_id: string; emoji: string }> {
    return this.guarded(async () => {
      this.beginWrite();
      const raw = this.messageOrThrow(messageId);
      const { sock, jid } = await this.prepareSend(this.chatOfOrThrow(messageId));
      await sock.sendMessage(jid, { react: { text: emoji, key: raw.key } });
      return { message_id: messageId, emoji };
    });
  }

  forwardMessage(messageId: string, toChatId: string): Promise<SentMessage> {
    return this.guarded(async () => {
      this.beginWrite();
      const raw = this.messageOrThrow(messageId);
      const { sock, jid } = await this.prepareSend(toChatId);
      const sent = await sock.sendMessage(jid, { forward: raw });
      return this.sentResult(sent, jid, messageText(raw));
    });
  }

  deleteMessage(messageId: string, forEveryone: boolean): Promise<{ message_id: string; for_everyone: boolean }> {
    return this.guarded(async () => {
      this.beginWrite();
      const raw = this.messageOrThrow(messageId);
      if (!forEveryone) {
        throw new WazapError(
          "WHATSAPP_ERROR",
          "WhatsApp only supports delete-for-everyone from a linked device; deleting for yourself alone is not available.",
          "Call delete_message again with for_everyone=true",
        );
      }
      if (!raw.key.fromMe) {
        throw new WazapError("NOT_OWN_MESSAGE", `Message ${messageId} was not sent by the linked account.`);
      }
      if (Date.now() - messageTimestampMs(raw) > RETRACT_WINDOW_MS) {
        throw new WazapError("RETRACT_WINDOW_EXPIRED", `Message ${messageId} is older than 2 days.`);
      }
      const { sock, jid } = await this.prepareSend(this.chatOfOrThrow(messageId));
      await sock.sendMessage(jid, { delete: raw.key });
      return { message_id: messageId, for_everyone: true };
    });
  }

  manageChat(chatId: string, action: ChatAction, muteHours?: number): Promise<ChatActionResult> {
    return this.guarded(async () => {
      const sock = this.beginWrite();
      const jid = this.resolveId(chatId);
      const last = this.lastMessageOf(jid);
      const lastMessages = last ? [last] : [];

      switch (action) {
        case "archive":
        case "unarchive":
          await sock.chatModify({ archive: action === "archive", lastMessages }, jid);
          break;
        case "pin":
        case "unpin":
          await sock.chatModify({ pin: action === "pin" }, jid);
          break;
        case "mute":
          await sock.chatModify({ mute: (muteHours ?? 8) * 3_600_000 }, jid);
          break;
        case "unmute":
          await sock.chatModify({ mute: null }, jid);
          break;
        case "mark_read":
          if (last) await sock.readMessages([last.key]);
          break;
        case "mark_unread":
          await sock.chatModify({ markRead: false, lastMessages }, jid);
          break;
      }

      const detail = action === "mute" ? ` for ${muteHours ?? 8}h` : "";
      return { chat_id: jid, action, applied: `${action}${detail}` };
    });
  }

  createGroup(name: string, participantIds: string[]): Promise<{ chat_id: string; participants: ParticipantResult[] }> {
    return this.guarded(async () => {
      const sock = this.beginWrite();
      const ids = participantIds.map((id) => this.resolveId(id));
      const meta = await sock.groupCreate(name, ids);
      this.cacheGroup(this.canonical(meta.id), meta);
      const present = new Set(meta.participants.map((p) => this.canonical(p.id)));
      return {
        chat_id: this.canonical(meta.id),
        participants: ids.map((id) =>
          present.has(id)
            ? { id, status: "ok" as const }
            : { id, status: "failed" as const, reason: "WhatsApp did not add this participant" },
        ),
      };
    });
  }

  manageGroup(
    groupId: string,
    action: GroupAction,
    participantIds?: string[],
    value?: string,
  ): Promise<GroupActionResult> {
    return this.guarded(async () => {
      const sock = this.beginWrite();
      const jid = this.resolveId(groupId);
      if (!isGroupId(jid)) {
        throw new WazapError("GROUP_NOT_FOUND", `"${groupId}" is not a group id.`, "Group ids end in @g.us");
      }

      if (ADMIN_ACTIONS.has(action)) await this.assertGroupAdmin(jid, action);
      const ids = (participantIds ?? []).map((id) => this.resolveId(id));
      if (PARTICIPANT_ACTIONS.has(action) && ids.length === 0) {
        throw new WazapError("INVALID_ID", `The "${action}" action needs at least one participant id.`);
      }

      switch (action) {
        case "add":
        case "remove":
        case "promote":
        case "demote": {
          const results = await sock.groupParticipantsUpdate(jid, ids, action);
          this.groupCache.delete(jid);
          return {
            group_id: jid,
            action,
            applied: `${action} ${ids.length} participant(s)`,
            participants: results.map((entry, index) => this.participantResult(entry, ids[index])),
          };
        }
        case "leave":
          await sock.groupLeave(jid);
          this.groupCache.delete(jid);
          return { group_id: jid, action, applied: "left the group" };
        case "set_subject": {
          const subject = requireValue(value, "set_subject", "the new group name");
          await sock.groupUpdateSubject(jid, subject);
          this.groupCache.delete(jid);
          return { group_id: jid, action, applied: `subject set to "${subject}"` };
        }
        case "set_description": {
          const description = requireValue(value, "set_description", "the new description");
          await sock.groupUpdateDescription(jid, description);
          this.groupCache.delete(jid);
          return { group_id: jid, action, applied: "description updated" };
        }
        case "get_invite_link": {
          const link = await this.inviteLink(jid);
          return { group_id: jid, action, applied: "invite link fetched", invite_link: link };
        }
        case "revoke_invite_link": {
          const code = await sock.groupRevokeInvite(jid);
          const link = code ? `https://chat.whatsapp.com/${code}` : undefined;
          return {
            group_id: jid,
            action,
            applied: "invite link revoked",
            ...(link ? { invite_link: link } : {}),
          };
        }
      }
    });
  }

  /** Close the current socket and mute it, so a socket we are replacing can no
   * longer emit a close event and trigger a reconnect of its own. */
  private teardownSocket(): void {
    const sock = this.sockClient;
    if (!sock) return;
    this.sockClient = null;
    try {
      sock.ev.removeAllListeners("connection.update");
      void sock.end(undefined);
    } catch (err) {
      logError("teardown", err);
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    this.teardownSocket();
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.status = "auth_failure";
      this.lastError =
        `${reason} — gave up after ${RECONNECT_MAX_ATTEMPTS} attempts. ` +
        "WhatsApp keeps rejecting this session: re-link the device with `npx wazap-mcp login`.";
      logError("reconnect", this.lastError);
      return;
    }
    const attempt = this.reconnectAttempts++;
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    const delay = Math.round(backoff * (0.5 + Math.random()));
    log(`disconnected (${reason}); retry ${attempt + 1}/${RECONNECT_MAX_ATTEMPTS} in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((err) => {
        logError("reconnect", err);
        this.scheduleReconnect("reconnect failed");
      });
    }, delay);
  }

  private wireEvents(sock: WASocket, generation: number): void {
    sock.ev.on("creds.update", () => void this.saveCreds?.());

    sock.ev.on("connection.update", (update) => {
      if (generation !== this.generation) return;
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        this.reconnectAttempts = 0;
        this.status = "connected";
        this.lastError = null;
        this.adoptSocketAccount();
        this.armSyncDeadline();
        log("connected to WhatsApp");
      } else if (connection === "close") {
        const code = statusCodeOf(lastDisconnect?.error);
        if (code === DisconnectReason.loggedOut) {
          this.status = "logged_out";
          this.lastError = "The account was unlinked from the phone.";
          logError("auth", this.lastError);
          this.teardownSocket();
        } else if (!this.stopped) {
          this.status = "disconnected";
          this.lastError = lastDisconnect?.error?.message ?? "connection closed";
          this.scheduleReconnect(this.lastError);
        }
      }
    });

    sock.ev.on("messaging-history.set", ({ chats, contacts, messages, lidPnMappings, isLatest, progress }) => {
      for (const mapping of lidPnMappings ?? []) this.learnLid(mapping.lid, mapping.pn);
      for (const contact of contacts) this.ingestContact(contact);
      for (const chat of chats) this.ingestChat(chat);
      const stored = this.ingestMessages(messages ?? []);
      void this.appendHistory(stored);
      this.historyReceived = true;
      this.releaseHistoryWaiters();
      if (isLatest === true || progress === 100) this.markSyncDone();
      this.markStoreDirty();
    });

    sock.ev.on("lid-mapping.update", (mapping) => this.learnLid(mapping.lid, mapping.pn));

    sock.ev.on("chats.upsert", (chats) => {
      for (const chat of chats) this.ingestChat(chat);
      this.markStoreDirty();
    });

    sock.ev.on("chats.update", (updates) => {
      for (const update of updates) {
        if (!update.id) continue;
        const jid = this.canonical(update.id);
        if (!isAddressableJid(jid)) continue;
        const previous = this.store.chats.get(jid);
        this.store.chats.set(jid, { ...(previous ?? {}), ...update, id: jid });
      }
      this.markStoreDirty();
    });

    sock.ev.on("chats.delete", (ids) => {
      for (const id of ids) this.store.chats.delete(this.canonical(id));
    });

    sock.ev.on("contacts.upsert", (contacts) => {
      for (const contact of contacts) this.ingestContact(contact);
      this.markStoreDirty();
    });

    sock.ev.on("contacts.update", (updates) => {
      for (const update of updates) {
        if (!update.id) continue;
        const previous = this.store.contacts.get(this.canonical(update.id));
        this.ingestContact({ ...(previous ?? {}), ...update, id: update.id });
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      const stored = this.ingestMessages(messages);
      if (type === "notify") {
        for (const raw of messages) {
          if (raw.key.fromMe) continue;
          this.lastInboundAt = Math.max(this.lastInboundAt ?? 0, messageTimestampMs(raw));
        }
      }
      void this.appendHistory(stored);
      this.markStoreDirty();
    });

    sock.ev.on("messages.update", (updates) => {
      for (const { key, update } of updates) {
        const jid = key.remoteJid ? this.canonical(key.remoteJid) : undefined;
        if (!jid) continue;
        const sid = messageIdFor(key, jid);
        const raw = this.store.messages.get(sid);
        if (!raw) continue;
        const edited = update.message?.editedMessage?.message;
        if (edited) {
          this.store.edited.add(sid);
          raw.message = edited;
        }
        if (update.messageTimestamp) raw.messageTimestamp = update.messageTimestamp;
        this.markStoreDirty();
      }
    });

    sock.ev.on("messages.reaction", (items) => {
      for (const { key, reaction } of items) {
        const jid = key.remoteJid ? this.canonical(key.remoteJid) : undefined;
        if (!jid) continue;
        const target = messageIdFor(key, jid);
        const author = reaction.key?.fromMe
          ? this.ownJid()
          : this.canonical(reaction.key?.participant ?? reaction.key?.remoteJid ?? "");
        if (!author) continue;
        const map = this.store.reactions.get(target) ?? new Map<string, string>();
        if (reaction.text) map.set(author, reaction.text);
        else map.delete(author);
        if (map.size > 0) this.store.reactions.set(target, map);
        else this.store.reactions.delete(target);
      }
    });

    sock.ev.on("groups.upsert", (groups) => {
      for (const meta of groups) this.cacheGroup(this.canonical(meta.id), meta);
    });

    sock.ev.on("groups.update", (updates) => {
      for (const update of updates) {
        if (!update.id) continue;
        const jid = this.canonical(update.id);
        const previous = this.groupCache.get(jid);
        if (previous) this.groupCache.set(jid, { ...previous, ...update });
      }
    });

    sock.ev.on("group-participants.update", ({ id }) => this.groupCache.delete(this.canonical(id)));

    sock.ev.on("blocklist.set", ({ blocklist }) => {
      this.blocked.clear();
      for (const jid of blocklist) this.blocked.add(this.canonical(jid));
    });

    sock.ev.on("blocklist.update", ({ blocklist, type }) => {
      for (const jid of blocklist) {
        if (type === "add") this.blocked.add(this.canonical(jid));
        else this.blocked.delete(this.canonical(jid));
      }
    });
  }

  private readAccount(): StatusInfo["account"] | "corrupt" {
    let linked;
    try {
      linked = readLinkedAccount(this.paths.authDir);
    } catch (err) {
      this.markCorrupt(err);
      return "corrupt";
    }
    if (!linked) {
      this.status = "not_linked";
      this.account = null;
      this.lastError = null;
      log("no WhatsApp account is linked; run `npx wazap-mcp login`");
      return null;
    }
    return { id: linked.id, name: linked.name, number: linked.number };
  }

  private markCorrupt(err: unknown): void {
    this.status = "session_corrupt";
    this.lastError = describe(err);
    logError("auth state", err);
  }

  private adoptSocketAccount(): void {
    const user = this.sockClient?.user;
    if (!user?.id) return;
    const id = this.canonical(user.id);
    this.account = { id, name: user.name ?? this.account?.name ?? "", number: id.split("@")[0] ?? "" };
    if (user.lid) this.learnLid(user.lid, id);
  }

  private ownJid(): string {
    const id = this.sockClient?.user?.id;
    if (id) return this.canonical(id);
    return this.account?.id ?? "";
  }

  private isMe(jid: string): boolean {
    const own = this.ownJid();
    if (!own) return false;
    if (this.canonical(jid) === own) return true;
    const lid = this.sockClient?.user?.lid;
    return lid !== undefined && jidNormalizedUser(lid) === jidNormalizedUser(jid);
  }

  private armSyncDeadline(): void {
    if (this.syncDeadline) clearTimeout(this.syncDeadline);
    this.syncDeadline = setTimeout(() => this.markSyncDone(), SYNC_WAIT_MS);
  }

  private markSyncDone(): void {
    if (this.syncDeadline) {
      clearTimeout(this.syncDeadline);
      this.syncDeadline = null;
    }
    if (this.initialSyncDone) return;
    this.initialSyncDone = true;
    this.releaseWaiters();
  }

  private releaseWaiters(): void {
    const waiters = this.syncWaiters;
    this.syncWaiters = [];
    for (const waiter of waiters) waiter();
    this.releaseHistoryWaiters();
  }

  private releaseHistoryWaiters(): void {
    const waiters = this.historyWaiters;
    this.historyWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Resolves as soon as the initial sync lands, and in any case within 10s. */
  private waitForSync(): Promise<void> {
    if (this.initialSyncDone) return Promise.resolve();
    return new Promise<void>((done) => {
      const timer = setTimeout(() => {
        this.syncWaiters = this.syncWaiters.filter((entry) => entry !== waiter);
        done();
      }, SYNC_WAIT_MS);
      const waiter = (): void => {
        clearTimeout(timer);
        done();
      };
      this.syncWaiters.push(waiter);
    });
  }

  private syncState(): SyncState {
    return this.initialSyncDone ? "done" : "in_progress";
  }

  private synced<T>(data: T): Synced<T> {
    return { data, sync: this.syncState() };
  }

  /** Every public method funnels through here, so no raw Baileys error escapes. */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      throw asWazapError(err);
    }
  }

  private ensureConnected(): WASocket {
    switch (this.status) {
      case "not_linked":
        throw new WazapError("NOT_LINKED", "No WhatsApp account is linked.", RELINK_FIX);
      case "session_corrupt":
        throw new WazapError("SESSION_CORRUPT", this.lastError ?? "Stored credentials are unreadable.", RESET_FIX);
      case "logged_out":
        throw new WazapError("SESSION_EXPIRED", this.lastError ?? "The account was unlinked.", RELINK_FIX);
      case "auth_failure":
        throw new WazapError("NOT_CONNECTED", this.lastError ?? "WhatsApp refused this session.");
      case "connecting":
      case "disconnected":
        throw new WazapError("NOT_CONNECTED", `The WhatsApp socket is ${this.status}.`, "Call get_status, wait, retry");
      case "connected": {
        if (!this.sockClient) throw new WazapError("NOT_CONNECTED", "The WhatsApp socket is gone.");
        return this.sockClient;
      }
    }
  }

  /** First statement of every write, so a broken link is reported before anything else. */
  private beginWrite(): WASocket {
    if (this.config.readOnly) {
      throw new WazapError("READ_ONLY", "wazap runs read-only, so this write is refused.");
    }
    return this.ensureConnected();
  }

  /** The single gate every send path passes: writability, addressability, announce-only. */
  private async prepareSend(chatId: string): Promise<{ sock: WASocket; jid: string }> {
    const sock = this.beginWrite();
    const jid = this.resolveId(chatId);

    if (isGroupId(jid)) {
      const meta = await this.groupMeta(jid);
      const mine = this.myParticipation(meta);
      if (meta.announce && !(mine && isAdmin(mine))) {
        throw new WazapError("GROUP_ANNOUNCEMENT_ONLY", `Only admins may post in "${meta.subject}".`);
      }
      return { sock, jid };
    }

    if (!this.store.chats.has(jid) && !this.store.contacts.has(jid)) {
      const found = await sock.onWhatsApp(jid).catch(() => undefined);
      if (!found?.some((entry) => entry.exists)) {
        throw new WazapError("NOT_ON_WHATSAPP", `${jid} has no WhatsApp account.`);
      }
    }
    return { sock, jid };
  }

  private async groupMeta(jid: string, fresh = false): Promise<GroupMetadata> {
    const cached = this.groupCache.get(jid);
    if (cached && !fresh) return cached;
    const sock = this.ensureConnected();
    let meta: GroupMetadata;
    try {
      meta = await sock.groupMetadata(jid);
    } catch (err) {
      const code = statusCodeOf(err);
      if (code === 403) throw new WazapError("NOT_A_PARTICIPANT", `The linked account is not in ${jid}.`);
      if (code === 404) throw new WazapError("GROUP_NOT_FOUND", `WhatsApp does not know the group ${jid}.`);
      throw new WazapError("GROUP_NOT_FOUND", `Could not read ${jid}: ${describe(err)}`);
    }
    this.cacheGroup(jid, meta);
    return meta;
  }

  private cacheGroup(jid: string, meta: GroupMetadata): void {
    this.groupCache.set(jid, meta);
    this.learnGroup(meta);
  }

  /**
   * Reading a group for the first time costs one metadata fetch, after which
   * its senders resolve from cache. A group we cannot read (left, deleted) is
   * not worth failing the read over.
   */
  private async learnParticipants(jid: string): Promise<void> {
    if (!isGroupId(jid) || this.groupCache.has(jid)) return;
    await this.groupMeta(jid).catch(() => undefined);
  }

  private myParticipation(meta: GroupMetadata): GroupParticipant | undefined {
    return meta.participants.find((p) => this.isMe(p.id) || (p.phoneNumber && this.isMe(p.phoneNumber)));
  }

  private async assertGroupAdmin(jid: string, action: GroupAction): Promise<void> {
    const meta = await this.groupMeta(jid);
    const mine = this.myParticipation(meta);
    if (!mine) throw new WazapError("NOT_A_PARTICIPANT", `The linked account is not in ${jid}.`);
    if (!isAdmin(mine)) {
      throw new WazapError("NOT_ADMIN", `"${action}" needs admin rights in "${meta.subject}".`);
    }
  }

  private async inviteLink(jid: string): Promise<string> {
    const sock = this.ensureConnected();
    const code = await sock.groupInviteCode(jid);
    if (!code) throw new WazapError("WHATSAPP_ERROR", `WhatsApp returned no invite code for ${jid}.`);
    return `https://chat.whatsapp.com/${code}`;
  }

  private participantResult(entry: { status: string; jid: string | undefined }, fallback?: string): ParticipantResult {
    const id = entry.jid ? this.canonical(entry.jid) : (fallback ?? "");
    if (entry.status === "200") return { id, status: "ok" };
    if (INVITE_NEEDED_CODES.has(entry.status)) {
      return { id, status: "invite_needed", reason: entry.status };
    }
    return { id, status: "failed", reason: entry.status };
  }

  private resolveId(input: string): string {
    return resolveChatId(input, (lid) => this.lidToPn.get(lid));
  }

  /** Canonical form, or the input unchanged for jids wazap does not address
   * (status broadcasts, newsletters). */
  private canonical(jid: string): string {
    if (!jid) return "";
    try {
      return resolveChatId(jid, (lid) => this.lidToPn.get(lid));
    } catch {
      return jid;
    }
  }

  private learnLid(lid: string, pn: string): void {
    if (!lid || !pn) return;
    const key = `${jidNormalizedUser(lid).split("@")[0]}@lid`;
    this.lidToPn.set(key, pn);
  }

  /**
   * The one place a jid becomes a name, so a sender, a chat header, a digest
   * title and a participant list can never disagree. The ladder runs from the
   * name the user chose to the least wrong thing we can say, and it stops short
   * of printing a raw LID: a LID is 15 digits that look exactly like a phone
   * number and are not one, so an unresolved one says so.
   *
   * `hint` is the pushName riding on the message being rendered, for a sender
   * whose name has not been ingested yet.
   */
  private displayName(jid: string, hint?: string): string {
    if (!jid) return "unknown";
    if (this.isMe(jid)) return this.account?.name || "You";
    if (isGroupId(jid)) {
      return this.store.chats.get(jid)?.name || this.groupCache.get(jid)?.subject || jid;
    }

    const phoneJid = jid.endsWith("@lid") ? this.lidToPn.get(jid) : undefined;
    for (const known of phoneJid ? [jid, phoneJid] : [jid]) {
      const contact = this.store.contacts.get(known);
      const name =
        contact?.name ||
        contact?.verifiedName ||
        contact?.notify ||
        this.store.pushNames.get(known) ||
        this.store.chats.get(known)?.name;
      if (name) return name;
    }
    if (hint) return hint;

    const digits = (phoneJid ?? jid).split("@")[0] ?? "";
    if ((phoneJid ?? jid).endsWith("@s.whatsapp.net")) return digits;
    return jid.endsWith("@lid") ? `unknown (lid …${digits.slice(-4)})` : jid;
  }

  private messageOrThrow(messageId: string): WAMessage {
    const raw = this.store.messages.get(messageId);
    if (!raw) {
      throw new WazapError(
        "MESSAGE_NOT_FOUND",
        `No message "${messageId}" is loaded.`,
        "Use a message_id from read_messages or search_messages",
      );
    }
    return raw;
  }

  private chatOfOrThrow(messageId: string): string {
    const jid = this.store.chatOf.get(messageId);
    if (!jid) throw new WazapError("MESSAGE_NOT_FOUND", `No message "${messageId}" is loaded.`);
    return jid;
  }

  private viewOf(sid: string, chatJid: string): MessageView {
    const raw = this.messageOrThrow(sid);
    return buildMessageView(raw, {
      canonical: (jid) => this.canonical(jid),
      nameFor: (jid) => this.displayName(jid, raw.pushName ?? undefined),
      ownId: this.ownJid(),
      chatId: chatJid,
      edited: this.store.edited.has(sid),
      reactions: this.store.reactionsFor(sid),
    });
  }

  private viewsFor(sids: string[], chatJid: string): MessageView[] {
    return sids.filter((sid) => this.store.messages.has(sid)).map((sid) => this.viewOf(sid, chatJid));
  }

  private olderThan(chatJid: string, before: string, limit: number): string[] {
    const ring = this.store.byChat.get(chatJid) ?? [];
    const at = ring.indexOf(before);
    if (at <= 0) return [];
    return ring.slice(Math.max(0, at - limit), at);
  }

  private async fetchOlder(sock: WASocket, anchor: WAMessage, limit: number): Promise<void> {
    const seconds = Math.floor(messageTimestampMs(anchor) / 1000);
    await sock.fetchMessageHistory(limit, anchor.key, seconds);
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        this.historyWaiters = this.historyWaiters.filter((entry) => entry !== waiter);
        done();
      }, HISTORY_FETCH_WAIT_MS);
      const waiter = (): void => {
        clearTimeout(timer);
        done();
      };
      this.historyWaiters.push(waiter);
    });
  }

  private lastMessageOf(chatJid: string): WAMessage | null {
    const ring = this.store.byChat.get(chatJid);
    const last = ring && ring.length > 0 ? this.store.messages.get(ring[ring.length - 1]!) : undefined;
    return last ?? null;
  }

  /**
   * Every chat WhatsApp described, plus one for any chat that only ever
   * arrived as messages: a chat with messages must never be invisible.
   */
  private knownChats(): BaileysChat[] {
    const chats = [...this.store.chats.values()];
    for (const jid of this.store.byChat.keys()) {
      if (!this.store.chats.has(jid) && isAddressableJid(jid)) chats.push({ id: jid });
    }
    return chats;
  }

  private chatActivity(chat: BaileysChat): number {
    const described = protoNumber(chat.conversationTimestamp);
    if (described !== undefined && described !== null) return described;
    const last = this.lastMessageOf(this.canonical(chat.id ?? ""));
    return last ? Math.floor(messageTimestampMs(last) / 1000) : 0;
  }

  private matchesChatFilter(chat: BaileysChat, filter: ChatFilter): boolean {
    const archived = Boolean(chat.archived);
    const group = isGroupId(chat.id ?? "");
    switch (filter) {
      case "unread":
        return !archived && (chat.unreadCount ?? 0) > 0;
      case "groups":
        return !archived && group;
      case "individual":
        return !archived && !group;
      case "archived":
        return archived;
      case "all":
        return !archived;
    }
  }

  private chatSummary(chat: BaileysChat): ChatSummary {
    const jid = this.canonical(chat.id ?? "");
    const last = this.lastMessageOf(jid);
    const muteEnd = protoNumber(chat.muteEndTime) ?? 0;
    const summary: ChatSummary = {
      chat_id: jid,
      name: this.displayName(jid),
      type: isGroupId(jid) ? "group" : "individual",
      unread_count: Math.max(0, chat.unreadCount ?? 0),
      last_message: last
        ? {
            text: messageText(last),
            timestamp: isoWithOffset(messageTimestampMs(last)),
            from_me: Boolean(last.key.fromMe),
          }
        : null,
      archived: Boolean(chat.archived),
      pinned: Boolean(chat.pinned),
      muted_until: muteEnd > Date.now() ? isoWithOffset(muteEnd) : null,
    };
    // A group we left is delivered as read-only; individual chats never are.
    if (isGroupId(jid) && chat.readOnly) summary.left = true;
    return summary;
  }

  private contactSummary(jid: string, contact?: BaileysContact): ContactSummary {
    const phoneJid = jid.endsWith("@lid") ? (this.lidToPn.get(jid) ?? jid) : jid;
    const number = phoneJid.endsWith("@s.whatsapp.net") ? (phoneJid.split("@")[0] ?? null) : null;
    return {
      contact_id: jid,
      name: this.displayName(jid),
      number,
      is_my_contact: Boolean(contact?.name),
      is_business: Boolean(contact?.verifiedName),
    };
  }

  private sentResult(sent: WAMessage | undefined, jid: string, text: string): SentMessage {
    if (!sent) {
      return { message_id: `unknown_${jid}_${randomUUID()}`, chat_id: jid, text, timestamp: isoWithOffset(Date.now()) };
    }
    const sid = messageIdFor(sent.key, jid);
    this.store.putMessage(sid, jid, sent);
    this.markStoreDirty();
    return { message_id: sid, chat_id: jid, text, timestamp: isoWithOffset(messageTimestampMs(sent)) };
  }

  private ingestChat(chat: BaileysChat): void {
    if (!chat.id) return;
    if (chat.lidJid && chat.pnJid) this.learnLid(chat.lidJid, chat.pnJid);
    const jid = this.canonical(chat.id);
    if (!isAddressableJid(jid)) return;
    const previous = this.store.chats.get(jid);
    this.store.chats.set(jid, { ...(previous ?? {}), ...chat, id: jid });
  }

  private ingestContact(contact: BaileysContact): void {
    if (!contact.id) return;
    // WhatsApp usually keys the contact by its phone jid and names the LID on
    // the side, so `phoneNumber` is empty and `id` is the phone number.
    const phone = contact.phoneNumber ?? (contact.id.endsWith("@s.whatsapp.net") ? contact.id : undefined);
    if (contact.lid && phone) this.learnLid(contact.lid, phone);
    const jid = this.canonical(contact.id);
    const previous = this.store.contacts.get(jid);
    this.store.contacts.set(jid, { ...(previous ?? {}), ...contact, id: jid });
  }

  private ingestMessages(messages: WAMessage[]): WAMessage[] {
    const stored: WAMessage[] = [];
    for (const raw of messages) {
      if (!raw.message || !raw.key?.remoteJid) continue;
      const jid = this.canonical(raw.key.remoteJid);
      if (!isAddressableJid(jid) || isControlMessage(raw)) continue;
      this.learnPushName(raw, jid);
      this.store.putMessage(messageIdFor(raw.key, jid), jid, raw);
      stored.push(raw);
    }
    return stored;
  }

  /** The sender's own profile name, which arrives on the message and nowhere else. */
  private learnPushName(raw: WAMessage, chatJid: string): void {
    const name = raw.pushName?.trim();
    if (!name || raw.key.fromMe) return;
    const sender = this.canonical(raw.key.participant ?? raw.participant ?? chatJid);
    if (sender && !this.isMe(sender)) this.store.pushNames.set(sender, name);
  }

  /**
   * Group metadata is the only place WhatsApp says which LID belongs to which
   * phone number, so one fetch teaches every later message in that group who
   * its participants are.
   */
  private learnGroup(meta: GroupMetadata): void {
    for (const p of meta.participants) {
      const lid = p.lid ?? (p.id.endsWith("@lid") ? p.id : undefined);
      const phone = p.phoneNumber ?? (p.id.endsWith("@s.whatsapp.net") ? p.id : undefined);
      if (lid && phone) this.learnLid(lid, phone);
      const contact: BaileysContact = { id: phone ?? p.id };
      if (lid) contact.lid = lid;
      if (p.name) contact.name = p.name;
      if (p.notify) contact.notify = p.notify;
      this.ingestContact(contact);
    }
  }

  private async loadPersisted(): Promise<void> {
    if (!this.config.persistHistory || this.persistedLoaded) return;
    this.persistedLoaded = true;
    await this.loadHistoryStore();
    await this.loadStoreSnapshot();
  }

  private async loadStoreSnapshot(): Promise<void> {
    try {
      const text = await readFile(this.paths.storeFile, "utf8");
      this.store.hydrate(JSON.parse(text) as StoreSnapshot);
      log(`store loaded: ${this.store.chats.size} chats, ${this.store.messages.size} messages`);
    } catch (err) {
      if (!isMissing(err)) logError("store load", err);
    }
  }

  private markStoreDirty(): void {
    if (!this.config.persistHistory) return;
    this.storeDirty = true;
    if (this.storeSaveTimer) return;
    this.storeSaveTimer = setTimeout(() => {
      this.storeSaveTimer = null;
      void this.flushStore();
    }, STORE_SAVE_DEBOUNCE_MS);
  }

  private async flushStore(): Promise<void> {
    if (!this.config.persistHistory || !this.storeDirty) return;
    this.storeDirty = false;
    try {
      await mkdir(this.paths.dataDir, { recursive: true, mode: DIR_MODE });
      const tmp = `${this.paths.storeFile}.tmp`;
      await writeFile(tmp, JSON.stringify(this.store.serialize()), { mode: FILE_MODE });
      await rename(tmp, this.paths.storeFile);
    } catch (err) {
      logError("store save", err);
    }
  }

  private async loadHistoryStore(): Promise<void> {
    try {
      await mkdir(this.paths.historyDir, { recursive: true, mode: DIR_MODE });
      const files = (await readdir(this.paths.historyDir)).filter((name) => name.endsWith(".jsonl"));
      let loaded = 0;
      for (const name of files) loaded += await this.loadHistoryFile(join(this.paths.historyDir, name));
      if (loaded > 0) log(`history store loaded: ${loaded} messages`);
    } catch (err) {
      logError("history load", err);
    }
  }

  private async loadHistoryFile(path: string): Promise<number> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      if (!isMissing(err)) logError("history load", err);
      return 0;
    }

    const newest = new Map<string, HistoryRecord>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as HistoryRecord;
        if (record.sid && record.raw) newest.set(record.sid, record);
      } catch {
        continue;
      }
    }
    const kept = [...newest.values()].sort((a, b) => a.ts - b.ts).slice(-HISTORY_STORE_CAP_PER_CHAT);

    // Rewrite compacted, so the file stays bounded across restarts.
    const compacted = kept.map((record) => JSON.stringify(record)).join("\n");
    const tmp = `${path}.tmp`;
    await writeFile(tmp, kept.length > 0 ? `${compacted}\n` : "", { mode: FILE_MODE });
    await rename(tmp, path);

    let loaded = 0;
    for (const record of kept) {
      const raw = decodeMessage(record.raw);
      if (!raw?.message || !raw.key?.remoteJid) continue;
      const jid = this.canonical(raw.key.remoteJid);
      if (!isAddressableJid(jid) || isControlMessage(raw)) continue;
      this.store.putMessage(record.sid, jid, raw);
      loaded++;
    }
    return loaded;
  }

  private async appendHistory(messages: WAMessage[]): Promise<void> {
    if (!this.config.persistHistory || messages.length === 0) return;
    const lines = new Map<string, string[]>();
    for (const raw of messages) {
      if (!raw.message || !raw.key?.remoteJid) continue;
      const encoded = encode(() => proto.WebMessageInfo.encode(raw).finish());
      if (!encoded) continue;
      const jid = this.canonical(raw.key.remoteJid);
      const record: HistoryRecord = {
        sid: messageIdFor(raw.key, jid),
        ts: Math.floor(messageTimestampMs(raw) / 1000),
        raw: encoded,
      };
      const bucket = lines.get(jid) ?? [];
      bucket.push(JSON.stringify(record));
      lines.set(jid, bucket);
    }

    try {
      await mkdir(this.paths.historyDir, { recursive: true, mode: DIR_MODE });
      for (const [jid, bucket] of lines) {
        const path = join(this.paths.historyDir, `${safeFilename(jid)}.jsonl`);
        await appendFile(path, `${bucket.join("\n")}\n`, { mode: FILE_MODE });
      }
    } catch (err) {
      logError("history append", err);
    }
  }
}

const ADMIN_ACTIONS = new Set<GroupAction>([
  "add",
  "remove",
  "promote",
  "demote",
  "set_subject",
  "set_description",
  "get_invite_link",
  "revoke_invite_link",
]);

const PARTICIPANT_ACTIONS = new Set<GroupAction>(["add", "remove", "promote", "demote"]);

/** WhatsApp answers "cannot add, invite them instead" with these codes. */
const INVITE_NEEDED_CODES = new Set(["403", "409"]);

function isAdmin(participant: GroupParticipant): boolean {
  return participant.admin === "admin" || participant.admin === "superadmin";
}

function requireValue(value: string | undefined, action: GroupAction, what: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new WazapError("INVALID_ID", `The "${action}" action needs a value: ${what}.`);
  return trimmed;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function statusCodeOf(err: unknown): number | undefined {
  return (err as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
}

function statusTextOf(entry: { [protocol: string]: unknown } | undefined): string | null {
  const status = entry?.status;
  if (status && typeof status === "object" && "status" in status) {
    return (status as { status?: string | null }).status ?? null;
  }
  return typeof status === "string" ? status : null;
}

function encode(run: () => Uint8Array): string | null {
  try {
    return Buffer.from(run()).toString("base64");
  } catch {
    return null;
  }
}

function decodeMessage(b64: string): WAMessage | null {
  try {
    return proto.WebMessageInfo.decode(Buffer.from(b64, "base64")) as unknown as WAMessage;
  } catch {
    return null;
  }
}

function decodeChat(b64: string): BaileysChat | null {
  try {
    return proto.Conversation.decode(Buffer.from(b64, "base64")) as unknown as BaileysChat;
  } catch {
    return null;
  }
}

function safeFilename(jid: string): string {
  return jid.replace(/[/\\:*?"<>|]/g, "_");
}

function mediaFilename(info: { mime: string; filename?: string }): string {
  const original = (info.filename ?? "").replace(/[^\w.-]/g, "_");
  const fromName = original.includes(".") ? original.slice(original.lastIndexOf(".")) : "";
  const subtype = info.mime.split("/")[1]?.split(";")[0] ?? "bin";
  return `${Date.now()}-${randomUUID().slice(0, 8)}${fromName || `.${subtype}`}`;
}

interface LoadedMedia {
  buffer: Buffer;
  mimetype: string;
  filename: string;
}

async function loadMedia(source: MediaSource): Promise<LoadedMedia> {
  const hasPath = Boolean(source.file_path);
  const hasUrl = Boolean(source.url);
  if (hasPath === hasUrl) {
    throw new WazapError("FILE_NOT_FOUND", "Provide exactly one of file_path or url.");
  }

  if (source.file_path) {
    const path = source.file_path;
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new WazapError("FILE_NOT_FOUND", `No file at "${path}" on the machine running wazap.`);
    }
    assertMediaSize(size);
    return { buffer: await readFile(path), mimetype: guessMime(path), filename: basename(path) };
  }

  const url = source.url!;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new WazapError("URL_FETCH_FAILED", `Could not fetch ${url}: ${describe(err)}`);
  }
  if (!response.ok) {
    throw new WazapError("URL_FETCH_FAILED", `Fetching ${url} returned HTTP ${response.status}.`);
  }
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared)) assertMediaSize(declared);
  const buffer = Buffer.from(await response.arrayBuffer());
  assertMediaSize(buffer.length);
  return {
    buffer,
    mimetype: response.headers.get("content-type")?.split(";")[0] ?? guessMime(url),
    filename: basename(url.split("?")[0] ?? url),
  };
}

function assertMediaSize(size: number): void {
  if (size > MAX_MEDIA_BYTES) {
    throw new WazapError("FILE_TOO_LARGE", `The file is ${Math.round(size / 1_048_576)} MB; WhatsApp allows 100 MB.`);
  }
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || "file";
}

function mediaContent(
  media: LoadedMedia,
  opts: { caption?: string; asDocument: boolean; asVoice: boolean },
): AnyMessageContent {
  const { buffer, mimetype, filename } = media;
  if (opts.asVoice) return { audio: buffer, mimetype: "audio/ogg; codecs=opus", ptt: true };
  if (opts.asDocument) return { document: buffer, mimetype, fileName: filename, caption: opts.caption };
  if (mimetype.startsWith("image/")) return { image: buffer, caption: opts.caption };
  if (mimetype.startsWith("video/")) return { video: buffer, caption: opts.caption };
  if (mimetype.startsWith("audio/")) return { audio: buffer, mimetype };
  return { document: buffer, mimetype, fileName: filename, caption: opts.caption };
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
};

function guessMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}
