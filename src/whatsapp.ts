/**
 * WhatsApp service over Baileys. Baileys emits raw events rather than exposing
 * a queryable store, so this files what they carry in the account database
 * (`accounts/<id>/wazap.sqlite`, see src/db) and answers the tools from it.
 * What stays in memory is bounded by people and chats, never by messages: the
 * lid pairings, group metadata, the last arrivals a wait can replay, drafts.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ALL_WA_PATCH_NAMES,
  DisconnectReason,
  downloadMediaMessage,
  proto,
  type WAMessage,
  type WASocket,
} from "baileys";
import type { ILogger } from "baileys/lib/Utils/logger.js";
import { accountPolicy, type AccountRecord } from "./accounts.js";
import { wordsAsk } from "./asks.js";
import { clearAuth, readLinkedAccount, useAtomicAuthState, type LinkedAccount } from "./auth-state.js";
import {
  GROUP_META_MAX,
  GROUP_META_MS,
  quotesOf,
  scanCatchup,
  taggedJids,
  type CatchupHost,
  type CatchupQuote,
  type CatchupScan,
  type CatchupScanRequest,
  type CatchupTagJids,
  type CatchupWindow,
} from "./catchup-scan.js";
import { BAILEYS_VERSION, WAZAP_VERSION, writesHints, type AccountPaths, type Config } from "./config.js";
import {
  AccountDb,
  chatKindOf,
  secondOfId,
  StorageError,
  type ChatKind,
  type EventRecord,
  type StoredMessage,
} from "./db/index.js";
import { draftContextFor, styleCheckFor, type DraftContext, type StyleCheck } from "./draft-style.js";
import { asWazapError, RELINK_FIX, RESET_FIX, WazapError } from "./errors.js";
import { findInAccount, type AccountFind, type FindContactQuery } from "./find-contact.js";
import { isGroupId, isNoiseJid, normalizePhone, STATUS_JID } from "./ids.js";
import { IMPORT_META } from "./legacy-import/index.js";
import { log, logError } from "./logger.js";
import { describe, mediaFilename } from "./outgoing-media.js";
import { makePreview, videoFrame } from "./previews.js";
import { decodeChat, momentsOf } from "./store.js";
import {
  formatAge,
  isUserMessage,
  isoWithOffset,
  mediaInfo,
  mentionedJids,
  messageIdFor,
  protoNumber,
  quotedSenderJid,
  thumbnailOf,
  viewText,
} from "./messages.js";
import { withoutPrivateQuote, withoutWords } from "./private-contacts.js";
import { PAIRING_TIMEOUT_MS, WA_BROWSER, prettyCode, socketFactory, startPairing } from "./pairing.js";
import { transcribeFile, transcribeReady } from "./transcribe/index.js";
import { DraftStore, frozenReceiptText, type DraftPayload, type DraftView } from "./drafts.js";
import { RateLimiter } from "./ratelimit.js";
import { maskNumber } from "./ui.js";
import { AccountGroups } from "./service/groups.js";
import { AccountIdentity, realName } from "./service/identity.js";
import { AccountIngest, STORY_TTL_MS, type MessageRef } from "./service/ingest.js";
import { AccountRecall } from "./service/recall.js";
import { AccountSends, type SendAttempt } from "./service/send.js";
import { AccountStorage } from "./service/storage.js";
import { MessageViews } from "./service/views.js";
import { AccountVoice } from "./service/voice.js";
import { MessageWaits } from "./service/waits.js";
import { DIR_MODE, FILE_MODE, leftGroup, orNullAfter, pageLimit, PROFILE_LOOKUP_MS, statusCodeOf } from "./service/util.js";
import {
  WebhookSink,
  asConnectionPayload,
  asWebhookPayload,
  webhookConnectionStatus,
  type WebhookConnectionPayload,
  type WebhookConnectionStatus,
  type WebhookPayload,
} from "./webhook.js";
import {
  CONNECTION_LANE,
  WEBHOOK_TRANSCRIPT_WAIT_MS,
  WebhookOutbox,
  chatLane,
  undeliveredFailure,
} from "./webhook-outbox.js";
import type { SearchCoverage } from "./coverage.js";
import type {
  ChatAction,
  ChatActionOptions,
  ChatActionResult,
  ChatFilter,
  ChatRead,
  ChatSummary,
  ConnectionStatus,
  ContactDetails,
  ContactDetailsEdit,
  ContactSyncResult,
  ContactSummary,
  GroupAction,
  GroupActionResult,
  GroupInfo,
  JoinGroupResult,
  MediaResult,
  MediaSource,
  MessageType,
  MessageView,
  PairingInfo,
  PrivateRule,
  ParticipantResult,
  RecallAnswer,
  RecentConversation,
  SentMessage,
  StatusInfo,
  SyncState,
  Synced,
  TranscribeOptions,
  TranscribeResult,
  WhatsAppApi,
  HandledResult,
  Preview,
  SearchAnswer,
  SearchOptions,
  UnansweredChat,
  UnconfirmedSend,
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
/** Unknown sends a read of one chat lists at most. */
const UNCONFIRMED_SENDS_SHOWN = 20;
const INLINE_IMAGE_MAX_BYTES = 1_000_000;
const RETRACT_WINDOW_MS = 2 * 24 * 3_600_000;
const STALE_INBOUND_MS = 24 * 3_600_000;
/** A photo bigger than this is not downloaded for a preview. */
const PREVIEW_SOURCE_MAX_BYTES = 6_000_000;
/** A video bigger than this is not downloaded for a frame. */
const PREVIEW_VIDEO_MAX_BYTES = 25_000_000;
/** How many active groups one catch-up fetches metadata for, to name their senders. */
const RECENT_GROUP_META_MAX = 12;
/** Messages getRecentMessages returns per chat: the newest of its window, as many as main's per-chat ring held. */
const RECENT_PER_CHAT_MAX = 2_000;
/** Local contact filing caps: enough to describe anyone, small enough to stay a note. */
const MAX_CONTACT_TAGS = 30;
const MAX_CONTACT_FIELDS = 30;
/** A detail value is a line, like a note — not a document. */
const MAX_FIELD_VALUE_CHARS = 200;
const MAX_TAG_CHARS = 40;
const MAX_FIELD_KEY_CHARS = 40;
/** How long one call may spend downloading and shrinking photos before it returns with what it has. */
const PREVIEW_BUDGET_MS = 20_000;
/** How far back into a chat an open ask is looked for. */
const UNANSWERED_SCAN = 30;
/** Messages read_messages walks past a type filter before it answers with what it found. */
const TYPE_FILTER_SCAN = 10_000;
/** A download is buffered in memory, so the biggest file it may pull is bounded. */
const MEDIA_DOWNLOAD_MAX_BYTES = 100_000_000;
/** How long a stop waits for a transcription under way to store what it got. */
const STOP_TRANSCRIBE_WAIT_MS = 30_000;
/** How long list_chats waits for a lid chat still folding into its number before it lists what it has. */
const FOLD_SETTLE_MS = 2_000;
/** Chat kinds a person can be waiting in: every one but the status feed. */
const WAITING_KINDS: readonly ChatKind[] = ["direct", "group", "newsletter", "broadcast"];
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

/** How long stop waits for a cancelled pairing socket to close. */
const PAIRING_STOP_MS = 5_000;

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
  private statusSince = Date.now();
  private lastError: string | null = null;
  /**
   * Called once when the reconnect budget runs out on something a restart could
   * fix. The CLI turns it into an exit code, so a supervisor gets its turn.
   */
  onGiveUp: (() => void) | null = null;
  /** Fires when a `link` lands, so the hub can persist the owner on the record. */
  onLinked: ((account: LinkedAccount) => void) | null = null;
  private account: StatusInfo["account"] = null;
  /** The pairing in flight, from the first `link` call until it settles either way. */
  private linking: Promise<PairingInfo> | null = null;
  private pairing: PairingInfo | null = null;
  /**
   * The pairing socket behind a code already handed out. Stopping cancels it and
   * waits for it to close, so no link lands credentials behind a logout or a removal.
   */
  private pairingRun: { cancel: () => void; settled: Promise<void> } | null = null;
  private lastInboundAt: number | null = null;
  /** Contacts with an address-book name; null until counted again after a name changed. */
  private namedContactsCache: number | null = null;
  private initialSyncDone = false;
  private historyReceived = false;
  private syncDeadline: ReturnType<typeof setTimeout> | null = null;
  private syncWaiters: Array<() => void> = [];
  private historyWaiters: Array<() => void> = [];
  private contactResyncTried = false;
  /** find_contact's one ask this boot for an address book that looked empty, shared by every find waiting on it (F2-3). */
  private addressBookAsk: Promise<void> | null = null;
  private readonly blocked = new Set<string>();
  /** Who a jid is: the lid pairings, the account's own ids, the names (src/service/identity.ts). */
  private readonly identity: AccountIdentity;
  /** The account database: open, boot, legacy files, expiry and file cleanup (src/service/storage.ts). */
  private readonly storage: AccountStorage;
  /** What a reader sees of the database (src/service/views.ts). */
  private readonly views: MessageViews;
  /** The account's groups and their metadata cache (src/service/groups.ts). */
  private readonly groups: AccountGroups;
  /** Voice notes as text: get_media's transcription and the queue (src/service/voice.ts). */
  private readonly voice: AccountVoice;
  /** Search by words and meaning, and the index behind it (src/service/recall.ts). */
  private readonly recallIndex: AccountRecall;
  /** wait_for_messages: the last arrivals and the waits parked on them (src/service/waits.ts). */
  private readonly waits: MessageWaits;
  /** Drafts, their one confirm, and every send (src/service/send.ts). */
  private readonly sends: AccountSends;
  /** What WhatsApp hands the account, filed in its database (src/service/ingest.ts). */
  private readonly ingest: AccountIngest;
  /** Lid chats still folding into their number's chat; list_chats lets them land. */
  private readonly folds = new Set<Promise<unknown>>();
  private stopPromise: Promise<void> | null = null;
  private readonly paths: AccountPaths;
  /** The seams the tests replace; production always runs the real providers. */
  private transcriber = transcribeFile;
  private transcribeReadiness = transcribeReady;
  private readonly drafts = new DraftStore();
  private readonly writes: RateLimiter;
  private readonly webhook: WebhookSink;
  /** Posts the events the account database holds; see src/webhook-outbox.ts. */
  private readonly outbox: WebhookOutbox;
  /** The last connection status queued for the consumer, so several internal states collapse into one event. */
  private lastWebhookStatus: WebhookConnectionStatus | null = null;
  private readonly accountRecord: AccountRecord;
  private readonly effectiveReadOnly: boolean;
  private readonly effectiveRateLimit: number;

  constructor(
    private readonly config: Config,
    account: AccountRecord,
    paths: AccountPaths
  ) {
    this.identity = new AccountIdentity({
      db: () => this.storage.db,
      readyDb: () => this.storage.readyDb(),
      sock: () => this.sockClient,
      account: () => this.account,
      stopped: () => this.stopped,
      cachedGroup: (jid) => this.groups.groupCache.get(jid),
      folds: this.folds,
      scheduleFileCleanup: () => this.storage.scheduleFileCleanup(),
      namesChanged: () => {
        this.namedContactsCache = null;
      },
    });
    this.storage = new AccountStorage(
      {
        stopped: () => this.stopped,
        adoptDatabase: (db) => this.adoptDatabase(db),
        recoverSends: (db) => this.sends.recoverSends(db),
        recoverTranscriptions: (db) => this.voice.recoverTranscriptions(db),
        startOutbox: () => this.outbox.start(),
        scheduleFlagsBackfill: (db) => this.ingest.scheduleFlagsBackfill(db),
        embedFeed: () => this.recallIndex.embedFeed,
      },
      this.identity,
      config,
      account,
      paths
    );
    this.views = new MessageViews(
      {
        db: () => this.storage.db,
        readyDb: () => this.storage.readyDb(),
        settleExpired: (db, id) => this.storage.settleExpired(db, id),
        transcriptOf: (message) => this.voice.transcriptOf(message),
      },
      this.identity
    );
    this.groups = new AccountGroups(
      {
        guarded: (work) => this.guarded(work),
        ensureConnected: () => this.ensureConnected(),
        beginWrite: () => this.beginWrite(),
        learnGroup: (meta) => this.ingest.learnGroup(meta),
      },
      this.identity,
      this.views
    );
    this.accountRecord = account;
    this.webhook = new WebhookSink(process.env, { account });
    this.outbox = new WebhookOutbox({
      db: () => this.storage.readyDb(),
      sink: () => this.webhook,
      payload: (event, message) => this.webhookPayload(event, message),
      awaitingTranscript: (message) => this.voice.webhookAwaitsTranscript(message),
    });
    const policy = accountPolicy(account, config);
    this.effectiveReadOnly = policy.readOnly;
    this.effectiveRateLimit = policy.rateLimit;
    this.writes = new RateLimiter(this.effectiveRateLimit);
    this.paths = paths;
    this.sends = new AccountSends(
      {
        db: () => this.storage.db,
        readyDb: () => this.storage.readyDb(),
        stopped: () => this.stopped,
        drafts: () => this.drafts,
        guarded: (work) => this.guarded(work),
        ensureConnected: () => this.ensureConnected(),
        beginWrite: () => this.beginWrite(),
        getMessage: (messageId) => this.getMessage(messageId),
        hasChat: (jid) => this.hasChat(jid),
        handling: (what, work, fallback) => this.handling(what, work, fallback),
        storeRaw: (raw, chatJid, live) => this.ingest.storeRaw(raw, chatJid, live),
        kept: (result) => this.ingest.kept(result),
        embedFeed: () => this.recallIndex.embedFeed,
      },
      this.identity,
      this.views,
      this.groups
    );
    this.voice = new AccountVoice(
      {
        db: () => this.storage.db,
        readyDb: () => this.storage.readyDb(),
        stopped: () => this.stopped,
        status: () => this.status,
        guarded: (work) => this.guarded(work),
        ensureConnected: () => this.ensureConnected(),
        mediaBuffer: (sock, messageId, raw) => this.mediaBuffer(sock, messageId, raw),
        transcriber: (...args) => this.transcriber(...args),
        transcribeReadiness: (...args) => this.transcribeReadiness(...args),
        transcribeAudio: (messageId) => this.transcribeAudio(messageId),
        embedFeed: () => this.recallIndex.embedFeed,
        webhookTranscriptSettled: (sid) => this.webhookTranscriptSettled(sid),
      },
      this.views,
      config,
      account,
      this.effectiveReadOnly
    );
    this.recallIndex = new AccountRecall(
      {
        db: () => this.storage.db,
        readyDb: () => this.storage.readyDb(),
        stopped: () => this.stopped,
        storageState: () => this.storage.storageState,
        guarded: (work) => this.guarded(work),
        ensureConnected: () => {
          this.ensureConnected();
        },
        waitForSync: () => this.waitForSync(),
        synced: (data) => this.synced(data),
        transcriptRecordOf: (message) => this.voice.transcriptRecordOf(message),
      },
      this.identity,
      this.views,
      config
    );
    this.waits = new MessageWaits(
      {
        readyDb: () => this.storage.readyDb(),
        stopped: () => this.stopped,
        guarded: (work) => this.guarded(work),
        ensureConnected: () => {
          this.ensureConnected();
        },
        addressesMe: (raw) => this.addressesMe(raw),
      },
      this.identity,
      this.views
    );
    this.ingest = new AccountIngest(
      {
        stopped: () => this.stopped,
        sock: () => this.sockClient,
        drafts: () => this.drafts,
        handling: (what, work, fallback) => this.handling(what, work, fallback),
        namesChanged: () => {
          this.namedContactsCache = null;
        },
        noteInbound: (fromMe, ts) => this.noteInbound(fromMe, ts),
        noteHistoryReceived: () => {
          this.historyReceived = true;
          this.releaseHistoryWaiters();
        },
        markSyncDone: () => this.markSyncDone(),
        announced: (stored, type) => this.announced(stored, type),
        nudgeOutbox: () => this.outbox.nudge(),
        embedFeed: () => this.recallIndex.embedFeed,
      },
      this.identity,
      this.views,
      this.storage,
      this.sends,
      this.voice,
      this.waits,
      config
    );
    this.storage.openDatabase();
    // Only the server transcribes: a short-lived command (status --live, contacts resync, the sync after a
    // link) queues what arrives and leaves the backlog to it.
    if (this.voice.autoTranscribe && config.command === "serve") this.voice.transcribeWorker.register(this.voice.transcribeSource);
  }

  async start(): Promise<void> {
    if (this.stopped || this.starting) return;
    this.starting = true;
    try {
      let linked = this.readAccount();
      if (linked !== "corrupt" && linked !== null) {
        this.account = linked;
        this.storage.claimDatabase(linked.id);
      }
      await this.storage.bootStorage();
      // A stop during the boot (a logout, a removal) must not be followed by a socket.
      if (this.stopped) return;
      if (linked === "corrupt" || linked === null) {
        // A link that finished while the database was being prepared found this
        // start() still running, so its own start() returned at once: pick it up.
        const since = this.linkedSinceBoot();
        if (since === null) return;
        linked = since;
        this.account = linked;
        this.storage.claimDatabase(linked.id);
        // A claim that swapped the database prepares the one it put in place.
        await this.storage.bootStorage();
        if (this.stopped) return;
      }

      let state;
      try {
        ({ state, saveCreds: this.saveCreds } = await useAtomicAuthState(this.paths.authDir));
      } catch (err) {
        this.markCorrupt(err);
        return;
      }
      if (this.stopped) return;

      this.teardownSocket();
      this.initialSyncDone = false;
      this.setStatus("connecting");
      const generation = ++this.generation;
      const sock = socketFactory.open({
        auth: state,
        logger: silentLogger,
        browser: WA_BROWSER,
        syncFullHistory: this.config.syncFullHistory,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        // Retries and poll decryption ask for a message the account already has.
        getMessage: async (key) => this.views.storedProto(key),
      });
      this.sockClient = sock;
      this.wireEvents(sock, generation);
    } finally {
      this.starting = false;
    }
  }

  stop(): Promise<void> {
    return this.stopPromise ??= this.stopOnce();
  }

  private async stopOnce(): Promise<void> {
    this.stopped = true;
    if (this.storage.expiryTimer) clearTimeout(this.storage.expiryTimer);
    if (this.storage.legacyTimer) clearInterval(this.storage.legacyTimer);
    this.storage.legacyTimer = null;
    this.storage.expiryTimer = null;
    this.storage.expiryAt = undefined;
    for (const timer of [this.reconnectTimer, this.syncDeadline]) {
      if (timer) clearTimeout(timer);
    }
    this.reconnectTimer = null;
    this.syncDeadline = null;
    this.ingest.stopCallSweep();
    this.releaseWaiters();
    this.waits.wakeArrivalWaiters();
    this.teardownSocket();
    await this.outbox.stop();
    await this.stopPairing();
    await this.ingest.historyIdle();
    // Before the database closes: a run under way gets a while to store the transcript it is paying for,
    // then gives its claim back, so the note waits for the next start rather than being uploaded twice.
    await this.voice.transcribeWorker.finish(this.voice.transcribeSource, STOP_TRANSCRIBE_WAIT_MS);
    this.voice.transcribeWorker.unregister(this.voice.transcribeSource);
    await this.recallIndex.stopRecall();
    const db = this.storage.accountDb;
    if (db !== null && db.isOpen) {
      await Promise.allSettled([this.storage.expirySweep, ...this.folds]);
      await db.idle().catch(() => {});
      await this.storage.fileWork.catch(() => {});
      // An account that keeps no history forgets it when it stops, as it did when nothing reached the disk.
      if (!this.config.persistHistory && this.storage.storageState === "ready") {
        await db.messages.purgeLive().catch((err: unknown) => logError("history purge", err));
        try {
          db.sends.forgetWords();
        } catch (err) {
          logError("send record", err);
        }
        await this.storage.unlinkReleased().catch(() => {});
      }
      db.close();
    }
  }

  // Storage ------------------------------------------------------------------

  /** The account database's path. */
  get databasePath(): string {
    return this.storage.databasePath;
  }

  /**
   * The account database for tests and for the doctor: every read and seed
   * goes through the same API the tools use. Refuses while the account is
   * still importing its earlier files, and when the database failed.
   */
  get db(): AccountDb {
    return this.storage.db;
  }

  /**
   * What start() runs before the socket, once per service. Tests call it to
   * boot a service without a socket.
   */
  bootStorage(): Promise<void> {
    return this.storage.bootStorage();
  }

  /** What the service mirrors from a database it starts reading: the pairings and the last sign of life. */
  private adoptDatabase(db: AccountDb): void {
    for (const [lid, phone] of db.identity.lidPairs()) this.identity.lids.learn(lid, phone);
    this.lastInboundAt = db.messages.lastInboundTs();
    this.namedContactsCache = null;
    this.recallIndex.vectorCount = null;
  }

  private async stopPairing(): Promise<void> {
    const run = this.pairingRun;
    if (run === null) return;
    run.cancel();
    let timer: NodeJS.Timeout | undefined;
    const bounded = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, PAIRING_STOP_MS);
    });
    await Promise.race([run.settled, bounded]).finally(() => clearTimeout(timer));
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
      // The service claimed the database for these credentials at start; only they go.
      if (this.status !== "not_linked") clearAuth(this.paths.authDir);
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
    if (this.stopped) {
      pairing.cancel();
      throw new WazapError("NOT_CONNECTED", "The account is shutting down.", "Call get_status");
    }
    this.pairing = {
      code: prettyCode(pairing.code),
      phone_masked: maskNumber(phone),
      expires_at: isoWithOffset(pairing.expiresAt),
    };
    this.setStatus("linking");
    void pairing.done.then(
      (account) => this.adoptLink(account),
      (err: unknown) => this.abandonLink(err)
    );
    // Registered after the handlers above, so a stop waiting on it resumes only
    // once adoptLink or abandonLink has seen the outcome.
    this.pairingRun = { cancel: pairing.cancel, settled: pairing.done.then(() => {}, () => {}) };
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
    this.pairingRun = null;
    // A stopped service is being logged out or removed: the credentials are the
    // caller's to clear, and the owner is not this service's to record.
    if (this.stopped) return;
    this.account = account;
    this.lastError = null;
    this.onLinked?.(account);
    await this.start();
  }

  private abandonLink(err: unknown): void {
    this.linking = null;
    this.pairing = null;
    this.pairingRun = null;
    // Cancelled by stop: nothing failed, so nothing to report.
    if (this.stopped) return;
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
    const db = this.storage.readyDb();
    if (db === null) return { chats: 0, contacts: 0, messages: 0 };
    const chats = db.identity.listChats().filter((chat) => this.views.listed(chat)).length;
    return { chats, contacts: this.namedContacts(), messages: db.counts().messages };
  }

  /** This account already has a chat, or messages, for this jid. Contacts do not count. */
  hasChat(jid: string): boolean {
    const id = this.identity.canonical(jid);
    if (!id || isNoiseJid(id)) return false;
    const chat = this.storage.readyDb()?.identity.chat(id) ?? null;
    return chat !== null && this.views.listed(chat);
  }

  hasMessage(id: string): boolean {
    if (this.stopped) return false;
    try {
      const db = this.storage.readyDb();
      if (db === null) return false;
      if (db.messages.get(id) !== null) return true;
      this.storage.settleExpired(db, id);
      return false;
    } catch {
      return false;
    }
  }

  hasDraft(id: string): boolean {
    const db = this.storage.readyDb();
    if (db === null) return false;
    try {
      return this.drafts.has(db.sends, id);
    } catch {
      return false;
    }
  }

  /**
   * People from the phone's address book: the only contact count worth
   * reporting. The database also holds everyone who ever wrote or reacted, so
   * its size says nothing about whether the address book ever arrived.
   */
  namedContacts(): number {
    if (this.namedContactsCache === null) {
      const db = this.storage.readyDb();
      if (db === null) return 0;
      let named = 0;
      for (const { contact } of db.identity.listContacts()) {
        const jid = contact.phoneJid ?? contact.lid ?? "";
        if (!isGroupId(jid) && realName(contact.name)) named++;
      }
      this.namedContactsCache = named;
    }
    return this.namedContactsCache;
  }

  /** The one writer of `status`, so `status_since` can never drift from it. */
  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.statusSince = Date.now();
    this.queueConnectionWebhook(next);
    // Notes that waited for the connection run now rather than at the worker's next look.
    if (next === "connected" && this.voice.autoTranscribe) this.voice.transcribeWorker.kick();
  }

  /**
   * Several internal states map to one thing a consumer acts on, so the guard is
   * on the mapped status, and it advances only once the event is in the outbox,
   * which retries it for a day and keeps the order the link moved in. A change
   * the webhook does not subscribe to is not queued and does not advance it.
   */
  private queueConnectionWebhook(status: ConnectionStatus): void {
    const mapped = webhookConnectionStatus(status);
    if (mapped === null || mapped === this.lastWebhookStatus || this.stopped) return;
    const settings = this.webhook.settings();
    if (settings.kind !== "ready" || !settings.events.includes("connection")) return;
    const db = this.storage.readyDb();
    if (db === null) {
      this.outbox.dropped(`connection ${mapped}`);
      return;
    }
    const at = this.statusSince;
    try {
      db.events.enqueue({
        kind: "connection",
        lane: CONNECTION_LANE,
        messageId: null,
        payload: JSON.stringify(asConnectionPayload({ status: mapped, account: this.accountRecord, at })),
        createdAt: at,
      });
    } catch (err) {
      this.outbox.dropped(`connection ${mapped}`, err);
      return;
    }
    this.lastWebhookStatus = mapped;
    this.outbox.nudge();
  }

  getStatus(): StatusInfo {
    const inboundAt = this.latestInboundAt();
    const info: StatusInfo = {
      status: this.status,
      status_since: isoWithOffset(this.statusSince),
      sync: this.syncState(),
      account: this.account,
      account_id: this.accountRecord.id,
      account_name: this.accountRecord.name,
      enabled: this.accountRecord.enabled,
      write_tools: !this.effectiveReadOnly,
      last_message_received_at: inboundAt === null ? null : isoWithOffset(inboundAt),
      reconnect_attempts: this.reconnectAttempts,
      wazap_version: WAZAP_VERSION,
      baileys_version: BAILEYS_VERSION,
      contacts_named: this.namedContacts(),
      data_dir: this.config.dataDir,
      read_only: this.effectiveReadOnly,
      rate_limit: this.effectiveRateLimit,
      last_error: this.lastError ?? this.storage.storageFault?.message ?? null,
      webhook: this.webhookStatus(),
      recall: this.recallIndex.recallStatus(),
      storage: this.storage.storageInfo(),
      transcription: this.voice.transcriptionStatus(),
      diagnostics: {
        read_self: {
          seen: this.ingest.readSelf.seen,
          synced: this.ingest.readSelf.synced,
          applied: this.ingest.readSelf.applied,
          unmatched: this.ingest.readSelf.unmatched,
          last_at: this.ingest.readSelf.lastAt === null ? null : isoWithOffset(this.ingest.readSelf.lastAt),
        },
      },
    };
    const hints: string[] = [];
    if (this.storage.storageState === "preparing") {
      hints.push("The account is preparing its database from its earlier message files (once, after an upgrade); tools answer NOT_CONNECTED until it is done.");
    }
    if (this.storage.storageState === "failed" && this.storage.storageFault?.fix) hints.push(this.storage.storageFault.fix);
    if (this.status === "linking" && this.pairing) {
      info.pairing = this.pairing;
      hints.push("Enter the code on the phone; call get_status again in 10 s");
    }
    hints.push(
      ...writesHints({
        readOnly: this.effectiveReadOnly,
        transport: this.config.transport,
        publicUrl: this.config.publicUrl,
      })
    );
    const stale = inboundAt !== null && Date.now() - inboundAt > STALE_INBOUND_MS;
    if (this.status === "connected" && stale) {
      hints.push("No messages received for 24h; the phone may be offline.");
    }
    if (hints.length > 0) info.hint = hints.join(" ");
    return info;
  }

  /**
   * `lastInboundAt` is read from the database when it opens and raised as
   * messages land, so status is a read, not a scan. A deleted newest message
   * can leave it a touch stale, which only ever delays the "phone may be
   * offline" hint.
   */
  private latestInboundAt(): number | null {
    return this.lastInboundAt;
  }

  /** Every stored inbound message is evidence the phone link is alive. */
  private noteInbound(fromMe: boolean, ts: number): void {
    if (fromMe) return;
    this.lastInboundAt = Math.max(this.lastInboundAt ?? 0, ts);
  }

  listChats(filter: ChatFilter, limit: number, opts: { private?: PrivateRule } = {}): Promise<Synced<ChatSummary[]>> {
    return this.guarded(async () => {
      this.ensureConnected();
      await this.waitForSync();
      // The lookup can teach a pairing, and a pairing folds a lid chat into its
      // number's: it comes first, and the fold is let land before the list is read.
      const lidChats = this.storage.db.identity.listChats().filter((chat) => chat.jid.endsWith("@lid") && this.views.listed(chat));
      await this.identity.learnLidPhones(lidChats.map((chat) => chat.jid));
      await this.foldsSettled();
      const db = this.storage.db;
      const entries = db.identity
        .listChats()
        .filter((chat) => this.views.listed(chat) && this.views.matchesChatFilter(chat, filter))
        .map((chat) => ({ chat, proto: chat.proto === null ? null : decodeChat(Buffer.from(chat.proto).toString("base64")) }));
      const activity = (entry: (typeof entries)[number]): number => {
        const described = protoNumber(entry.proto?.conversationTimestamp);
        if (described !== undefined && described !== null) return described;
        return entry.chat.lastTs === null ? 0 : Math.floor(entry.chat.lastTs / 1000);
      };
      const people = this.identity.privateScope(opts.private);
      const chats = entries
        .sort((a, b) => activity(b) - activity(a) || (b.chat.lastMessageId ?? 0) - (a.chat.lastMessageId ?? 0) || b.chat.id - a.chat.id)
        .slice(0, limit)
        .map((entry) => this.views.chatSummary(entry.chat, entry.proto, people));
      return this.synced(chats);
    });
  }

  readMessages(chatId: string, limit: number, before?: string, types?: MessageType[]): Promise<ChatRead> {
    return this.guarded(async () => {
      const sock = this.ensureConnected();
      const jid = this.identity.resolveId(chatId);
      await this.waitForSync();
      await this.groups.learnParticipants(jid);
      await this.identity.learnLidPhones([jid]);

      if (before === undefined) {
        const read: ChatRead = this.synced(this.views.viewsOfStored(this.pageOf(jid, limit, undefined, types)));
        // The newest page is where a send handed to WhatsApp would show: until its echo comes, say it may be on its way.
        const unconfirmed = types === undefined ? this.unconfirmedSends(jid) : [];
        return unconfirmed.length === 0 ? read : { ...read, unconfirmedSends: unconfirmed };
      }

      const anchor = this.views.storedOrThrow(before);
      const inChat = this.storage.db.identity.chat(jid)?.jid === anchor.chatJid;
      let older = inChat ? this.pageOf(jid, limit, anchor.id, types) : [];
      if (older.length > 0) return this.synced(this.views.viewsOfStored(older));
      await this.fetchOlder(sock, anchor, limit);
      older = inChat ? this.pageOf(jid, limit, anchor.id, types) : [];
      // The phone may hold more than it sent in time: an empty answer says it was asked, never that the chat starts here.
      return { ...this.synced(this.views.viewsOfStored(older)), older: { askedPhone: true, received: older.length } };
    });
  }

  /**
   * confirm_send's sends to this chat that went unknown and have not echoed:
   * a read that does not show them yet has not shown they failed.
   */
  private unconfirmedSends(jid: string): UnconfirmedSend[] {
    const db = this.storage.readyDb();
    if (db === null) return [];
    const chats = [...new Set([jid, db.identity.chat(jid)?.jid].filter((id): id is string => typeof id === "string"))];
    return db.sends.unknownIn(chats, UNCONFIRMED_SENDS_SHOWN).map((row) => ({
      draft_id: row.draftId,
      text: frozenReceiptText(row),
      handed_at: isoWithOffset(row.updatedAt),
      state: "unknown" as const,
    }));
  }

  /**
   * The newest `limit` messages of a chat older than `before`, oldest first.
   * A type filter pages on past what it leaves out, so `limit` counts
   * messages the caller asked for, up to a bounded walk.
   */
  private pageOf(jid: string, limit: number, before: number | undefined, types?: MessageType[]): StoredMessage[] {
    const db = this.storage.db;
    const wanted = types === undefined || types.length === 0 ? null : new Set<string>(types);
    const out: StoredMessage[] = [];
    let cursor = before;
    let walked = 0;
    for (;;) {
      const page = db.messages.chatPage(jid, { limit: wanted === null ? limit : Math.max(limit, 200), ...(cursor === undefined ? {} : { before: cursor }) });
      for (const message of page.items) {
        walked++;
        if (wanted !== null && !wanted.has(message.type)) continue;
        out.push(message);
        if (out.length >= limit) break;
      }
      if (out.length >= limit || page.nextBefore === null || walked >= TYPE_FILTER_SCAN) break;
      cursor = page.nextBefore;
    }
    return out.reverse();
  }

  getRecentMessages(
    hours: number,
    filter: Exclude<ChatFilter, "archived">,
    includeSystem = false,
    types?: MessageType[]
  ): Promise<Synced<RecentConversation[]>> {
    return this.guarded(async () => {
      this.ensureConnected();
      await this.waitForSync();
      const cutoff = Date.now() - hours * 3_600_000;
      const active = this.storage.db.identity.listChats().filter((chat) => chat.lastTs !== null && chat.lastTs >= cutoff);
      await this.identity.learnLidPhones(active.map((chat) => chat.jid));
      // A group's metadata is what names a sender the address book does not
      // know; fetch it for the groups that spoke in the window, once each.
      const activeGroups = active
        .map((chat) => chat.jid)
        .filter((jid) => isGroupId(jid) && !this.groups.groupCache.has(jid) && !this.groups.unreadableGroups.has(jid));
      await Promise.all(activeGroups.slice(0, RECENT_GROUP_META_MAX).map((jid) => this.groups.learnParticipants(jid)));

      const db = this.storage.db;
      const wanted = types === undefined || types.length === 0 ? null : new Set<string>(types);
      const chosen: Array<{ jid: string; stored: StoredMessage[] }> = [];
      for (const chat of active) {
        if (chat.kind === "status" || isNoiseJid(chat.jid) || !this.views.matchesChatFilter(chat, filter)) continue;
        // Each chat's newest messages in the window, at most as many as main's per-chat ring held.
        const newestFirst: StoredMessage[] = [];
        for (let before: number | undefined; newestFirst.length < RECENT_PER_CHAT_MAX; ) {
          const limit = Math.min(500, RECENT_PER_CHAT_MAX - newestFirst.length);
          const page = db.messages.chatPage(chat.jid, { limit, since: cutoff, ...(before === undefined ? {} : { before }) });
          newestFirst.push(...page.items);
          if (page.nextBefore === null) break;
          before = page.nextBefore;
        }
        const stored = newestFirst.reverse().filter((message) => wanted === null || wanted.has(message.type));
        if (stored.length > 0) chosen.push({ jid: chat.jid, stored });
      }
      // One read of every chosen message's reactions, votes and receipts, and each name once.
      const lookups = this.views.viewLookups(chosen.flatMap((entry) => entry.stored));
      const conversations: RecentConversation[] = [];
      for (const { jid, stored } of chosen) {
        const messages = stored
          .map((message) => this.views.viewOfStored(message, lookups))
          .filter((view) => includeSystem || view.type !== "system");
        if (messages.length === 0) continue;
        const note = this.identity.noteFor(jid);
        conversations.push({
          chat_id: jid,
          chat_name: this.identity.displayName(jid),
          ...(note ? { note } : {}),
          type: isGroupId(jid) ? "group" : "individual",
          last_activity: messages[messages.length - 1]!.timestamp,
          messages,
        });
      }

      conversations.sort((a, b) => b.last_activity.localeCompare(a.last_activity));
      return this.synced(conversations);
    });
  }

  searchMessages(
    query: string,
    chatId: string | undefined,
    limit: number,
    opts: SearchOptions = {}
  ): Promise<SearchAnswer> {
    return this.guarded(async () => {
      this.ensureConnected();
      await this.waitForSync();
      limit = pageLimit(limit);
      const db = this.storage.db;
      const scope = chatId === undefined ? undefined : this.identity.resolveId(chatId);
      const from = this.identity.senderFilter(opts.from);
      const filter = {
        ...(scope === undefined ? {} : { chat: scope }),
        ...(from === undefined ? {} : { from }),
        ...(opts.sinceMs === undefined ? {} : { since: opts.sinceMs }),
        ...(opts.untilMs === undefined ? {} : { until: opts.untilMs }),
      };
      const people = scope === undefined ? this.identity.privateScope(opts.private) : null;
      // from naming one of them asks for what they wrote; a quote of anyone else kept #private still loses its words.
      const author = people !== null && from !== undefined && people.names(from) ? from : undefined;
      const found: StoredMessage[] = [];
      let privateOmitted = 0;
      let capped: number | null = null;
      for (let before: number | undefined; found.length < limit; ) {
        const page = db.search.text({ query, limit, ...filter, ...(before === undefined ? {} : { before }) });
        for (const message of page.items) {
          // The status feed is not a chat: a story never answers a search.
          if (message.chatJid === STATUS_JID) continue;
          // Nor does someone kept #private, unless the call names them: counted, never an entry without its words.
          if (author === undefined && people?.message(message)) {
            privateOmitted++;
            continue;
          }
          found.push(message);
          if (found.length >= limit) break;
        }
        // A page the scan limit stopped is the last one: another would scan as much again, and the answer says where it stopped.
        if (page.scanCapped) {
          if (found.length < limit) capped = page.nextBefore;
          break;
        }
        if (page.nextBefore === null) break;
        before = page.nextBefore;
      }
      const views = this.views.viewsOfStored(found);
      const answer: SearchAnswer = this.synced(people === null ? views : views.map((view) => withoutPrivateQuote(view, people, author)));
      if (capped !== null) answer.scanCapped = { searchedBackTo: isoWithOffset(secondOfId(capped) * 1000) };
      if (privateOmitted > 0) answer.privateOmitted = privateOmitted;
      return answer;
    });
  }

  /**
   * What a search by words ran across: every visible message of the account (or
   * of the chat) inside the time filters, the status feed left out. Null when
   * the database cannot say; a coverage miss never takes a search down.
   */
  searchCoverage(chatId: string | undefined, opts: { sinceMs?: number; untilMs?: number } = {}): SearchCoverage | null {
    try {
      const db = this.storage.readyDb();
      if (db === null) return null;
      const scope = chatId === undefined ? undefined : this.identity.resolveId(chatId);
      const cov = db.search.coverage({
        excludeKinds: ["status"],
        ...(scope === undefined ? {} : { chat: scope }),
        ...(opts.sinceMs === undefined ? {} : { since: opts.sinceMs }),
        ...(opts.untilMs === undefined ? {} : { until: opts.untilMs }),
      });
      return {
        searched: cov.messages,
        chats: cov.chats,
        oldest_at: cov.oldestTs === null ? null : isoWithOffset(cov.oldestTs),
        newest_at: cov.newestTs === null ? null : isoWithOffset(cov.newestTs),
        per_chat_cap: null,
      };
    } catch {
      return null;
    }
  }

  recall(
    query: string,
    chatId: string | undefined,
    limit: number,
    opts: SearchOptions = {}
  ): Promise<Synced<RecallAnswer>> {
    return this.recallIndex.recall(query, chatId, limit, opts);
  }

  getMessage(messageId: string): Promise<MessageView> {
    return this.guarded(async () => {
      this.ensureConnected();
      return this.views.viewOfStored(this.views.storedOrThrow(messageId));
    });
  }

  /**
   * Name and number matches, plus the local filing: a tag or a detail's key or
   * value hits too, which is how "contabil" finds the person filed under
   * `role: contabil`. With `tag` only contacts carrying it come back, so
   * "everyone tagged furnizori" is one call. People known only through their
   * local filing — never synced as contacts — are candidates as well.
   */
  searchContacts(query: string, limit: number, opts: { tag?: string } = {}): Promise<ContactSummary[]> {
    return this.guarded(async () => {
      this.ensureConnected();
      await this.waitForSync();
      const needle = query.trim().toLowerCase();
      // "0734…" typed the way a number is dialled at home matches "40734…".
      const digits = needle.replace(/\D/g, "").replace(/^0+/, "");
      const tag = opts.tag === undefined ? undefined : normalizeTag(opts.tag);
      if (tag === "") {
        throw new WazapError("INVALID_ID", `"${opts.tag}" is not a usable tag.`, 'Pass a label like "client"');
      }
      const matches: ContactSummary[] = [];
      for (const { contact, notes } of this.storage.db.identity.listContacts()) {
        const person = contact.phoneJid ?? contact.lid;
        if (person === null || isGroupId(person) || isNoiseJid(person)) continue;
        // The address book (the account's own entry too, when it is in it) and the people the user filed: not everyone who ever wrote.
        if (contact.listed === null && notes === null) continue;
        const tags = notes?.tags ?? [];
        if (tag !== undefined && !tags.includes(tag)) continue;
        // Every name we might show, or someone the chat list calls "Carmen"
        // would not be findable by that name here.
        const known = [contact.name, contact.verifiedName, contact.notify, contact.pushName].map(realName);
        const number = person.split("@")[0] ?? "";
        const hit =
          needle === "" ||
          known.some((name) => name?.toLowerCase().includes(needle)) ||
          (digits.length >= 5 && number.includes(digits)) ||
          tags.some((t) => t.includes(needle)) ||
          Object.entries(notes?.fields ?? {}).some(([key, value]) => key.includes(needle) || value.toLowerCase().includes(needle));
        if (!hit) continue;
        matches.push(this.views.contactSummary(person));
        if (matches.length >= limit) break;
      }
      return matches;
    });
  }

  getContact(contactId: string): Promise<ContactDetails> {
    return this.guarded(async () => {
      const sock = this.ensureConnected();
      const jid = this.identity.resolveId(contactId);
      // A number WhatsApp does not know never answers these two queries, so
      // they get a deadline and the contact still comes back from the store.
      const [about, picture] = await Promise.all([
        orNullAfter(
          sock.fetchStatus(jid).then((entries) => statusTextOf(entries?.[0])),
          PROFILE_LOOKUP_MS
        ),
        orNullAfter(sock.profilePictureUrl(jid, "image"), PROFILE_LOOKUP_MS),
      ]);
      return {
        ...this.views.contactSummary(jid),
        about,
        profile_pic_url: picture ?? null,
        is_blocked: this.blocked.has(jid),
      };
    });
  }

  // ---- find_contact and the draft context (F2-3) ----------------------------

  /**
   * Who a name means on this account (src/find-contact.ts), from what the
   * account stores: no connection is needed, only a database that answers.
   * While connected, an address book that looks empty is first asked for (see
   * askForEmptyAddressBook).
   */
  findContact(query: FindContactQuery): Promise<AccountFind> {
    return this.guarded(async () => {
      let db = this.storage.db;
      if (this.status === "connected") {
        await this.waitForSync();
        await this.askForEmptyAddressBook();
        db = this.storage.db;
      }
      return findInAccount(db, this.accountRecord.id, query, (id) => this.identity.resolveId(id));
    });
  }

  /**
   * No contact carries a saved name: ask WhatsApp for the address book, at
   * most once per boot and on the same rule as the self-heal
   * (needsContactResync: not while the connection is still syncing, not within
   * 7 days of the last ask), then wait up to 15 s for names. Every find that
   * comes in meanwhile waits on the same ask. A failure is logged; the answer
   * comes from what is stored.
   */
  private askForEmptyAddressBook(): Promise<void> {
    if (this.addressBookAsk === null) {
      if (this.namedContacts() > 0) return Promise.resolve();
      this.addressBookAsk = (async () => {
        try {
          const sock = this.ensureConnected();
          const decision = {
            named: this.namedContacts(),
            storedVersions: await this.hasAppStateVersions(sock),
            resyncedAt: this.contactsResyncedAt(),
            now: Date.now(),
          };
          if (!needsContactResync(decision)) return;
          log("address book missing; requesting a full contact sync before find_contact answers");
          await this.resyncContacts(sock);
          await this.waitForNames(0, Date.now() + CONTACT_SETTLE_MS);
        } catch (err) {
          logError("contact sync", err);
        }
      })();
    }
    return this.addressBookAsk;
  }

  /** The recent exchange and the user's style in a chat, for a contact find_contact resolved. */
  draftContext(chatJid: string, options: { recent: boolean; private?: PrivateRule }): DraftContext | null {
    return draftContextFor(this.storage.db, chatJid, { recent: options.recent, others: options.private?.others, senderName: (jid) => this.identity.displayName(jid) });
  }

  /** send_message's style check on a text draft; null when the chat gives too little to judge or the database is not ready. */
  styleCheck(chatJid: string, text: string, options: { private?: PrivateRule } = {}): StyleCheck | null {
    const db = this.storage.readyDb();
    return db === null ? null : styleCheckFor(db, chatJid, text, { others: options.private?.others });
  }

  // ---- end find_contact ------------------------------------------------------

  waitForMessages(opts: WaitOptions): Promise<WaitResult> {
    return this.waits.waitForMessages(opts);
  }

  /** The stories of the last `hours`, newest first, each with its author as the sender. */
  getStories(hours: number, opts: { private?: PrivateRule } = {}): Promise<Synced<MessageView[]>> {
    return this.guarded(async () => {
      this.ensureConnected();
      await this.waitForSync();
      const cutoff = Math.max(Date.now() - hours * 3_600_000, Date.now() - STORY_TTL_MS);
      const stories: StoredMessage[] = [];
      for (let before: number | undefined; ; ) {
        const page = this.storage.db.messages.chatPage(STATUS_JID, { limit: 200, ...(before === undefined ? {} : { before }) });
        const fresh = page.items.filter((message) => message.ts >= cutoff);
        stories.push(...fresh);
        if (fresh.length < page.items.length || page.nextBefore === null) break;
        before = page.nextBefore;
      }
      await this.identity.learnLidPhones(stories.flatMap((story) => (story.senderJid === null ? [] : [story.senderJid])));
      const views = this.views.viewsOfStored(stories);
      const people = this.identity.privateScope(opts.private);
      // Stories are never asked for by name: a #private person's keep who, when and what kind.
      return this.synced(people === null ? views : views.map((view, i) => (people.message(stories[i]!) ? withoutWords(view) : view)));
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
        const message = this.storage.readyDb()?.messages.get(sid) ?? null;
        const raw = message === null ? null : this.views.rawOf(message);
        if (!raw) continue;
        const shipped = thumbnailOf(raw);
        if (shipped) {
          out.push({ message_id: sid, ...shipped });
          continue;
        }
        const cached = await this.readPreview(sid);
        if (!this.hasMessage(sid)) continue;
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
          if (!made || !this.hasMessage(sid)) continue;
          await this.writePreview(sid, made);
          if (!this.hasMessage(sid)) continue;
          out.push({ message_id: sid, mime: "image/jpeg", base64: made.toString("base64") });
        } catch {
          // Expired on WhatsApp's side, or not decodable: this one goes without.
        }
      }
      return out.filter((preview) => this.hasMessage(preview.message_id));
    });
  }

  /** Previews live as files, one JPEG per message, recorded against it in the database so a delete takes the file too. */
  private previewPath(sid: string): string {
    return join(this.paths.previewsDir, `${safeFilename(sid)}.jpg`);
  }

  private async readPreview(sid: string): Promise<Buffer | null> {
    const path = this.storage.readyDb()?.messages.media(sid).find((media) => media.kind === "preview")?.path;
    if (path === undefined) return null;
    try {
      return await readFile(path);
    } catch (err) {
      if (!isMissing(err)) logError("preview read", err);
      return null;
    }
  }

  /**
   * Writes the file, then records it against its message. A message deleted
   * meanwhile refuses the record, and the file goes at once; one deleted after
   * the record releases it through the database's unlink queue.
   */
  private async writePreview(sid: string, jpeg: Buffer): Promise<void> {
    if (!this.hasMessage(sid)) return;
    const path = this.previewPath(sid);
    await mkdir(this.paths.previewsDir, { recursive: true, mode: DIR_MODE });
    if (!this.hasMessage(sid)) return;
    await writeFile(path, jpeg, { mode: FILE_MODE });
    const db = this.storage.readyDb();
    const recorded = db?.messages.setMedia(sid, "preview", path) ?? { stored: false, replaced: null };
    if (!recorded.stored) await rm(path, { force: true });
    if (recorded.replaced !== null && recorded.replaced !== path) await rm(recorded.replaced, { force: true });
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
      this.ensureConnected();
      await this.waitForSync();
      const now = Date.now();
      const cutoff = now - minAgeHours * 3_600_000;
      const horizon = now - maxAgeHours * 3_600_000;
      const db = this.storage.db;
      const found: UnansweredChat[] = [];
      // The database narrows to chats whose newest word is theirs inside the
      // horizon and that no handled mark still covers; the ask is judged here.
      for (let after: { lastTs: number; id: number } | undefined; ; ) {
        const page = db.messages.waiting({ since: horizon, until: now, limit: 200, kinds: WAITING_KINDS, ...(after === undefined ? {} : { after }) });
        for (const { chat, handled } of page.items) {
          const jid = chat.jid;
          if (isNoiseJid(jid)) continue;
          const open = this.openAsk(jid);
          if (!open) continue;
          const { ask, theirs } = open;
          if (handled?.askSid === ask.sid) continue;
          if (ask.ts > cutoff || ask.ts < horizon) continue;
          const group = isGroupId(jid);
          const note = this.identity.noteFor(jid);
          found.push({
            chat_id: jid,
            name: this.identity.displayName(jid),
            type: group ? "group" : "individual",
            ask: this.views.viewOfStored(ask),
            messages_since_you: theirs.length,
            business: !group && Boolean(db.identity.contact(jid)?.verifiedName),
            ...(note ? { note } : {}),
            waiting_since: isoWithOffset(ask.ts),
            age: formatAge(ask.ts),
          });
        }
        if (page.next === null) break;
        after = page.next;
      }
      found.sort((a, b) => {
        if (a.type !== b.type) return a.type === "individual" ? -1 : 1;
        return a.waiting_since.localeCompare(b.waiting_since);
      });
      return this.synced(found.slice(0, limit));
    });
  }

  /**
   * The ask still open in a chat: their messages after the user's last one,
   * and among them the newest that asks for something. In a group only a
   * message addressed to the user counts.
   */
  private openAsk(jid: string): { ask: StoredMessage; theirs: StoredMessage[] } | null {
    const tail = this.storage.db.messages.chatPage(jid, { limit: UNANSWERED_SCAN }).items;
    const theirs: StoredMessage[] = [];
    for (const message of tail) {
      if (message.fromMe) break;
      if (message.type === "system") continue;
      theirs.unshift(message);
    }
    if (theirs.length === 0) return null;
    const group = isGroupId(jid);
    const ask = [...theirs].reverse().find((message) => {
      const raw = this.views.rawOf(message);
      if (group && (raw === null || !this.addressesMe(raw))) return false;
      return this.readsAsAsk(message, raw);
    });
    return ask ? { ask, theirs } : null;
  }

  // ---- catch_up (F2-2): this account's side; the digest is src/catchup.ts ----

  /**
   * The account's catch-up entries over a window. It reads what the database
   * holds whether or not the socket is up, and says which: a digest of a
   * disconnected account is reported as such, not as "nothing new". An account
   * never linked has nothing to read.
   */
  catchUpScan(request: CatchupScanRequest): Promise<CatchupScan> {
    return this.guarded(async () => {
      if (this.status === "not_linked" || this.status === "linking") this.ensureConnected();
      return scanCatchup(this.storage.db, this.catchupHost(), request, { id: this.accountRecord.id, name: this.accountRecord.name });
    });
  }

  catchUpTags(): Promise<CatchupTagJids> {
    return this.guarded(async () => taggedJids(this.storage.db));
  }

  catchUpQuotes(ids: number[]): Promise<CatchupQuote[]> {
    return this.guarded(async () => quotesOf(this.storage.db, ids));
  }

  catchUpAdvance(client: string, window: CatchupWindow): Promise<{ advanced: boolean }> {
    return this.guarded(async () => ({
      advanced: this.storage.db.catchup.advance(client, window.untilSeq, {
        at: window.at,
        expectedThroughSeq: window.expected,
        // What the window read from: the mark, or a time when it read by time (a first run, a mark too old).
        from: { seq: window.afterSeq < 0 ? null : window.afterSeq, at: window.sinceAt },
      }).advanced,
    }));
  }

  private catchupHost(): CatchupHost {
    return {
      now: () => Date.now(),
      ownJid: () => this.identity.ownJid(),
      nameOf: (jid) => this.identity.displayName(jid),
      noteOf: (jid) => this.identity.noteFor(jid),
      isNoise: (jid) => isNoiseJid(jid),
      leftGroup: (chat) => {
        try {
          return chat.proto !== null && leftGroup(chat.proto);
        } catch {
          return false;
        }
      },
      // Names only: the lid table is a lookup, and group metadata is fetched for
      // at most a dozen groups, within a second, and only while connected — a
      // fetch that cannot run would mark the group unreadable for good.
      prepareNames: async (groups, people) => {
        await this.identity.learnLidPhones(people);
        if (this.status !== "connected") return;
        const unknown = groups.filter((jid) => !this.groups.groupCache.has(jid) && !this.groups.unreadableGroups.has(jid)).slice(0, GROUP_META_MAX);
        if (unknown.length === 0) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.all(unknown.map((jid) => this.groups.learnParticipants(jid))),
          new Promise<void>((done) => {
            timer = setTimeout(done, GROUP_META_MS);
          }),
        ]);
        clearTimeout(timer);
      },
      connection: () => ({
        status: this.status,
        since: isoWithOffset(this.statusSince),
        sync: this.syncState(),
        mentionsIndexing: this.storage.readyDb()?.messages.flagsBackfillPending() ?? false,
      }),
    };
  }

  // ---- end catch_up -------------------------------------------------------------

  setContactNote(contactId: string, note: string): Promise<ContactSummary> {
    return this.guarded(async () => {
      const jid = this.identity.resolveId(contactId);
      this.storage.db.identity.setNote(jid, note);
      return this.views.contactSummary(jid);
    });
  }

  /**
   * The local contact file: tags and key-value details the agent files a
   * person under, found by find_contact. Nothing reaches WhatsApp —
   * the protocol stores only a name — so this is how "my accountant" and
   * "the guys from the depot" stay attached to people. The person need not
   * be a saved contact; filing a chat partner works too.
   */
  updateContactDetails(contactId: string, edit: ContactDetailsEdit): Promise<ContactSummary> {
    return this.guarded(async () => {
      const jid = this.identity.personJid(contactId);
      const addTags = (edit.addTags ?? []).map((t) => requireTag(t));
      const removeTags = (edit.removeTags ?? []).map((t) => requireTag(t));
      const set: Record<string, string> = {};
      const removeFields = new Set((edit.removeFields ?? []).map((k) => requireFieldKey(k)));
      for (const [key, value] of Object.entries(edit.fields ?? {})) {
        const normalized = requireFieldKey(key);
        const trimmed = value.trim();
        if (trimmed === "") removeFields.add(normalized);
        else {
          if (trimmed.length > MAX_FIELD_VALUE_CHARS) {
            throw new WazapError("TEXT_TOO_LONG", `Detail "${normalized}" is over ${MAX_FIELD_VALUE_CHARS} characters.`);
          }
          set[normalized] = trimmed;
        }
      }
      if (
        addTags.length === 0 &&
        removeTags.length === 0 &&
        Object.keys(set).length === 0 &&
        removeFields.size === 0
      ) {
        throw new WazapError(
          "INVALID_ID",
          "Nothing to update.",
          "Pass add_tags, remove_tags, fields or remove_fields"
        );
      }
      const db = this.storage.db;
      const current = db.identity.notes(jid);
      const tagCount =
        new Set([...(current?.tags ?? []), ...addTags].filter((t) => !removeTags.includes(t))).size;
      const fieldCount = new Set(
        [...Object.keys(current?.fields ?? {}), ...Object.keys(set)].filter((k) => !removeFields.has(k))
      ).size;
      if (tagCount > MAX_CONTACT_TAGS) {
        throw new WazapError("TEXT_TOO_LONG", `A contact holds at most ${MAX_CONTACT_TAGS} tags.`);
      }
      if (fieldCount > MAX_CONTACT_FIELDS) {
        throw new WazapError("TEXT_TOO_LONG", `A contact holds at most ${MAX_CONTACT_FIELDS} details.`);
      }
      db.identity.updateFields(jid, { addTags, removeTags, set, removeFields: [...removeFields] });
      return this.views.contactSummary(jid);
    });
  }

  /**
   * "I dealt with that outside WhatsApp." The open ask is remembered as
   * handled, so it leaves the waiting list; the next message from them
   * makes a new ask and the chat comes back.
   */
  markHandled(chatId: string): Promise<HandledResult> {
    return this.guarded(async () => {
      const jid = this.identity.resolveId(chatId);
      const db = this.storage.db;
      const open = db.identity.chat(jid) === null ? null : this.openAsk(jid);
      const last = db.messages.chatPage(jid, { limit: 1 }).items[0] ?? null;
      const ask = open?.ask ?? (last && !last.fromMe ? last : null);
      if (ask) db.identity.markHandled(jid, ask.sid);
      return {
        chat_id: jid,
        name: this.identity.displayName(jid),
        ask_id: ask?.sid ?? null,
        ask_text: ask ? this.views.viewTextOf(ask) : null,
      };
    });
  }

  private readsAsAsk(message: StoredMessage, raw: WAMessage | null): boolean {
    if (message.type === "call") return false;
    // A voice note nobody has heard is an ask until proven otherwise.
    if (message.type === "voice" && message.transcript === null) return true;
    return wordsAsk(raw === null ? this.views.viewTextOf(message) : viewText(raw, this.voice.transcriptOf(message)));
  }

  /** A group message that @-mentions the linked account or replies to one of its messages. */
  private addressesMe(raw: WAMessage): boolean {
    if (mentionedJids(raw).some((jid) => this.identity.isMe(jid))) return true;
    const quoted = quotedSenderJid(raw);
    return quoted !== undefined && this.identity.isMe(quoted);
  }

  downloadMedia(messageId: string, saveTo?: string): Promise<MediaResult> {
    return this.guarded(async () => {
      const sock = this.ensureConnected();
      const raw = this.views.messageOrThrow(messageId);
      const info = mediaInfo(raw);
      if (!info) throw new WazapError("MEDIA_UNAVAILABLE", `Message ${messageId} carries no media.`);
      const buffer = await this.mediaBuffer(sock, messageId, raw);
      this.views.messageOrThrow(messageId);

      const dir = saveTo ?? this.paths.mediaDir;
      if (!isAbsolute(dir)) {
        throw new WazapError("FILE_NOT_FOUND", `"${dir}" is not an absolute directory path.`);
      }
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
      this.views.messageOrThrow(messageId);
      const filename = mediaFilename(info);
      const path = join(dir, filename);
      await writeFile(path, buffer, { mode: FILE_MODE });
      // An export already written belongs to the user; never delete arbitrary
      // download paths. Do not return its bytes after expiry, however.
      this.views.messageOrThrow(messageId);

      const inline =
        info.mime.startsWith("image/") && buffer.length <= INLINE_IMAGE_MAX_BYTES ? buffer.toString("base64") : null;
      return { path, mime: info.mime, size: buffer.length, filename, inline_base64: inline };
    });
  }

  transcribeAudio(messageId: string, language?: string, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
    return this.voice.transcribeAudio(messageId, language, opts);
  }

  /**
   * The account is being removed: its upload or whisper.cpp run under way ends
   * now instead of being waited for, and gives its attempt back.
   */
  abortTranscription(): void {
    this.voice.abortTranscription();
  }

  /**
   * Resolves when the background queue has nothing left to transcribe. Off the
   * WhatsAppApi on purpose: an agent has no business waiting on it, and a test
   * needs it so it can wait on the queue instead of sleeping.
   */
  transcribeIdle(): Promise<void> {
    return this.voice.transcribeIdle();
  }

  /**
   * Resolves when the embedding feed has nothing left to embed. Same rule as
   * transcribeIdle: off the public API, here so tests can wait on it.
   */
  recallIdle(): Promise<void> {
    return this.recallIndex.recallIdle();
  }

  /**
   * A chat cleared or deleted for this account, by manage_chat or on the phone.
   * The barrier is stored and every message at or before it hidden before this
   * returns, so an event handler need not wait; the rows, their vectors and
   * their files go in chunks behind it. A deleted chat also leaves the chat
   * list until a new message arrives.
   */
  private forgetChat(jid: string, deleted: boolean): Promise<void> {
    const db = this.storage.db;
    const at = Date.now();
    if (deleted) db.identity.upsertChat({ jid, archived: false, pinned: null, unread: 0, proto: null });
    const purge = deleted ? db.messages.deleteChat(jid, at) : db.messages.clearChat(jid, at);
    return purge.then(() => this.storage.scheduleFileCleanup());
  }

  /**
   * Test and lifecycle barrier, not an MCP tool: queued purges, folds, expiry
   * sweeps and file cleanup have finished. A cleanup failure since the last
   * call is reported here, once. Deleting tools wait on it too.
   */
  async storageIdle(): Promise<void> {
    await this.ingest.historyIdle();
    const db = this.storage.accountDb;
    if (db !== null && db.isOpen) {
      await Promise.allSettled([...this.folds]);
      await db.idle();
      // A deadline that passed before its timer fired is due now: the sweep runs here too.
      const next = this.storage.readyDb()?.messages.nextExpiry() ?? null;
      if (next !== null && next <= Date.now()) await this.storage.sweepExpired();
    }
    await this.storage.expirySweep;
    for (;;) {
      const pending = this.storage.fileWork;
      await pending;
      if (pending === this.storage.fileWork) break;
    }
    const fault = this.storage.fileFault;
    this.storage.fileFault = null;
    if (fault) throw fault;
  }

  /** The folds a pairing started, let land within a bound: list_chats reads the merged rows. */
  private async foldsSettled(): Promise<void> {
    if (this.folds.size === 0) return;
    await Promise.race([Promise.allSettled([...this.folds]), sleep(FOLD_SETTLE_MS, undefined, { ref: false })]);
  }

  draft(payload: DraftPayload, owner?: string): Promise<DraftView> {
    return this.sends.draft(payload, owner);
  }

  confirm(draftId: string, owner?: string): Promise<SentMessage> {
    return this.sends.confirm(draftId, owner);
  }

  sendMessage(
    chatId: string,
    text: string,
    replyTo?: string,
    mentionIds?: string[],
    attempt?: SendAttempt
  ): Promise<SentMessage> {
    return this.sends.sendMessage(chatId, text, replyTo, mentionIds, attempt);
  }

  sendMedia(
    chatId: string,
    source: MediaSource,
    opts: { caption?: string; asDocument: boolean; asVoice: boolean; asGif: boolean },
    attempt?: SendAttempt
  ): Promise<SentMessage> {
    return this.sends.sendMedia(chatId, source, opts, attempt);
  }

  sendPoll(
    chatId: string,
    question: string,
    options: string[],
    multiSelect: boolean,
    attempt?: SendAttempt
  ): Promise<SentMessage> {
    return this.sends.sendPoll(chatId, question, options, multiSelect, attempt);
  }

  sendLocation(
    chatId: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string,
    attempt?: SendAttempt
  ): Promise<SentMessage> {
    return this.sends.sendLocation(chatId, latitude, longitude, name, address, attempt);
  }

  editMessage(messageId: string, text: string): Promise<SentMessage> {
    return this.sends.editMessage(messageId, text);
  }

  reactToMessage(messageId: string, emoji: string): Promise<{ message_id: string; emoji: string }> {
    return this.sends.reactToMessage(messageId, emoji);
  }

  forwardMessage(messageId: string, toChatId: string, attempt?: SendAttempt): Promise<SentMessage> {
    return this.sends.forwardMessage(messageId, toChatId, attempt);
  }

  deleteMessage(messageId: string, forEveryone: boolean): Promise<{ message_id: string; for_everyone: boolean }> {
    return this.guarded(async () => {
      const stored = this.views.storedOrThrow(messageId);
      const raw = this.views.messageOrThrow(messageId);
      const chat = stored.chatJid;
      const target: MessageRef = { chatJid: chat, fromMe: stored.fromMe, keyId: stored.keyId };
      if (!forEveryone) {
        // Only the linked account's copy goes, whoever sent it and however old:
        // WhatsApp syncs that to the account's other devices, and nobody else
        // sees a change.
        const sock = this.beginWrite();
        const timestamp = Math.floor(stored.ts / 1000);
        await sock.chatModify({ deleteForMe: { deleteMedia: false, key: raw.key, timestamp } }, chat);
        this.storage.requireCleanupOwner();
        this.ingest.retract([target], stored.ts);
        await this.storageIdle();
        return { message_id: messageId, for_everyone: false };
      }
      let key = raw.key;
      if (stored.fromMe) {
        if (Date.now() - stored.ts > RETRACT_WINDOW_MS) {
          throw new WazapError("RETRACT_WINDOW_EXPIRED", `Message ${messageId} is older than 2 days.`);
        }
      } else if (isGroupId(chat)) {
        // Someone else's message comes down only by a group admin's hand. Baileys
        // sends it as an admin revoke, and the key must name who sent it. Baileys
        // documents no time limit for that, so the 2-day window is not assumed here.
        await this.groups.assertGroupAdmin(chat, "delete_message");
        const participant = raw.key.participant || raw.participant;
        if (!participant) {
          throw new WazapError(
            "WHATSAPP_ERROR",
            `WhatsApp did not say who sent ${messageId}, so it cannot be deleted as an admin.`
          );
        }
        key = { ...raw.key, participant };
      } else {
        throw new WazapError("NOT_OWN_MESSAGE", `Message ${messageId} was not sent by the linked account.`);
      }
      const { sock, jid } = await this.sends.prepareSend(chat);
      await sock.sendMessage(jid, { delete: key });
      this.storage.requireCleanupOwner();
      // Deleted means out of the index too — the text does not get to linger on.
      this.ingest.retract([target], stored.ts);
      await this.storageIdle();
      return { message_id: messageId, for_everyone: true };
    });
  }

  manageChat(chatId: string, action: ChatAction, opts: ChatActionOptions = {}): Promise<ChatActionResult> {
    return this.guarded(async () => {
      const sock = this.beginWrite();
      const jid = this.identity.resolveId(chatId);
      const last = this.views.lastMessageOf(jid);
      const lastMessages = last ? [last] : [];
      const muteHours = opts.muteHours ?? 8;
      let detail = "";
      let messageId: string | undefined;

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
          await sock.chatModify({ mute: muteHours * 3_600_000 }, jid);
          detail = ` for ${muteHours}h`;
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
        case "pin_message":
        case "unpin_message": {
          const hours = opts.pinHours ?? 168;
          const time = PIN_SECONDS[hours];
          if (time === undefined) {
            throw new WazapError("INVALID_ID", `pin_hours must be 24, 168 or 720, not ${hours}.`, "Pass pin_hours as 24, 168 or 720");
          }
          const raw = this.messageInChat(opts.messageId, jid, action);
          messageId = opts.messageId;
          // A pin is a message to the chat, so every member sees it; WhatsApp ignores the time on an unpin.
          const type = action === "pin_message" ? proto.PinInChat.Type.PIN_FOR_ALL : proto.PinInChat.Type.UNPIN_FOR_ALL;
          await sock.sendMessage(jid, { pin: raw.key, type, time });
          if (action === "pin_message") detail = ` for ${hours}h`;
          break;
        }
        case "star_message":
        case "unstar_message": {
          const raw = this.messageInChat(opts.messageId, jid, action);
          messageId = opts.messageId;
          const starred = [{ id: raw.key.id ?? "", fromMe: Boolean(raw.key.fromMe) }];
          await sock.chatModify({ star: { messages: starred, star: action === "star_message" } }, jid);
          break;
        }
        case "clear":
        case "delete":
          await sock.chatModify(action === "clear" ? { clear: true, lastMessages } : { delete: true, lastMessages }, jid);
          this.storage.requireCleanupOwner();
          // The same forgetting the phone's own clear or delete gets, done now rather than on WhatsApp's echo.
          await this.forgetChat(jid, action === "delete");
          await this.storageIdle();
          break;
        case "block":
        case "unblock":
          if (isGroupId(jid) || isNoiseJid(jid)) {
            throw new WazapError(
              "INVALID_ID",
              `"${action}" works only on a one-to-one chat, and ${jid} is not one.`,
              "Pass the chat_id of a person"
            );
          }
          await sock.updateBlockStatus(jid, action);
          if (action === "block") this.blocked.add(jid);
          else this.blocked.delete(jid);
          break;
      }

      return { chat_id: jid, action, applied: `${action}${detail}`, ...(messageId ? { message_id: messageId } : {}) };
    });
  }

  /** A message named by a chat action must be in that chat, or the action would land on another one. */
  private messageInChat(messageId: string | undefined, jid: string, action: ChatAction): WAMessage {
    if (messageId === undefined) {
      throw new WazapError(
        "INVALID_ID",
        `The "${action}" action needs a message_id.`,
        "Pass a message_id from read_messages on this chat"
      );
    }
    const raw = this.views.messageOrThrow(messageId);
    const chat = this.views.chatOfOrThrow(messageId);
    if (chat !== jid) {
      throw new WazapError(
        "MESSAGE_NOT_FOUND",
        `Message ${messageId} is not in ${jid}; it belongs to ${chat}.`,
        "Pass the chat_id the message belongs to, or a message_id from read_messages on this chat"
      );
    }
    return raw;
  }

  getGroupInfo(groupId: string): Promise<GroupInfo> {
    return this.groups.getGroupInfo(groupId);
  }

  createGroup(name: string, participantIds: string[]): Promise<{ chat_id: string; participants: ParticipantResult[] }> {
    return this.groups.createGroup(name, participantIds);
  }

  joinGroup(opts: { invite?: string; messageId?: string; confirm: boolean }): Promise<JoinGroupResult> {
    return this.groups.joinGroup(opts);
  }

  manageGroup(
    groupId: string,
    action: GroupAction,
    participantIds?: string[],
    value?: string,
    source?: MediaSource
  ): Promise<GroupActionResult> {
    return this.groups.manageGroup(groupId, action, participantIds, value, source);
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

  /**
   * Runs one event's writes, and keeps a storage failure — a full disk, a
   * database closed by a stop — inside the handler: logged, never thrown into
   * Baileys' emitter.
   */
  private handling<T>(what: string, work: () => T, fallback: T): T {
    if (this.stopped) return fallback;
    try {
      return work();
    } catch (err) {
      if (!this.stopped) logError(what, err);
      return fallback;
    }
  }

  private wireEvents(sock: WASocket, generation: number): void {
    sock.ev.on("creds.update", () => {
      const save = this.saveCreds;
      if (save) void save().catch((err: unknown) => logError("creds save", err));
    });

    sock.ev.on("connection.update", (update) => {
      if (generation !== this.generation) return;
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        this.reconnectAttempts = 0;
        this.setStatus("connected");
        this.lastError = null;
        this.adoptSocketAccount();
        this.armSyncDeadline();
        log("connected to WhatsApp");
        void this.healContacts(sock, generation);
        void this.loadBlocklist(sock, generation);
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

    sock.ev.on("messaging-history.set", (batch) => this.ingest.ingestHistory(batch));

    sock.ev.on("call", ([call]) => {
      if (generation !== this.generation || !call) return;
      // WhatsApp addresses a call node by LID as often as by number, and ownJid
      // is only ever the number, so an outgoing call reads as incoming unless
      // the two are brought into the same form first.
      const from = this.identity.canonical(call.from);
      const entry = this.ingest.calls.observe({ ...call, from }, this.identity.ownJid(), Date.now());
      if (entry) this.ingest.storeCall(entry);
      this.ingest.armCallSweep();
    });

    sock.ev.on("lid-mapping.update", (mapping) => this.identity.learnLid(mapping.lid, mapping.pn));

    sock.ev.on("chats.upsert", (chats) => {
      this.handling("chats", () => this.storage.db.transaction(() => chats.forEach((chat) => this.ingest.ingestChat(chat))), undefined);
    });

    sock.ev.on("chats.update", (updates) => {
      this.handling(
        "chats",
        () =>
          this.storage.db.transaction(() => {
            for (const update of updates) {
              if (!update.id) continue;
              const jid = this.identity.canonical(update.id);
              if (isNoiseJid(jid)) continue;
              this.ingest.writeChat(jid, { ...update, id: jid });
            }
          }),
        undefined
      );
    });

    sock.ev.on("chats.delete", (ids) => {
      for (const id of ids) {
        this.handling("chat delete", () => void this.forgetChat(this.identity.canonical(id), true).catch((err: unknown) => logError("chat delete", err)), undefined);
      }
    });

    sock.ev.on("contacts.upsert", (contacts) => {
      this.handling("contacts", () => this.storage.db.transaction(() => contacts.forEach((contact) => this.ingest.ingestContact(contact))), undefined);
    });

    sock.ev.on("contacts.update", (updates) => {
      this.handling(
        "contacts",
        () =>
          this.storage.db.transaction(() => {
            for (const update of updates) if (update.id) this.ingest.ingestContact({ ...update, id: update.id });
          }),
        undefined
      );
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (this.ingest.historyPending === 0 || this.stopped) {
        this.ingest.receiveMessages(messages, type);
        return;
      }
      // While history is being stored, new messages land at once and marks on messages wait for it.
      const marks = messages.filter((raw) => this.ingest.isMark(raw));
      this.ingest.receiveMessages(messages.filter((raw) => !marks.includes(raw)), type);
      if (marks.length > 0) this.ingest.afterHistory(() => this.ingest.receiveMessages(marks, type, true));
    });

    sock.ev.on("messages.delete", (item) => {
      // The other side asked that these go; the database honours it the way the
      // phone does, vectors and files included.
      if ("all" in item) {
        this.handling("messages delete", () => void this.forgetChat(this.identity.canonical(item.jid), false).catch((err: unknown) => logError("messages delete", err)), undefined);
        return;
      }
      const targets: MessageRef[] = [];
      for (const key of item.keys) {
        if (!key.remoteJid || !key.id) continue;
        targets.push({ chatJid: this.identity.canonical(key.remoteJid), fromMe: Boolean(key.fromMe), keyId: key.id });
      }
      const at = Date.now();
      this.ingest.markLater("messages delete", () => this.ingest.retract(targets, at));
    });

    sock.ev.on("messages.update", (updates) => {
      const readSelf = updates.flatMap(({ key, update }) => (this.ingest.isReadSelfUpdate(key, update) ? [key] : []));
      this.ingest.noteReadSelf(readSelf.length);
      this.ingest.markLater("messages update", () => {
        for (const { key, update } of updates) this.ingest.applyUpdate(key, update);
        if (readSelf.length > 0) this.ingest.applyReadSelf(readSelf);
      });
    });

    // In a group, each member's receipt arrives on its own; the status is theirs combined.
    sock.ev.on("message-receipt.update", (items) => {
      // A member's receipt that is the account's own: one of its devices read a group message (a story it viewed is not a chat read).
      const readSelf = items.flatMap(({ key, receipt }) =>
        key.remoteJid && chatKindOf(this.identity.canonical(key.remoteJid)) === "group" && receipt.userJid && this.identity.isMe(receipt.userJid) && (receipt.readTimestamp || receipt.playedTimestamp)
          ? [key]
          : []
      );
      this.ingest.noteReadSelf(readSelf.length);
      this.ingest.markLater(
        "receipts",
        () =>
          this.storage.db.transaction(() => {
            if (readSelf.length > 0) this.ingest.applyReadSelf(readSelf);
            for (const { key, receipt } of items) {
              const jid = key.remoteJid ? this.identity.canonical(key.remoteJid) : undefined;
              // The account's other devices confirm its messages too; they are not members.
              if (!jid || !key.fromMe || !receipt.userJid || this.identity.isMe(receipt.userJid)) continue;
              const moments = momentsOf(receipt);
              this.storage.db.messages.receipt(messageIdFor(key, jid), this.identity.canonical(receipt.userJid), {
                deliveredAt: moments.delivered ?? null,
                readAt: moments.read ?? null,
                playedAt: moments.played ?? null,
              });
            }
          })
      );
    });

    sock.ev.on("messages.reaction", (items) => {
      this.ingest.markLater(
        "reactions",
        () => {
          for (const { key, reaction } of items) {
            const jid = key.remoteJid ? this.identity.canonical(key.remoteJid) : undefined;
            if (!jid) continue;
            const author = reaction.key?.fromMe
              ? this.identity.ownJid()
              : this.identity.canonical(reaction.key?.participant || reaction.key?.remoteJid || "");
            if (!author) continue;
            const at = protoNumber(reaction.senderTimestampMs) || Date.now();
            this.ingest.react(messageIdFor(key, jid), author, reaction.text ?? "", at);
          }
        }
      );
    });

    sock.ev.on("groups.upsert", (groups) => {
      this.handling("groups", () => groups.forEach((meta) => this.groups.cacheGroup(this.identity.canonical(meta.id), meta)), undefined);
    });

    sock.ev.on("groups.update", (updates) => {
      for (const update of updates) {
        if (!update.id) continue;
        const jid = this.identity.canonical(update.id);
        const previous = this.groups.groupCache.get(jid);
        if (previous) this.groups.groupCache.set(jid, { ...previous, ...update });
      }
    });

    sock.ev.on("group-participants.update", ({ id }) => this.groups.groupCache.delete(this.identity.canonical(id)));

    sock.ev.on("blocklist.set", ({ blocklist }) => {
      this.blocked.clear();
      for (const jid of blocklist) this.blocked.add(this.identity.canonical(jid));
    });

    sock.ev.on("blocklist.update", ({ blocklist, type }) => {
      for (const jid of blocklist) {
        if (type === "add") this.blocked.add(this.identity.canonical(jid));
        else this.blocked.delete(this.identity.canonical(jid));
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

  /** The credentials a pairing saved while start() was busy, without touching the status when there are none. */
  private linkedSinceBoot(): StatusInfo["account"] | null {
    if (this.linking !== null) return null;
    try {
      const linked = readLinkedAccount(this.paths.authDir);
      return linked ? { id: linked.id, name: linked.name, number: linked.number } : null;
    } catch {
      return null;
    }
  }

  private markCorrupt(err: unknown): void {
    this.setStatus("session_corrupt");
    this.lastError = describe(err);
    logError("auth state", err);
  }

  private adoptSocketAccount(): void {
    const user = this.sockClient?.user;
    if (!user?.id) return;
    const id = this.identity.canonical(user.id);
    this.account = { id, name: user.name ?? this.account?.name ?? "", number: id.split("@")[0] ?? "" };
    if (user.lid) this.identity.learnLid(user.lid, id);
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
        resyncedAt: this.contactsResyncedAt(),
        now: Date.now(),
      };
      if (!needsContactResync(decision)) return;
      log("address book missing; requesting a full contact sync");
      await this.resyncContacts(sock);
    } catch (err) {
      logError("contact sync", err);
    }
  }

  /** When wazap last asked WhatsApp for the whole address book, kept in the database's meta. */
  private contactsResyncedAt(): number | null {
    const stored = this.storage.readyDb()?.getMeta(IMPORT_META.contactsResyncedAt) ?? null;
    const at = stored === null ? Number.NaN : Number(stored);
    return Number.isFinite(at) ? at : null;
  }

  /**
   * Who the account has blocked, asked once per connection: WhatsApp pushes the
   * list only when it changes, so getContact would otherwise say "not blocked"
   * for everyone until then. A failure costs only that answer, so it is logged.
   */
  private async loadBlocklist(sock: WASocket, generation: number): Promise<void> {
    // A stand-in socket without the call has no blocklist to give, and nothing worth logging.
    if (typeof sock.fetchBlocklist !== "function") return;
    try {
      const blocklist = await sock.fetchBlocklist();
      if (generation !== this.generation || this.stopped) return;
      this.blocked.clear();
      for (const jid of blocklist) if (jid) this.blocked.add(this.identity.canonical(jid));
    } catch (err) {
      logError("blocklist", err);
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
    this.storage.readyDb()?.setMeta(IMPORT_META.contactsResyncedAt, String(Date.now()));
    await sock.resyncAppState(ALL_WA_PATCH_NAMES, true);
  }

  private syncState(): SyncState {
    return this.initialSyncDone ? "done" : "in_progress";
  }

  private synced<T>(data: T): Synced<T> {
    return { data, sync: this.syncState() };
  }

  /** Every public method funnels through here, so no raw Baileys or storage error escapes. */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof StorageError && err.code === "CLOSED") {
        throw new WazapError("NOT_CONNECTED", "The account is stopping.", "Call get_status, wait, retry");
      }
      throw asWazapError(err);
    }
  }

  private ensureConnected(): WASocket {
    if (this.storage.storageState === "preparing") throw this.storage.preparingError();
    if (this.storage.storageState === "failed" && this.storage.storageFault !== null) throw this.storage.storageFault;
    switch (this.status) {
      case "not_linked":
        throw new WazapError("NOT_LINKED", "No WhatsApp account is linked.", RELINK_FIX);
      case "linking":
        throw new WazapError(
          "NOT_CONNECTED",
          "Pairing is in progress.",
          "Enter the code on the phone, then call get_status"
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
    if (this.effectiveReadOnly) {
      const id = this.accountRecord.id;
      throw new WazapError(
        "READ_ONLY",
        `Account "${id}" is read-only, so this write is refused.`,
        this.accountRecord.writes === false
          ? `Run \`wazap config writes on --account ${id}\`, then restart the server`
          : "Run `wazap config writes on`, then restart the server"
      );
    }
    const sock = this.ensureConnected();
    this.writes.take();
    return sock;
  }

  /**
   * The bytes behind a message's media — saving them and transcribing them
   * share this. Media arrives whole in memory, so the size is checked twice:
   * the declared length before the download starts, and the stream itself
   * while it lands — a sender can understate the first, not the second.
   */
  private async mediaBuffer(sock: WASocket, messageId: string, raw: WAMessage): Promise<Buffer> {
    const declared = mediaInfo(raw)?.size;
    if (declared !== undefined && declared > MEDIA_DOWNLOAD_MAX_BYTES) {
      throw new WazapError(
        "FILE_TOO_LARGE",
        `The media of ${messageId} is ${Math.ceil(declared / 1_000_000)} MB; downloads are capped at ${MEDIA_DOWNLOAD_MAX_BYTES / 1_000_000} MB.`
      );
    }
    try {
      const stream = await downloadMediaMessage(raw, "stream", {}, {
        logger: silentLogger,
        reuploadRequest: sock.updateMediaMessage,
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of stream) {
        this.views.messageOrThrow(messageId);
        bytes += (chunk as Buffer).length;
        if (bytes > MEDIA_DOWNLOAD_MAX_BYTES) {
          stream.destroy();
          throw new WazapError(
            "FILE_TOO_LARGE",
            `The media of ${messageId} exceeds the ${MEDIA_DOWNLOAD_MAX_BYTES / 1_000_000} MB download cap.`
          );
        }
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    } catch (err) {
      if (err instanceof WazapError) throw err;
      const failure = new WazapError(
        "MEDIA_UNAVAILABLE",
        `Could not download the media of ${messageId}: ${describe(err)}`,
        "Ask the sender to resend it"
      );
      // Not enumerable, so no answer serializes it: the transcription queue reads its status to tell expired media from a timeout.
      Object.defineProperty(failure, "cause", { value: err, configurable: true, writable: true });
      throw failure;
    }
  }

  /**
   * Live messages both ways, queued for the webhook in the transaction that
   * stores them, and only on the notify gate transcription uses: a history
   * sync must not post the backlog, and stubs or system notices are not events.
   * That gate is also what keeps wazap's own sends quiet in production, since
   * Baileys re-emits a local send as an `append`; `sentByWazap` is the id-level
   * backstop for an echo that does arrive as `notify`. An event the webhook
   * does not subscribe to is never written, and a message delivered twice is
   * queued once. An incoming voice note waits for its transcript, at most
   * WEBHOOK_TRANSCRIPT_WAIT_MS. A write the database refuses fails the whole
   * transaction, messages included, so none is stored without its event.
   * Returns `stored`, for the caller to go on with.
   */
  private announced(stored: WAMessage[], type: string): WAMessage[] {
    if (type !== "notify" || this.stopped || stored.length === 0) return stored;
    const settings = this.webhook.settings();
    if (settings.kind !== "ready") return stored;
    const db = this.storage.db;
    const now = Date.now();
    for (const raw of stored) {
      let sid: string;
      let event: "message_received" | "message_sent";
      try {
        if (!isUserMessage(raw)) continue;
        if (this.webhookOwnSend(raw)) continue;
        event = raw.key.fromMe ? "message_sent" : "message_received";
        if (!settings.events.includes(event)) continue;
        sid = messageIdFor(raw.key, this.identity.canonical(raw.key.remoteJid ?? ""));
      } catch (err) {
        // A message this cannot make sense of is not announced; the rest of the batch still is.
        logError("webhook", err);
        continue;
      }
      const message = db.messages.get(sid);
      if (message === null || db.events.hasMessageEvent(message.id, event)) continue;
      db.events.enqueue({
        kind: event,
        lane: chatLane(message.chatId),
        messageId: message.id,
        payload: JSON.stringify({ is_self_chat: this.identity.isMe(message.chatJid) }),
        createdAt: now,
        readyAt: this.webhookReadyAt(message, now),
      });
    }
    return stored;
  }

  /**
   * Seam (F1-e): whether wazap sent this message itself, so its echo is never
   * announced as `message_sent`. Runs inside the transaction that stores the
   * echo; the durable send record is what should answer it, so an echo after
   * a restart is recognised too.
   */
  private webhookOwnSend(raw: WAMessage): boolean {
    return Boolean(raw.key.fromMe && raw.key.id && this.sends.isOwnSend(raw.key.id));
  }

  /**
   * Until when a message's event may wait for its words: WEBHOOK_TRANSCRIPT_WAIT_MS
   * for a voice note the transcription queue took, due at once otherwise. The
   * queue row is written earlier in the same transaction by queueTranscript,
   * so this is the queue's own rule (`transcribable`, the history window, the
   * provider), not a copy of it.
   */
  private webhookReadyAt(message: StoredMessage, now: number): number {
    return this.voice.transcriptQueued(message) ? now + WEBHOOK_TRANSCRIPT_WAIT_MS : now;
  }

  /**
   * The transcription worker is done with a note — words stored, failed, given
   * up on, or unable to run — or with every note (`null`: the provider paused):
   * the events held for them look again now.
   */
  private webhookTranscriptSettled(_sid: string | null): void {
    this.outbox.kick();
  }

  /**
   * The body of an event as it is posted: a message event from the message as
   * the database holds it now, so an edit or a transcript that landed since it
   * was queued goes with it; a connection event as it was queued, under the
   * account's current name.
   */
  private webhookPayload(event: EventRecord, message: StoredMessage | null): WebhookPayload {
    const stored = JSON.parse(event.payload) as Record<string, unknown>;
    const account = this.accountRecord;
    if (message === null) {
      return { ...(stored as unknown as WebhookConnectionPayload), account_id: account.id, account_name: account.name };
    }
    return asWebhookPayload({
      event: event.kind === "message_sent" ? "message_sent" : "message_received",
      view: this.views.viewOfStored(message),
      account,
      isSelfChat: stored.is_self_chat === true,
    });
  }

  /** get_status's webhook block: settings, and the outbox as the account database records it. */
  private webhookStatus(): StatusInfo["webhook"] {
    if (this.webhook.settings().kind !== "ready") return this.webhook.info(undefined, null);
    const delivery = this.outbox.delivery(this.storage.readyDb());
    return this.webhook.info(delivery, undeliveredFailure(delivery));
  }

  private async fetchOlder(sock: WASocket, anchor: StoredMessage, limit: number): Promise<void> {
    const raw = this.views.rawOf(anchor) ?? this.views.keyOnly(anchor);
    const seconds = Math.floor(anchor.ts / 1000);
    await sock.fetchMessageHistory(limit, raw.key, seconds);
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

}

/** How long a pinned message stays pinned, by the hours manage_chat takes: WhatsApp's 24 hours, 7 days and 30 days. */
const PIN_SECONDS: Record<number, 86_400 | 604_800 | 2_592_000> = { 24: 86_400, 168: 604_800, 720: 2_592_000 };

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function statusTextOf(entry: { [protocol: string]: unknown } | undefined): string | null {
  const status = entry?.status;
  if (status && typeof status === "object" && "status" in status) {
    return (status as { status?: string | null }).status ?? null;
  }
  return typeof status === "string" ? status : null;
}

/** A tag is a lowercase token: "#Client  Ro" files as "client-ro". */
function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#+/, "").replace(/\s+/g, "-");
}

function requireTag(raw: string): string {
  const tag = normalizeTag(raw);
  if (tag === "" || tag.length > MAX_TAG_CHARS) {
    throw new WazapError("INVALID_ID", `"${raw}" is not a usable tag.`, 'Pass a short label like "client"');
  }
  return tag;
}

function requireFieldKey(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (key === "" || key.length > MAX_FIELD_KEY_CHARS) {
    throw new WazapError("INVALID_ID", `"${raw}" is not a usable detail key.`, 'Pass a short key like "role"');
  }
  return key;
}

function safeFilename(jid: string): string {
  return jid.replace(/[/\\:*?"<>|]/g, "_");
}
