/**
 * WhatsApp connection wrapper around Baileys (socket-based, no browser).
 *
 * Migrated from whatsapp-web.js: Baileys speaks the WhatsApp multi-device
 * protocol directly over a WebSocket, which is far more robust to WhatsApp Web
 * frontend changes, handles `@lid` addressing natively (the bug that broke
 * sending), and drops memory from ~500MB (Chromium) to ~20MB.
 *
 * Baileys gives raw events, not a queryable store. We keep a small in-memory
 * store (chats, contacts, recent messages by id) fed from those events so the
 * MCP read tools keep working. History before this process started is only
 * available to the extent WhatsApp syncs it on connect.
 */

import { mkdir, writeFile, appendFile, readFile, readdir, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import makeWASocket, {
  proto,
  useMultiFileAuthState,
  downloadMediaMessage,
  jidNormalizedUser,
  jidDecode,
  isJidGroup,
  getContentType,
  DisconnectReason,
  Browsers,
  type WASocket,
  type WAMessage,
  type WAMessageContent,
  type Chat as BaileysChat,
  type Contact as BaileysContact,
  type GroupMetadata,
} from "baileys";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import type { Config } from "./config.js";
import { log, logError } from "./logger.js";
import type {
  ChatAction,
  ChatSummary,
  ContactDetails,
  ContactSummary,
  GroupAction,
  GroupInfo,
  MediaResult,
  MessageSummary,
  RecentConversation,
  SentMessage,
  StatusInfo,
  WaChat,
  WaContact,
  WaMedia,
  WaMessage,
  WhatsAppServiceOpts,
  WhatsAppStatus,
} from "./wa-types.js";

export type {
  ChatAction,
  ChatSummary,
  ContactDetails,
  ContactSummary,
  GroupAction,
  GroupInfo,
  GroupParticipantInfo,
  MediaResult,
  MessageSummary,
  RecentConversation,
  SentMessage,
  StatusInfo,
  WaChat,
  WaContact,
  WaMessage,
  WhatsAppServiceOpts,
  WhatsAppStatus,
} from "./wa-types.js";

/** Baileys content types that aren't real conversational messages. */
const NON_CONTENT_TYPES = new Set<string>([
  "protocolMessage",
  "senderKeyDistributionMessage",
  "reactionMessage",
  "pollUpdateMessage",
  "messageContextInfo",
]);

const INLINE_IMAGE_MAX_BYTES = 1_000_000;
/** Cap the per-chat raw-message ring so memory stays bounded. Generous so
 *  on-demand older-history fetch (fetchOlderHistory) has room to deepen a chat. */
const MAX_MESSAGES_PER_CHAT = 1000;
/** Per-chat messages written to the on-disk snapshot (keeps the file lean while
 *  the in-memory ring can hold more within a session). */
const PERSIST_MESSAGES_PER_CHAT = 120;
/** Debounce store snapshots: save this long after the last change. */
const STORE_SAVE_DEBOUNCE_MS = 20_000;
/** Max messages kept per chat in the persistent history store (compacted on load). */
const HISTORY_STORE_CAP_PER_CHAT = 2_000;

/** One line in a per-chat history JSONL file. */
interface HistoryRecord {
  sid: string;
  ts: number;
  raw: string; // base64 protobuf WAMessage
}

/** Sanitize a JID to a safe filename (strips path-separator chars). */
function safeJidFilename(jid: string): string {
  return jid.replace(/[/\\:*?"<>|]/g, "_");
}

/** On-disk store snapshot. Messages/chats are base64 protobuf (faithful to
 *  Baileys' own wire types); contacts/byChat are plain JSON. */
interface StoreSnapshot {
  v: 1;
  chats: Record<string, string>;
  contacts: Record<string, BaileysContact>;
  messages: Record<string, string>;
  byChat: Record<string, string[]>;
}

type Deps = {
  sock: () => WASocket;
  ownJid: () => string;
  store: Store;
};

/** One line of the durable message journal (compact, JSON-serializable). */
interface RecentJournalRecord {
  timestamp: string;
  chat_id: string;
  chat_name: string;
  is_group: boolean;
  sender: string;
  from_me: boolean;
  body: string;
}

/** In-memory state fed from Baileys events; the read tools query this. */
class Store {
  readonly chats = new Map<string, BaileysChat>();
  readonly contacts = new Map<string, BaileysContact>();
  /** serializedId -> raw message, for media/react/forward/delete + lookups. */
  readonly messages = new Map<string, WAMessage>();
  /** chatJid -> ordered serialized ids (oldest..newest), capped. */
  readonly byChat = new Map<string, string[]>();

  private msgSeconds(serialized: string): number {
    return toSeconds(this.messages.get(serialized)?.messageTimestamp);
  }

  putMessage(serialized: string, chatJid: string, raw: WAMessage): void {
    const isUpdate = this.messages.has(serialized);
    this.messages.set(serialized, raw);
    let ring = this.byChat.get(chatJid);
    if (!ring) {
      ring = [];
      this.byChat.set(chatJid, ring);
    }
    if (isUpdate && ring.includes(serialized)) return; // refresh raw in place, keep order
    // Live messages arrive newest-last (append, no sort). Older messages from a
    // history sync / fetchOlderHistory arrive out of order — re-sort only then.
    const ts = toSeconds(raw.messageTimestamp);
    const lastTs = ring.length ? this.msgSeconds(ring[ring.length - 1]) : -Infinity;
    ring.push(serialized);
    if (ts < lastTs) ring.sort((a, b) => this.msgSeconds(a) - this.msgSeconds(b));
    while (ring.length > MAX_MESSAGES_PER_CHAT) {
      const dropped = ring.shift();
      if (dropped) this.messages.delete(dropped);
    }
  }

  /** Snapshot the store for disk: protobuf for chats/messages, JSON for the rest.
   *  Only the most recent `persistCap` messages per chat are kept, lean. */
  serialize(persistCap: number): StoreSnapshot {
    const snap: StoreSnapshot = { v: 1, chats: {}, contacts: {}, messages: {}, byChat: {} };
    for (const [jid, chat] of this.chats) {
      try {
        snap.chats[jid] = Buffer.from(proto.Conversation.encode(chat).finish()).toString("base64");
      } catch {
        /* skip a chat that won't encode */
      }
    }
    for (const [jid, contact] of this.contacts) snap.contacts[jid] = contact;
    const keep = new Set<string>();
    for (const [jid, ring] of this.byChat) {
      const capped = ring.slice(-persistCap);
      snap.byChat[jid] = capped;
      for (const sid of capped) keep.add(sid);
    }
    for (const sid of keep) {
      const raw = this.messages.get(sid);
      if (!raw) continue;
      try {
        snap.messages[sid] = Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString("base64");
      } catch {
        /* skip a message that won't encode */
      }
    }
    return snap;
  }

  /** Load a snapshot from disk back into the store. Returns counts loaded. */
  hydrate(snap: StoreSnapshot): { chats: number; messages: number } {
    if (!snap || snap.v !== 1) return { chats: 0, messages: 0 };
    let chats = 0;
    let messages = 0;
    for (const [jid, b64] of Object.entries(snap.chats ?? {})) {
      try {
        this.chats.set(jid, proto.Conversation.decode(Buffer.from(b64, "base64")) as unknown as BaileysChat);
        chats++;
      } catch {
        /* skip */
      }
    }
    for (const [jid, contact] of Object.entries(snap.contacts ?? {})) this.contacts.set(jid, contact);
    for (const [sid, b64] of Object.entries(snap.messages ?? {})) {
      try {
        this.messages.set(sid, proto.WebMessageInfo.decode(Buffer.from(b64, "base64")) as unknown as WAMessage);
        messages++;
      } catch {
        /* skip */
      }
    }
    for (const [jid, ring] of Object.entries(snap.byChat ?? {})) {
      this.byChat.set(jid, ring.filter((sid) => this.messages.has(sid)));
    }
    return { chats, messages };
  }
}

/** Reconnect pacing. A closed socket used to be retried instantly, which turns
 * any persistent rejection into a login storm — WhatsApp answers that by
 * throttling the account and refusing to link *any* new device to it, phone
 * included. Retries are spaced, jittered and capped; past the cap we stop and
 * wait for a human instead of hammering. */
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 5 * 60_000;
const RECONNECT_MAX_ATTEMPTS = 10;

export class WhatsAppService {
  private sockClient: WASocket | null = null;
  private saveCreds: (() => Promise<void>) | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private starting = false;
  /** Bumped per socket, so events from a superseded socket are ignored. */
  private generation = 0;
  private readonly authPath: string;
  private readonly qrFile: string;
  private readonly label: string;
  private readonly readOnly: boolean;
  private readonly syncHistory: boolean;
  private readonly journalDir: string | null;
  private readonly storeCacheFile: string | null;
  private readonly historyStoreDir: string | null;
  private storeSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private storeDirty = false;
  private status: WhatsAppStatus = "starting";
  private lastError: string | null = null;
  private readyAt = 0;
  private account: StatusInfo["account"] = null;
  private stopped = false;
  private readonly store = new Store();
  private readonly messageHooks: Array<(msg: WaMessage) => void> = [];
  private readonly lidPnHooks: Array<(lid: string, pn: string) => void> = [];

  constructor(
    private readonly config: Config,
    opts: WhatsAppServiceOpts = {},
  ) {
    this.authPath = opts.authPath ?? config.authPath;
    this.qrFile = opts.qrFile ?? config.qrFile;
    this.label = opts.label ?? "main";
    this.readOnly = opts.readOnly ?? false;
    this.syncHistory = opts.syncFullHistory ?? false;
    this.journalDir = opts.journalDir ? resolve(config.pkgRoot, opts.journalDir) : null;
    this.storeCacheFile = opts.storeCacheFile ? resolve(config.pkgRoot, opts.storeCacheFile) : null;
    this.historyStoreDir = opts.historyStoreDir ? resolve(config.pkgRoot, opts.historyStoreDir) : null;
  }

  onMessage(hook: (msg: WaMessage) => void): void {
    this.messageHooks.push(hook);
  }

  /** Register a callback that receives (lid, pn) pairs as Baileys learns them. */
  onLidPnPair(hook: (lid: string, pn: string) => void): void {
    this.lidPnHooks.push(hook);
  }

  /** Guard every mutation: a read-only connection (read-only account)
   * must never send a message or change state. */
  private assertWritable(): void {
    if (this.readOnly) {
      throw new Error(
        `[${this.label}] this WhatsApp connection is read-only (read-only account); ` +
          "sending and mutations are disabled. Route writes through the agent account.",
      );
    }
  }

  getStatus(): StatusInfo {
    return {
      status: this.status,
      lastError: this.lastError,
      account: this.account,
    };
  }

  async start(): Promise<void> {
    if (this.stopped || this.starting) return;
    this.starting = true;
    try {
      log(`[${this.label}] starting WhatsApp client (Baileys)… (first run shows a QR code to scan)`);
      await this.loadHistoryStore();
      await this.loadStoreCache();
      const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
      this.saveCreds = saveCreds;
      this.teardownSocket();
      const generation = ++this.generation;
      const sock = makeWASocket({
        auth: state,
        browser: Browsers.macOS("Desktop"),
        syncFullHistory: this.syncHistory,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
      });
      this.sockClient = sock;
      this.wireEvents(sock, generation);
    } finally {
      this.starting = false;
    }
  }

  /** Close the current socket and mute it, so a socket we are replacing can no
   * longer emit a close event and trigger a reconnect of its own. */
  private teardownSocket(): void {
    const sock = this.sockClient;
    if (!sock) return;
    this.sockClient = null;
    try {
      sock.ev.removeAllListeners("connection.update");
      sock.end(undefined);
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
        `WhatsApp keeps rejecting this session: re-link the device (delete ${this.authPath} and re-scan the QR).`;
      logError("reconnect", this.lastError);
      return;
    }
    const attempt = this.reconnectAttempts++;
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    const delay = Math.round(backoff * (0.5 + Math.random()));
    log(
      `[${this.label}] disconnected (${reason}); retry ${attempt + 1}/${RECONNECT_MAX_ATTEMPTS} in ${Math.round(delay / 1000)}s`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((err) => {
        logError("reconnect", err);
        this.scheduleReconnect("reconnect failed");
      });
    }, delay);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.storeSaveTimer) {
      clearTimeout(this.storeSaveTimer);
      this.storeSaveTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.flushStoreCache();
    try {
      this.teardownSocket();
    } catch (err) {
      logError("shutdown", err);
    }
  }

  // ---- Store persistence (A) -----------------------------------------------------

  private storeLoaded = false;

  private async loadStoreCache(): Promise<void> {
    if (!this.storeCacheFile || this.storeLoaded) return;
    this.storeLoaded = true;
    try {
      const text = await readFile(this.storeCacheFile, "utf8");
      const counts = this.store.hydrate(JSON.parse(text) as StoreSnapshot);
      log(`[${this.label}] store cache loaded: ${counts.chats} chats, ${counts.messages} messages`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") logError("store cache load", err);
    }
  }

  /** Mark the store dirty; a debounced timer flushes it to disk. */
  private markStoreDirty(): void {
    if (!this.storeCacheFile) return;
    this.storeDirty = true;
    if (this.storeSaveTimer) return;
    this.storeSaveTimer = setTimeout(() => {
      this.storeSaveTimer = null;
      void this.flushStoreCache();
    }, STORE_SAVE_DEBOUNCE_MS);
  }

  private async flushStoreCache(): Promise<void> {
    if (!this.storeCacheFile || !this.storeDirty) return;
    this.storeDirty = false;
    try {
      const snap = this.store.serialize(PERSIST_MESSAGES_PER_CHAT);
      await mkdir(resolve(this.storeCacheFile, ".."), { recursive: true });
      const tmp = `${this.storeCacheFile}.tmp`;
      await writeFile(tmp, JSON.stringify(snap), { mode: 0o600 });
      await rename(tmp, this.storeCacheFile);
    } catch (err) {
      logError("store cache save", err);
    }
  }

  // ---- Per-chat history store (B) ---------------------------------------------

  private historyLoaded = false;

  private async loadHistoryStore(): Promise<void> {
    if (!this.historyStoreDir || this.historyLoaded) return;
    this.historyLoaded = true;
    try {
      await mkdir(this.historyStoreDir, { recursive: true });
      const entries = await readdir(this.historyStoreDir);
      let totalMsgs = 0;
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const filePath = join(this.historyStoreDir, entry);
        try {
          const text = await readFile(filePath, "utf8");
          const lines = text.split("\n").filter((l) => l.trim());
          const seen = new Map<string, HistoryRecord>();
          for (const line of lines) {
            try {
              const rec = JSON.parse(line) as HistoryRecord;
              if (rec.sid && rec.raw) seen.set(rec.sid, rec);
            } catch { /* skip corrupt line */ }
          }
          const sorted = [...seen.values()].sort((a, b) => a.ts - b.ts);
          const capped = sorted.slice(-HISTORY_STORE_CAP_PER_CHAT);
          // Compact the file atomically so it stays bounded across restarts.
          const compacted = capped.map((r) => JSON.stringify(r)).join("\n") + (capped.length ? "\n" : "");
          const tmp = `${filePath}.tmp`;
          await writeFile(tmp, compacted, { mode: 0o600 });
          await rename(tmp, filePath);
          for (const rec of capped) {
            try {
              const raw = proto.WebMessageInfo.decode(Buffer.from(rec.raw, "base64")) as unknown as WAMessage;
              if (raw.message && raw.key?.remoteJid) {
                this.store.putMessage(rec.sid, raw.key.remoteJid, raw);
                totalMsgs++;
              }
            } catch { /* skip corrupt record */ }
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") logError("history store load file", err);
        }
      }
      if (totalMsgs > 0) log(`[${this.label}] history store loaded: ${totalMsgs} messages`);
    } catch (err) {
      logError("history store load", err);
    }
  }

  private async appendToHistoryStore(messages: WAMessage[]): Promise<void> {
    if (!this.historyStoreDir) return;
    // Group by chatJid to minimise file-open round-trips.
    const byChat = new Map<string, string[]>();
    for (const raw of messages) {
      if (!raw.message || !raw.key?.remoteJid) continue;
      const jid = raw.key.remoteJid;
      try {
        const sid = serializeKey(raw.key);
        const ts = toSeconds(raw.messageTimestamp);
        const rawB64 = Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString("base64");
        const line = JSON.stringify({ sid, ts, raw: rawB64 } satisfies HistoryRecord);
        let lines = byChat.get(jid);
        if (!lines) { lines = []; byChat.set(jid, lines); }
        lines.push(line);
      } catch { /* skip unencodable message */ }
    }
    for (const [jid, lines] of byChat) {
      const filePath = join(this.historyStoreDir, `${safeJidFilename(jid)}.jsonl`);
      try {
        await appendFile(filePath, lines.join("\n") + "\n", { mode: 0o600 });
      } catch (err) {
        logError("history store append", err);
      }
    }
  }

  // ---- Chats ------------------------------------------------------------------

  async getRecentChats(
    limit: number,
    filter: "all" | "unread" | "groups" | "individual" | "archived" = "all",
  ): Promise<ChatSummary[]> {
    this.ensureReady();
    let chats = [...this.store.chats.values()];
    chats = chats.filter((chat) => {
      const isGroup = isJidGroup(chat.id ?? "") ?? false;
      const archived = Boolean(chat.archived);
      switch (filter) {
        case "unread":
          return !archived && (chat.unreadCount ?? 0) > 0;
        case "groups":
          return !archived && isGroup;
        case "individual":
          return !archived && !isGroup;
        case "archived":
          return archived;
        default:
          return !archived;
      }
    });
    chats.sort((a, b) => chatTime(b) - chatTime(a));
    return chats.slice(0, limit).map((chat) => this.toChatSummary(chat));
  }

  async readMessages(chatId: string, limit: number): Promise<MessageSummary[]> {
    this.ensureReady();
    const jid = this.normalizeChatId(chatId);
    const ring = this.store.byChat.get(jid) ?? [];
    const ids = ring.slice(-limit);
    return Promise.all(
      ids
        .map((sid) => this.store.messages.get(sid))
        .filter((m): m is WAMessage => Boolean(m))
        .map((raw) => this.toMessageSummary(raw)),
    );
  }

  /**
   * Conversations active in the last `hours`, read from the durable journal
   * (not the volatile in-memory store), so a read-only consumer's window survives a
   * restart. Returns [] when journaling is off. Does not require the socket to
   * be ready — it reads files.
   */
  async getRecentMessages(hours = 24): Promise<RecentConversation[]> {
    if (!this.journalDir) return [];
    const cutoff = Date.now() - hours * 3_600_000;
    let files: string[];
    try {
      files = (await readdir(this.journalDir)).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      return [];
    }
    // The window spans at most ceil(hours/24)+1 daily files; reading the tail is
    // cheap and avoids parsing the whole archive.
    const wanted = files.slice(-Math.max(2, Math.ceil(hours / 24) + 1));
    const byChat = new Map<string, RecentConversation>();
    for (const file of wanted) {
      let text: string;
      try {
        text = await readFile(resolve(this.journalDir, file), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let rec: RecentJournalRecord;
        try {
          rec = JSON.parse(line) as RecentJournalRecord;
        } catch {
          continue;
        }
        if (!rec.timestamp || Date.parse(rec.timestamp) < cutoff) continue;
        let conv = byChat.get(rec.chat_id);
        if (!conv) {
          conv = {
            chat_id: rec.chat_id,
            chat_name: rec.chat_name,
            is_group: rec.is_group,
            last_activity: rec.timestamp,
            messages: [],
          };
          byChat.set(rec.chat_id, conv);
        }
        if (rec.chat_name) conv.chat_name = rec.chat_name;
        conv.messages.push({
          timestamp: rec.timestamp,
          sender: rec.sender,
          from_me: rec.from_me,
          body: rec.body,
        });
        if (rec.timestamp > conv.last_activity) conv.last_activity = rec.timestamp;
      }
    }
    const out = [...byChat.values()];
    // ISO-8601 UTC strings sort lexicographically, so string compare is correct.
    for (const c of out) c.messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    out.sort((a, b) => b.last_activity.localeCompare(a.last_activity));
    return out;
  }

  /**
   * On-demand deeper history (B): ask WhatsApp for messages OLDER than the
   * oldest one we hold for this chat. They arrive asynchronously via
   * messaging-history.set and land in the store; we wait briefly, then report
   * the new depth. Bounded by what WhatsApp still has + the per-chat ring cap.
   */
  async fetchOlderHistory(
    chatId: string,
    count: number,
  ): Promise<{ chat_id: string; requested: number; had: number; now: number; gained: number; oldest: string | null }> {
    this.ensureReady();
    const jid = this.normalizeChatId(chatId);
    const ring = this.store.byChat.get(jid) ?? [];
    const anchor = ring.length ? this.store.messages.get(ring[0]) : undefined;
    if (!anchor?.key) {
      throw new Error(
        "No anchor message for this chat yet — call read_messages on it first, then fetch older.",
      );
    }
    const had = ring.length;
    await this.sock().fetchMessageHistory(count, anchor.key, toSeconds(anchor.messageTimestamp));
    // Results arrive asynchronously on messaging-history.set; give them a moment.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const after = this.store.byChat.get(jid) ?? [];
    const oldestRaw = after.length ? this.store.messages.get(after[0]) : undefined;
    return {
      chat_id: jid,
      requested: count,
      had,
      now: after.length,
      gained: Math.max(0, after.length - had),
      oldest: oldestRaw ? new Date(toMillis(oldestRaw.messageTimestamp)).toISOString() : null,
    };
  }

  async searchMessages(query: string, chatId: string | undefined, limit: number): Promise<MessageSummary[]> {
    this.ensureReady();
    const needle = query.trim().toLowerCase();
    const scope = chatId ? this.normalizeChatId(chatId) : null;
    const out: MessageSummary[] = [];
    for (const raw of this.store.messages.values()) {
      if (scope && raw.key.remoteJid !== scope) continue;
      const body = extractBody(raw).toLowerCase();
      if (needle && !body.includes(needle)) continue;
      out.push(await this.toMessageSummary(raw));
      if (out.length >= limit) break;
    }
    return out;
  }

  async manageChat(chatId: string, action: ChatAction, muteHours?: number): Promise<string> {
    this.assertWritable();
    this.ensureReady();
    const jid = this.normalizeChatId(chatId);
    const sock = this.sock();
    const last = this.lastMessage(jid);
    switch (action) {
      case "archive":
      case "unarchive":
        await sock.chatModify({ archive: action === "archive", lastMessages: last ? [last] : [] }, jid);
        break;
      case "pin":
      case "unpin":
        await sock.chatModify({ pin: action === "pin" }, jid);
        break;
      case "mute":
        await sock.chatModify({ mute: muteHours ? muteHours * 3_600_000 : 8 * 3_600_000 }, jid);
        break;
      case "unmute":
        await sock.chatModify({ mute: null }, jid);
        break;
      case "mark_read":
        if (last) await sock.readMessages([last.key]);
        break;
      case "mark_unread":
        await sock.chatModify({ markRead: false, lastMessages: last ? [last] : [] }, jid);
        break;
    }
    const detail = action === "mute" ? (muteHours ? ` for ${muteHours}h` : " indefinitely") : "";
    return `${action}${detail} applied to ${jid}`;
  }

  // ---- Contacts -----------------------------------------------------------------

  async searchContacts(query: string, limit: number): Promise<ContactSummary[]> {
    this.ensureReady();
    const needle = query.trim().toLowerCase();
    const digits = needle.replace(/[^\d]/g, "");
    const matches: ContactSummary[] = [];
    for (const contact of this.store.contacts.values()) {
      const name = (contact.name ?? "").toLowerCase();
      const pushname = (contact.notify ?? "").toLowerCase();
      const number = jidDecode(contact.id)?.user ?? "";
      const hit =
        (needle && (name.includes(needle) || pushname.includes(needle))) ||
        (digits.length >= 5 && number.replace(/[^\d]/g, "").includes(digits));
      if (!hit) continue;
      matches.push(this.toContactSummary(contact));
      if (matches.length >= limit) break;
    }
    return matches;
  }

  async getContact(contactId: string): Promise<ContactDetails> {
    this.ensureReady();
    const jid = this.normalizeChatId(contactId);
    const contact = this.store.contacts.get(jid);
    const sock = this.sock();
    const [about, profilePic] = await Promise.all([
      sock.fetchStatus(jid).then((s) => statusText(s)).catch(() => null),
      sock.profilePictureUrl(jid, "image").catch(() => null),
    ]);
    const summary: ContactSummary = contact
      ? this.toContactSummary(contact)
      : {
          contact_id: jid,
          name: jidDecode(jid)?.user ?? jid,
          number: jidDecode(jid)?.user ?? null,
          is_my_contact: false,
          is_business: false,
        };
    return { ...summary, about: about ?? null, profile_pic_url: profilePic ?? null, is_blocked: false };
  }

  // ---- Messages: send / react / forward / delete ---------------------------------

  async sendMessage(chatId: string, content: string, replyToMessageId?: string): Promise<SentMessage> {
    this.assertWritable();
    this.ensureReady();
    const jid = this.normalizeChatId(chatId);
    const quoted = replyToMessageId ? this.store.messages.get(replyToMessageId) : undefined;
    const sent = await this.sock().sendMessage(jid, { text: content }, quoted ? { quoted } : {});
    return this.sentResult(sent, jid, content);
  }

  async sendMedia(
    chatId: string,
    source: { file_path?: string; url?: string },
    caption?: string,
    asDocument?: boolean,
  ): Promise<SentMessage> {
    this.assertWritable();
    this.ensureReady();
    const jid = this.normalizeChatId(chatId);
    const { buffer, mimetype, filename } = await loadMedia(source);
    const content = mediaSendContent(buffer, mimetype, filename, caption, Boolean(asDocument));
    const sent = await this.sock().sendMessage(jid, content);
    return this.sentResult(sent, jid, caption ?? `[${mimetype}]`);
  }

  async downloadMedia(messageId: string): Promise<MediaResult> {
    this.ensureReady();
    const raw = this.getRawOrThrow(messageId);
    const media = await this.rawDownload(raw);
    if (!media) {
      throw new Error(
        "Media could not be downloaded — it may have expired on WhatsApp's servers or not be synced to this device.",
      );
    }
    const dir = resolve(this.config.pkgRoot, "media");
    await mkdir(dir, { recursive: true });
    const filename = mediaFilename(media);
    const path = resolve(dir, filename);
    const buffer = Buffer.from(media.data, "base64");
    await writeFile(path, buffer, { mode: 0o600 });
    const inline =
      media.mimetype.startsWith("image/") && buffer.length <= INLINE_IMAGE_MAX_BYTES ? media.data : null;
    return { path, filename, mimetype: media.mimetype, size_bytes: buffer.length, base64: inline };
  }

  async reactToMessage(messageId: string, emoji: string): Promise<string> {
    this.assertWritable();
    this.ensureReady();
    const raw = this.getRawOrThrow(messageId);
    await this.sock().sendMessage(raw.key.remoteJid!, { react: { text: emoji, key: raw.key } });
    return emoji ? `Reacted with ${emoji} to message ${messageId}` : `Removed reaction from message ${messageId}`;
  }

  async forwardMessage(messageId: string, toChatId: string): Promise<string> {
    this.assertWritable();
    this.ensureReady();
    const raw = this.getRawOrThrow(messageId);
    const jid = this.normalizeChatId(toChatId);
    await this.sock().sendMessage(jid, { forward: raw });
    return `Forwarded message ${messageId} to ${jid}`;
  }

  async deleteMessage(messageId: string, forEveryone: boolean): Promise<string> {
    this.assertWritable();
    this.ensureReady();
    const raw = this.getRawOrThrow(messageId);
    if (forEveryone) {
      await this.sock().sendMessage(raw.key.remoteJid!, { delete: raw.key });
      return `Deleted message ${messageId} for everyone`;
    }
    // Baileys retracts for everyone; it has no per-message local-only delete.
    return `Baileys supports only delete-for-everyone — re-run with for_everyone=true to retract message ${messageId}.`;
  }

  // ---- Groups ---------------------------------------------------------------------

  async createGroup(name: string, participantIds: string[]): Promise<{ chat_id: string; missing: string[] }> {
    this.assertWritable();
    this.ensureReady();
    const ids = participantIds.map((p) => this.normalizeChatId(p));
    const result = await this.sock().groupCreate(name, ids);
    const present = new Set((result.participants ?? []).map((p) => p.id));
    const missing = ids.filter((id) => !present.has(id));
    return { chat_id: result.id, missing };
  }

  async getGroupInfo(chatId: string): Promise<GroupInfo> {
    this.ensureReady();
    const jid = this.normalizeChatId(chatId);
    if (!isJidGroup(jid)) throw new Error(`${jid} is not a group chat.`);
    const meta = await this.sock().groupMetadata(jid);
    const participants = meta.participants.slice(0, 100).map((p) => ({
      contact_id: p.id,
      name: this.resolveName(p.id),
      is_admin: p.admin === "admin" || p.admin === "superadmin",
    }));
    return {
      chat_id: meta.id,
      name: meta.subject,
      description: meta.desc ?? null,
      owner: meta.owner ?? null,
      created_at: meta.creation ? new Date(meta.creation * 1000).toISOString() : null,
      participant_count: meta.participants.length,
      participants,
    };
  }

  async manageGroup(
    chatId: string,
    action: GroupAction,
    participantIds?: string[],
    value?: string,
  ): Promise<string> {
    this.assertWritable();
    this.ensureReady();
    const jid = this.normalizeChatId(chatId);
    if (!isJidGroup(jid)) throw new Error(`${jid} is not a group chat.`);
    const sock = this.sock();
    const ids = (participantIds ?? []).map((p) => this.normalizeChatId(p));
    const needIds = ["add", "remove", "promote", "demote"].includes(action);
    if (needIds && ids.length === 0) throw new Error(`Action "${action}" requires participant_ids.`);
    switch (action) {
      case "add":
      case "remove":
      case "promote":
      case "demote":
        await sock.groupParticipantsUpdate(jid, ids, action);
        break;
      case "leave":
        await sock.groupLeave(jid);
        break;
      case "set_subject":
        if (!value) throw new Error('Action "set_subject" requires value (the new name).');
        await sock.groupUpdateSubject(jid, value);
        break;
      case "set_description":
        if (!value) throw new Error('Action "set_description" requires value.');
        await sock.groupUpdateDescription(jid, value);
        break;
      case "get_invite_link": {
        const code = await sock.groupInviteCode(jid);
        return `https://chat.whatsapp.com/${code}`;
      }
    }
    return `${action} done on ${jid}${ids.length ? ` (${ids.join(", ")})` : ""}`;
  }

  // ---- Internals ------------------------------------------------------------

  private sock(): WASocket {
    if (!this.sockClient) throw new Error("WhatsApp socket not started.");
    return this.sockClient;
  }

  private ownJid(): string {
    const id = this.sockClient?.user?.id;
    return id ? jidNormalizedUser(id) : "";
  }

  private deps(): Deps {
    return { sock: () => this.sock(), ownJid: () => this.ownJid(), store: this.store };
  }

  private sentResult(sent: WAMessage | undefined, jid: string, body: string): SentMessage {
    const serialized = sent ? serializeKey(sent.key) : `${randomUUID()}`;
    if (sent) this.store.putMessage(serialized, jid, sent);
    return {
      id: serialized,
      to: jid,
      body,
      timestamp: sent?.messageTimestamp ? new Date(toMillis(sent.messageTimestamp)).toISOString() : new Date().toISOString(),
    };
  }

  private getRawOrThrow(messageId: string): WAMessage {
    const raw = this.store.messages.get(messageId);
    if (raw) return raw;
    throw new Error(
      `Message "${messageId}" not found in the live store. Baileys only retains messages seen since startup; ` +
        `use an id from read_messages / search_messages.`,
    );
  }

  private lastMessage(jid: string): WAMessage | null {
    const ring = this.store.byChat.get(jid);
    const last = ring && ring.length ? this.store.messages.get(ring[ring.length - 1]) : undefined;
    return last ?? null;
  }

  private resolveName(jid: string): string {
    const c = this.store.contacts.get(jidNormalizedUser(jid));
    return c?.name || c?.notify || jidDecode(jid)?.user || jid;
  }

  private markReady(via: string): void {
    if (this.status === "ready") return;
    this.status = "ready";
    this.lastError = null;
    this.readyAt = Math.floor(Date.now() / 1000);
    const u = this.sockClient?.user;
    this.account = u ? { id: jidNormalizedUser(u.id), name: u.name ?? "", platform: "baileys" } : null;
    log(`[${this.label}] WhatsApp is ready (${via}).`);
  }

  private ensureReady(): void {
    if (this.status === "ready") return;
    const hint =
      this.status === "qr"
        ? `Scan the QR code (printed above in the terminal, or open "${this.qrFile}") with WhatsApp on your phone.`
        : this.status === "auth_failure"
          ? "Authentication failed — delete the session folder and re-scan the QR."
          : "The client is still connecting; try again in a few seconds.";
    throw new Error(`WhatsApp is not ready (status: ${this.status}). ${hint}`);
  }

  private wireEvents(sock: WASocket, generation: number): void {
    sock.ev.on("creds.update", () => void this.saveCreds?.());

    sock.ev.on("connection.update", (u) => {
      if (generation !== this.generation) return;
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        this.status = "qr";
        void this.renderQr(qr);
      }
      if (connection === "open") {
        this.reconnectAttempts = 0;
        this.markReady("connection.open");
      } else if (connection === "close") {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          this.status = "auth_failure";
          this.lastError = "logged out — delete the session folder and re-scan the QR.";
          logError("auth", this.lastError);
          this.teardownSocket();
        } else if (!this.stopped) {
          this.status = "disconnected";
          this.lastError = lastDisconnect?.error?.message ?? "connection closed";
          this.scheduleReconnect(this.lastError);
        }
      }
    });

    // Store hydration. messaging-history.set carries the on-connect history sync
    // AND the results of fetchOlderHistory — it includes `messages`, which the
    // read tools need (older history, not just the chat list).
    sock.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
      for (const c of chats) if (c.id) this.store.chats.set(c.id, c);
      for (const c of contacts) this.store.contacts.set(c.id, c);
      for (const raw of messages ?? []) {
        if (raw.message && raw.key?.remoteJid) {
          this.store.putMessage(serializeKey(raw.key), raw.key.remoteJid, raw);
        }
      }
      if (this.historyStoreDir) void this.appendToHistoryStore(messages ?? []);
      this.markStoreDirty();
    });
    sock.ev.on("chats.upsert", (chats) => {
      for (const c of chats) if (c.id) this.store.chats.set(c.id, c);
      this.markStoreDirty();
    });
    sock.ev.on("chats.update", (updates) => {
      for (const up of updates) {
        if (!up.id) continue;
        const prev = this.store.chats.get(up.id);
        this.store.chats.set(up.id, { ...(prev ?? { id: up.id }), ...up } as BaileysChat);
      }
      this.markStoreDirty();
    });
    sock.ev.on("chats.delete", (ids) => {
      for (const id of ids) this.store.chats.delete(id);
    });
    sock.ev.on("contacts.upsert", (contacts) => {
      for (const c of contacts) {
        this.store.contacts.set(c.id, c);
        this.emitLidPnPair(c);
      }
      this.markStoreDirty();
    });
    sock.ev.on("contacts.update", (updates) => {
      for (const up of updates) {
        if (!up.id) continue;
        const prev = this.store.contacts.get(up.id);
        const merged = { ...(prev ?? { id: up.id }), ...up } as BaileysContact;
        this.store.contacts.set(up.id, merged);
        this.emitLidPnPair(merged);
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      const toAppendToHistory: WAMessage[] = [];
      for (const raw of messages) {
        if (!raw.message || !raw.key?.remoteJid) continue;
        const serialized = serializeKey(raw.key);
        this.store.putMessage(serialized, raw.key.remoteJid, raw);
        toAppendToHistory.push(raw);
        if (type !== "notify") continue;
        if (this.journalDir) void this.appendToJournal(raw);
        const adapted = this.makeWaMessage(raw);
        for (const hook of this.messageHooks) {
          try {
            hook(adapted);
          } catch (err) {
            logError("message hook", err);
          }
        }
      }
      if (this.historyStoreDir && toAppendToHistory.length) void this.appendToHistoryStore(toAppendToHistory);
      this.markStoreDirty();
    });
  }

  private async renderQr(qr: string): Promise<void> {
    log("Scan this QR code with WhatsApp (Settings → Linked devices → Link a device):");
    qrcodeTerminal.generate(qr, { small: true }, (rendered: string) => {
      process.stderr.write("\n" + rendered + "\n");
    });
    try {
      await QRCode.toFile(this.qrFile, qr, { width: 400, margin: 2 });
      log(`[${this.label}] QR code also saved to ${this.qrFile}`);
    } catch (err) {
      logError("save qr", err);
    }
  }


  /** Append one live content message to the durable per-day journal. */
  private async appendToJournal(raw: WAMessage): Promise<void> {
    if (!this.journalDir) return;
    try {
      const ct = raw.message ? getContentType(raw.message) : undefined;
      if (!ct || NON_CONTENT_TYPES.has(ct)) return;
      const remoteJid = raw.key.remoteJid ?? "";
      if (!remoteJid || remoteJid === "status@broadcast") return;
      const iso = new Date(toMillis(raw.messageTimestamp)).toISOString();
      const fromMe = Boolean(raw.key.fromMe);
      const rec: RecentJournalRecord = {
        timestamp: iso,
        chat_id: remoteJid,
        chat_name: this.store.chats.get(remoteJid)?.name || this.resolveName(remoteJid),
        is_group: isJidGroup(remoteJid) ?? false,
        sender: fromMe ? "me" : this.resolveName(raw.key.participant || remoteJid),
        from_me: fromMe,
        body: extractBody(raw) || `[${contentType(raw)}]`,
      };
      await mkdir(this.journalDir, { recursive: true });
      await appendFile(resolve(this.journalDir, `${iso.slice(0, 10)}.jsonl`), JSON.stringify(rec) + "\n", "utf8");
    } catch (err) {
      logError("journal append", err);
    }
  }

  private async toMessageSummary(raw: WAMessage): Promise<MessageSummary> {
    const fromMe = Boolean(raw.key.fromMe);
    const sender = fromMe ? "me" : this.resolveName(raw.key.participant || raw.key.remoteJid || "");
    return {
      id: serializeKey(raw.key),
      chat_id: raw.key.remoteJid ?? "",
      from_me: fromMe,
      sender,
      body: extractBody(raw) || `[${contentType(raw)}]`,
      type: contentType(raw),
      has_media: hasMedia(raw),
      has_quoted: hasQuoted(raw),
      timestamp: new Date(toMillis(raw.messageTimestamp)).toISOString(),
    };
  }

  private toChatSummary(chat: BaileysChat): ChatSummary {
    const id = chat.id ?? "";
    const isGroup = isJidGroup(id) ?? false;
    const ring = this.store.byChat.get(id);
    const lastRaw = ring && ring.length ? this.store.messages.get(ring[ring.length - 1]) : undefined;
    return {
      chat_id: id,
      name: chat.name || this.resolveName(id),
      is_group: isGroup,
      unread_count: chat.unreadCount ?? 0,
      archived: Boolean(chat.archived),
      pinned: Boolean(chat.pinned),
      muted: Boolean(chat.muteEndTime),
      last_activity: chatTime(chat) ? new Date(chatTime(chat) * 1000).toISOString() : null,
      last_message: lastRaw ? extractBody(lastRaw) : null,
    };
  }

  private toContactSummary(contact: BaileysContact): ContactSummary {
    const number = jidDecode(contact.id)?.user ?? null;
    return {
      contact_id: contact.id,
      name: contact.name || contact.notify || number || contact.id,
      number,
      is_my_contact: Boolean(contact.name),
      is_business: false,
    };
  }

  private async rawDownload(raw: WAMessage): Promise<WaMedia | null> {
    try {
      const buffer = (await downloadMediaMessage(
        raw,
        "buffer",
        {},
        { logger: silentLogger, reuploadRequest: this.sock().updateMediaMessage },
      )) as Buffer;
      const content = raw.message?.[contentType(raw) as keyof WAMessageContent] as
        | { mimetype?: string; fileName?: string }
        | undefined;
      return {
        data: buffer.toString("base64"),
        mimetype: content?.mimetype ?? "application/octet-stream",
        filename: content?.fileName ?? null,
      };
    } catch (err) {
      logError("download media", err);
      return null;
    }
  }

  /** Build a whatsapp-web.js-shaped adapter object from a raw Baileys message. */
  private makeWaMessage(raw: WAMessage): WaMessage {
    const remoteJid = raw.key.remoteJid ?? "";
    const isGroup = isJidGroup(remoteJid) ?? false;
    const fromMe = Boolean(raw.key.fromMe);
    const own = this.ownJid();
    const participant = raw.key.participant ?? undefined;
    const from = fromMe ? own : remoteJid;
    const to = fromMe ? remoteJid : own;
    const serialized = serializeKey(raw.key);
    const self = this;
    return {
      id: { _serialized: serialized, remote: remoteJid, id: raw.key.id ?? "", fromMe },
      from,
      to,
      author: isGroup ? participant : undefined,
      fromMe,
      body: extractBody(raw),
      type: contentType(raw),
      timestamp: toSeconds(raw.messageTimestamp),
      hasMedia: hasMedia(raw),
      hasQuotedMsg: hasQuoted(raw),
      async getChat(): Promise<WaChat> {
        const chat = self.store.chats.get(remoteJid);
        let name = chat?.name ?? "";
        if (isGroup && !name) {
          name = await self.sock().groupMetadata(remoteJid).then((m) => m.subject).catch(() => "");
        }
        if (!name) name = self.resolveName(remoteJid);
        return {
          id: { _serialized: remoteJid, user: jidDecode(remoteJid)?.user ?? remoteJid },
          name,
          isGroup,
          async getContact(): Promise<WaContact> {
            const isMe = !isGroup && jidDecode(remoteJid)?.user === jidDecode(own)?.user;
            return { id: { _serialized: remoteJid }, isMe };
          },
        };
      },
      async downloadMedia(): Promise<WaMedia | undefined> {
        return (await self.rawDownload(raw)) ?? undefined;
      },
      async react(emoji: string): Promise<void> {
        await self.sock().sendMessage(remoteJid, { react: { text: emoji, key: raw.key } });
      },
      async forward(chat: WaChat): Promise<void> {
        await self.sock().sendMessage(chat.id._serialized, { forward: raw });
      },
      async delete(forEveryone: boolean): Promise<void> {
        if (forEveryone) await self.sock().sendMessage(remoteJid, { delete: raw.key });
      },
    };
  }

  /** Emit a (lid, pn) pair to all registered hooks when a contact carries both. */
  private emitLidPnPair(c: BaileysContact): void {
    if (!this.lidPnHooks.length) return;
    const lid = c.lid ?? (c.id.endsWith("@lid") ? c.id : undefined);
    const pn = c.phoneNumber ?? (!c.id.endsWith("@lid") ? c.id : undefined);
    if (!lid || !pn) return;
    for (const hook of this.lidPnHooks) {
      try {
        hook(lid, pn);
      } catch (err) {
        logError("lid-pn hook", err);
      }
    }
  }

  /** Normalize a bare number / @c.us id to Baileys' @s.whatsapp.net form. */
  private normalizeChatId(input: string): string {
    const trimmed = input.trim();
    if (isJidGroup(trimmed) || trimmed.endsWith("@g.us")) return trimmed;
    if (trimmed.endsWith("@lid") || trimmed.endsWith("@s.whatsapp.net")) return jidNormalizedUser(trimmed);
    if (trimmed.endsWith("@c.us")) return `${trimmed.split("@")[0]}@s.whatsapp.net`;
    if (trimmed.includes("@")) return trimmed;
    const digits = trimmed.replace(/[^\d]/g, "");
    return `${digits}@s.whatsapp.net`;
  }
}

// ---- Pure helpers -----------------------------------------------------------

const silentLogger = {
  level: "silent",
  child: () => silentLogger,
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
} as const;

function serializeKey(key: WAMessage["key"]): string {
  return `${key.fromMe ? "true" : "false"}_${key.remoteJid ?? ""}_${key.id ?? ""}`;
}

function toMillis(ts: WAMessage["messageTimestamp"]): number {
  return toSeconds(ts) * 1000;
}

function toSeconds(ts: WAMessage["messageTimestamp"]): number {
  if (!ts) return Math.floor(Date.now() / 1000);
  if (typeof ts === "number") return ts;
  return typeof ts.toNumber === "function" ? ts.toNumber() : Number(ts);
}

function chatTime(chat: BaileysChat): number {
  const t = chat.conversationTimestamp;
  if (!t) return 0;
  return typeof t === "number" ? t : typeof t.toNumber === "function" ? t.toNumber() : Number(t);
}

function contentType(raw: WAMessage): string {
  const ct = raw.message ? getContentType(raw.message) : undefined;
  switch (ct) {
    case "conversation":
    case "extendedTextMessage":
      return "chat";
    case "imageMessage":
      return "image";
    case "videoMessage":
      return "video";
    case "audioMessage":
      return raw.message?.audioMessage?.ptt ? "ptt" : "audio";
    case "documentMessage":
      return "document";
    case "stickerMessage":
      return "sticker";
    default:
      return ct ?? "unknown";
  }
}

function extractBody(raw: WAMessage): string {
  const m = raw.message;
  if (!m) return "";
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    ""
  );
}

function hasMedia(raw: WAMessage): boolean {
  return ["image", "video", "audio", "ptt", "document", "sticker"].includes(contentType(raw));
}

function hasQuoted(raw: WAMessage): boolean {
  const m = raw.message;
  const ct = m ? getContentType(m) : undefined;
  const node = ct ? (m?.[ct as keyof WAMessageContent] as { contextInfo?: { quotedMessage?: unknown } } | undefined) : undefined;
  return Boolean(node?.contextInfo?.quotedMessage);
}

function statusText(s: unknown): string | null {
  if (s && typeof s === "object" && "status" in s) return (s as { status?: string }).status ?? null;
  return null;
}

function mediaFilename(media: WaMedia): string {
  const original = (media.filename ?? "").replace(/[^\w.\-]/g, "_");
  const extFromName = original.includes(".") ? original.slice(original.lastIndexOf(".")) : "";
  const subtype = media.mimetype.split("/")[1]?.split(";")[0] ?? "bin";
  const ext = extFromName || `.${subtype}`;
  return `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
}

async function loadMedia(source: { file_path?: string; url?: string }): Promise<{
  buffer: Buffer;
  mimetype: string;
  filename: string;
}> {
  if (source.file_path) {
    const path = resolve(source.file_path);
    const buffer = readFileSync(path);
    return { buffer, mimetype: guessMime(path), filename: path.split("/").pop() ?? "file" };
  }
  if (source.url) {
    const res = await fetch(source.url);
    if (!res.ok) throw new Error(`Failed to fetch media: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const mimetype = res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
    return { buffer, mimetype, filename: source.url.split("/").pop()?.split("?")[0] ?? "file" };
  }
  throw new Error("Provide either file_path or url.");
}

function mediaSendContent(
  buffer: Buffer,
  mimetype: string,
  filename: string,
  caption: string | undefined,
  asDocument: boolean,
): Parameters<WASocket["sendMessage"]>[1] {
  if (asDocument) return { document: buffer, mimetype, fileName: filename, caption };
  if (mimetype.startsWith("image/")) return { image: buffer, caption };
  if (mimetype.startsWith("video/")) return { video: buffer, caption };
  if (mimetype.startsWith("audio/")) return { audio: buffer, mimetype };
  return { document: buffer, mimetype, fileName: filename, caption };
}

function guessMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    pdf: "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}
