import type { ReadSnapshot } from "./wa-types.js";
import { atomicWrite } from "./atomic-file.js";
import { sendContext } from "./send-context.js";
import { Archive, type ArchiveRow } from "./archive.js";
import { caller, requireWrite } from "./access.js";
/**
 * WhatsApp service over Baileys. Baileys emits raw events rather than exposing
 * a queryable store, so this keeps a small in-memory store (chats, contacts,
 * messages by id) fed from those events, optionally persisted under the data
 * dir so a restart does not start blind.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import makeWASocket, {
  ALL_WA_PATCH_NAMES,
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
import { clearSession, readLinkedAccount, useAtomicAuthState, type LinkedAccount } from "./auth-state.js";
import { CallTracker, callMessage, isTrackedCall, type CallEntry } from "./calls.js";
import { BAILEYS_VERSION, paths, WAZAP_VERSION, type Config, type Paths } from "./config.js";
import { asWazapError, RELINK_FIX, RESET_FIX, WazapError } from "./errors.js";
import {
  splitMessageId,
  isGroupId,
  isNoiseJid,
  isStatusJid,
  normalizePhone,
  resolveChatId,
  STATUS_JID,
} from "./ids.js";
import { log, logError } from "./logger.js";
import { Notes } from "./notes.js";
import { asGifMedia, assertMediaSource, describe, loadMedia, mediaContent, mediaFilename } from "./outgoing-media.js";
import { makePreview, videoFrame } from "./previews.js";
import { decodeMessage, encode, Store, type HistoryRecord, type StoreSnapshot } from "./store.js";
import {
  buildMessageView,
  contextInfo,
  callInfo,
  formatAge,
  isCallPlaceholder,
  isControlMessage,
  isStubEvent,
  isoWithOffset,
  mediaInfo,
  mentionedJids,
  messageIdFor,
  messageText,
  messageTimestampMs,
  messageType,
  protoNumber,
  quotedSenderJid,
  reactionOf,
  thumbnailOf,
  viewText,
  voiceSeconds,
} from "./messages.js";
import { PAIRING_TIMEOUT_MS, WA_BROWSER, prettyCode, startPairing } from "./pairing.js";
import {
  readTranscribeSettings,
  transcribeFile,
  TranscribeQueue,
  transcribeReady,
  type Transcript,
  type TranscribeSettings,
  type TranscriptRecord,
} from "./transcribe/index.js";
import { DraftStore, type Draft, type DraftPayload, type DraftView } from "./drafts.js";
import { RateLimiter } from "./ratelimit.js";
import { maskNumber } from "./ui.js";
import type {
  CallInfo,
  ChatAction,
  ChatActionResult,
  ChatFilter,
  ChatSummary,
  ConnectionStatus,
  ContactDetails,
  ContactSyncResult,
  ContactSummary,
  GroupAction,
  GroupActionResult,
  GroupInfo,
  MediaResult,
  MediaSource,
  MessageType,
  OutgoingTarget,
  MessageView,
  PairingInfo,
  ParticipantResult,
  RecentConversation,
  SentMessage,
  StatusInfo,
  SyncState,
  Synced,
  TranscribeResult,
  WhatsAppApi,
  HandledResult,
  Preview,
  SearchOptions,
  UnansweredChat,
  WaitOptions,
  WaitResult,
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
const EDIT_WINDOW_MS = 15 * 60_000;
const RETRACT_WINDOW_MS = 2 * 24 * 3_600_000;
const MAX_GROUP_PARTICIPANTS = 500;
const STALE_INBOUND_MS = 24 * 3_600_000;
const STORE_SAVE_DEBOUNCE_MS = 20_000;
/** How many arrivals wait_for_messages can replay to a cursor before it has to say it lost track. */
const ARRIVALS_KEPT = 500;
/** After the first matching arrival, how long a wait keeps collecting the rest of the burst. */
const ARRIVAL_SETTLE_MS = 1_000;
/** A photo bigger than this is not downloaded for a preview. */
const PREVIEW_SOURCE_MAX_BYTES = 6_000_000;
/** A video bigger than this is not downloaded for a frame. */
const PREVIEW_VIDEO_MAX_BYTES = 25_000_000;
/** How many active groups one catch-up fetches metadata for, to name their senders. */
const RECENT_GROUP_META_MAX = 12;
/** How long one call may spend downloading and shrinking photos before it returns with what it has. */
const PREVIEW_BUDGET_MS = 20_000;
/** WhatsApp shows a story for a day; so does wazap. */
const STORY_TTL_MS = 24 * 3_600_000;
/** How far back into a chat get_unanswered reads for the ask. */
const UNANSWERED_SCAN = 30;
/** Words that make a message read as something asked of the user, when it has no question mark. */
const ASK_PATTERN =
  /\b(te rog|v[ăa] rog|po[țt]i|pute[țt]i|ai putea|a[țt]i putea|c[âa]nd|c[âa]t|unde|trimite|trimi[țt]i|sun[ăa]|spune-mi|zi-mi|confirm[ăai]?|urgent|please|can you|could you|would you|when|where|how much|send me|let me know|need)\b/i;
const CALL_SWEEP_MS = 30_000;
/** The same call reaches the store up to three ways; only nearness in time tells them apart. */
const CALL_DEDUPE_WINDOW_MS = 60_000;
const CALL_DEDUPE_SCAN = 20;
const HISTORY_STORE_CAP_PER_CHAT = 2_000;
/** Ten minutes of speech. Past that, auto-transcribing is a bill nobody asked for. */
const AUTO_TRANSCRIBE_MAX_SECONDS = 600;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * A contact WhatsApp will not name for us still arrives with a `name`: the
 * masked number "+40∙∙∙∙∙∙∙98". Counting those as address-book entries would
 * make wazap believe the address book had landed, and showing one hides the
 * plain number the reader can actually dial. Anything made only of digits and
 * masking is not a name.
 */
const NOT_A_NAME = /^[+\d\s()\-.·•∙…*]+$/u;

/** The name a human wrote, or "" for a placeholder and for nothing at all. */
export function realName(value: string | null | undefined): string {
  const name = value?.trim() ?? "";
  return name === "" || NOT_A_NAME.test(name) ? "" : name;
}

/** A resync asks WhatsApp for the whole address book, so it is not free. */
const CONTACT_RESYNC_COOLDOWN_MS = 7 * 24 * 3_600_000;
/** How long past the initial sync a slow app state sync still gets to deliver. */
const CONTACT_SETTLE_MS = 15_000;

export interface ContactResyncInput {
  /** Contacts carrying an address-book name right now. */
  named: number;
  /** WhatsApp has already told us a version for at least one collection. */
  storedVersions: boolean;
  /** When wazap last asked for the whole address book, from the store. */
  resyncedAt: number | null;
  now: number;
}

/**
 * Whether this session should ask WhatsApp for the address book from scratch.
 *
 * Names arrive only in an app state sync that starts from version zero. With no
 * stored version there is nothing to heal: the connection is already doing that
 * sync. With versions stored and no names in hand, the delivery went somewhere
 * that threw it away, and only a resync gets it back. An account whose address
 * book is genuinely empty looks identical, which is what the cooldown is for.
 */
export function needsContactResync({ named, storedVersions, resyncedAt, now }: ContactResyncInput): boolean {
  if (named > 0 || !storedVersions) return false;
  return resyncedAt === null || now - resyncedAt >= CONTACT_RESYNC_COOLDOWN_MS;
}

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

const PROFILE_LOOKUP_MS = 8_000;

/** Resolves to `null` when `work` rejects or is still pending after `ms`. */
function orNullAfter<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work.catch(() => null), guard]).finally(() => clearTimeout(timer));
}

export class WhatsAppService implements WhatsAppApi {
  private sockClient: WASocket | null = null;
  private saveCreds: (() => Promise<void>) | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private starting = false;
  private stopped = false;
  private readonly activeOperations = new Set<Promise<unknown>>();
  /** Bumped per socket, so events from a superseded socket are ignored. */
  private generation = 0;
  private status: ConnectionStatus = "connecting";
  private statusSince = Date.now();
  private lastError: string | null = null;
  /**
   * Called once when the reconnect budget runs out on something a restart could
   * fix. The CLI turns it into an exit code, so a supervisor gets its turn.
   */
  onGiveUp: (() => void) | null = null;
  private account: StatusInfo["account"] = null;
  /** The pairing in flight, from the first `link` call until it settles either way. */
  private linking: Promise<PairingInfo> | null = null;
  private pairing: PairingInfo | null = null;
  private lastInboundAt: number | null = null;
  private initialSyncDone = false;
  private historyReceived = false;
  private syncDeadline: ReturnType<typeof setTimeout> | null = null;
  private syncWaiters: Array<() => void> = [];
  /** Inbound messages as they land, newest last, so a wait can resume from a cursor. */
  private readonly arrivals: Array<{ seq: number; sid: string; jid: string }> = [];
  private arrivalSeq = 0;
  private readonly bootId = randomUUID().slice(0, 8);
  private arrivalWaiters: Array<() => void> = [];
  private historyWaiters: Array<() => void> = [];
  private storeDirty = false;
  private storeSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private callSweepTimer: ReturnType<typeof setInterval> | null = null;
  private persistedLoaded = false;
  private archive = new Archive();
  private archiveReady: Promise<void> | null = null;
  private archiveTail: Promise<void> = Promise.resolve();
  private syncTimedOut = false;
  private archiveExpiry: ReturnType<typeof setInterval> | null = null;

  private contactResyncTried = false;
  private readonly blocked = new Set<string>();
  private readonly groupCache = new Map<string, GroupMetadata>();
  /** Groups whose metadata WhatsApp refused, so we stop asking on every read. */
  private readonly unreadableGroups = new Set<string>();
  /** `<user>@lid` to the phone-number jid, so ids we hand out stay canonical. */
  private readonly lidToPn = new Map<string, string>();
  /** The same, for naming only, and it holds more. See `learnLidPhone`. */
  private readonly lidPhones = new Map<string, string>();
  /** The other way round, so a phone jid can be named from what was learned under its lid. */
  private readonly phoneLids = new Map<string, string>();
  private readonly store = new Store();
  private readonly calls = new CallTracker();
  private readonly paths: Paths;
  private readonly notes: Notes;
  /** The transcription environment, or the complaint about it. See `readTranscribeConfig`. */
  private readonly transcribe: TranscribeSettings | WazapError;
  /** Null unless a provider is configured and auto mode is on. */
  private readonly transcribeQueue: TranscribeQueue | null;
  /** The seam the tests replace; production always runs the real providers. */
  private transcriber = transcribeFile;
  /** Transcriptions under way, so one recording is never uploaded twice at once. */
  private readonly transcribing = new Map<string, Promise<TranscribeResult>>();
  private readonly drafts = new DraftStore();
  private outboxReady: Promise<void> | null = null;
  private outbox = new Map<
    string,
    { draft: Draft; principal: string; state: string; messageId: string; result?: SentMessage }
  >();
  private confirms = new Map<string, Promise<SentMessage>>();
  private readonly writes: RateLimiter;

  constructor(private readonly config: Config) {
    if (config.cacheLimit) this.store.setCacheLimit(config.cacheLimit);
    this.writes = new RateLimiter(config.rateLimitPerMinute);
    this.paths = paths(config.dataDir);
    this.notes = new Notes(this.paths.notesFile);
    this.transcribe = readTranscribeConfig(config.dataDir, config.accountEnv);
    const settings = this.transcribe;
    this.transcribeQueue =
      settings instanceof WazapError || settings.provider === null || !settings.auto
        ? null
        : new TranscribeQueue(async (sid) => {
            // Whatever is still queued when the service stops is dropped rather
            // than run against a socket that is already gone.
            if (this.stopped) return;
            await this.transcribeAudio(sid);
          });
  }

  setCacheLimit(limit: number): void { this.store.setCacheLimit(limit); }

  async start(): Promise<void> {
    if (this.stopped || this.starting) return;
    this.starting = true;
    try {
      const linked = this.readAccount();
      if (linked === "corrupt") return;
      if (linked === null) {
        if (this.config.accountOwner) {
          this.account = { id: this.config.accountOwner, name: "", number: this.config.accountOwner.split("@")[0]! };
          await this.loadPersisted();
        }
        return;
      }
      this.config.validateAccount?.(linked.id);
      this.account = linked;
      await this.loadPersisted();
      if (this.config.offline) { this.setStatus("disconnected"); return; }

      let state;
      try {
        ({ state, saveCreds: this.saveCreds } = await useAtomicAuthState(this.paths.authDir));
      } catch (err) {
        this.markCorrupt(err);
        return;
      }

      this.teardownSocket();
      this.initialSyncDone = false;
      this.syncTimedOut = false;
      this.setStatus("connecting");
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
    this.teardownSocket();
    this.releaseWaiters();
    this.wakeArrivalWaiters();
    await Promise.allSettled([...this.activeOperations]);
    await this.transcribeIdle();
    for (const timer of [this.storeSaveTimer, this.reconnectTimer, this.syncDeadline]) {
      if (timer) clearTimeout(timer);
    }
    this.storeSaveTimer = null;
    this.reconnectTimer = null;
    this.syncDeadline = null;
    this.stopCallSweep();
    this.releaseWaiters();
    this.wakeArrivalWaiters();
    if (this.archiveExpiry) clearInterval(this.archiveExpiry);
    await this.archiveTail;
    await this.flushStore();
    await this.archive.close();
    this.teardownSocket();
    if (this.archive.error || this.notes.error)
      throw new WazapError("ARCHIVE_UNAVAILABLE", (this.archive.error ?? this.notes.error)!);
  }

  /**
   * Pair this install from inside the agent, so linking needs no terminal. One
   * pairing runs at a time: a second call while one is in flight hands back the
   * same code rather than opening a second socket on the same session.
   */
  link(phone: string): Promise<PairingInfo> {
    return this.guarded(async () => {
      if (this.linking) return this.linking;
      const number = normalizePhone(phone);
      this.requireUnlinked();
      if (this.status !== "not_linked") clearSession(this.paths);
      this.linking = this.pair(number);
      return this.linking;
    });
  }

  private requireUnlinked(): void {
    switch (this.status) {
      case "not_linked":
      case "logged_out":
      case "session_corrupt":
      case "auth_failure":
        return;
      default:
        throw new WazapError("ALREADY_LINKED", `The account is ${this.status}.`, "Call get_status");
    }
  }

  private async pair(phone: string): Promise<PairingInfo> {
    let pairing;
    try {
      pairing = await startPairing(this.paths.authDir, phone, PAIRING_TIMEOUT_MS);
    } catch (err) {
      this.abandonLink(err);
      throw err;
    }
    this.pairing = {
      code: prettyCode(pairing.code),
      phone_masked: maskNumber(phone),
      expires_at: isoWithOffset(pairing.expiresAt),
    };
    this.setStatus("linking");
    void pairing.done.then(
      (account) => this.adoptLink(account),
      (err: unknown) => this.abandonLink(err),
    );
    return this.pairing;
  }

  /**
   * The pairing socket is already ended by the time `done` resolves, so this one
   * is safe to open. It has to be this process's socket, because WhatsApp sends
   * the history once and only the store here can catch it.
   */
  private async adoptLink(account: LinkedAccount): Promise<void> {
    this.linking = null;
    this.pairing = null;
    this.config.validateAccount?.(account.id);
    this.account = account;
    this.lastError = null;
    await this.start();
  }

  private abandonLink(err: unknown): void {
    this.linking = null;
    this.pairing = null;
    this.setStatus("not_linked");
    this.lastError = describe(err);
    logError("link", err);
  }

  /** True once WhatsApp has delivered at least one history-sync batch. */
  hasHistory(): boolean {
    return this.historyReceived;
  }

  /**
   * The same full resync the self-heal runs, on demand. Nothing about the
   * account changes: this asks WhatsApp to send the address book again.
   */
  syncContacts(): Promise<ContactSyncResult> {
    return this.guarded(async () => {
      const sock = this.ensureConnected();
      const before = this.namedContacts();
      await this.resyncContacts(sock);
      const after = await this.waitForNames(before, Date.now() + CONTACT_SETTLE_MS);
      return { requested: true, named_before: before, named_after: after };
    });
  }

  storeCounts(): { chats: number; contacts: number; messages: number } {
    return { chats: this.store.chats.size, contacts: this.namedContacts(), messages: this.store.messages.size };
  }

  /**
   * People from the phone's address book: the only contact count worth
   * reporting. The store also holds everyone who ever appeared in a group and
   * every group itself, so its raw size says nothing about whether the address
   * book ever arrived.
   */
  namedContacts(): number {
    let named = 0;
    for (const [jid, contact] of this.store.contacts) {
      if (!isGroupId(jid) && realName(contact.name)) named++;
    }
    return named;
  }

  /** The one writer of `status`, so `status_since` can never drift from it. */
  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.statusSince = Date.now();
  }

  getStatus(): StatusInfo {
    const info: StatusInfo = {
      status: this.status,
      status_since: isoWithOffset(this.statusSince),
      sync: this.syncState(),
      account: this.account,
      last_message_received_at: this.lastInboundAt === null ? null : isoWithOffset(this.lastInboundAt),
      reconnect_attempts: this.reconnectAttempts,
      wazap_version: WAZAP_VERSION,
      baileys_version: BAILEYS_VERSION,
      contacts_named: this.namedContacts(),
      data_dir: this.config.dataDir,
      read_only: this.config.readOnly,
      rate_limit: this.config.rateLimitPerMinute,
      last_error: this.lastError,
      archive: {
        state: this.archive.error || this.notes.error ? "error" : this.archiveReady ? "ready" : "deferred",
        error: this.archive.error ?? this.notes.error,
        migrated: this.archive.migrated,
        unknown_sends: [...this.outbox.values()].filter((e) => e.state === "unknown").length,
      },
    };
    if (this.status === "linking" && this.pairing) {
      info.pairing = this.pairing;
      info.hint = "Enter the code on the phone; call get_status again in 10 s";
    }
    const stale = this.lastInboundAt !== null && Date.now() - this.lastInboundAt > STALE_INBOUND_MS;
    if (this.status === "connected" && stale) {
      info.hint = "No messages received for 24h; the phone may be offline.";
    }
    return info;
  }

  listChats(filter: ChatFilter, limit: number): Promise<Synced<ChatSummary[]>> {
    return this.guarded(async () => {
      this.ensureReadable();
      if (this.status === "connected") await this.waitForSync();
      await this.refreshArchiveTails();
      const candidates = this.knownChats().filter((chat) => this.matchesChatFilter(chat, filter));
      // The lookup can teach a pairing, and a pairing changes which rows are
      // the same person, so it comes first and everything after it is one
      // synchronous pass: merge, sort, cut, render. Otherwise a chat merged
      // under its lid could render under its number and sit next to the row
      // that already had that number.
      await this.learnLidPhones(candidates.map((chat) => this.canonical(chat.id ?? "")));
      const selected = this.mergeAliases(candidates)
        .sort((a, b) => this.chatActivity(b) - this.chatActivity(a))
        .slice(0, limit);
      const chats: ChatSummary[] = [];
      for (const chat of selected) {
        await this.loadChatTail(this.canonical(chat.id ?? ""));
        chats.push(this.chatSummary(chat));
      }
      return this.synced(chats);
    });
  }

  readMessages(chatId: string, limit: number, before?: string, types?: MessageType[]): Promise<Synced<MessageView[]>> {
    return this.guarded(async () => {
      this.ensureReadable();
      const sock = this.sockClient;
      const jid = this.resolveId(chatId);
      if (this.status === "connected") await this.waitForSync();
      await this.learnParticipants(jid);
      await this.learnLidPhones([jid]);

      await this.archiveBarrier();
      const anchor = before ? await this.archive.call("get", { sid: before }) : undefined;
      if (before && (!anchor || anchor.jid !== jid))
        throw new WazapError("MESSAGE_NOT_FOUND", "The paging anchor is not in this chat.");
      const query = { jid, limit: limit + 1, before: anchor, types };
      let rows = (await this.archive.call("query", query)) as ArchiveRow[];
      let history_fetch: "not_requested" | "received" | "timed_out" | "unavailable" = "not_requested";
      if (before && rows.length < limit && anchor?.raw) {
        const raw = decodeMessage(anchor.raw);
        if (raw) {
          history_fetch = sock ? await this.fetchOlderForChat(sock, raw, jid, limit) : "unavailable";
          await this.archiveBarrier();
          rows = await this.archive.call("query", query);
        }
      }
      const data = rows
        .slice(0, limit)
        .reverse()
        .map((row) => this.archiveView(row));
      return {
        ...this.synced(data),
        has_more_local: rows.length > limit,
        history_fetch,
        coverage: await this.coverage(jid),
      };
    });
  }

  getRecentMessages(
    hours: number,
    filter: Exclude<ChatFilter, "archived">,
    includeSystem = false,
    types?: MessageType[],
    limit = 200,
    cursor?: string,
    snapshot?: ReadSnapshot,
  ): Promise<Synced<RecentConversation[]>> {
    return this.guarded(async () => {
      this.ensureReadable();
      if (this.status === "connected") await this.waitForSync();
      await this.archiveBarrier();
      await this.learnLidPhones(this.store.byChat.keys());
      await this.archiveTail;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ hours, filter, includeSystem, types: types ?? [] }))
        .digest("hex");
      let through = snapshot?.through ?? Date.now(),
        watermark = snapshot?.watermark ?? Number((await this.archive.call("watermark")).id ?? 0),
        before: undefined | { ts: number; sid: string } = snapshot?.anchor;
      if (cursor) {
        try {
          const c = JSON.parse(Buffer.from(cursor, "base64url").toString());
          if (
            c.f !== fingerprint ||
            !Number.isFinite(c.through) ||
            !Number.isFinite(c.watermark) ||
            !Number.isFinite(c.before?.ts) ||
            typeof c.before.sid !== "string"
          )
            throw Error();
          through = c.through;
          watermark = c.watermark;
          before = c.before;
        } catch {
          throw new WazapError("INVALID_ID", "Cursor does not match this catch-up. Start again without cursor.");
        }
      }
      const jids =
        filter === "unread"
          ? this.knownChats()
              .filter((c) => this.matchesChatFilter(c, filter))
              .map((c) => this.canonical(c.id!))
          : undefined;
      const rows = (await this.archive.call("query", {
        since: through - hours * 3_600_000,
        until: through,
        watermark,
        before,
        jids,
        group: filter === "groups" ? true : filter === "individual" ? false : undefined,
        types,
        excludeSystem: !includeSystem,
        limit: limit + 1,
      })) as ArchiveRow[];
      const selected = rows.slice(0, limit);
      await Promise.all(
        [...new Set(selected.map((r) => r.jid))]
          .filter(isGroupId)
          .slice(0, RECENT_GROUP_META_MAX)
          .map((j) => this.learnParticipants(j)),
      );
      const grouped = new Map<string, RecentConversation>();
      for (const row of selected) {
        const view = this.archiveView(row);
        let c = grouped.get(row.jid);
        if (!c) {
          c = {
            chat_id: row.jid,
            chat_name: this.displayName(row.jid),
            type: isGroupId(row.jid) ? "group" : "individual",
            last_activity: view.timestamp,
            messages: [],
            ...(this.notes.noteFor(row.jid) ? { note: this.notes.noteFor(row.jid) } : {}),
          };
          grouped.set(row.jid, c);
        }
        c.messages.unshift(view);
      }
      const last = selected.at(-1);
      return {
        ...this.synced([...grouped.values()]),
        coverage: await this.coverage(),
        next_cursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({ f: fingerprint, through, watermark, before: { ts: last.ts, sid: last.sid } }),
              ).toString("base64url")
            : null,
      };
    });
  }

  searchMessages(
    query: string,
    chatId: string | undefined,
    limit: number,
    opts: SearchOptions = {},
  ): Promise<Synced<MessageView[]>> {
    return this.guarded(async () => {
      this.ensureReadable();
      if (this.status === "connected") await this.waitForSync();
      const needle = query.trim().toLowerCase();
      const scope = chatId === undefined ? undefined : this.resolveId(chatId);
      const from = opts.from === undefined ? undefined : opts.from === "me" ? this.ownJid() : this.resolveId(opts.from);
      await this.archiveBarrier();
      const before = opts.snapshot?.anchor ?? (opts.before ? await this.archive.call("get", { sid: opts.before }) : undefined);
      if (opts.before && !before) throw new WazapError("MESSAGE_NOT_FOUND", "Unknown search anchor.");
      const rows = (await this.archive.call("query", {
        query: needle,
        jid: scope,
        from,
        since: opts.sinceMs,
        until: opts.snapshot ? Math.min(opts.untilMs ?? Infinity, opts.snapshot.through) : opts.untilMs,
        watermark: opts.snapshot?.watermark,
        before,
        limit: limit + 1,
      })) as ArchiveRow[];
      const data = rows.slice(0, limit).map((row) => this.archiveView(row));
      return {
        ...this.synced(data),
        next_before: rows.length > limit ? data.at(-1)!.message_id : null,
        coverage: await this.coverage(scope),
      };
    });
  }

  getMessage(messageId: string): Promise<MessageView> {
    return this.guarded(async () => {
      this.ensureReadable();
      await this.archiveBarrier();
      const row = await this.archive.call("get", { sid: messageId });
      if (!row) {
        this.messageOrThrow(messageId);
        return this.viewOf(messageId, this.store.chatOf.get(messageId) ?? "");
      }
      return this.archiveView(row);
    });
  }

  searchContacts(query: string, limit: number): Promise<ContactSummary[]> {
    return this.guarded(async () => {
      this.ensureReadable();
      if (this.status === "connected") await this.waitForSync();
      const needle = query.trim().toLowerCase();
      // "0734…" typed the way a number is dialled at home matches "40734…".
      const digits = needle.replace(/\D/g, "").replace(/^0+/, "");
      const matches: ContactSummary[] = [];
      const seen = new Set<string>();

      for (const [jid, contact] of this.store.contacts) {
        // A lid entry whose number is known is the same person as the phone entry.
        const person = this.canonical(jid);
        if (seen.has(person)) continue;
        seen.add(person);
        // Every name we might show, or someone the chat list calls "Carmen"
        // would not be findable by that name here.
        const known = [contact.name, contact.verifiedName, contact.notify, this.store.pushNames.get(jid)].map(realName);
        const number = jid.split("@")[0] ?? "";
        const hit =
          needle === "" ||
          known.some((name) => name?.toLowerCase().includes(needle)) ||
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
      // A number WhatsApp does not know never answers these two queries, so
      // they get a deadline and the contact still comes back from the store.
      const [about, picture] = await Promise.all([
        orNullAfter(
          sock.fetchStatus(jid).then((entries) => statusTextOf(entries?.[0])),
          PROFILE_LOOKUP_MS,
        ),
        orNullAfter(sock.profilePictureUrl(jid, "image"), PROFILE_LOOKUP_MS),
      ]);
      return {
        ...this.contactSummary(jid, contact),
        about,
        profile_pic_url: picture ?? null,
        is_blocked: this.blocked.has(jid),
      };
    });
  }

  /**
   * Block until something arrives that matches, or until the deadline. The
   * first match starts a short settle so a burst of messages comes back as
   * one answer. A cursor from this run replays what landed since it, so a
   * loop of calls misses nothing between them; one from another run is
   * refused and the wait starts from now, and says so.
   */
  waitForMessages(opts: WaitOptions): Promise<WaitResult> {
    return this.guarded(async () => {
      this.ensureConnected();
      const chatJid = opts.chatId === undefined ? undefined : this.resolveId(opts.chatId);
      const parsed = this.parseCursor(opts.cursor);
      let since = parsed.seq;
      const deadline = Date.now() + opts.timeoutMs;
      const matching = (): typeof this.arrivals =>
        this.arrivals.filter((a) => a.seq > since && this.arrivalMatches(a, chatJid, opts.addressedToMe));

      let found = matching();
      let timedOut = false;
      if (found.length === 0) {
        while (!this.stopped && Date.now() < deadline) {
          await this.nextArrival(deadline - Date.now());
          found = matching();
          if (found.length > 0) break;
        }
        if (found.length === 0) timedOut = true;
      }
      if (found.length > 0) {
        await this.nextArrival(Math.min(ARRIVAL_SETTLE_MS, Math.max(0, deadline - Date.now())), true);
        found = matching();
      }
      const last = found.length > 0 ? found[found.length - 1]!.seq : Math.max(since, this.arrivalSeq);
      since = last;
      await this.archiveBarrier();
      const messages: MessageView[] = [];
      for (const arrival of found) {
        const row = await this.archive.call("get", { sid: arrival.sid });
        if (row) messages.push(this.archiveView(row));
      }
      return {
        messages,
        cursor: `${this.bootId}:${last}`,
        timed_out: timedOut,
        cursor_reset: parsed.reset,
      };
    });
  }

  /** The stories of the last `hours`, newest first, each with its author as the sender. */
  getStories(hours: number): Promise<Synced<MessageView[]>> {
    return this.guarded(async () => {
      this.ensureReadable();
      if (this.status === "connected") await this.waitForSync();
      await this.archiveBarrier();
      this.store.pruneStories(Date.now() - STORY_TTL_MS);
      const cutoff = Date.now() - hours * 3_600_000;
      const sids = this.store.stories.filter((sid) => {
        const raw = this.store.messages.get(sid);
        return raw !== undefined && messageTimestampMs(raw) >= cutoff;
      });
      await this.learnLidPhones(sids.map((sid) => this.store.messages.get(sid)?.key.participant ?? "").filter(Boolean));
      return this.synced(this.viewsFor(sids, STATUS_JID).reverse());
    });
  }

  /**
   * Small JPEGs of these messages' photos, in the order given, at most `max`.
   * The preview WhatsApp shipped comes first, then one made earlier, and only
   * then is the photo downloaded and shrunk here, once, within a time budget so
   * the call returns with what it has. A photo that is not a JPEG, has expired
   * or is too big simply has no preview.
   */
  previews(messageIds: string[], max: number): Promise<Preview[]> {
    return this.guarded(async () => {
      const out: Preview[] = [];
      const started = Date.now();
      for (const sid of messageIds) {
        if (out.length >= max) break;
        let raw: WAMessage;
        try {
          raw = await this.loadMessage(sid);
        } catch (error) {
          if (error instanceof WazapError && error.code === "ARCHIVE_UNAVAILABLE") throw error;
          continue;
        }
        const shipped = thumbnailOf(raw);
        if (shipped) {
          out.push({ message_id: sid, ...shipped });
          continue;
        }
        const cached = await this.readPreview(sid);
        if (cached) {
          out.push({ message_id: sid, mime: "image/jpeg", base64: cached.toString("base64") });
          continue;
        }
        const info = mediaInfo(raw);
        if (!info) continue;
        const photo = /^image\/jpe?g\b/i.test(info.mime) && (info.size ?? 0) <= PREVIEW_SOURCE_MAX_BYTES;
        const video = /^video\//i.test(info.mime) && (info.size ?? 0) <= PREVIEW_VIDEO_MAX_BYTES;
        if (!photo && !video) continue;
        if (Date.now() - started > PREVIEW_BUDGET_MS) continue;
        const sock = this.sockClient;
        if (!sock || this.status !== "connected") continue;
        try {
          const buffer = await this.mediaBuffer(sock, sid, raw);
          const made = photo ? Buffer.from(makePreview(buffer).base64, "base64") : await videoFrame(buffer);
          if (!made) continue;
          await this.loadMessage(sid);
          await this.writePreview(sid, made);
          try {
            await this.loadMessage(sid);
          } catch (error) {
            await rm(this.previewPath(sid), { force: true });
            throw error;
          }
          out.push({ message_id: sid, mime: "image/jpeg", base64: made.toString("base64") });
        } catch {
          // Expired on WhatsApp's side, or not decodable: this one goes without.
        }
      }
      return out;
    });
  }

  /** Previews live as files, one JPEG per message, so the snapshot stays small and a restart keeps them. */
  private previewPath(sid: string): string {
    return join(this.paths.previewsDir, `${safeFilename(sid)}.jpg`);
  }

  private async readPreview(sid: string): Promise<Buffer | null> {
    try {
      return await readFile(this.previewPath(sid));
    } catch (err) {
      if (!isMissing(err)) logError("preview read", err);
      return null;
    }
  }

  private async writePreview(sid: string, jpeg: Buffer): Promise<void> {
    await mkdir(this.paths.previewsDir, { recursive: true, mode: DIR_MODE });
    await writeFile(this.previewPath(sid), jpeg, { mode: FILE_MODE });
    const raw = this.store.messages.get(sid);
    await this.archive.call("mediaTrack", {
      sid,
      path: this.previewPath(sid),
      expires: raw && isStatusJid(raw.key.remoteJid ?? "") ? messageTimestampMs(raw) + 24 * 3_600_000 : null,
    });
  }

  /**
   * Chats where the last word is theirs and it asks for something: a question
   * mark, a request word, or a voice note nobody has heard yet. A closing
   * "ok, mersi" is not an ask, so the chat is left out. Groups count only when
   * the account was @-mentioned or replied to after its own last message.
   * People first, then the oldest wait first.
   */
  getUnanswered(minAgeHours: number, maxAgeHours: number, limit: number): Promise<Synced<UnansweredChat[]>> {
    return this.guarded(async () => {
      this.ensureReadable();
      if (this.status === "connected") await this.waitForSync();
      await this.refreshArchiveTails();
      const cutoff = Date.now() - minAgeHours * 3_600_000;
      const horizon = Date.now() - maxAgeHours * 3_600_000;
      const found: UnansweredChat[] = [];
      for (const chat of this.mergeAliases(this.knownChats())) {
        if (chat.archived) continue;
        const jid = this.canonical(chat.id ?? "");
        if (isNoiseJid(jid)) continue;
        await this.loadChatTail(jid);
        const open = this.openAsk(jid);
        if (!open) continue;
        const { askSid, theirs } = open;
        if (this.notes.isHandled(jid, askSid)) continue;
        const group = isGroupId(jid);
        const ask = this.viewOf(askSid, jid);
        const askRaw = this.store.messages.get(askSid)!;
        const askedAt = messageTimestampMs(askRaw);
        if (askedAt > cutoff || askedAt < horizon) continue;
        found.push({
          chat_id: jid,
          name: this.displayName(jid),
          type: group ? "group" : "individual",
          ask,
          messages_since_you: theirs.length,
          business: !group && Boolean(this.store.contacts.get(jid)?.verifiedName),
          ...(this.notes.noteFor(jid) ? { note: this.notes.noteFor(jid) } : {}),
          waiting_since: isoWithOffset(askedAt),
          age: formatAge(askedAt),
        });
      }
      found.sort((a, b) => {
        if (a.type !== b.type) return a.type === "individual" ? -1 : 1;
        return a.waiting_since.localeCompare(b.waiting_since);
      });
      return { ...this.synced(found.slice(0, limit)), coverage:{...await this.coverage(),triage_scan_limit:UNANSWERED_SCAN,result_limit:limit,basis:'heuristic_candidates'} };
    });
  }

  /**
   * The ask still open in a chat: their messages after the user's last one,
   * and among them the newest that asks for something. In a group only a
   * message addressed to the user counts.
   */
  private openAsk(jid: string): { askSid: string; theirs: string[] } | null {
    const ring = this.store.byChat.get(jid) ?? [];
    const tail = ring.slice(-UNANSWERED_SCAN);
    const theirs: string[] = [];
    for (let i = tail.length - 1; i >= 0; i--) {
      const raw = this.store.messages.get(tail[i]!);
      if (!raw) continue;
      if (raw.key.fromMe) break;
      if (messageType(raw) === "system") continue;
      theirs.unshift(tail[i]!);
    }
    if (theirs.length === 0) return null;
    const group = isGroupId(jid);
    const askSid = [...theirs].reverse().find((sid) => {
      const raw = this.store.messages.get(sid)!;
      if (group && !this.addressesMe(raw)) return false;
      return this.readsAsAsk(raw, sid);
    });
    return askSid ? { askSid, theirs } : null;
  }

  setContactNote(contactId: string, note: string): Promise<ContactSummary> {
    return this.guarded(async () => {
      const jid = this.resolveId(contactId);
      this.notes.setNote(jid, note);
      return this.contactSummary(jid, this.store.contacts.get(jid));
    });
  }

  /**
   * "I dealt with that outside WhatsApp." The open ask is remembered as
   * handled, so it leaves the waiting list; the next message from them
   * makes a new ask and the chat comes back.
   */
  markHandled(chatId: string): Promise<HandledResult> {
    return this.guarded(async () => {
      const jid = this.resolveId(chatId);
      await this.archiveBarrier();
      await this.loadChatTail(jid);
      const open = this.openAsk(jid);
      const last = this.lastMessageOf(jid);
      const askSid = open?.askSid ?? (last && !last.key.fromMe ? messageIdFor(last.key, jid) : null);
      if (askSid) this.notes.markHandled(jid, askSid);
      return {
        chat_id: jid,
        name: this.displayName(jid),
        ask_id: askSid,
        ask_text: askSid ? viewText(this.store.messages.get(askSid)!, this.store.transcripts.get(askSid)) : null,
      };
    });
  }

  private readsAsAsk(raw: WAMessage, sid: string): boolean {
    const type = messageType(raw);
    if (type === "call") return false;
    const transcript = this.store.transcripts.get(sid);
    // A voice note nobody has heard is an ask until proven otherwise.
    if (type === "voice" && transcript === undefined) return true;
    // A link's query string is not a question.
    const text = viewText(raw, transcript).replace(/https?:\/\/\S+/g, "");
    return text.includes("?") || ASK_PATTERN.test(text);
  }

  /** A group message that @-mentions the linked account or replies to one of its messages. */
  private addressesMe(raw: WAMessage): boolean {
    if (mentionedJids(raw).some((jid) => this.isMe(jid))) return true;
    const quoted = quotedSenderJid(raw);
    return quoted !== undefined && this.isMe(quoted);
  }

  private arrivalMatches(
    arrival: { sid: string; jid: string },
    chatJid: string | undefined,
    addressedToMe: boolean,
  ): boolean {
    if (chatJid !== undefined && arrival.jid !== chatJid) return false;
    if (!addressedToMe || !isGroupId(arrival.jid)) return true;
    const raw = this.store.messages.get(arrival.sid);
    return raw !== undefined && this.addressesMe(raw);
  }

  private parseCursor(cursor: string | undefined): { seq: number; reset: boolean } {
    if (cursor === undefined) return { seq: this.arrivalSeq, reset: false };
    const [boot, rest] = cursor.split(":");
    const seq = Number(rest);
    const oldest = this.arrivals[0]?.seq ?? this.arrivalSeq;
    if (
      boot !== this.bootId ||
      !Number.isInteger(seq) ||
      seq > this.arrivalSeq ||
      (seq < oldest - 1 && this.arrivals.length > 0)
    ) {
      return { seq: this.arrivalSeq, reset: true };
    }
    return { seq, reset: false };
  }

  /** Resolves on the next arrival or after `ms`; a settle rides out the burst and ends only on the deadline or a stop. */
  private nextArrival(ms: number, settle = false): Promise<void> {
    return new Promise((resolve) => {
      const waiter = (): void => {
        if (!settle || this.stopped) done();
      };
      const done = (): void => {
        clearTimeout(timer);
        const at = this.arrivalWaiters.indexOf(waiter);
        if (at !== -1) this.arrivalWaiters.splice(at, 1);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.arrivalWaiters.push(waiter);
    });
  }

  private noteArrivals(stored: readonly WAMessage[]): void {
    let landed = false;
    for (const raw of stored) {
      if (raw.key.fromMe || !raw.key.remoteJid) continue;
      if (messageType(raw) === "system") continue;
      const jid = this.canonical(raw.key.remoteJid);
      if (isNoiseJid(jid)) continue;
      this.arrivals.push({ seq: ++this.arrivalSeq, sid: messageIdFor(raw.key, jid), jid });
      landed = true;
    }
    while (this.arrivals.length > ARRIVALS_KEPT) this.arrivals.shift();
    if (landed) this.wakeArrivalWaiters();
  }

  private wakeArrivalWaiters(): void {
    const waiters = this.arrivalWaiters;
    this.arrivalWaiters = [];
    for (const waiter of waiters) waiter();
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
      const raw = await this.loadMessage(messageId);
      const info = mediaInfo(raw);
      if (!info) throw new WazapError("MEDIA_UNAVAILABLE", `Message ${messageId} carries no media.`);
      const buffer = await this.mediaBuffer(sock, messageId, raw);

      if (!caller().local && saveTo && saveTo !== this.paths.mediaDir)
        throw new WazapError("MEDIA_ACCESS_DENIED", "Remote downloads are stored only in the Wazap media directory.");
      const dir = saveTo ?? this.paths.mediaDir;
      if (!isAbsolute(dir)) {
        throw new WazapError("FILE_NOT_FOUND", `"${dir}" is not an absolute directory path.`);
      }
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
      await this.loadMessage(messageId);
      const filename = mediaFilename(info);
      const path = join(dir, filename);
      await writeFile(path, buffer, { mode: FILE_MODE });
      if (dir === this.paths.mediaDir)
        await this.archive.call("mediaTrack", {
          sid: messageId,
          path,
          expires: isStatusJid(raw.key.remoteJid ?? "") ? messageTimestampMs(raw) + 24 * 3_600_000 : null,
        });
      try {
        await this.loadMessage(messageId);
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      }

      const inline =
        info.mime.startsWith("image/") && buffer.length <= INLINE_IMAGE_MAX_BYTES ? buffer.toString("base64") : null;
      return { path, mime: info.mime, size: buffer.length, filename, inline_base64: inline };
    });
  }

  /**
   * Speech into text, once per message: a transcript already on hand is returned
   * as it is, because the local provider is slow and the API one is billed.
   */
  transcribeAudio(messageId: string, language?: string): Promise<TranscribeResult> {
    return this.guarded(async () => {
      const raw = await this.loadMessage(messageId);
      const known = this.store.transcripts.get(messageId);
      if (known) return transcribeResult(known, true);

      const type = messageType(raw);
      const info = mediaInfo(raw);
      if (info === undefined || (type !== "voice" && type !== "audio")) {
        throw new WazapError(
          "MEDIA_UNAVAILABLE",
          `Message ${messageId} is not a voice note or an audio message.`,
          "Pass a message whose type is voice or audio",
        );
      }

      const settings = this.transcribeSettings();
      // Read-only has always meant no side effect anyone outside can see. The
      // local provider keeps that promise; uploading the user's audio to a
      // third party and spending their money does not.
      if ((this.config.readOnly || !caller().allowWrite) && settings.provider === "openai") {
        throw new WazapError(
          "READ_ONLY",
          "wazap runs read-only, so it will not upload audio to the transcription API.",
          "Restart without WAZAP_READ_ONLY, or run `wazap config transcribe local`",
        );
      }
      const readiness = await transcribeReady(settings);
      if (!readiness.ok) throw new WazapError("TRANSCRIBE_UNAVAILABLE", readiness.detail, readiness.fix);

      // The cache is only written once a provider has run and been paid, so the
      // auto queue and a tool call asking for the same message at the same
      // moment would otherwise upload it twice. They share the first run.
      const running = this.transcribing.get(messageId);
      if (running) return await running;
      const work = this.runTranscribe(messageId, raw, info, settings, language);
      this.transcribing.set(messageId, work);
      try {
        return await work;
      } finally {
        this.transcribing.delete(messageId);
      }
    });
  }

  private async runTranscribe(
    messageId: string,
    raw: WAMessage,
    info: { mime: string; size?: number; filename?: string },
    settings: TranscribeSettings,
    language?: string,
  ): Promise<TranscribeResult> {
    // Readiness is never ok while no provider is configured.
    const provider = settings.provider!;
    const sock = this.ensureConnected();
    const buffer = await this.mediaBuffer(sock, messageId, raw);
    // Its own temp dir, deleted straight after: nobody asked to keep this file,
    // and the media dir is where the files the user did ask for live.
    const dir = await mkdtemp(join(tmpdir(), "wazap-audio-"));
    let transcript: Transcript;
    try {
      const file = join(dir, mediaFilename(info));
      await writeFile(file, buffer, { mode: FILE_MODE });
      transcript = await this.transcriber(settings, file, language === undefined ? {} : { language });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // An API provider answers without a duration, and WhatsApp already said
    // how long the recording runs.
    const seconds = transcript.duration_seconds ?? voiceSeconds(raw);
    const record: TranscriptRecord = {
      ...transcript,
      ...(seconds === undefined ? {} : { duration_seconds: seconds }),
      provider,
      at: Date.now(),
    };
    await this.loadMessage(messageId);
    this.store.transcripts.set(messageId, record);
    this.markStoreDirty();
    // The newest line for a sid wins on reload, so re-appending is what makes
    // the transcript outlive the process.
    await this.appendHistory([raw]);
    if (!this.store.messages.has(messageId)) this.store.transcripts.delete(messageId);
    return transcribeResult(record, false);
  }

  /**
   * Resolves when the background queue has nothing left to transcribe. Off the
   * WhatsAppApi on purpose: an agent has no business waiting on it, and a test
   * needs it so it can wait on the queue instead of sleeping.
   */
  transcribeIdle(): Promise<void> {
    return this.transcribeQueue?.idle() ?? Promise.resolve();
  }

  private loadOutbox(): Promise<void> {
    return (this.outboxReady ??= (async () => {
      await this.ensureArchive();
      for (const entry of await this.archive.call("outboxAll")) {
        if (entry.state === "sending") entry.state = "unknown";
        this.outbox.set(entry.draft.id, entry);
        if (entry.state === "unknown") await this.saveDraft(entry);
        if (entry.state === "sent" || entry.state === "expired") await this.cleanDraft(entry.draft);
      }
      await this.expireDrafts();
    })());
  }
  private async expireDrafts(): Promise<void> {
    for (const entry of this.outbox.values())
      if (
        (entry.state === "draft" || entry.state === "unknown") &&
        entry.draft.expiresAt <= Date.now() &&
        !this.confirms.has(entry.draft.id)
      ) {
        if (entry.state === "draft") entry.state = "expired";
        await this.cleanDraft(entry.draft);
        await this.saveDraft(entry);
      }
  }
  private async saveDraft(entry: {
    draft: Draft;
    principal: string;
    state: string;
    messageId: string;
    result?: SentMessage;
  }): Promise<void> {
    const terminal =
      entry.state === "sent" ||
      entry.state === "expired" ||
      (entry.state === "unknown" && entry.draft.expiresAt <= Date.now());
    const payload = entry.draft.payload;
    const value = terminal
      ? {
          ...entry,
          draft: {
            ...entry.draft,
            preview: "",
            payload: {
              kind: payload.kind,
              chatId: payload.chatId,
              ...(payload.kind === "media" ? { source: payload.source, prepared: payload.prepared } : {}),
            },
          },
        }
      : entry;
    await this.archive.call("outboxPut", { id: entry.draft.id, value });
  }
  private async cleanDraft(draft: Draft): Promise<void> {
    if (draft.payload.kind === "media" && draft.payload.prepared)
      await rm(draft.payload.source.file_path!, { force: true });
    if (draft.payload.kind === "forward") delete draft.payload.snapshotRaw;
  }
  draft(payload: DraftPayload): Promise<DraftView> {
    return this.guarded(async () => {
      requireWrite();
      if (this.config.readOnly) throw new WazapError("READ_ONLY", "Writes are disabled.");
      if (payload.kind === "media") await assertMediaSource(payload.source);
      const sock = this.ensureConnected();
      const jid = await this.assertOutgoing(payload.chatId, sock);
      await this.loadOutbox();
      await this.expireDrafts();
      if ([...this.outbox.values()].filter((e) => e.state === "draft").length >= 20)
        throw new WazapError("RATE_LIMITED", "There are already 20 pending drafts.");
      let stored: DraftPayload = { ...payload, chatId: jid };
      if (payload.kind === "forward") {
        const raw = await this.loadMessage(payload.messageId);
        stored = {
          ...payload,
          chatId: jid,
          text: messageText(raw),
          snapshotRaw: encode(() => proto.WebMessageInfo.encode(raw).finish())!,
        };
      }
      if (payload.kind === "media") {
        const media = await asGifMedia(
          await loadMedia(
            payload.source,
            caller().local ? undefined : { exportDir: this.config.exportDir, dataDir: this.config.rootDataDir ?? this.config.dataDir },
          ),
          payload.asGif,
        );
        const dir = join(this.config.dataDir, "draft-media");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const file = join(dir, `${randomUUID()}-${media.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
        await writeFile(file, media.buffer, { mode: 0o600 });
        stored = { ...payload, chatId: jid, source: { file_path: file }, prepared: true };
      }
      const draft = this.drafts.put(this.outgoingOf(jid), stored);
      const entry = {
        draft,
        principal: caller().principal,
        state: "draft",
        messageId: randomUUID().replaceAll("-", "").toUpperCase(),
      };
      await this.saveDraft(entry);
      this.outbox.set(draft.id, entry);
      return this.drafts.view(draft);
    });
  }
  confirm(draftId: string): Promise<SentMessage> {
    return this.guarded(async () => {
      requireWrite();
      await this.loadOutbox();
      const entry = this.outbox.get(draftId);
      if (!entry || entry.principal !== caller().principal)
        throw new WazapError("DRAFT_NOT_FOUND", "Unknown draft for this client.");
      if (entry.state === "sent") return entry.result!;
      if (this.confirms.has(draftId)) return await this.confirms.get(draftId)!;
      if (entry.state === "unknown" || entry.state === "sending")
        throw new WazapError("SEND_OUTCOME_UNKNOWN", "Delivery has not been confirmed. Do not resend.");
      if (entry.state === "expired" || entry.draft.expiresAt <= Date.now()) {
        entry.state = "expired";
        await this.saveDraft(entry);
        await this.cleanDraft(entry.draft);
        throw new WazapError("DRAFT_EXPIRED", "Draft expired.");
      }
      const work = sendContext.run(
        {
          messageId: entry.messageId,
          dispatch: async () => {
            await this.saveDraft({ ...entry, state: "sending" });
            entry.state = "sending";
          },
        },
        async () => {
          try {
            const result = await this.dispatchDraft(entry.draft);
            entry.state = "sent";
            entry.result = result;
            await this.saveDraft(entry);
            await this.cleanDraft(entry.draft);
            return result;
          } catch (err) {
            if (entry.state === "sending") {
              entry.state = "unknown";
              await this.saveDraft(entry);
              throw new WazapError(
                "SEND_OUTCOME_UNKNOWN",
                "Delivery may have succeeded. Check the chat before drafting again.",
              );
            }
            throw err;
          }
        },
      );
      this.confirms.set(draftId, work);
      try {
        return await work;
      } finally {
        this.confirms.delete(draftId);
      }
    });
  }
  private async sendWithReceipt(
    sock: WASocket,
    jid: string,
    content: AnyMessageContent,
    options: any = {},
  ): Promise<WAMessage | undefined> {
    const attempt = sendContext.getStore();
    if (attempt) await attempt.dispatch();
    return await sock.sendMessage(jid, content, { ...options, ...(attempt ? { messageId: attempt.messageId } : {}) });
  }

  sendMessage(chatId: string, text: string, replyTo?: string, mentionIds?: string[]): Promise<SentMessage> {
    return this.guarded(async () => {
      if (text.length > MAX_TEXT_CHARS) {
        throw new WazapError(
          "TEXT_TOO_LONG",
          `The text is ${text.length} characters; WhatsApp allows ${MAX_TEXT_CHARS}.`,
        );
      }
      const { sock, jid } = await this.prepareSend(chatId);
      const mentions = (mentionIds ?? []).map((id) => this.resolveId(id));
      const quoted = replyTo === undefined ? undefined : await this.loadMessage(replyTo);
      const sent = await this.sendWithReceipt(
        sock,
        jid,
        mentions.length > 0 ? { text, mentions } : { text },
        quoted ? { quoted } : {},
      );
      return this.sentResult(sent, jid, text);
    });
  }

  sendMedia(
    chatId: string,
    source: MediaSource,
    opts: { caption?: string; asDocument: boolean; asVoice: boolean; asGif: boolean },
    prepared = false,
  ): Promise<SentMessage> {
    return this.guarded(async () => {
      const { sock, jid } = await this.prepareSend(chatId);
      const media = await asGifMedia(
        await loadMedia(
          source,
          prepared || caller().local ? undefined : { exportDir: this.config.exportDir, dataDir: this.config.rootDataDir ?? this.config.dataDir },
        ),
        opts.asGif,
      );
      const content = mediaContent(media, opts);
      const sent = await this.sendWithReceipt(sock, jid, content);
      return this.sentResult(sent, jid, opts.caption ?? `[${media.mimetype}]`);
    });
  }

  sendPoll(chatId: string, question: string, options: string[], multiSelect: boolean): Promise<SentMessage> {
    return this.guarded(async () => {
      const { sock, jid } = await this.prepareSend(chatId);
      const sent = await this.sendWithReceipt(sock, jid, {
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
      const sent = await this.sendWithReceipt(sock, jid, {
        location: { degreesLatitude: latitude, degreesLongitude: longitude, name, address },
      });
      return this.sentResult(sent, jid, `[location] ${name ?? `${latitude}, ${longitude}`}`);
    });
  }

  editMessage(messageId: string, text: string): Promise<SentMessage> {
    return this.guarded(async () => {
      if (text.length > MAX_TEXT_CHARS) {
        throw new WazapError(
          "TEXT_TOO_LONG",
          `The text is ${text.length} characters; WhatsApp allows ${MAX_TEXT_CHARS}.`,
        );
      }
      const raw = await this.loadMessage(messageId);
      if (!raw.key.fromMe) {
        throw new WazapError("NOT_OWN_MESSAGE", `Message ${messageId} was not sent by the linked account.`);
      }
      const age = Date.now() - messageTimestampMs(raw);
      if (age > EDIT_WINDOW_MS) {
        throw new WazapError("EDIT_WINDOW_EXPIRED", `Message ${messageId} is older than 15 minutes.`);
      }
      const { sock, jid } = await this.prepareSend(this.canonical(raw.key.remoteJid!));
      await sock.sendMessage(jid, { text, edit: raw.key });
      return { message_id: messageId, chat_id: jid, text, timestamp: isoWithOffset(Date.now()) };
    });
  }

  reactToMessage(messageId: string, emoji: string): Promise<{ message_id: string; emoji: string }> {
    return this.guarded(async () => {
      const raw = await this.loadMessage(messageId);
      const { sock, jid } = await this.prepareSend(this.canonical(raw.key.remoteJid!));
      await sock.sendMessage(jid, { react: { text: emoji, key: raw.key } });
      return { message_id: messageId, emoji };
    });
  }

  forwardMessage(messageId: string, toChatId: string): Promise<SentMessage> {
    return this.guarded(async () => {
      const raw = await this.loadMessage(messageId);
      const { sock, jid } = await this.prepareSend(toChatId);
      const sent = await this.sendWithReceipt(sock, jid, { forward: raw });
      return this.sentResult(sent, jid, messageText(raw));
    });
  }

  deleteMessage(messageId: string, forEveryone: boolean): Promise<{ message_id: string; for_everyone: boolean }> {
    return this.guarded(async () => {
      const raw = await this.loadMessage(messageId);
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
      const { sock, jid } = await this.prepareSend(this.canonical(raw.key.remoteJid!));
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
      this.setStatus("auth_failure");
      this.lastError =
        `${reason} — gave up after ${RECONNECT_MAX_ATTEMPTS} attempts. ` +
        "WhatsApp keeps rejecting this session: re-link the device with `npx wazap-mcp login`.";
      logError("reconnect", this.lastError);
      this.onGiveUp?.();
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
    sock.ev.on("creds.update", () => {
      void this.saveCreds?.().catch(err => {
        this.archive.error = `Credential persistence failed: ${describe(err)}`;
        this.lastError = this.archive.error;
        this.setStatus("session_corrupt");
        this.teardownSocket();
      });
    });

    sock.ev.on("connection.update", (update) => {
      if (generation !== this.generation) return;
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        this.reconnectAttempts = 0;
        this.setStatus("connected");
        this.lastError = null;
        this.adoptSocketAccount();
        if (this.archive.error) {
          this.lastError = this.archive.error;
          this.setStatus("session_corrupt");
          this.teardownSocket();
          return;
        }
        this.armSyncDeadline();
        log("connected to WhatsApp");
        void this.healContacts(sock, generation);
      } else if (connection === "close") {
        const code = statusCodeOf(lastDisconnect?.error);
        if (code === DisconnectReason.loggedOut) {
          this.setStatus("logged_out");
          this.lastError = "The account was unlinked from the phone.";
          logError("auth", this.lastError);
          this.teardownSocket();
        } else if (!this.stopped) {
          this.setStatus("disconnected");
          this.lastError = lastDisconnect?.error?.message ?? "connection closed";
          this.scheduleReconnect(this.lastError);
        }
      }
    });

    sock.ev.on("messaging-history.set", ({ chats, contacts, messages, lidPnMappings, isLatest, progress }) => {
      if (this.stopped || generation !== this.generation) return;
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

    sock.ev.on("call", ([call]) => {
      if (generation !== this.generation || !call) return;
      // WhatsApp addresses a call node by LID as often as by number, and ownJid
      // is only ever the number, so an outgoing call reads as incoming unless
      // the two are brought into the same form first.
      const from = this.canonical(call.from);
      const entry = this.calls.observe({ ...call, from }, this.ownJid(), Date.now());
      if (entry) this.storeCall(entry);
      this.armCallSweep();
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
        if (isNoiseJid(jid)) continue;
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
      this.markStoreDirty();
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (this.stopped || generation !== this.generation) return;
      const stored = this.ingestMessages(messages);
      if (type === "notify") {
        for (const raw of messages) {
          if (raw.key.fromMe) continue;
          this.lastInboundAt = Math.max(this.lastInboundAt ?? 0, messageTimestampMs(raw));
        }
        this.queueTranscripts(stored);
        this.noteArrivals(stored);
      }
      void this.appendHistory(stored);
      this.markStoreDirty();
    });

    sock.ev.on("messages.update", (updates) => {
      for (const { key, update } of updates) {
        const jid = key.remoteJid ? this.canonical(key.remoteJid) : undefined;
        if (!jid) continue;
        const sid = messageIdFor(key, jid);
        if (this.stopped) continue;
        if (update.message === null) {
          this.queueArchive(async () => {
            await this.archive.call("erase", { sid, jid });
            await this.purgeMedia(sid);
          });
          this.store.dropMessage(sid);
          continue;
        }
        const edited = update.message?.editedMessage?.message;
        if (edited)
          this.queueArchive(async () => {
            const old = await this.archive.call("get", { sid });
            const raw = old?.raw ? decodeMessage(old.raw) : null;
            if (raw) {
              raw.message = edited;
              await this.archive.call("edit", { sid, row: { ...this.archiveRow(raw), edited: 1 } });
            }
          });
        const raw = this.store.messages.get(sid);
        if (!raw) continue;
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
          : this.canonical(reaction.key?.participant || reaction.key?.remoteJid || "");
        if (!author) continue;
        if (this.store.messages.has(target)) this.store.react(target, author, reaction.text ?? "");
        this.queueArchive(() => this.archive.call("reaction", { sid: target, author, emoji: reaction.text ?? "" }));
      }
      this.markStoreDirty();
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
      this.setStatus("not_linked");
      this.account = null;
      this.lastError = null;
      log("no WhatsApp account is linked; run `npx wazap-mcp login`");
      return null;
    }
    return { id: linked.id, name: linked.name, number: linked.number };
  }

  private markCorrupt(err: unknown): void {
    this.setStatus("session_corrupt");
    this.lastError = describe(err);
    logError("auth state", err);
  }

  private adoptSocketAccount(): void {
    const user = this.sockClient?.user;
    if (!user?.id) return;
    const id = this.canonical(user.id);
    if (this.archiveReady && this.account && this.account.id !== id) {
      this.archive.error = "ARCHIVE_ACCOUNT_MISMATCH: use another data directory for this account";
      return;
    }
    try { this.config.validateAccount?.(id); }
    catch (err) { this.archive.error = describe(err); return; }
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
    this.syncDeadline = setTimeout(() => {
      this.syncTimedOut = true;
      this.releaseWaiters();
    }, SYNC_WAIT_MS);
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
    if (this.initialSyncDone || this.syncTimedOut || this.stopped) return Promise.resolve();
    return new Promise<void>((done) => {
      const timer = setTimeout(() => {
        this.syncWaiters = this.syncWaiters.filter((entry) => entry !== waiter);
        this.syncTimedOut = true;
        done();
      }, SYNC_WAIT_MS);
      const waiter = (): void => {
        clearTimeout(timer);
        done();
      };
      this.syncWaiters.push(waiter);
    });
  }

  /**
   * The address book, once, for a session that connected without it.
   *
   * Names reach a companion through the app state sync, and WhatsApp sends each
   * collection's snapshot only to a connection asking from version zero. A
   * socket that saved those versions and dropped the contacts leaves every later
   * connection resyncing from a version with nothing left to send, so the only
   * way back is to forget the versions and ask again.
   */
  private async healContacts(sock: WASocket, generation: number): Promise<void> {
    if (this.contactResyncTried) return;
    this.contactResyncTried = true;
    try {
      await this.waitForSync();
      const named = await this.waitForNames(0, Date.now() + CONTACT_SETTLE_MS);
      if (generation !== this.generation || this.stopped) return;
      const decision = {
        named,
        storedVersions: await this.hasAppStateVersions(sock),
        resyncedAt: this.store.contactsResyncedAt,
        now: Date.now(),
      };
      if (!needsContactResync(decision)) return;
      log("address book missing; requesting a full contact sync");
      await this.resyncContacts(sock);
    } catch (err) {
      logError("contact sync", err);
    }
  }

  /** Names still arriving mean the sync is working; only silence means it is not coming. */
  private async waitForNames(floor: number, deadline: number): Promise<number> {
    for (;;) {
      const named = this.namedContacts();
      if (named > floor || this.stopped || Date.now() >= deadline) return named;
      await sleep(500);
    }
  }

  private async hasAppStateVersions(sock: WASocket): Promise<boolean> {
    const stored = await sock.authState.keys.get("app-state-sync-version", [...ALL_WA_PATCH_NAMES]);
    return Object.values(stored).some((state) => state);
  }

  /**
   * Forget every stored app state version, then resync. The order is the whole
   * point: Baileys asks for a snapshot only when it has no version to resume
   * from, and the snapshot is what carries the contacts. The timestamp is
   * written before the request, so a resync interrupted halfway is not retried
   * on every start.
   */
  private async resyncContacts(sock: WASocket): Promise<void> {
    const forgotten = Object.fromEntries(ALL_WA_PATCH_NAMES.map((name) => [name, null]));
    await sock.authState.keys.set({ "app-state-sync-version": forgotten });
    this.store.contactsResyncedAt = Date.now();
    this.markStoreDirty();
    await sock.resyncAppState(ALL_WA_PATCH_NAMES, true);
  }

  private syncState(): SyncState {
    return this.initialSyncDone ? "done" : this.syncTimedOut ? "partial" : "in_progress";
  }

  private synced<T>(data: T): Synced<T> {
    return { data, sync: this.syncState() };
  }

  /** Every public method funnels through here, so no raw Baileys error escapes. */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    const operation = work();
    this.activeOperations.add(operation);
    try {
      return await operation;
    } catch (error) {
      throw asWazapError(error);
    } finally {
      this.activeOperations.delete(operation);
    }
  }

  private ensureReadable(): void {
    if (this.config.rootDataDir && this.account) return;
    this.ensureConnected();
  }

  captureReadSnapshot(): Promise<ReadSnapshot> {
    return this.guarded(async () => {
      this.ensureReadable();
      await this.archiveBarrier();
      return { through: Date.now(), watermark: Number((await this.archive.call("watermark")).id ?? 0) };
    });
  }

  private ensureConnected(): WASocket {
    switch (this.status) {
      case "not_linked":
        throw new WazapError("NOT_LINKED", "No WhatsApp account is linked.", RELINK_FIX);
      case "linking":
        throw new WazapError(
          "NOT_CONNECTED",
          "Pairing is in progress.",
          "Enter the code on the phone, then call get_status",
        );
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

  /** First statement of every write, so a broken link is reported before the bucket is spent. */
  private beginWrite(): WASocket {
    requireWrite();
    if (this.config.readOnly) {
      throw new WazapError("READ_ONLY", "wazap runs read-only, so this write is refused.");
    }
    const sock = this.ensureConnected();
    this.writes.take();
    return sock;
  }

  private outgoingOf(jid: string): OutgoingTarget {
    const name = this.displayName(jid);
    if (isGroupId(jid)) return { chat_id: jid, name };
    const number = this.contactSummary(jid).number;
    return number ? { chat_id: jid, name, number } : { chat_id: jid, name };
  }

  private dispatchDraft(draft: Draft): Promise<SentMessage> {
    const chatId = draft.to.chat_id;
    const payload = draft.payload;
    switch (payload.kind) {
      case "text":
        return this.sendMessage(chatId, payload.text, payload.replyTo, payload.mentionIds);
      case "media":
        return this.sendMedia(
          chatId,
          payload.source,
          {
            caption: payload.caption,
            asDocument: payload.asDocument,
            asVoice: payload.asVoice,
            asGif: payload.asGif,
          },
          payload.prepared,
        );
      case "poll":
        return this.sendPoll(chatId, payload.question, payload.options, payload.multiSelect);
      case "location":
        return this.sendLocation(chatId, payload.latitude, payload.longitude, payload.name, payload.address);
      case "forward":
        if (payload.snapshotRaw)
          return this.guarded(async () => {
            const { sock, jid } = await this.prepareSend(chatId);
            const raw = decodeMessage(payload.snapshotRaw!);
            if (!raw) throw new WazapError("MEDIA_UNAVAILABLE", "Draft snapshot is unreadable.");
            return this.sentResult(await this.sendWithReceipt(sock, jid, { forward: raw }), jid, payload.text ?? "");
          });
        return this.forwardMessage(payload.messageId, chatId);
      default: {
        const _exhaustive: never = payload;
        return _exhaustive;
      }
    }
  }

  /** The single gate every send path passes: writability, addressability, announce-only. */
  private async prepareSend(chatId: string): Promise<{ sock: WASocket; jid: string }> {
    const sock = this.beginWrite();
    const jid = await this.assertOutgoing(chatId, sock);
    return { sock, jid };
  }

  /**
   * Same addressability checks as a send, without opening a write. A draft that
   * fails here would fail at confirm_send too.
   */
  private async assertOutgoing(chatId: string, sock: WASocket): Promise<string> {
    const jid = this.resolveId(chatId);

    if (isGroupId(jid)) {
      const meta = await this.groupMeta(jid);
      const mine = this.myParticipation(meta);
      if (meta.announce && !(mine && isAdmin(mine))) {
        throw new WazapError("GROUP_ANNOUNCEMENT_ONLY", `Only admins may post in "${meta.subject}".`);
      }
      return jid;
    }

    if (!this.store.chats.has(jid) && !this.store.contacts.has(jid)) {
      const found = await sock.onWhatsApp(jid).catch(() => undefined);
      if (!found?.some((entry) => entry.exists)) {
        throw new WazapError("NOT_ON_WHATSAPP", `${jid} has no WhatsApp account.`);
      }
    }
    return jid;
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
    this.markStoreDirty();
  }

  /**
   * Reading a group for the first time costs one metadata fetch, after which its
   * senders resolve from cache. A group we cannot read — left, deleted — is not
   * worth failing the read over, and asking again on every read would cost a
   * round trip per message page forever.
   */
  private async learnParticipants(jid: string): Promise<void> {
    if (!isGroupId(jid) || this.groupCache.has(jid) || this.unreadableGroups.has(jid)) return;
    await this.groupMeta(jid).catch(() => this.unreadableGroups.add(jid));
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

  /**
   * WhatsApp usually keys a contact by its phone jid and names the LID on the
   * side, leaving `phoneNumber` empty, so the pairing has to be read off `id`.
   * A hydrated store is full of these, which is why loading one relearns them.
   */
  private relearnLid(contact: BaileysContact): void {
    if (!contact.lid) return;
    if (contact.phoneNumber) this.learnLid(contact.lid, contact.phoneNumber);
    else if (contact.id?.endsWith("@s.whatsapp.net")) this.learnLid(contact.lid, contact.id);
  }

  /** A pairing WhatsApp stated in a field meant for it, so ids may follow it. */
  private learnLid(lid: string, pn: string): void {
    if (!lid || !pn) return;
    const key = lidKey(lid);
    const phone = jidNormalizedUser(pn);
    this.lidToPn.set(key, phone);
    this.notes.remap(key, phone);
    if (this.archiveReady)
      this.queueArchive(async () => {
        for (const sid of await this.archive.call("alias", { alias: key, jid: phone })) await this.purgeMedia(sid);
      });
    if (this.store.lids.get(key) !== phone) {
      this.store.lids.set(key, phone);
      this.markStoreDirty();
    }
    this.learnLidPhone(lid, pn);
    this.foldAlias(key);
  }

  /**
   * A chat that was filed under a lid before its number was known moves in
   * with the phone chat: its messages join that ring, its row merges into
   * that row, and the lid key goes away. Without this a snapshot written
   * while the pairing was unknown keeps showing the person twice.
   */
  private foldAlias(lid: string): void {
    const jid = this.canonical(lid);
    if (jid === lid) return;
    const ring = this.store.byChat.get(lid);
    if (ring) {
      for (const sid of ring) {
        const raw = this.store.messages.get(sid);
        if (raw) this.store.putMessage(sid, jid, raw);
      }
      this.store.byChat.delete(lid);
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
      // What the phone entry says wins; the lid entry only fills gaps.
      const existing = this.store.contacts.get(jid);
      this.store.contacts.set(jid, { ...definedOnly(contact), ...definedOnly(existing ?? {}), id: jid });
      this.store.contacts.delete(lid);
    }
    if (ring || alias || contact) this.markStoreDirty();
  }

  /**
   * The naming half of a pairing: who a lid is, for display. `learnLid` calls
   * it and also makes the number canonical, folding any chat or contact filed
   * under the lid into the phone one, history included, so nothing splits.
   */
  private learnLidPhone(lid: string, pn: string): void {
    if (!lid || !pn) return;
    const key = lidKey(lid);
    const phone = jidNormalizedUser(pn);
    this.lidPhones.set(key, phone);
    this.phoneLids.set(phone, key);
    const pushed = this.store.pushNames.get(key) ?? this.store.pushNames.get(phone);
    if (pushed) {
      this.store.pushNames.set(key, pushed);
      this.store.pushNames.set(phone, pushed);
    }
  }

  /**
   * Ask Baileys for the numbers behind the LIDs we are about to name. It answers
   * from the table the account has already synced, so this is a lookup and not a
   * fetch, and it covers LIDs no chat, contact or group ever paired.
   */
  private async learnLidPhones(jids: Iterable<string>): Promise<void> {
    const missing = [...new Set(jids)].filter((jid) => jid.endsWith("@lid") && !this.lidPhones.has(jid));
    if (missing.length === 0) return;
    const mappings = await this.sockClient?.signalRepository.lidMapping.getPNsForLIDs(missing).catch(() => null);
    // A pairing from WhatsApp's own table is as good as one from a contact:
    // the chat moves in with the phone chat, history included.
    for (const { lid, pn } of mappings ?? []) this.learnLid(lid, pn);
  }

  /**
   * The one place a jid becomes a name, so a sender, a chat header, a digest
   * title and a participant list can never disagree. The last rung is never a
   * raw LID: a LID is fifteen digits that read as a phone number and are not
   * one, so an unresolved one says it is unknown instead.
   *
   * `hint` is the pushName on the message being rendered, for a sender whose
   * name has not been ingested yet.
   */
  private displayName(jid: string, hint?: string): string {
    if (!jid) return "unknown";
    if (this.isMe(jid)) return this.account?.name || "You";
    if (isGroupId(jid)) {
      return this.store.chats.get(jid)?.name || this.groupCache.get(jid)?.subject || jid;
    }

    const alias = jid.endsWith("@lid") ? this.lidPhones.get(jid) : this.phoneLids.get(jid);
    for (const known of alias ? [jid, alias] : [jid]) {
      const contact = this.store.contacts.get(known);
      const name =
        realName(contact?.name) ||
        realName(contact?.verifiedName) ||
        realName(contact?.notify) ||
        realName(this.store.pushNames.get(known)) ||
        realName(this.store.chats.get(known)?.name);
      if (name) return name;
    }
    const hinted = realName(hint);
    if (hinted) return hinted;

    const phoneJid = jid.endsWith("@lid") ? alias : jid;
    const digits = (phoneJid ?? jid).split("@")[0] ?? "";
    if ((phoneJid ?? jid).endsWith("@s.whatsapp.net")) return digits;
    return jid.endsWith("@lid") ? `unknown (lid …${digits.slice(-4)})` : jid;
  }

  /** The bytes behind a message's media. Saving them and transcribing them share it. */
  private async mediaBuffer(sock: WASocket, messageId: string, raw: WAMessage): Promise<Buffer> {
    try {
      return await downloadMediaMessage(
        raw,
        "buffer",
        {},
        {
          logger: silentLogger,
          reuploadRequest: sock.updateMediaMessage,
        },
      );
    } catch (err) {
      throw new WazapError(
        "MEDIA_UNAVAILABLE",
        `Could not download the media of ${messageId}: ${describe(err)}`,
        "Ask the sender to resend it",
      );
    }
  }

  /** The parsed environment, or the reason it could not be parsed, as a refusal. */
  private transcribeSettings(): TranscribeSettings {
    if (this.transcribe instanceof WazapError) {
      throw new WazapError("TRANSCRIBE_UNAVAILABLE", this.transcribe.message, this.transcribe.fix);
    }
    return this.transcribe;
  }

  /**
   * Only what genuinely arrived, which is why this hangs off the notify branch
   * rather than off ingestMessages: a history sync replays a backlog, and
   * transcribing all of it is a bill nobody asked for. Incoming voice notes
   * only, and only ones whose length WhatsApp stated and kept short, since an
   * audio file is something the sender chose to attach and a recording of
   * unknown length is unbounded. Anything skipped here is still one
   * transcribe_audio call away. A service on its way out starts nothing.
   */
  private queueTranscripts(arrived: readonly WAMessage[]): void {
    if (this.stopped || this.transcribeQueue === null) return;
    for (const raw of arrived) {
      if (raw.key.fromMe || messageType(raw) !== "voice") continue;
      const seconds = voiceSeconds(raw);
      if (seconds === undefined || seconds > AUTO_TRANSCRIBE_MAX_SECONDS) continue;
      const sid = messageIdFor(raw.key, this.canonical(raw.key.remoteJid ?? ""));
      if (this.store.transcripts.has(sid)) continue;
      this.transcribeQueue.enqueue(sid);
    }
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
      noteFor: (jid) => this.notes.noteFor(jid),
      ownId: this.ownJid(),
      chatId: chatJid,
      edited: this.store.edited.has(sid),
      reactions: this.store.reactionsFor(sid),
      transcript: this.store.transcripts.get(sid),
    });
  }

  private viewsFor(sids: string[], chatJid: string): MessageView[] {
    return sids.filter((sid) => this.store.messages.has(sid)).map((sid) => this.viewOf(sid, chatJid));
  }

  /** Absent and empty both mean every type: narrowing is opt-in, never a default. */
  private ofTypes(sids: string[], types?: MessageType[]): string[] {
    if (types === undefined || types.length === 0) return sids;
    return sids.filter((sid) => {
      const raw = this.store.messages.get(sid);
      return raw !== undefined && types.includes(messageType(raw));
    });
  }

  /**
   * The anchor is found in the unfiltered ring, so paging never depends on the
   * filter, and `limit` then counts messages the caller asked for rather than
   * messages we are about to throw away.
   */
  private olderThan(chatJid: string, before: string, limit: number, types?: MessageType[]): string[] {
    const ring = this.store.byChat.get(chatJid) ?? [];
    const at = ring.indexOf(before);
    if (at <= 0) return [];
    return this.ofTypes(ring.slice(0, at), types).slice(-limit);
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
      if (!this.store.chats.has(jid) && !isNoiseJid(jid)) chats.push({ id: jid });
    }
    return chats;
  }

  /**
   * WhatsApp files the same person under a `@lid` chat and a phone chat, and
   * `chatSummary` canonicalises both to the phone jid, so without this a list
   * shows one contact twice. The alias with the newest activity keeps its
   * flags; the unread count is the larger of the two.
   */
  private mergeAliases(chats: BaileysChat[]): BaileysChat[] {
    const byCanonical = new Map<string, BaileysChat>();
    for (const chat of chats) {
      const key = this.canonical(chat.id ?? "");
      const seen = byCanonical.get(key);
      if (!seen) {
        byCanonical.set(key, chat);
        continue;
      }
      const [newer, older] = this.chatActivity(chat) > this.chatActivity(seen) ? [chat, seen] : [seen, chat];
      byCanonical.set(key, { ...newer, unreadCount: Math.max(newer.unreadCount ?? 0, older.unreadCount ?? 0) });
    }
    return [...byCanonical.values()];
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
      ...(this.notes.noteFor(jid) ? { note: this.notes.noteFor(jid) } : {}),
      archived: Boolean(chat.archived),
      pinned: Boolean(chat.pinned),
      muted_until: muteEnd > Date.now() ? isoWithOffset(muteEnd) : null,
    };
    // A group we left is delivered as read-only; individual chats never are.
    if (isGroupId(jid) && chat.readOnly) summary.left = true;
    return summary;
  }

  private contactSummary(jid: string, contact?: BaileysContact): ContactSummary {
    const phoneJid = jid.endsWith("@lid") ? (this.lidPhones.get(jid) ?? jid) : jid;
    const number = phoneJid.endsWith("@s.whatsapp.net") ? (phoneJid.split("@")[0] ?? null) : null;
    return {
      contact_id: jid,
      name: this.displayName(jid),
      ...(this.notes.noteFor(jid) ? { note: this.notes.noteFor(jid) } : {}),
      number,
      is_my_contact: realName(contact?.name) !== "",
      is_business: Boolean(contact?.verifiedName),
    };
  }

  private sentResult(sent: WAMessage | undefined, jid: string, text: string): SentMessage {
    if (!sent) {
      throw new WazapError(
        "SEND_OUTCOME_UNKNOWN",
        "WhatsApp returned no delivery result. Do not resend automatically.",
      );
    }
    const sid = messageIdFor(sent.key, jid);
    this.store.putMessage(sid, jid, sent);
    void this.appendHistory([sent]);
    this.markStoreDirty();
    return { message_id: sid, chat_id: jid, text, timestamp: isoWithOffset(messageTimestampMs(sent)) };
  }

  private ingestChat(chat: BaileysChat): void {
    if (!chat.id) return;
    if (chat.lidJid && chat.pnJid) this.learnLid(chat.lidJid, chat.pnJid);
    const jid = this.canonical(chat.id);
    if (isNoiseJid(jid)) return;
    const previous = this.store.chats.get(jid);
    this.store.chats.set(jid, { ...(previous ?? {}), ...definedOnly(chat), id: jid });
  }

  private ingestContact(contact: BaileysContact): void {
    if (!contact.id) return;
    this.relearnLid(contact);
    const jid = this.canonical(contact.id);
    const previous = this.store.contacts.get(jid);
    // Baileys sends a contact with the fields it does not know set to
    // undefined; spread as they are, they would erase a name learned earlier.
    this.store.contacts.set(jid, { ...(previous ?? {}), ...definedOnly(contact), id: jid });
  }

  private ingestMessages(messages: WAMessage[]): WAMessage[] {
    const stored: WAMessage[] = [];
    for (const raw of messages) {
      if (!raw.key?.remoteJid || (!raw.message && !isStubEvent(raw))) continue;
      if (isStatusJid(raw.key.remoteJid)) {
        this.ingestStory(raw);
        continue;
      }
      const jid = this.canonical(raw.key.remoteJid);
      if (isNoiseJid(jid) || isControlMessage(raw)) continue;
      this.learnPushName(raw, jid);
      if (this.applyReaction(raw, jid)) continue;
      const sid = messageIdFor(raw.key, jid);
      if (!this.keepOverEarlierCall(raw, jid, sid)) continue;
      this.store.putMessage(sid, jid, raw);
      if (raw.key.fromMe)
        this.queueArchive(async () => {
          await this.loadOutbox();
          for (const entry of this.outbox.values())
            if (entry.messageId === raw.key.id && ["sending", "unknown"].includes(entry.state)) {
              entry.state = "sent";
              entry.result = {
                message_id: sid,
                chat_id: jid,
                text: messageText(raw),
                timestamp: isoWithOffset(messageTimestampMs(raw)),
              };
              await this.saveDraft(entry);
              await this.cleanDraft(entry.draft);
            }
        });
      stored.push(raw);
    }
    return stored;
  }

  /**
   * A story is a message on the status pseudo-chat with its author as the
   * participant. It is kept apart from the chats: no ring, no history file,
   * no wait woken, and it goes after a day, as on the phone.
   */
  private ingestStory(raw: WAMessage): void {
    if (raw.key.fromMe || isControlMessage(raw) || messageType(raw) === "system") return;
    this.learnPushName(raw, STATUS_JID);
    this.store.putStory(messageIdFor(raw.key, STATUS_JID), STATUS_JID, raw);
    this.store.pruneStories(Date.now() - STORY_TTL_MS);
  }

  /**
   * A reaction is not a message in the chat, it is a mark on one: it goes onto
   * the target and is never filed on its own, whether it arrives live, in a
   * history sync or back from disk. True when `raw` was a reaction.
   */
  private applyReaction(raw: WAMessage, chatJid: string): boolean {
    const reaction = reactionOf(raw);
    if (!reaction) return false;
    const author = raw.key.fromMe ? this.ownJid() : this.canonical(raw.key.participant || raw.key.remoteJid || chatJid);
    const target = messageIdFor(reaction.targetKey, chatJid);
    if (author) {
      this.store.react(target, author, reaction.text);
      this.queueArchive(() => this.archive.call("reaction", { sid: target, author, emoji: reaction.text }));
    }
    return true;
  }

  /** Reactions an older snapshot filed as messages of their own move onto their targets. */
  private foldReactions(): void {
    for (const [sid, raw] of [...this.store.messages]) {
      const jid = this.store.chatOf.get(sid);
      if (jid !== undefined && this.applyReaction(raw, jid)) this.store.dropMessage(sid);
    }
  }

  /**
   * One call can reach the store three ways: wazap's own tracker, the stub
   * baileys synthesises on a timeout, and WhatsApp's later call-log message.
   * Each carries a different id, so only nearness in time pairs them up, and
   * whichever says more about the call is the one worth keeping. The history
   * reload runs it too: the JSONL still holds the line the loser wrote before
   * it was dropped, and a restart would otherwise bring the pair back.
   */
  private keepOverEarlierCall(raw: WAMessage, chatJid: string, sid: string): boolean {
    const info = callInfo(raw);
    if (!info) return true;
    const at = messageTimestampMs(raw);
    for (const known of this.store.recent(chatJid, CALL_DEDUPE_SCAN)) {
      if (known.sid === sid) continue;
      const other = callInfo(known.raw);
      if (!other) continue;
      // A redial inside the window is two calls, and wazap knows it built both.
      if (isTrackedCall(raw) && isTrackedCall(known.raw)) continue;
      if (Math.abs(messageTimestampMs(known.raw) - at) > CALL_DEDUPE_WINDOW_MS) continue;
      if (callDetail(raw, info) <= callDetail(known.raw, other)) return false;
      this.store.dropMessage(known.sid);
      this.queueArchive(() => this.archive.call("remove", { sid: known.sid }));
      return true;
    }
    return true;
  }

  /** A live call goes in the way any message does, so everything downstream carries it. */
  private storeCall(entry: CallEntry): void {
    const stored = this.ingestMessages([callMessage(entry)]);
    if (stored.length === 0) return;
    void this.appendHistory(stored);
    this.markStoreDirty();
  }

  /**
   * Only while a call is in flight: a call whose terminal event never arrives
   * would otherwise sit pending forever, and a timer with nothing to do would
   * otherwise keep ticking for the life of the process.
   */
  private armCallSweep(): void {
    if (this.callSweepTimer || this.calls.pending === 0) return;
    this.callSweepTimer = setInterval(() => {
      for (const entry of this.calls.expire(Date.now())) this.storeCall(entry);
      if (this.calls.pending === 0) this.stopCallSweep();
    }, CALL_SWEEP_MS);
    this.callSweepTimer.unref();
  }

  private stopCallSweep(): void {
    if (this.callSweepTimer) clearInterval(this.callSweepTimer);
    this.callSweepTimer = null;
  }

  private learnPushName(raw: WAMessage, chatJid: string): void {
    const name = raw.pushName?.trim();
    if (!name || raw.key.fromMe) return;
    const sender = this.canonical(raw.key.participant || raw.participant || chatJid);
    if (sender && !this.isMe(sender)) this.store.pushNames.set(sender, name);
  }

  /**
   * One fetch teaches every later message in that group who its participants
   * are, which matters most for a group whose members are strangers to the
   * address book.
   */
  private learnGroup(meta: GroupMetadata): void {
    for (const p of meta.participants) {
      const lid = p.lid ?? (p.id.endsWith("@lid") ? p.id : undefined);
      const phone = p.phoneNumber ?? (p.id.endsWith("@s.whatsapp.net") ? p.id : undefined);
      if (lid && phone) this.learnLid(lid, phone);
      const name = p.name ?? p.notify ?? p.username;
      if (name) this.ingestContact({ id: phone ?? p.id, ...(lid ? { lid } : {}), notify: name });
    }
  }

  private async loadPersisted(): Promise<void> {
    if (this.persistedLoaded) return;
    await this.ensureArchive();
    await this.loadOutbox();
    await this.expireArchive();
    this.persistedLoaded = true;
    if (this.config.persistHistory) await this.loadStoreSnapshot();
    for (const { alias, jid } of await this.archive.call("aliases")) this.learnLid(alias, jid);
    // Cache only a bounded tail; all historical reads use SQLite.
    const rows = (await this.archive.call("query", { limit: 1000 })) as ArchiveRow[];
    for (const row of rows.reverse()) this.cacheArchiveRow(row);
  }

  private async loadStoreSnapshot(): Promise<void> {
    try {
      const text = await readFile(join(this.config.dataDir, "state.json"), "utf8").catch(() =>
        readFile(this.paths.storeFile, "utf8"),
      );
      const snapshot = JSON.parse(text) as StoreSnapshot;
      // The archive is authoritative. Only stories still use the metadata snapshot.
      snapshot.messages = Object.fromEntries(
        Object.entries(snapshot.messages ?? {}).filter(([sid]) => snapshot.stories?.includes(sid)),
      );
      snapshot.byChat = {};
      snapshot.transcripts = {};
      snapshot.reactions = {};
      this.store.hydrate(snapshot);
      this.store.pruneStories(Date.now() - 24 * 3_600_000);
      for (const contact of this.store.contacts.values()) this.relearnLid(contact);
      for (const [lid, pn] of this.store.lids) this.learnLid(lid, pn);
      for (const key of [...this.store.byChat.keys(), ...this.store.chats.keys(), ...this.store.contacts.keys()]) {
        if (key.endsWith("@lid")) this.foldAlias(key);
      }
      this.foldReactions();
      // Archived messages, not cache residency, determine media lifetime.
      log(`store loaded: ${this.store.chats.size} chats, ${this.store.messages.size} messages`);
    } catch (err) {
      if (!isMissing(err)) {
        this.archive.error = describe(err);
        throw new WazapError("ARCHIVE_UNAVAILABLE", `Cannot load state.json: ${describe(err)}`);
      }
    }
  }

  private markStoreDirty(): void {
    // A stopped service has already flushed, so arming another save would only
    // hold the process open for the length of the debounce.
    if (!this.config.persistHistory || this.stopped) return;
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
      const snapshot = this.store.serialize();
      snapshot.messages = Object.fromEntries(
        Object.entries(snapshot.messages).filter(([sid]) => snapshot.stories?.includes(sid)),
      );
      snapshot.byChat = {};
      snapshot.transcripts = {};
      snapshot.reactions = {};
      for (const [jid, b64] of Object.entries(snapshot.chats)) {
        const chat = proto.Conversation.decode(Buffer.from(b64, "base64"));
        chat.messages = [];
        snapshot.chats[jid] = Buffer.from(proto.Conversation.encode(chat).finish()).toString("base64");
      }
      atomicWrite(join(this.config.dataDir, "state.json"), JSON.stringify(snapshot));
    } catch (err) {
      this.storeDirty = true;
      this.archive.error = describe(err);
      logError("store save", err);
    }
  }

  private async refreshArchiveTails(): Promise<void> {
    await this.archiveBarrier();
    for (const chat of await this.archive.call("chats")) {
      const cached: BaileysChat = this.store.chats.get(chat.jid) ?? { id: chat.jid };
      cached.conversationTimestamp = Math.max(Number(cached.conversationTimestamp ?? 0), Math.floor(chat.ts / 1000));
      this.store.chats.set(chat.jid, cached);
    }
  }
  private async loadChatTail(jid: string): Promise<void> {
    for (const sid of [...(this.store.byChat.get(jid) ?? [])]) this.store.dropMessage(sid);
    const rows = (await this.archive.call("query", { jid, limit: UNANSWERED_SCAN })) as ArchiveRow[];
    for (const row of rows.reverse()) {
      if (row.deleted) this.store.dropMessage(row.sid);
      else this.cacheArchiveRow(row);
    }
  }
  private archiveRow(raw: WAMessage): ArchiveRow {
    const jid = this.canonical(raw.key.remoteJid ?? "");
    const sid = messageIdFor(raw.key, jid);
    const transcript = this.store.transcripts.get(sid);
    const view = buildMessageView(raw, {
      canonical: (id) => this.canonical(id),
      nameFor: (id) => this.displayName(id),
      ownId: this.ownJid(),
      chatId: jid,
      edited: this.store.edited.has(sid),
      transcript,
      reactions: this.store.reactionsFor(sid),
    });
    const context = contextInfo(raw);
    const expiration = Number(context?.expiration ?? 0);
    const ephemeralStart = Number(raw.ephemeralStartTimestamp ?? 0) * 1000;
    return {
      sid,
      jid,
      ts: messageTimestampMs(raw),
      sender: view.sender.id,
      type: view.type,
      text: view.text,
      raw: view.type === "view_once" ? "" : (encode(() => proto.WebMessageInfo.encode(raw).finish()) ?? ""),
      extra: { view, transcript, reactions: this.store.reactionsFor(sid) },
      edited: view.edited ? 1 : 0,
      quoted: view.quoted?.message_id ?? null,
      expires: expiration > 0 ? (ephemeralStart || messageTimestampMs(raw)) + expiration * 1000 : null,
    };
  }

  private ensureArchive(): Promise<void> {
    if (this.archiveReady) return this.archiveReady;
    this.archiveReady = (async () => {
      const owner = this.account?.id;
      if (!owner) throw new WazapError("ARCHIVE_UNAVAILABLE", "Archive import deferred until its owner is known.");
      await this.archive.open(
        this.config.persistHistory ? join(this.config.dataDir, "archive.sqlite") : ":memory:",
        owner,
      );
      if (!this.archive.migrated) {
        const rows: ArchiveRow[] = [];
        if (this.config.persistHistory) {
          const legacy = await readFile(this.paths.storeFile, "utf8").catch((err) => {
            if (!isMissing(err)) throw err;
            return null;
          });
          let snapshot: StoreSnapshot | null = null;
          if (legacy) {
            try {
              snapshot = JSON.parse(legacy) as StoreSnapshot;
              if (snapshot?.v !== 1) throw Error("Unsupported store version");
            } catch (error) {
              throw new WazapError("ARCHIVE_UNAVAILABLE", `Cannot import store.json: ${describe(error)}`);
            }
            this.store.hydrate(snapshot);
            for (const contact of this.store.contacts.values()) this.relearnLid(contact);
            for (const [lid, pn] of this.store.lids) this.lidToPn.set(lid, pn);
          }
          const files = await readdir(this.paths.historyDir).catch((err) => {
            if (!isMissing(err)) throw err;
            return [] as string[];
          });
          for (const file of files.filter((f) => f.endsWith(".jsonl"))) {
            const text = await readFile(join(this.paths.historyDir, file), "utf8");
            for (const [index, line] of text.split("\n").entries()) {
              if (!line.trim()) continue;
              try {
                const record = JSON.parse(line) as HistoryRecord;
                const raw = decodeMessage(record.raw);
                if (!raw?.key?.remoteJid || !raw.key.id || !record.sid) throw Error("Invalid history record");
                const row = this.archiveRow(raw);
                row.sid = record.sid;
                if (record.tr) {
                  row.extra.transcript = record.tr;
                  row.text = viewText(raw, record.tr);
                }
                rows.push(row);
              } catch (e) {
                throw new WazapError("ARCHIVE_UNAVAILABLE", `Cannot import ${file}:${index + 1}: ${describe(e)}`);
              }
            }
          }
          if (snapshot) {
            this.store.hydrate(snapshot);
            for (const [sid, b64] of Object.entries(snapshot.messages ?? {})) {
              const raw = decodeMessage(b64);
              if (!raw?.key?.id || !raw.key.remoteJid) throw Error(`Cannot import store.json: invalid message ${sid}`);
              const row = this.archiveRow(raw);
              row.sid = sid;
              if (this.applyReaction(raw, row.jid)) continue;
              rows.push(row);
            }
          }
        }
        await this.archive.call("migrate", {
          rows: rows.filter((row) => row.type !== "reaction" && !isNoiseJid(row.jid)),
        });
        this.archive.migrated = true;
      }
      for (const [alias, jid] of this.lidToPn)
        for (const sid of await this.archive.call("alias", { alias, jid })) await this.purgeMedia(sid);
      this.archiveExpiry = setInterval(
        () =>
          this.queueArchive(async () => {
            await this.expireArchive();
            await this.loadOutbox();
            await this.expireDrafts();
          }),
        60_000,
      );
      this.archiveExpiry.unref();
    })().catch((err) => {
      this.archive.error = describe(err);
      throw err;
    });
    return this.archiveReady;
  }
  private queueArchive(work: () => Promise<any>): void {
    this.archiveTail = this.archiveTail
      .then(async () => {
        await this.ensureArchive();
        await work();
      })
      .catch((err) => {
        this.archive.error = describe(err);
        logError("archive", err);
      });
  }
  private async archiveBarrier(): Promise<void> {
    await this.ensureArchive();
    await this.archiveTail;
    if (this.archive.error) throw new WazapError("ARCHIVE_UNAVAILABLE", this.archive.error);
    await this.expireArchive();
  }
  private async expireArchive(): Promise<void> {
    for (const sid of await this.archive.call("expiredMedia", { now: Date.now() })) await this.purgeMedia(sid);
    for (const sid of [...this.store.stories]) {
      const raw = this.store.messages.get(sid);
      if (!raw || messageTimestampMs(raw) < Date.now() - 24 * 3_600_000) await this.purgeMedia(sid);
    }
    this.store.pruneStories(Date.now() - 24 * 3_600_000);
    for (const sid of await this.archive.call("expire", { now: Date.now() })) {
      this.store.dropMessage(sid);
      await this.purgeMedia(sid);
    }
  }
  private async purgeMedia(sid: string): Promise<void> {
    const target = await this.archive.call("get", { sid });
    const id = splitMessageId(sid).key;
    for (const [cachedId, raw] of this.store.messages) {
      const jid = this.canonical(this.store.chatOf.get(cachedId) ?? "");
      if (jid !== (target?.jid ?? this.canonical(splitMessageId(sid).jid))) continue;
      if (raw.key.id === id) {
        this.store.dropMessage(cachedId);
        await rm(this.previewPath(cachedId), { force: true });
        continue;
      }
      const scrub = (value: any): void => {
        if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return;
        if (value.stanzaId === id) delete value.quotedMessage;
        for (const child of Object.values(value)) scrub(child);
      };
      scrub(raw.message);
    }
    for (const entry of this.outbox.values())
      if (entry.messageId === id && entry.result) {
        entry.result.text = "[deleted]";
        await this.saveDraft(entry);
      }
    await rm(this.previewPath(sid), { force: true });
    if (target?.sid !== sid && target?.sid) await rm(this.previewPath(target.sid), { force: true });
    for (const path of await this.archive.call("mediaPaths", { sid })) await rm(path, { force: true });
    await this.archive.call("mediaForget", { sid });
    this.markStoreDirty();
  }
  private archiveView(row: ArchiveRow): MessageView {
    const extra = typeof row.extra === "string" ? JSON.parse(row.extra) : (row.extra ?? {});
    const raw = row.raw ? decodeMessage(row.raw) : null;
    const base: MessageView = raw
      ? buildMessageView(raw, {
          canonical: (id) => this.canonical(id),
          nameFor: (id) => this.displayName(id, raw.pushName ?? undefined),
          noteFor: (id) => this.notes.noteFor(id),
          ownId: this.ownJid(),
          chatId: row.jid,
          edited: !!row.edited,
          transcript: extra.transcript,
          reactions: extra.reactions ?? [],
        })
      : (extra.view ?? {
          message_id: row.sid,
          chat_id: row.jid,
          from_me: false,
          sender: { id: row.sender, name: this.displayName(row.sender) },
          type: "deleted",
          text: "[deleted]",
          timestamp: isoWithOffset(row.ts),
          age: formatAge(row.ts),
          has_media: false,
          forwarded: false,
          edited: false,
        });
    base.message_id = row.sid;
    base.chat_id = row.jid;
    if (row.deleted) {
      base.type = "deleted";
      base.text = "[deleted]";
      base.has_media = false;
      delete base.media;
      delete base.transcript;
      delete base.quoted;
    }
    return base;
  }
  private cacheArchiveRow(row: ArchiveRow): void {
    if (!row.raw || row.deleted) return;
    const raw = decodeMessage(row.raw);
    if (!raw) return;
    this.store.putMessage(row.sid, row.jid, raw);
    if (!this.store.messages.has(row.sid)) return;
    const extra = typeof row.extra === "string" ? JSON.parse(row.extra) : (row.extra ?? {});
    if (extra.transcript) this.store.transcripts.set(row.sid, extra.transcript);
    if (row.edited) this.store.edited.add(row.sid);
  }
  private async loadMessage(sid: string): Promise<WAMessage> {
    await this.archiveBarrier();
    const row = await this.archive.call("get", { sid });
    if (row) {
      if (row.deleted || !row.raw)
        throw new WazapError("MEDIA_UNAVAILABLE", "This message was withdrawn, expired or is view-once.");
      this.cacheArchiveRow(row);
      const raw = decodeMessage(row.raw);
      if (raw) return raw;
    }
    return this.messageOrThrow(sid);
  }
  private async coverage(jid?: string): Promise<Record<string, unknown>> {
    const c = await this.archive.call("coverage", { jid });
    return {
      source: this.config.persistHistory ? "local_archive" : "memory",
      oldest_available_at: c.oldest === null ? null : isoWithOffset(c.oldest),
      newest_available_at: c.newest === null ? null : isoWithOffset(c.newest),
      phone_history: "unknown",
      sync: this.syncState(),
    };
  }
  private async appendHistory(messages: WAMessage[]): Promise<void> {
    if (!messages.length) return;
    const rows = messages.map((raw) => this.archiveRow(raw));
    this.queueArchive(() => this.archive.call("batch", { rows }));
    await this.archiveTail;
  }
  private async fetchOlderForChat(
    sock: WASocket,
    anchor: WAMessage,
    jid: string,
    limit: number,
  ): Promise<"received" | "timed_out" | "unavailable"> {
    let complete!: (value: "received" | "timed_out" | "unavailable") => void;
    const result = new Promise<"received" | "timed_out" | "unavailable">((resolve) => {
      complete = resolve;
    });
    const listener = (event: any) => {
      if (event.messages?.some((m: WAMessage) => this.canonical(m.key.remoteJid ?? "") === jid)) complete("received");
    };
    sock.ev.on("messaging-history.set", listener);
    const timer = setTimeout(() => complete("timed_out"), HISTORY_FETCH_WAIT_MS);
    try {
      void sock
        .fetchMessageHistory(limit, anchor.key, Math.floor(messageTimestampMs(anchor) / 1000))
        .catch(() => complete("unavailable"));
      return await result;
    } finally {
      clearTimeout(timer);
      sock.ev.off?.("messaging-history.set", listener);
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

/**
 * A wrong WAZAP_TRANSCRIBE_* value must not take a running server down with it.
 * Everything else still works, so the complaint is logged once and kept, and the
 * tool that needs it reports it instead of transcribing.
 */
function readTranscribeConfig(dataDir: string, env = process.env): TranscribeSettings | WazapError {
  try {
    return readTranscribeSettings(env, dataDir);
  } catch (err) {
    const fault = asWazapError(err);
    logError("transcribe settings", fault);
    return fault;
  }
}

/** Field by field, because `at` is the cache's bookkeeping and not the caller's business. */
function transcribeResult(record: TranscriptRecord, cached: boolean): TranscribeResult {
  return {
    text: record.text,
    ...(record.language === undefined ? {} : { language: record.language }),
    ...(record.duration_seconds === undefined ? {} : { duration_seconds: record.duration_seconds }),
    provider: record.provider,
    cached,
  };
}

/** How much a call message says. A duration is the most it can carry. */
function callDetail(raw: WAMessage, info: CallInfo): number {
  if (info.duration_seconds !== undefined) return 2;
  return isCallPlaceholder(raw) ? 0 : 1;
}

/** The own enumerable fields whose value is not undefined, so a spread cannot erase with "unknown". */
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function lidKey(lid: string): string {
  return `${jidNormalizedUser(lid).split("@")[0]}@lid`;
}

function isAdmin(participant: GroupParticipant): boolean {
  return participant.admin === "admin" || participant.admin === "superadmin";
}

function requireValue(value: string | undefined, action: GroupAction, what: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new WazapError("INVALID_ID", `The "${action}" action needs a value: ${what}.`);
  return trimmed;
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

function safeFilename(jid: string): string {
  return jid.replace(/[/\\:*?"<>|]/g, "_");
}
