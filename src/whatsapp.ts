/**
 * WhatsApp service over Baileys. Baileys emits raw events rather than exposing
 * a queryable store, so this files what they carry in the account database
 * (`accounts/<id>/wazap.sqlite`, see src/db) and answers the tools from it.
 * What stays in memory is bounded by people and chats, never by messages: the
 * lid pairings, group metadata, the last arrivals a wait can replay, drafts.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ALL_WA_PATCH_NAMES,
  type BaileysEventMap,
  DisconnectReason,
  downloadMediaMessage,
  normalizeMessageContent,
  proto,
  type Chat as BaileysChat,
  type Contact as BaileysContact,
  type GroupMetadata,
  type GroupParticipant,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from "baileys";
import type { ILogger } from "baileys/lib/Utils/logger.js";
import { accountPolicy, type AccountRecord } from "./accounts.js";
import { clearSession, readLinkedAccount, useAtomicAuthState, type LinkedAccount } from "./auth-state.js";
import { CallTracker, callMessage, isTrackedCall, type CallEntry } from "./calls.js";
import { BAILEYS_VERSION, WAZAP_VERSION, writesHints, type AccountPaths, type Config } from "./config.js";
import {
  AccountDb,
  chatKindOf,
  secondOfId,
  StorageError,
  type ChatKind,
  type ChatRecord,
  type MessageInput,
  type Receipt as StoredReceipt,
  type StoredMessage,
  type UpsertResult,
} from "./db/index.js";
import { asWazapError, RELINK_FIX, RESET_FIX, WazapError } from "./errors.js";
import { LidRegistry, lidKey } from "./identity.js";
import { isGroupId, isNoiseJid, isStatusJid, normalizePhone, STATUS_JID } from "./ids.js";
import { FUTURE_SLACK_MS, IMPORT_META, importBetaArchive, importLegacyAccount, scrubQuote, type ImportReport } from "./legacy-import/index.js";
import {
  LEGACY_TTL_MS,
  accountBetaState,
  carryLegacyRecord,
  lateBetaArchive,
  legacyRecordOf,
  legacySchedule,
  linkedOwners,
  moveAccountLegacy,
  purgeAccountLegacy,
  purgePreviousOwners,
  setAsideFor,
  settleAccountArchive,
  settleBetaArchive,
} from "./legacy-files.js";
import { log, logError } from "./logger.js";
import { messageExpiry } from "./message-expiry.js";
import {
  asGifMedia,
  assertMediaSource,
  describe,
  loadMedia,
  loadProfilePicture,
  mediaContent,
  mediaFilename,
} from "./outgoing-media.js";
import { makePreview, videoFrame } from "./previews.js";
import { safeLinkPreview } from "./link-preview.js";
import { chatMetadata, decodeChat, encode, momentsOf, raiseStatus, raiseUser, type Receipt } from "./store.js";
import {
  buildMessageView,
  callInfo,
  formatAge,
  isCallPlaceholder,
  isControlMessage,
  isEvent,
  isStubEvent,
  isUserMessage,
  isoWithOffset,
  mediaInfo,
  mentionedJids,
  messageIdFor,
  messageText,
  messageTimestampMs,
  messageType,
  phoneOf,
  pollOf,
  protoNumber,
  quotedMessageId,
  quotedSenderJid,
  reactionOf,
  revokedTargetKey,
  searchableText,
  thumbnailOf,
  viewText,
  voiceSeconds,
  voteOf,
  type EncryptedVote,
} from "./messages.js";
import { readVote } from "./polls.js";
import { PAIRING_TIMEOUT_MS, WA_BROWSER, prettyCode, socketFactory, startPairing } from "./pairing.js";
import { diversify } from "./recall/variety.js";
import {
  EMBED_MODELS,
  EmbedEngine,
  EmbedFeed,
  embedReady,
  RECALL_TEXT_CAP,
  readRecallSettings,
  type RecallSettings,
  type RecallStatus,
} from "./recall/index.js";
import {
  readTranscribeSettings,
  transcribeFile,
  TranscribeQueue,
  transcribeReady,
  type Transcript,
  type TranscribeSettings,
  type TranscriptRecord,
} from "./transcribe/index.js";
import { DraftStore, withMentionTokens, type Draft, type DraftPayload, type DraftView } from "./drafts.js";
import { RateLimiter } from "./ratelimit.js";
import { IMPORT_UNVERIFIED_META, importProgress } from "./storage-status.js";
import { maskNumber } from "./ui.js";
import { SentIds } from "./sent-ids.js";
import {
  WebhookSink,
  asConnectionPayload,
  asWebhookPayload,
  webhookConnectionStatus,
  type WebhookConnectionStatus,
} from "./webhook.js";
import type { SearchCoverage } from "./coverage.js";
import type {
  CallInfo,
  ChatAction,
  ChatActionOptions,
  ChatActionResult,
  ChatFilter,
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
  JoinRequest,
  MediaResult,
  MediaSource,
  MessageType,
  OutgoingTarget,
  MessageView,
  PairingInfo,
  ParticipantResult,
  RecallAnswer,
  RecallHit,
  RecentConversation,
  SentMessage,
  StatusInfo,
  StorageInfo,
  SyncState,
  Synced,
  TranscribeResult,
  WhatsAppApi,
  HandledResult,
  Preview,
  SearchAnswer,
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
/** Hybrid hits recall ranks for variety before it cuts the list to the limit. */
const RECALL_RERANK_WINDOW = 100;
/** A match found by meaning counts half as much a month on, as the old recall index ranked it. */
const RECALL_RECENCY_HALF_LIFE_MS = 30 * 86_400_000;
/** Messages get_recent_messages returns per chat: the newest of its window, as many as main's per-chat ring held. */
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
/** How far back into a chat a poll that just arrived looks for the votes that came before it. */
const EARLY_VOTE_SCAN = 2_000;
/** Messages read_messages walks past a type filter before it answers with what it found. */
const TYPE_FILTER_SCAN = 10_000;
/** A download is buffered in memory, so the biggest file it may pull is bounded. */
const MEDIA_DOWNLOAD_MAX_BYTES = 100_000_000;
/** Ten minutes of speech. Past that, auto-transcribing is a bill nobody asked for. */
const AUTO_TRANSCRIBE_MAX_SECONDS = 600;
/** How long a message event waits for the transcript of the voice note it carries. */
const WEBHOOK_TRANSCRIPT_WAIT_MS = 60_000;
/** How long list_chats waits for a lid chat still folding into its number before it lists what it has. */
const FOLD_SETTLE_MS = 2_000;
/** How long one transaction of a history batch may hold the event loop. */
const HISTORY_CHUNK_MS = 20;
/** How long the recall status reuses its count of stored vectors. */
const VECTOR_COUNT_TTL_MS = 10_000;
/** Chat kinds a person can be waiting in: every one but the status feed. */
const WAITING_KINDS: readonly ChatKind[] = ["direct", "group", "newsletter", "broadcast"];
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** The account database's file, beside the account's credentials. */
const DB_FILE = "wazap.sqlite";
/** How often a running service looks again at legacy files whose week may be up. */
const LEGACY_SWEEP_MS = 24 * 60 * 60 * 1000;

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
/** How long stop waits for a cancelled pairing socket to close. */
const PAIRING_STOP_MS = 5_000;

/** Resolves to `null` when `work` rejects or is still pending after `ms`. */
function orNullAfter<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work.catch(() => null), guard]).finally(() => clearTimeout(timer));
}

/**
 * Whether an account still has files from before the account database: the
 * snapshot, history, barriers, notes, the recall index, or a 0.15-beta
 * archive. The import reads them once; F1-b2b moves them aside afterwards.
 */
function legacyFilesPresent(dataDir: string, paths: AccountPaths): boolean {
  const files = [
    paths.storeFile,
    paths.notesFile,
    join(paths.root, "retention.json"),
    join(paths.root, "recall", "state.json"),
    join(paths.root, "archive.sqlite"),
    join(dataDir, "archive.sqlite"),
  ];
  if (files.some((file) => existsSync(file))) return true;
  try {
    return readdirSync(paths.historyDir).some((name) => name.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

/** A message a reply, a vote or a delete names by its chat, direction and key. */
interface MessageRef {
  chatJid: string;
  fromMe: boolean;
  keyId: string;
}

/** The deleted or expired message's words no longer answer anything; the row is gone to readers. */
function missingMessage(messageId: string): WazapError {
  return new WazapError(
    "MESSAGE_NOT_FOUND",
    `No message "${messageId}" is loaded.`,
    "Use a message_id from read_messages or search_messages"
  );
}

type HistorySetEvent = BaileysEventMap["messaging-history.set"];

/** What viewsOfStored reads once for a whole list of messages. */
interface ViewLookups {
  marks: ReturnType<AccountDb["messages"]["marksOf"]>;
  nameFor: (jid: string, pushName?: string) => string;
  noteFor: (jid: string) => string | undefined;
}

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
  /**
   * History batches stored one after another, and the live marks (edits,
   * reactions, receipts, deletes) that arrived while one was being stored,
   * each after the work before it; storageIdle waits on the chain.
   */
  private historyWork: Promise<void> = Promise.resolve();
  /** Batches and marks on the chain that have not run yet. */
  private historyPending = 0;
  private syncDeadline: ReturnType<typeof setTimeout> | null = null;
  private syncWaiters: Array<() => void> = [];
  /** Inbound messages as they land, newest last, so a wait can resume from a cursor. */
  private readonly arrivals: Array<{ seq: number; sid: string; jid: string }> = [];
  private arrivalSeq = 0;
  private readonly bootId = randomUUID().slice(0, 8);
  private arrivalWaiters: Array<() => void> = [];
  private historyWaiters: Array<() => void> = [];
  private callSweepTimer: ReturnType<typeof setInterval> | null = null;
  private contactResyncTried = false;
  private readonly previewLink = safeLinkPreview;
  private readonly blocked = new Set<string>();
  private readonly groupCache = new Map<string, GroupMetadata>();
  /** Groups whose metadata WhatsApp refused, so we stop asking on every read. */
  private readonly unreadableGroups = new Set<string>();
  /** Every lid ↔ number pairing, mirrored from the account database: the ids every read hands out. */
  private lids = new LidRegistry();
  /** The account database, opened in the constructor; null only when it could not be opened. */
  private accountDb: AccountDb | null = null;
  /**
   * `preparing` while the legacy files are being imported, `failed` when the
   * database could not be opened or prepared. Tools refuse in both, the first
   * with NOT_CONNECTED, which says "retry later" to every client.
   */
  private storageState: "ready" | "preparing" | "failed" = "ready";
  private storageFault: WazapError | null = null;
  private storageBoot: Promise<void> | null = null;
  /** Lid chats still folding into their number's chat; list_chats lets them land. */
  private readonly folds = new Set<Promise<unknown>>();
  private stopPromise: Promise<void> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The daily pass over the legacy files, the beta archive and set-aside databases. */
  private legacyTimer: ReturnType<typeof setInterval> | null = null;
  private expiryAt: number | undefined;
  private expirySweep: Promise<void> = Promise.resolve();
  /** Unlinking the files deleted messages released, one pass at a time. */
  private fileWork: Promise<void> = Promise.resolve();
  /** A cleanup that failed, reported once to whoever waits for cleanup next. */
  private fileFault: WazapError | null = null;
  private readonly calls = new CallTracker();
  private readonly paths: AccountPaths;
  /** The transcription environment, or the complaint about it. See `readTranscribeConfig`. */
  private readonly transcribe: TranscribeSettings | WazapError;
  /** The recall environment, or the complaint about it. Same rule as transcribe: a bad env is a line, not a crash. */
  private readonly recallEnv: RecallSettings | WazapError;
  /** Embeds what the database holds; null when recall is off. */
  private readonly embedFeed: EmbedFeed | null;
  private vectorCount: { at: number; count: number } | null = null;
  /** The sidecar starts on the first embedding call, never at boot. */
  private recallEngineP: Promise<EmbedEngine> | null = null;
  /** Null unless a provider is configured and auto mode is on. */
  private readonly transcribeQueue: TranscribeQueue | null;
  /** The seam the tests replace; production always runs the real providers. */
  private transcriber = transcribeFile;
  /** Transcriptions under way, so one recording is never uploaded twice at once. */
  private readonly transcribing = new Map<string, Promise<TranscribeResult>>();
  private readonly drafts = new DraftStore();
  private readonly writes: RateLimiter;
  private readonly webhook: WebhookSink;
  /** Sends of our own, so their `fromMe` echo is never announced as `message_sent`. */
  private readonly sentByWazap = new SentIds();
  /** The last status a consumer was told, so several internal states collapse into one event. */
  private lastWebhookStatus: WebhookConnectionStatus | null = null;
  /** Connection posts run one at a time, so a consumer sees the order the link moved in. */
  private connectionPosts: Promise<void> = Promise.resolve();
  private readonly accountRecord: AccountRecord;
  private readonly effectiveReadOnly: boolean;
  private readonly effectiveRateLimit: number;

  constructor(
    private readonly config: Config,
    account: AccountRecord,
    paths: AccountPaths
  ) {
    this.accountRecord = account;
    this.webhook = new WebhookSink(process.env, { account, statsFile: paths.webhookFile });
    const policy = accountPolicy(account, config);
    this.effectiveReadOnly = policy.readOnly;
    this.effectiveRateLimit = policy.rateLimit;
    this.writes = new RateLimiter(this.effectiveRateLimit);
    this.paths = paths;
    this.transcribe = readTranscribeConfig(config.dataDir);
    this.recallEnv = readRecallConfig(config.dataDir);
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
    const recall = this.recallEnv;
    this.embedFeed =
      recall instanceof WazapError || !recall.enabled || !config.persistHistory
        ? null
        : new EmbedFeed({
            db: () => this.readyDb(),
            model: recall.model,
            words: (message) => this.recallWords(message),
            embed: (texts) => this.recallEmbed(texts, "document"),
          });
    this.openDatabase();
  }

  async start(): Promise<void> {
    if (this.stopped || this.starting) return;
    this.starting = true;
    try {
      let linked = this.readAccount();
      if (linked !== "corrupt" && linked !== null) {
        this.account = linked;
        this.claimDatabase(linked.id);
      }
      await this.bootStorage();
      // A stop during the boot (a logout, a removal) must not be followed by a socket.
      if (this.stopped) return;
      if (linked === "corrupt" || linked === null) {
        // A link that finished while the database was being prepared found this
        // start() still running, so its own start() returned at once: pick it up.
        const since = this.linkedSinceBoot();
        if (since === null) return;
        linked = since;
        this.account = linked;
        this.claimDatabase(linked.id);
        // A claim that swapped the database prepares the one it put in place.
        await this.bootStorage();
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
        getMessage: async (key) => this.storedProto(key),
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
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.legacyTimer) clearInterval(this.legacyTimer);
    this.legacyTimer = null;
    this.expiryTimer = null;
    this.expiryAt = undefined;
    for (const timer of [this.reconnectTimer, this.syncDeadline]) {
      if (timer) clearTimeout(timer);
    }
    this.reconnectTimer = null;
    this.syncDeadline = null;
    this.stopCallSweep();
    this.releaseWaiters();
    this.wakeArrivalWaiters();
    this.webhook.flushStats();
    this.teardownSocket();
    await this.stopPairing();
    await this.historyIdle();
    await this.stopRecall();
    const db = this.accountDb;
    if (db !== null && db.isOpen) {
      await Promise.allSettled([this.expirySweep, ...this.folds]);
      await db.idle().catch(() => {});
      await this.fileWork.catch(() => {});
      // An account that keeps no history forgets it when it stops, as it did when nothing reached the disk.
      if (!this.config.persistHistory && this.storageState === "ready") {
        await db.messages.purgeLive().catch((err: unknown) => logError("history purge", err));
        await this.unlinkReleased().catch(() => {});
      }
      db.close();
    }
  }

  // Storage ------------------------------------------------------------------

  /** The account database's path. */
  get databasePath(): string {
    return join(this.paths.root, DB_FILE);
  }

  /**
   * The account database for tests and for the doctor: every read and seed
   * goes through the same API the tools use. Refuses while the account is
   * still importing its earlier files, and when the database failed.
   */
  get db(): AccountDb {
    if (this.storageState === "preparing") throw this.preparingError();
    if (this.accountDb === null || this.storageState === "failed") {
      throw this.storageFault ?? new WazapError("SERVICE_ERROR", "The account database is not open.");
    }
    if (!this.accountDb.isOpen) {
      throw new WazapError("NOT_CONNECTED", "The account is stopping.", "Call get_status, wait, retry");
    }
    return this.accountDb;
  }

  /** The database when it answers reads and takes writes, or null: preparing, failed, stopped. */
  private readyDb(): AccountDb | null {
    const db = this.accountDb;
    return db !== null && db.isOpen && this.storageState === "ready" ? db : null;
  }

  private preparingError(): WazapError {
    return new WazapError(
      "NOT_CONNECTED",
      `Account "${this.accountRecord.id}" is preparing its database from its earlier message files. This happens once, after an upgrade.`,
      "Call get_status, wait, retry"
    );
  }

  private storageFail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const fix = err instanceof StorageError || err instanceof WazapError ? err.fix : undefined;
    this.storageState = "failed";
    this.storageFault = new WazapError(
      "SERVICE_ERROR",
      `The account database of "${this.accountRecord.id}" could not be used: ${message}`,
      fix ?? "Run `wazap status`, check the account directory's permissions and free disk space, then restart the server"
    );
    logError(`account database ${this.accountRecord.id}`, err);
  }

  /**
   * Opens the database synchronously, so a service answers from the moment it
   * exists; the import, the purge of an interrupted clear and the rest of the
   * boot wait for bootStorage().
   */
  private openDatabase(): void {
    try {
      const db = AccountDb.open(this.databasePath, { scrubQuote, now: () => Date.now() });
      this.accountDb = db;
      this.adoptDatabase(db);
      if (this.legacyPending(db)) this.storageState = "preparing";
    } catch (err) {
      this.storageFail(err);
    }
  }

  /** What the service mirrors from a database it starts reading: the pairings and the last sign of life. */
  private adoptDatabase(db: AccountDb): void {
    for (const [lid, phone] of db.identity.lidPairs()) this.lids.learn(lid, phone);
    this.lastInboundAt = db.messages.lastInboundTs();
    this.namedContactsCache = null;
    this.vectorCount = null;
  }

  private legacyPending(db: AccountDb): boolean {
    const state = db.getMeta(IMPORT_META.state);
    if (state === "done" || state === "imported" || state === "skipped") return false;
    return state === "running" || legacyFilesPresent(this.config.dataDir, this.paths);
  }

  /**
   * Ties the database to the linked number. A file another number filled — the
   * account logged out and a different phone linked — is set aside whole, next
   * to it: one person's history never shows under another's. The newest file
   * set aside for the linking number takes its place when there is one (that
   * number linked here before), otherwise a fresh one does. Legacy files the
   * earlier import read stay unread, and the record of what was moved to
   * legacy/ goes with whichever database serves next, so its week still runs.
   */
  private claimDatabase(owner: string): void {
    const db = this.accountDb;
    if (db === null || !db.isOpen || this.storageState === "failed") return;
    try {
      db.bindOwner(owner);
      return;
    } catch (err) {
      if (!(err instanceof StorageError) || err.code !== "OWNER_MISMATCH") {
        this.storageFail(err);
        return;
      }
    }
    const imported = db.getMeta(IMPORT_META.state) !== null;
    const legacy = legacyRecordOf(db);
    db.close();
    const now = Date.now();
    const aside = join(this.paths.root, `wazap.${now}.previous-owner.sqlite`);
    try {
      const restore = setAsideFor(this.paths.root, owner);
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(`${this.databasePath}${suffix}`)) renameSync(`${this.databasePath}${suffix}`, `${aside}${suffix}`);
      }
      if (restore !== null) {
        // The database file first: a -wal never lands beside a file it does not belong to.
        for (const suffix of ["", "-wal", "-shm"]) {
          const from = join(this.paths.root, `${restore}${suffix}`);
          if (existsSync(from)) renameSync(from, `${this.databasePath}${suffix}`);
        }
        log(`account ${this.accountRecord.id}: a number linked here before is linked again; its database is back, the other one set aside`);
      } else {
        log(`account ${this.accountRecord.id}: a different number is linked; its earlier database was set aside`);
      }
      const next = AccountDb.open(this.databasePath, { scrubQuote, now: () => Date.now() });
      this.accountDb = next;
      if (restore === null && (imported || legacyFilesPresent(this.config.dataDir, this.paths))) next.setMeta(IMPORT_META.state, "skipped");
      carryLegacyRecord(legacy, next);
      next.bindOwner(owner);
      this.lids = new LidRegistry();
      this.adoptDatabase(next);
      this.storageState = this.legacyPending(next) ? "preparing" : "ready";
      // The next bootStorage() prepares the database now in place.
      this.storageBoot = null;
    } catch (err) {
      this.storageFail(err);
    }
  }

  /**
   * What start() runs before the socket, once per service: finish a fold or a
   * purge a stop interrupted, import the account's earlier files the first
   * time, forget the history of an account that keeps none, reconcile preview
   * files, and arm the expiry timer and the embedding feed. Tests call it to
   * boot a service without a socket.
   */
  bootStorage(): Promise<void> {
    this.storageBoot ??= this.bootStorageOnce().catch((err: unknown) => {
      this.storageBoot = null;
      throw err;
    });
    return this.storageBoot;
  }

  private async bootStorageOnce(): Promise<void> {
    const db = this.accountDb;
    if (db === null || this.storageState === "failed") throw this.storageFault ?? new WazapError("SERVICE_ERROR", "The account database is not open.");
    if (this.stopped || !db.isOpen) return;
    try {
      await db.resume();
      if (this.legacyPending(db)) {
        this.storageState = "preparing";
        log(`account ${this.accountRecord.id}: importing the earlier message files into the account database (once)`);
        const report = await importLegacyAccount({
          dataDir: this.config.dataDir,
          accountId: this.accountRecord.id,
          accountPaths: this.paths,
          db,
          options: { retention: this.config.retention === true },
        });
        this.noteImport(db, report);
        this.lids = new LidRegistry();
        this.adoptDatabase(db);
      }
      await this.importLateBeta(db);
      if (this.stopped || !db.isOpen) return;
      if (!this.config.persistHistory) await db.messages.purgeLive();
      this.storageState = "ready";
    } catch (err) {
      if (this.stopped || !db.isOpen) return;
      this.storageFail(err);
      throw this.storageFault!;
    }
    await this.reconcilePreviews(db).catch((err: unknown) => logError("preview reconcile", err));
    await this.scheduleFileCleanup().catch(() => {});
    this.retireLegacy();
    if (this.legacyTimer === null && !this.stopped) {
      this.legacyTimer = setInterval(() => this.retireLegacy(), LEGACY_SWEEP_MS);
      this.legacyTimer.unref();
    }
    this.armExpiry();
    if (this.embedFeed !== null) this.embedFeed.kick();
    else {
      // Recall is off, or its settings do not parse: no queue is kept that nothing
      // would drain. The feed that runs again refills it once.
      try {
        db.vectors.unfeed();
      } catch (err) {
        logError("recall index", err);
      }
    }
  }

  /**
   * A beta archive this account's number owns and its import did not take (it
   * was not linked then, or the archive came later): imported now, before the
   * account serves, so the archive is never retired with rows only it holds.
   * A failure is logged and retried at the next start; the archive stays.
   */
  private async importLateBeta(db: AccountDb): Promise<void> {
    const archive = lateBetaArchive(this.config.dataDir, this.paths, db);
    if (archive === null || this.stopped || !db.isOpen) return;
    const before = this.storageState;
    this.storageState = "preparing";
    log(`account ${this.accountRecord.id}: importing the beta archive.sqlite its number owns (once)`);
    try {
      const result = await importBetaArchive({
        dataDir: this.config.dataDir,
        accountId: this.accountRecord.id,
        accountPaths: this.paths,
        db,
        betaArchive: archive,
        options: { retention: this.config.retention === true },
      });
      const beta = result.phases?.beta;
      log(`account ${this.accountRecord.id}: beta archive ${result.outcome}${beta ? `, ${beta.imported} messages added` : ""}`);
      this.lids = new LidRegistry();
      this.adoptDatabase(db);
    } catch (err) {
      if (this.stopped || !db.isOpen) return;
      const code = (err as { code?: unknown })?.code;
      logError(`account ${this.accountRecord.id}`, `the beta archive import failed (${typeof code === "string" ? code : "error"}); it stays and is tried again at the next start`);
    } finally {
      if (this.storageState === "preparing") this.storageState = before;
    }
  }

  /**
   * What the legacy files' week asks of this account, at boot and daily:
   * move its imported legacy files into legacy/, delete what is due (a week
   * on, at once under WAZAP_RETENTION=1, never an unverified import's), and
   * move or delete the beta archive. Each step fails alone and is logged by
   * its error code, never by a path inside the files.
   */
  private retireLegacy(): void {
    const db = this.readyDb();
    if (db === null) return;
    const id = this.accountRecord.id;
    const now = Date.now();
    const retention = this.config.retention === true;
    const step = (what: string, run: () => void): void => {
      try {
        run();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code ?? (err instanceof Error ? err.name : "error");
        logError(`account ${id}`, `${what} failed (${code}); tried again at the next pass`);
      }
    };
    step("moving the earlier message files into legacy/", () => {
      const { moved, recorded } = moveAccountLegacy(this.paths.root, db, now);
      if (!recorded || moved === 0) return;
      const schedule = legacySchedule(db);
      const when =
        schedule?.deleteAfter == null
          ? "kept until you delete them"
          : retention
            ? "deleted now (WAZAP_RETENTION=1)"
            : `deleted after ${isoWithOffset(schedule.deleteAfter)}`;
      log(`account ${id}: moved ${moved} earlier message files into legacy/, ${when}`);
    });
    step("deleting legacy/", () => {
      const entries = purgeAccountLegacy(this.paths.root, db, now, retention);
      if (entries !== null) log(`account ${id}: deleted ${entries} earlier message files from legacy/`);
    });
    step("settling the account's beta archive", () => {
      const { moved, deleted } = settleAccountArchive(this.paths.root, db, now, retention);
      if (moved) log(`account ${id}: moved its beta archive.sqlite into legacy/`);
      if (deleted > 0) log(`account ${id}: deleted ${deleted} beta archive(s) from legacy/`);
    });
    step("deleting set-aside databases", () => {
      const deleted = purgePreviousOwners(this.paths.root, now, linkedOwners(this.config.dataDir));
      if (deleted > 0) log(`account ${id}: deleted ${deleted} database(s) set aside when a different number linked`);
    });
    step("settling the beta archive", () => {
      const { moved, deleted } = settleBetaArchive(this.config.dataDir, now, retention, (accountId) =>
        accountId === id ? accountBetaState(db) : undefined
      );
      if (moved) log("moved the beta archive.sqlite into legacy/");
      if (deleted > 0) log(`deleted ${deleted} beta archive(s) from legacy/`);
    });
  }

  /** Logs how the import went; an import with unexplained differences still serves, and says so for doctor. */
  private noteImport(db: AccountDb, report: ImportReport): void {
    const counts = `${report.totals.messages} messages, ${report.totals.chats} chats`;
    if (report.state === "done") {
      db.setMeta(IMPORT_UNVERIFIED_META, null);
      log(`account ${this.accountRecord.id}: imported ${counts}, verified`);
      return;
    }
    const unexpected = report.verification?.unexpected ?? {};
    db.setMeta(IMPORT_UNVERIFIED_META, JSON.stringify({ at: report.finishedAt, unexpected }));
    const summary = Object.entries(unexpected)
      .map(([kind, n]) => `${kind} ${n}`)
      .join(", ");
    logError(
      `account ${this.accountRecord.id}`,
      `imported ${counts}, but verification found differences it could not explain (${summary || "verification did not run"}); serving from the database`
    );
  }

  /**
   * Preview files the database does not know: kept and recorded when their
   * message is still visible (a preview made before the upgrade), removed when
   * it is not. Bounded by the files in the folder.
   */
  private async reconcilePreviews(db: AccountDb): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.paths.previewsDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".jpg")) continue;
      const path = join(this.paths.previewsDir, name);
      if (!db.isOpen) return;
      const sid = name.slice(0, -".jpg".length);
      const known = db.messages.get(sid);
      if (known !== null && db.messages.media(sid).some((media) => media.kind === "preview" && media.path === path)) continue;
      if (known === null || !db.messages.setMedia(sid, "preview", path).stored) await rm(path, { force: true });
    }
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
    const db = this.readyDb();
    if (db === null) return { chats: 0, contacts: 0, messages: 0 };
    const chats = db.identity.listChats().filter((chat) => this.listed(chat)).length;
    return { chats, contacts: this.namedContacts(), messages: db.counts().messages };
  }

  /** This account already has a chat, or messages, for this jid. Contacts do not count. */
  hasChat(jid: string): boolean {
    const id = this.canonical(jid);
    if (!id || isNoiseJid(id)) return false;
    const chat = this.readyDb()?.identity.chat(id) ?? null;
    return chat !== null && this.listed(chat);
  }

  hasMessage(id: string): boolean {
    if (this.stopped) return false;
    try {
      const db = this.readyDb();
      if (db === null) return false;
      if (db.messages.get(id) !== null) return true;
      this.settleExpired(db, id);
      return false;
    } catch {
      return false;
    }
  }

  /**
   * A message a read found past its deadline becomes a tombstone there and
   * then, before the sweep reaches it: an expiry once observed stays, even if
   * the clock moves back.
   */
  private settleExpired(db: AccountDb, id: string): void {
    const row = db.messages.get(id, { includeHidden: true });
    const now = Date.now();
    if (row === null || row.deletedAt !== null || row.expiresAt === null || row.expiresAt > now) return;
    db.messages.delete(row.sid, { at: now });
    void this.scheduleFileCleanup().catch(() => {});
  }

  hasDraft(id: string): boolean {
    return this.drafts.has(id);
  }

  /**
   * People from the phone's address book: the only contact count worth
   * reporting. The database also holds everyone who ever wrote or reacted, so
   * its size says nothing about whether the address book ever arrived.
   */
  namedContacts(): number {
    if (this.namedContactsCache === null) {
      const db = this.readyDb();
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
  }

  /**
   * Several internal states map to one thing a consumer acts on, so the guard is
   * on the mapped status, and it advances only on a post the consumer actually
   * received: an endpoint that was down for `expired` hears it on the next
   * change instead of never, since re-linking needs a human and there is no
   * later transition to recover with. One chain, because a post can occupy half
   * a minute in retries and a flapping link would otherwise land `linked` and
   * `disconnected` out of order. Running the guard inside the chain is what makes
   * "only on change" true of what arrives rather than of what was attempted. The
   * chain rests on `notify` never throwing, so it also catches: a rejection here
   * would silence every later change instead of one.
   */
  private queueConnectionWebhook(status: ConnectionStatus): void {
    const mapped = webhookConnectionStatus(status);
    if (mapped === null) return;
    const at = this.statusSince;
    this.connectionPosts = this.connectionPosts
      .then(async () => {
        if (mapped === this.lastWebhookStatus) return;
        if (this.stopped || this.webhook.settings().kind !== "ready") return;
        if (await this.webhook.notify(asConnectionPayload({ status: mapped, account: this.accountRecord, at }))) {
          this.lastWebhookStatus = mapped;
        }
      })
      .catch((err) => logError("webhook", err));
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
      last_error: this.lastError ?? this.storageFault?.message ?? null,
      webhook: this.webhook.info(),
      recall: this.recallStatus(),
      storage: this.storageInfo(),
    };
    const hints: string[] = [];
    if (this.storageState === "preparing") {
      hints.push("The account is preparing its database from its earlier message files (once, after an upgrade); tools answer NOT_CONNECTED until it is done.");
    }
    if (this.storageState === "failed" && this.storageFault?.fix) hints.push(this.storageFault.fix);
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

  /** What get_status says about the database; reads two meta rows. */
  private storageInfo(): StorageInfo {
    const db = this.accountDb;
    const open = db !== null && db.isOpen;
    if (this.storageState === "failed" || !open) return { state: this.storageState === "preparing" ? "preparing" : "failed" };
    if (this.storageState === "preparing") {
      const progress = importProgress(db);
      return progress === null ? { state: "preparing" } : { state: "preparing", progress: `${progress.phase} (${progress.step} of ${progress.steps})` };
    }
    const info: StorageInfo = { state: db.getMeta(IMPORT_UNVERIFIED_META) === null ? "ready" : "imported-unverified" };
    const schedule = legacySchedule(db);
    if (schedule !== null && schedule.deletedAt === null) {
      info.legacy_files = schedule.kept !== null ? { kept: schedule.kept } : { deleted_after: isoWithOffset(schedule.movedAt + LEGACY_TTL_MS) };
    }
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

  listChats(filter: ChatFilter, limit: number): Promise<Synced<ChatSummary[]>> {
    return this.guarded(async () => {
      this.ensureConnected();
      await this.waitForSync();
      // The lookup can teach a pairing, and a pairing folds a lid chat into its
      // number's: it comes first, and the fold is let land before the list is read.
      const lidChats = this.db.identity.listChats().filter((chat) => chat.jid.endsWith("@lid") && this.listed(chat));
      await this.learnLidPhones(lidChats.map((chat) => chat.jid));
      await this.foldsSettled();
      const db = this.db;
      const entries = db.identity
        .listChats()
        .filter((chat) => this.listed(chat) && this.matchesChatFilter(chat, filter))
        .map((chat) => ({ chat, proto: chat.proto === null ? null : decodeChat(Buffer.from(chat.proto).toString("base64")) }));
      const activity = (entry: (typeof entries)[number]): number => {
        const described = protoNumber(entry.proto?.conversationTimestamp);
        if (described !== undefined && described !== null) return described;
        return entry.chat.lastTs === null ? 0 : Math.floor(entry.chat.lastTs / 1000);
      };
      const chats = entries
        .sort((a, b) => activity(b) - activity(a) || (b.chat.lastMessageId ?? 0) - (a.chat.lastMessageId ?? 0) || b.chat.id - a.chat.id)
        .slice(0, limit)
        .map((entry) => this.chatSummary(entry.chat, entry.proto));
      return this.synced(chats);
    });
  }

  readMessages(chatId: string, limit: number, before?: string, types?: MessageType[]): Promise<Synced<MessageView[]>> {
    return this.guarded(async () => {
      const sock = this.ensureConnected();
      const jid = this.resolveId(chatId);
      await this.waitForSync();
      await this.learnParticipants(jid);
      await this.learnLidPhones([jid]);

      if (before === undefined) {
        return this.synced(this.viewsOfStored(this.pageOf(jid, limit, undefined, types)));
      }

      const anchor = this.storedOrThrow(before);
      const inChat = this.db.identity.chat(jid)?.jid === anchor.chatJid;
      let older = inChat ? this.pageOf(jid, limit, anchor.id, types) : [];
      if (older.length === 0) {
        await this.fetchOlder(sock, anchor, limit);
        older = inChat ? this.pageOf(jid, limit, anchor.id, types) : [];
      }
      return this.synced(this.viewsOfStored(older));
    });
  }

  /**
   * The newest `limit` messages of a chat older than `before`, oldest first.
   * A type filter pages on past what it leaves out, so `limit` counts
   * messages the caller asked for, up to a bounded walk.
   */
  private pageOf(jid: string, limit: number, before: number | undefined, types?: MessageType[]): StoredMessage[] {
    const db = this.db;
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
      const active = this.db.identity.listChats().filter((chat) => chat.lastTs !== null && chat.lastTs >= cutoff);
      await this.learnLidPhones(active.map((chat) => chat.jid));
      // A group's metadata is what names a sender the address book does not
      // know; fetch it for the groups that spoke in the window, once each.
      const activeGroups = active
        .map((chat) => chat.jid)
        .filter((jid) => isGroupId(jid) && !this.groupCache.has(jid) && !this.unreadableGroups.has(jid));
      await Promise.all(activeGroups.slice(0, RECENT_GROUP_META_MAX).map((jid) => this.learnParticipants(jid)));

      const db = this.db;
      const wanted = types === undefined || types.length === 0 ? null : new Set<string>(types);
      const chosen: Array<{ jid: string; stored: StoredMessage[] }> = [];
      for (const chat of active) {
        if (chat.kind === "status" || isNoiseJid(chat.jid) || !this.matchesChatFilter(chat, filter)) continue;
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
      const lookups = this.viewLookups(chosen.flatMap((entry) => entry.stored));
      const conversations: RecentConversation[] = [];
      for (const { jid, stored } of chosen) {
        const messages = stored
          .map((message) => this.viewOfStored(message, lookups))
          .filter((view) => includeSystem || view.type !== "system");
        if (messages.length === 0) continue;
        const note = this.noteFor(jid);
        conversations.push({
          chat_id: jid,
          chat_name: this.displayName(jid),
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
      const db = this.db;
      const scope = chatId === undefined ? undefined : this.resolveId(chatId);
      const from = this.senderFilter(opts.from);
      const filter = {
        ...(scope === undefined ? {} : { chat: scope }),
        ...(from === undefined ? {} : { from }),
        ...(opts.sinceMs === undefined ? {} : { since: opts.sinceMs }),
        ...(opts.untilMs === undefined ? {} : { until: opts.untilMs }),
      };
      const found: StoredMessage[] = [];
      let capped: number | null = null;
      for (let before: number | undefined; found.length < limit; ) {
        const page = db.search.text({ query, limit, ...filter, ...(before === undefined ? {} : { before }) });
        for (const message of page.items) {
          // The status feed is not a chat: a story never answers a search.
          if (message.chatJid === STATUS_JID) continue;
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
      const answer: SearchAnswer = this.synced(this.viewsOfStored(found));
      if (capped !== null) answer.scanCapped = { searchedBackTo: isoWithOffset(secondOfId(capped) * 1000) };
      return answer;
    });
  }

  /**
   * What search_messages ran across: every visible message of the account (or
   * of the chat) inside the time filters, the status feed left out. Null when
   * the database cannot say; a coverage miss never takes a search down.
   */
  searchCoverage(chatId: string | undefined, opts: { sinceMs?: number; untilMs?: number } = {}): SearchCoverage | null {
    try {
      const db = this.readyDb();
      if (db === null) return null;
      const scope = chatId === undefined ? undefined : this.resolveId(chatId);
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

  /**
   * Words and meaning in one search: the query is embedded, then matched
   * against the account's stored vectors and its trigram index under the
   * same filters search_messages takes, and the two rankings are fused. A hit
   * found only by meaning must clear the similarity floor. A row the database
   * holds only as text (imported from the old recall index) answers with that
   * text, marked `from_index`.
   */
  recall(
    query: string,
    chatId: string | undefined,
    limit: number,
    opts: SearchOptions = {}
  ): Promise<Synced<RecallAnswer>> {
    return this.guarded(async () => {
      this.ensureConnected();
      await this.waitForSync();
      const settings = this.readyRecall();
      limit = pageLimit(limit);
      const scope = chatId === undefined ? undefined : this.resolveId(chatId);
      const from = this.senderFilter(opts.from);
      const [vector] = await this.recallEmbed([query], "query");
      const db = this.db;
      // TODO(F1-b3): the hybrid scan runs on the main thread, ~160-190 ms at 100,000 vectors; it moves to a worker.
      const result = db.vectors.hybrid({
        query,
        model: settings.model,
        vector: vector ?? null,
        // Wide enough that the variety rules below have something to promote.
        limit: Math.max(limit + 5, RECALL_RERANK_WINDOW),
        minSimilarity: settings.minSimilarity,
        recencyHalfLifeMs: RECALL_RECENCY_HALF_LIFE_MS,
        ...(scope === undefined ? {} : { chat: scope }),
        ...(from === undefined ? {} : { from }),
        ...(opts.sinceMs === undefined ? {} : { since: opts.sinceMs }),
        ...(opts.untilMs === undefined ? {} : { until: opts.untilMs }),
      });
      const kept = diversify(
        result.hits.filter((hit) => hit.message.chatJid !== STATUS_JID),
        (hit) => ({ chat: hit.message.chatJid, text: `${hit.message.text ?? ""} ${hit.message.transcript ?? ""}` })
      ).slice(0, limit);
      const views = this.viewsOfStored(kept.map((hit) => hit.message));
      const hits = kept.map((hit, i) => ({
        score: hit.score,
        similarity: hit.similarity,
        matched: (hit.lexicalRank !== null && hit.semanticRank !== null ? "both" : hit.lexicalRank !== null ? "words" : "meaning") as RecallHit["matched"],
        message: views[i]!,
        from_index: hit.message.raw === null,
      })) satisfies RecallAnswer["hits"];
      return this.synced({ hits, index: this.recallStatus() });
    });
  }

  /**
   * The settings a recall query may run on, or the refusal the tool reports.
   * "off" splits by cause: the feature disabled, or the history it derives
   * from not persisted; "degraded" carries the line the status already found.
   */
  private readyRecall(): RecallSettings {
    const status = this.recallStatus();
    if (status.state === "degraded") {
      throw new WazapError("RECALL_UNAVAILABLE", status.detail ?? "Semantic recall is unavailable.", status.fix);
    }
    if (status.state === "off" || this.recallEnv instanceof WazapError) {
      if (this.recallEnv instanceof WazapError || !this.recallEnv.enabled) {
        throw new WazapError("RECALL_UNAVAILABLE", "Semantic recall is off.", "Run `wazap config recall local`");
      }
      throw new WazapError(
        "RECALL_UNAVAILABLE",
        "Semantic recall needs message history kept on disk, which is off.",
        "Set WAZAP_PERSIST_HISTORY=1 and restart the server"
      );
    }
    return this.recallEnv;
  }

  /** What the index embeds for a message: the words a person chose, capped to the model's window. */
  private recallWords(message: StoredMessage): string | null {
    const maxChars = this.recallEnv instanceof WazapError ? RECALL_TEXT_CAP : EMBED_MODELS[this.recallEnv.model].maxChars;
    const raw = this.rawOf(message);
    let words: string | null;
    if (raw === null) {
      words = message.transcript === null ? message.text : `${message.text ?? ""} "${message.transcript}"`;
    } else {
      words = searchableText(raw, message.transcript === null ? undefined : this.transcriptRecordOf(message));
    }
    return words === null || words.trim() === "" ? null : words.slice(0, maxChars);
  }

  getMessage(messageId: string): Promise<MessageView> {
    return this.guarded(async () => {
      this.ensureConnected();
      return this.viewOfStored(this.storedOrThrow(messageId));
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
      for (const { contact, notes } of this.db.identity.listContacts()) {
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
        matches.push(this.contactSummary(person));
        if (matches.length >= limit) break;
      }
      return matches;
    });
  }

  getContact(contactId: string): Promise<ContactDetails> {
    return this.guarded(async () => {
      const sock = this.ensureConnected();
      const jid = this.resolveId(contactId);
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
        ...this.contactSummary(jid),
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
      const db = this.readyDb();
      // A message deleted or expired since it arrived is not handed out.
      const messages = found.flatMap((a) => {
        const message = db?.messages.get(a.sid) ?? null;
        return message === null ? [] : [this.viewOfStored(message)];
      });
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
      this.ensureConnected();
      await this.waitForSync();
      const cutoff = Math.max(Date.now() - hours * 3_600_000, Date.now() - STORY_TTL_MS);
      const stories: StoredMessage[] = [];
      for (let before: number | undefined; ; ) {
        const page = this.db.messages.chatPage(STATUS_JID, { limit: 200, ...(before === undefined ? {} : { before }) });
        const fresh = page.items.filter((message) => message.ts >= cutoff);
        stories.push(...fresh);
        if (fresh.length < page.items.length || page.nextBefore === null) break;
        before = page.nextBefore;
      }
      await this.learnLidPhones(stories.flatMap((story) => (story.senderJid === null ? [] : [story.senderJid])));
      return this.synced(this.viewsOfStored(stories));
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
        const message = this.readyDb()?.messages.get(sid) ?? null;
        const raw = message === null ? null : this.rawOf(message);
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
    const path = this.readyDb()?.messages.media(sid).find((media) => media.kind === "preview")?.path;
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
    const db = this.readyDb();
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
      const db = this.db;
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
          const note = this.noteFor(jid);
          found.push({
            chat_id: jid,
            name: this.displayName(jid),
            type: group ? "group" : "individual",
            ask: this.viewOfStored(ask),
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
    const tail = this.db.messages.chatPage(jid, { limit: UNANSWERED_SCAN }).items;
    const theirs: StoredMessage[] = [];
    for (const message of tail) {
      if (message.fromMe) break;
      if (message.type === "system") continue;
      theirs.unshift(message);
    }
    if (theirs.length === 0) return null;
    const group = isGroupId(jid);
    const ask = [...theirs].reverse().find((message) => {
      const raw = this.rawOf(message);
      if (group && (raw === null || !this.addressesMe(raw))) return false;
      return this.readsAsAsk(message, raw);
    });
    return ask ? { ask, theirs } : null;
  }

  setContactNote(contactId: string, note: string): Promise<ContactSummary> {
    return this.guarded(async () => {
      const jid = this.resolveId(contactId);
      this.db.identity.setNote(jid, note);
      return this.contactSummary(jid);
    });
  }

  /**
   * The local contact file: tags and key-value details the agent files a
   * person under, searchable by search_contacts. Nothing reaches WhatsApp —
   * the protocol stores only a name — so this is how "my accountant" and
   * "the guys from the depot" stay attached to people. The person need not
   * be a saved contact; filing a chat partner works too.
   */
  updateContactDetails(contactId: string, edit: ContactDetailsEdit): Promise<ContactSummary> {
    return this.guarded(async () => {
      const jid = this.personJid(contactId);
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
      const db = this.db;
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
      return this.contactSummary(jid);
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
      const db = this.db;
      const open = db.identity.chat(jid) === null ? null : this.openAsk(jid);
      const last = db.messages.chatPage(jid, { limit: 1 }).items[0] ?? null;
      const ask = open?.ask ?? (last && !last.fromMe ? last : null);
      if (ask) db.identity.markHandled(jid, ask.sid);
      return {
        chat_id: jid,
        name: this.displayName(jid),
        ask_id: ask?.sid ?? null,
        ask_text: ask ? this.viewTextOf(ask) : null,
      };
    });
  }

  private readsAsAsk(message: StoredMessage, raw: WAMessage | null): boolean {
    if (message.type === "call") return false;
    // A voice note nobody has heard is an ask until proven otherwise.
    if (message.type === "voice" && message.transcript === null) return true;
    // A link's query string is not a question.
    const text = (raw === null ? this.viewTextOf(message) : viewText(raw, this.transcriptOf(message))).replace(/https?:\/\/\S+/g, "");
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
    addressedToMe: boolean
  ): boolean {
    if (chatJid !== undefined && arrival.jid !== chatJid) return false;
    if (!addressedToMe || !isGroupId(arrival.jid)) return true;
    const message = this.readyDb()?.messages.get(arrival.sid) ?? null;
    const raw = message === null ? null : this.rawOf(message);
    return raw !== null && this.addressesMe(raw);
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
        info_locked: Boolean(meta.restrict),
        member_add_mode: meta.memberAddMode ? "all" : "admins",
        join_approval: Boolean(meta.joinApprovalMode),
        disappearing_seconds: meta.ephemeralDuration ?? 0,
      };
      if (meta.isCommunity || meta.linkedParent) {
        info.community = {
          is_community: Boolean(meta.isCommunity),
          parent_group_id: meta.linkedParent ? this.canonical(meta.linkedParent) : null,
        };
      }

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
      const buffer = await this.mediaBuffer(sock, messageId, raw);
      this.messageOrThrow(messageId);

      const dir = saveTo ?? this.paths.mediaDir;
      if (!isAbsolute(dir)) {
        throw new WazapError("FILE_NOT_FOUND", `"${dir}" is not an absolute directory path.`);
      }
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
      this.messageOrThrow(messageId);
      const filename = mediaFilename(info);
      const path = join(dir, filename);
      await writeFile(path, buffer, { mode: FILE_MODE });
      // An export already written belongs to the user; never delete arbitrary
      // download paths. Do not return its bytes after expiry, however.
      this.messageOrThrow(messageId);

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
      const message = this.storedOrThrow(messageId);
      if (message.transcript !== null) return transcribeResult(this.transcriptRecordOf(message), true);
      const raw = this.messageOrThrow(messageId);

      const type = messageType(raw);
      const info = mediaInfo(raw);
      if (info === undefined || (type !== "voice" && type !== "audio")) {
        throw new WazapError(
          "MEDIA_UNAVAILABLE",
          `Message ${messageId} is not a voice note or an audio message.`,
          "Pass a message whose type is voice or audio"
        );
      }

      const settings = this.transcribeSettings();
      // Read-only has always meant no side effect anyone outside can see. The
      // local provider keeps that promise; uploading the user's audio to a
      // third party and spending their money does not.
      if (this.effectiveReadOnly && settings.provider === "openai") {
        throw new WazapError(
          "READ_ONLY",
          "wazap runs read-only, so it will not upload audio to the transcription API.",
          "Run `wazap config writes on` and restart the server, or run `wazap config transcribe local`"
        );
      }
      const readiness = await transcribeReady(settings);
      if (!readiness.ok) throw new WazapError("TRANSCRIBE_UNAVAILABLE", readiness.detail, readiness.fix);

      // The transcript is only written once a provider has run and been paid, so the
      // auto queue and a tool call asking for the same message at the same
      // moment would otherwise upload it twice. They share the first run.
      const running = this.transcribing.get(message.sid);
      if (running) return await running;
      const work = this.runTranscribe(message.sid, raw, info, settings, language);
      this.transcribing.set(message.sid, work);
      try {
        return await work;
      } finally {
        this.transcribing.delete(message.sid);
      }
    });
  }

  private async runTranscribe(
    messageId: string,
    raw: WAMessage,
    info: { mime: string; size?: number; filename?: string },
    settings: TranscribeSettings,
    language?: string
  ): Promise<TranscribeResult> {
    // Readiness is never ok while no provider is configured.
    const provider = settings.provider!;
    this.messageOrThrow(messageId);
    const sock = this.ensureConnected();
    const buffer = await this.mediaBuffer(sock, messageId, raw);
    this.messageOrThrow(messageId);
    // Its own temp dir, deleted straight after: nobody asked to keep this file,
    // and the media dir is where the files the user did ask for live.
    const dir = await mkdtemp(join(tmpdir(), "wazap-audio-"));
    let transcript: Transcript;
    try {
      const file = join(dir, mediaFilename(info));
      await writeFile(file, buffer, { mode: FILE_MODE });
      this.messageOrThrow(messageId);
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
    // A message revoked or expired while the transcription ran keeps nothing behind.
    this.messageOrThrow(messageId);
    const sid = this.storedOrThrow(messageId).sid;
    const { text, ...details } = record;
    if (!this.db.messages.setTranscript(sid, text, details)) throw missingMessage(messageId);
    // With the transcript on it, the voice note finally carries searchable words.
    this.embedFeed?.kick();
    this.messageOrThrow(messageId);
    return transcribeResult(record, false);
  }

  /**
   * A stored transcript as the views and transcribe_audio take it, with the
   * details stored beside it. One stored without them (set directly, or by
   * an import of a record that had none) names the configured provider.
   */
  private transcriptRecordOf(message: StoredMessage): TranscriptRecord {
    const text = message.transcript ?? "";
    const info = message.transcriptInfo;
    if (info !== null) {
      return {
        text,
        provider: info.provider as TranscriptRecord["provider"],
        at: info.at,
        ...(info.language === undefined ? {} : { language: info.language }),
        ...(info.duration_seconds === undefined ? {} : { duration_seconds: info.duration_seconds }),
      };
    }
    const configured = this.transcribe instanceof WazapError ? null : this.transcribe.provider;
    return { text, provider: configured ?? "local", at: 0 };
  }

  private transcriptOf(message: StoredMessage): TranscriptRecord | undefined {
    return message.transcript === null ? undefined : this.transcriptRecordOf(message);
  }

  /**
   * Resolves when the background queue has nothing left to transcribe. Off the
   * WhatsAppApi on purpose: an agent has no business waiting on it, and a test
   * needs it so it can wait on the queue instead of sleeping.
   */
  transcribeIdle(): Promise<void> {
    return this.transcribeQueue?.idle() ?? Promise.resolve();
  }

  /**
   * Resolves when the embedding feed has nothing left to embed. Same rule as
   * transcribeIdle: off the public API, here so tests can wait on it.
   */
  async recallIdle(): Promise<void> {
    await this.embedFeed?.idle();
    this.vectorCount = null;
  }

  /**
   * The sidecar, started on the first embedding request and shared with every
   * other account in the process on the same binary and model. A failed start
   * is not cached — the next queued batch tries again.
   */
  private recallEngine(): Promise<EmbedEngine> {
    if (this.stopped) return Promise.reject(new WazapError("RECALL_UNAVAILABLE", "the service is stopping"));
    if (this.recallEnv instanceof WazapError || !this.recallEnv.enabled) {
      return Promise.reject(
        new WazapError("RECALL_UNAVAILABLE", "Semantic recall is off.", "Run `wazap config recall local`")
      );
    }
    if (this.recallEngineP === null) {
      const settings = this.recallEnv;
      this.recallEngineP = (async () => {
        const spec = EMBED_MODELS[settings.model];
        const readiness = await embedReady(settings, spec);
        if (!readiness.ok) throw new WazapError("RECALL_UNAVAILABLE", readiness.detail, readiness.fix);
        return EmbedEngine.start(settings, spec, log);
      })();
      this.recallEngineP.catch(() => (this.recallEngineP = null));
    }
    return this.recallEngineP;
  }

  private async recallEmbed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    const engine = await this.recallEngine();
    return engine.embed(texts, kind);
  }

  /**
   * What a revoke takes back, by chat, direction and key. Protocol keys are
   * sender-relative, unlike reactions', and an embedded key cannot revoke a
   * message in a different chat. Baileys' group REVOKE stub retains the
   * actor's fromMe, not necessarily the original author's (an admin may
   * revoke somebody else's message), so it takes back both directions.
   */
  private revokeTargets(raw: WAMessage): MessageRef[] {
    const target = revokedTargetKey(raw);
    if (!target?.id || !raw.key?.remoteJid) return [];
    const chatJid = this.canonical(raw.key.remoteJid);
    if (raw.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
      if (isGroupId(chatJid)) {
        return [
          { chatJid, fromMe: false, keyId: target.id },
          { chatJid, fromMe: true, keyId: target.id },
        ];
      }
      return [{ chatJid, fromMe: Boolean(target.fromMe), keyId: target.id }];
    }
    const author = target.participant || target.remoteJid;
    const fromMe = raw.key.fromMe ? Boolean(target.fromMe) : !target.fromMe && Boolean(author) && this.isMe(author!);
    return [{ chatJid, fromMe, keyId: target.id }];
  }

  /**
   * Messages gone for this account — revoked, deleted for everyone or for the
   * account alone — the way the phone lets them go: each becomes a tombstone,
   * ahead of the message when it has not arrived yet, so no replay brings it
   * back; its quotes lose their copy of it, its vector and its files go.
   */
  private retract(targets: readonly MessageRef[], ts: number): void {
    const db = this.readyDb();
    if (db === null || targets.length === 0) return;
    const at = this.plausibleTs(ts);
    db.transaction(() => {
      for (const target of targets) {
        if (!target.keyId || (isNoiseJid(target.chatJid) && !isStatusJid(target.chatJid))) continue;
        db.messages.delete(messageIdFor({ fromMe: target.fromMe, id: target.keyId }, target.chatJid), {
          chatJid: target.chatJid,
          keyId: target.keyId,
          fromMe: target.fromMe,
          ts: at,
        });
      }
    });
    void this.scheduleFileCleanup().catch(() => {});
  }

  /**
   * A chat cleared or deleted for this account, by manage_chat or on the phone.
   * The barrier is stored and every message at or before it hidden before this
   * returns, so an event handler need not wait; the rows, their vectors and
   * their files go in chunks behind it. A deleted chat also leaves the chat
   * list until a new message arrives.
   */
  private forgetChat(jid: string, deleted: boolean): Promise<void> {
    const db = this.db;
    const at = Date.now();
    if (deleted) db.identity.upsertChat({ jid, archived: false, pinned: null, unread: 0, proto: null });
    const purge = deleted ? db.messages.deleteChat(jid, at) : db.messages.clearChat(jid, at);
    return purge.then(() => this.scheduleFileCleanup());
  }

  /**
   * Unlinks the files the database released — previews of deleted, cleared or
   * expired messages — one pass at a time. A failure is kept for the next
   * caller that waits on cleanup, and the paths stay queued in the database.
   */
  private scheduleFileCleanup(): Promise<void> {
    const run = this.fileWork.then(() => this.unlinkReleased());
    this.fileWork = run.catch((err: unknown) => {
      this.fileFault = new WazapError(
        "WHATSAPP_ERROR",
        "Local message persistence or cleanup failed.",
        "Check the account directory permissions and disk space before restarting"
      );
      logError("message storage", err);
    });
    return this.fileWork;
  }

  private async unlinkReleased(): Promise<void> {
    const db = this.accountDb;
    if (db === null || !db.isOpen || db.readOnly) return;
    const claimed = db.claimUnlinks();
    if (claimed.length === 0) return;
    const done: string[] = [];
    let failure: unknown = null;
    for (const path of claimed) {
      try {
        // Only files wazap itself made are ever unlinked, whatever a row says.
        if (this.ownsFile(path)) await rm(path, { force: true });
        done.push(path);
      } catch (err) {
        failure ??= err;
      }
    }
    if (db.isOpen) db.ackUnlinks(done);
    if (failure !== null) throw failure;
  }

  private ownsFile(path: string): boolean {
    const inside = relative(this.paths.previewsDir, path);
    return inside !== "" && !inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside);
  }

  /**
   * Test and lifecycle barrier, not an MCP tool: queued purges, folds, expiry
   * sweeps and file cleanup have finished. A cleanup failure since the last
   * call is reported here, once. Deleting tools wait on it too.
   */
  async storageIdle(): Promise<void> {
    await this.historyIdle();
    const db = this.accountDb;
    if (db !== null && db.isOpen) {
      await Promise.allSettled([...this.folds]);
      await db.idle();
      // A deadline that passed before its timer fired is due now: the sweep runs here too.
      const next = this.readyDb()?.messages.nextExpiry() ?? null;
      if (next !== null && next <= Date.now()) await this.sweepExpired();
    }
    await this.expirySweep;
    for (;;) {
      const pending = this.fileWork;
      await pending;
      if (pending === this.fileWork) break;
    }
    const fault = this.fileFault;
    this.fileFault = null;
    if (fault) throw fault;
  }

  /** The folds a pairing started, let land within a bound: list_chats reads the merged rows. */
  private async foldsSettled(): Promise<void> {
    if (this.folds.size === 0) return;
    await Promise.race([Promise.allSettled([...this.folds]), sleep(FOLD_SETTLE_MS, undefined, { ref: false })]);
  }

  private recallStatus(): RecallStatus {
    if (this.recallEnv instanceof WazapError) {
      return { state: "degraded", indexed: 0, pending: 0, detail: this.recallEnv.message, fix: this.recallEnv.fix };
    }
    if (!this.recallEnv.enabled || !this.config.persistHistory || this.embedFeed === null) {
      return { state: "off", indexed: 0, pending: 0 };
    }
    const db = this.readyDb();
    const indexed = this.indexedCount(db, this.recallEnv.model);
    const pending = this.embedFeed.pending;
    if (this.embedFeed.failing !== null) {
      return {
        state: "degraded",
        indexed,
        pending,
        detail: this.embedFeed.failing,
        fix: "Check that the embedding server answers; indexing resumes on its own, with nothing lost",
      };
    }
    if (db === null) {
      if (this.storageState === "preparing") return { state: "indexing", indexed, pending };
      return { state: "degraded", indexed, pending, detail: "the account database is not open" };
    }
    return { state: this.embedFeed.busy ? "indexing" : "ready", indexed, pending };
  }

  /** Stored vectors of the model, counted at most every few seconds: the count walks the table. */
  private indexedCount(db: AccountDb | null, model: string): number {
    if (db === null) return this.vectorCount?.count ?? 0;
    const now = Date.now();
    if (this.vectorCount === null || now - this.vectorCount.at > VECTOR_COUNT_TTL_MS) {
      this.vectorCount = { at: now, count: db.vectors.count(model) };
    }
    return this.vectorCount.count;
  }

  /**
   * The feed first, then the engine — releasing its claim on the shared
   * sidecar unblocks an embedding call in flight. An engine still coming up is
   * released whenever its start resolves.
   */
  private async stopRecall(): Promise<void> {
    const feedStop = this.embedFeed?.stop() ?? Promise.resolve();
    if (this.recallEngineP !== null) {
      void this.recallEngineP.then((engine) => engine.stop()).catch(() => {});
    }
    await feedStop;
  }

  draft(payload: DraftPayload): Promise<DraftView> {
    return this.guarded(async () => {
      if (payload.kind === "media") await assertMediaSource(payload.source);
      const sock = this.ensureConnected();
      const jid = await this.assertOutgoing(payload.chatId, sock);
      let stored: DraftPayload = { ...payload, chatId: jid };
      if (payload.kind === "forward") {
        this.contentOrThrow(payload.messageId);
        stored = { ...payload, chatId: jid, text: (await this.getMessage(payload.messageId)).text };
      } else if (payload.kind === "text" && payload.mentionIds?.length) {
        // Mentions resolve here, and the text gains each @<user> it lacks, so the
        // preview is the text that leaves and each token matches its mentionedJid.
        const mentionIds = payload.mentionIds.map((id) => this.resolveId(id));
        stored = { ...payload, chatId: jid, mentionIds, text: withMentionTokens(payload.text, mentionIds) };
      }
      return this.drafts.view(this.drafts.put(this.outgoingOf(jid), stored));
    });
  }

  confirm(draftId: string): Promise<SentMessage> {
    return this.guarded(async () => {
      const draft = this.drafts.take(draftId);
      try {
        return await this.dispatchDraft(draft);
      } catch (err) {
        this.drafts.putBack(draft);
        throw err;
      }
    });
  }

  sendMessage(chatId: string, text: string, replyTo?: string, mentionIds?: string[]): Promise<SentMessage> {
    return this.guarded(async () => {
      if (text.length > MAX_TEXT_CHARS) {
        throw new WazapError(
          "TEXT_TOO_LONG",
          `The text is ${text.length} characters; WhatsApp allows ${MAX_TEXT_CHARS}.`
        );
      }
      const { sock, jid } = await this.prepareSend(chatId);
      const mentions = (mentionIds ?? []).map((id) => this.resolveId(id));
      if (replyTo !== undefined) this.contentOrThrow(replyTo);
      const linkPreview = await this.previewLink(text);
      const quoted = replyTo === undefined ? undefined : this.contentOrThrow(replyTo);
      const sent = await sock.sendMessage(
        jid,
        // Explicit null on failure prevents Baileys from using its own fetcher.
        { text, linkPreview, ...(mentions.length > 0 ? { mentions } : {}) },
        quoted ? { quoted } : {}
      );
      return this.sentResult(sent, jid, text);
    });
  }

  sendMedia(
    chatId: string,
    source: MediaSource,
    opts: { caption?: string; asDocument: boolean; asVoice: boolean; asGif: boolean }
  ): Promise<SentMessage> {
    return this.guarded(async () => {
      const { sock, jid } = await this.prepareSend(chatId);
      const media = await asGifMedia(await loadMedia(source), opts.asGif);
      const content = mediaContent(media, opts);
      if ("video" in content) {
        // Do not fall back to Baileys's unrestricted, shell-spawned ffmpeg.
        // Even an empty thumbnail suppresses its implicit decoder invocation.
        content.jpegThumbnail = (await videoFrame(media.buffer, 32))?.toString("base64") ?? "";
      }
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
    address?: string
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
      if (text.length > MAX_TEXT_CHARS) {
        throw new WazapError(
          "TEXT_TOO_LONG",
          `The text is ${text.length} characters; WhatsApp allows ${MAX_TEXT_CHARS}.`
        );
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
      const linkPreview = await this.previewLink(text);
      this.messageOrThrow(messageId);
      await sock.sendMessage(jid, { text, edit: raw.key, linkPreview });
      return { message_id: messageId, chat_id: jid, text, timestamp: isoWithOffset(Date.now()) };
    });
  }

  reactToMessage(messageId: string, emoji: string): Promise<{ message_id: string; emoji: string }> {
    return this.guarded(async () => {
      const raw = this.messageOrThrow(messageId);
      const { sock, jid } = await this.prepareSend(this.chatOfOrThrow(messageId));
      this.messageOrThrow(messageId);
      await sock.sendMessage(jid, { react: { text: emoji, key: raw.key } });
      return { message_id: messageId, emoji };
    });
  }

  forwardMessage(messageId: string, toChatId: string): Promise<SentMessage> {
    return this.guarded(async () => {
      const raw = this.contentOrThrow(messageId);
      const { sock, jid } = await this.prepareSend(toChatId);
      this.contentOrThrow(messageId);
      const sent = await sock.sendMessage(jid, { forward: raw });
      return this.sentResult(sent, jid, messageText(raw));
    });
  }

  deleteMessage(messageId: string, forEveryone: boolean): Promise<{ message_id: string; for_everyone: boolean }> {
    return this.guarded(async () => {
      const stored = this.storedOrThrow(messageId);
      const raw = this.messageOrThrow(messageId);
      const chat = stored.chatJid;
      const target: MessageRef = { chatJid: chat, fromMe: stored.fromMe, keyId: stored.keyId };
      if (!forEveryone) {
        // Only the linked account's copy goes, whoever sent it and however old:
        // WhatsApp syncs that to the account's other devices, and nobody else
        // sees a change.
        const sock = this.beginWrite();
        const timestamp = Math.floor(stored.ts / 1000);
        await sock.chatModify({ deleteForMe: { deleteMedia: false, key: raw.key, timestamp } }, chat);
        this.requireCleanupOwner();
        this.retract([target], stored.ts);
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
        await this.assertGroupAdmin(chat, "delete_message");
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
      const { sock, jid } = await this.prepareSend(chat);
      await sock.sendMessage(jid, { delete: key });
      this.requireCleanupOwner();
      // Deleted means out of the index too — the text does not get to linger on.
      this.retract([target], stored.ts);
      await this.storageIdle();
      return { message_id: messageId, for_everyone: true };
    });
  }

  setOwnProfilePicture(source: MediaSource): Promise<{ profile_pic_url: string | null }> {
    return this.guarded(async () => {
      const media = await loadProfilePicture(source);
      const sock = this.beginWrite();
      const jid = this.ownJid();
      await sock.updateProfilePicture(jid, media.buffer);
      const picture = await orNullAfter(sock.profilePictureUrl(jid, "image"), PROFILE_LOOKUP_MS);
      return { profile_pic_url: picture ?? null };
    });
  }

  manageChat(chatId: string, action: ChatAction, opts: ChatActionOptions = {}): Promise<ChatActionResult> {
    return this.guarded(async () => {
      const sock = this.beginWrite();
      const jid = this.resolveId(chatId);
      const last = this.lastMessageOf(jid);
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
          this.requireCleanupOwner();
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
    const raw = this.messageOrThrow(messageId);
    const chat = this.chatOfOrThrow(messageId);
    if (chat !== jid) {
      throw new WazapError(
        "MESSAGE_NOT_FOUND",
        `Message ${messageId} is not in ${jid}; it belongs to ${chat}.`,
        "Pass the chat_id the message belongs to, or a message_id from read_messages on this chat"
      );
    }
    return raw;
  }

  /**
   * Add a person to the account's WhatsApp contacts, or rename one already
   * there: the same app-state mutation WhatsApp Web's "add contact" sends.
   * With saveOnPhone it also lands in the phone's own address book; without it
   * the entry lives inside WhatsApp and still syncs to the other linked
   * devices. WhatsApp stores no fields beyond the name — everything else a
   * user wants remembered stays local in set_contact_note.
   */
  saveContact(
    contactId: string,
    name: string,
    opts: { firstName?: string; saveOnPhone?: boolean } = {}
  ): Promise<ContactSummary> {
    return this.guarded(async () => {
      const sock = this.beginWrite();
      const jid = this.personJid(contactId);
      const fullName = name.trim();
      if (fullName === "") {
        throw new WazapError("INVALID_ID", "The contact needs a non-empty name.");
      }
      const contact: proto.SyncActionValue.IContactAction = {
        fullName,
        saveOnPrimaryAddressbook: opts.saveOnPhone ?? true,
        ...this.contactJids(jid),
      };
      const firstName = opts.firstName?.trim();
      if (firstName) contact.firstName = firstName;
      await sock.addOrEditContact(jid, contact);
      // The patch echo takes a moment; file the name now so the store is right.
      this.db.identity.upsertContact({ jid, name: fullName, listed: true });
      this.namedContactsCache = null;
      return this.contactSummary(jid);
    });
  }

  /** Take a person out of the account's contacts: the saved name goes, the chat stays. */
  removeContact(contactId: string): Promise<ContactSummary> {
    return this.guarded(async () => {
      const sock = this.beginWrite();
      const jid = this.personJid(contactId);
      await sock.removeContact(jid);
      const db = this.db;
      if (db.identity.contact(jid)?.name != null) {
        db.identity.upsertContact({ jid, name: null });
        this.namedContactsCache = null;
      }
      return this.contactSummary(jid);
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
            : { id, status: "failed" as const, reason: "WhatsApp did not add this participant" }
        ),
      };
    });
  }

  /**
   * Join a group from an invite: a chat.whatsapp.com link or its bare code, or
   * an invite message someone sent. Without confirm it only looks the group up,
   * so the user sees what they would join. The code goes to WhatsApp and
   * nowhere else: not into a result, an error or a log line.
   */
  joinGroup(opts: { invite?: string; messageId?: string; confirm: boolean }): Promise<JoinGroupResult> {
    return this.guarded(async () => {
      if ((opts.invite === undefined) === (opts.messageId === undefined)) {
        throw new WazapError(
          "INVALID_ID",
          "Pass exactly one of invite or message_id.",
          'invite takes a https://chat.whatsapp.com/ link or its code; message_id an "invite" message from read_messages'
        );
      }
      const invite = opts.messageId === undefined ? undefined : this.inviteMessageOf(opts.messageId);
      const code = invite?.code ?? inviteCodeOf(opts.invite ?? "");
      const unknown = { description: null, participant_count: null, join_approval: null };

      if (!opts.confirm) {
        const sock = this.ensureConnected();
        let meta: GroupMetadata;
        try {
          meta = await sock.groupGetInviteInfo(code);
        } catch (err) {
          // An invite message still names its group when WhatsApp will not describe it.
          if (invite === undefined) throw inviteRefused(err);
          return { status: "preview", group_id: this.canonical(invite.groupJid), name: invite.name, ...unknown };
        }
        return {
          status: "preview",
          group_id: this.canonical(meta.id),
          name: meta.subject || null,
          description: meta.desc ?? null,
          participant_count: meta.size ?? meta.participants.length,
          join_approval: Boolean(meta.joinApprovalMode),
        };
      }

      const sock = this.beginWrite();
      if (invite !== undefined) {
        const from: unknown = await sock.groupAcceptInviteV4(invite.raw.key, invite.message).catch((err: unknown) => {
          throw inviteRefused(err);
        });
        const group = typeof from === "string" && isGroupId(from) ? from : invite.groupJid;
        return { status: "joined", group_id: this.canonical(group), name: invite.name, ...unknown };
      }
      const group = await sock.groupAcceptInvite(code).catch((err: unknown) => {
        throw inviteRefused(err);
      });
      // A group that asks for approval answers with the request, not the group,
      // and Baileys hands back nothing: the account is not in yet.
      return group
        ? { status: "joined", group_id: this.canonical(group), name: null, ...unknown }
        : { status: "pending_approval", group_id: null, name: null, ...unknown };
    });
  }

  manageGroup(
    groupId: string,
    action: GroupAction,
    participantIds?: string[],
    value?: string,
    source?: MediaSource
  ): Promise<GroupActionResult> {
    return this.guarded(async () => {
      const sock = this.beginWrite();
      const jid = this.resolveId(groupId);
      if (!isGroupId(jid)) {
        throw new WazapError("GROUP_NOT_FOUND", `"${groupId}" is not a group id.`, "Group ids end in @g.us");
      }

      // A setting's value is checked first, so a bad one never reaches WhatsApp, not even the admin lookup.
      const choices = GROUP_SETTINGS[action];
      const setting = choices ? settingFor(action, value, choices) : undefined;
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
        case "set_picture": {
          // The same loader as the account's own photo, so a bad file fails the same way.
          const media = await loadProfilePicture(source ?? {});
          await sock.updateProfilePicture(jid, media.buffer);
          const picture = await orNullAfter(sock.profilePictureUrl(jid, "image"), PROFILE_LOOKUP_MS);
          return { group_id: jid, action, applied: "group photo updated", profile_pic_url: picture ?? null };
        }
        case "remove_picture":
          await sock.removeProfilePicture(jid);
          return { group_id: jid, action, applied: "group photo removed" };
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
        case "list_join_requests": {
          const listed = await sock.groupRequestParticipantsList(jid);
          const requests = listed.filter((attrs) => attrs.jid).map((attrs) => this.joinRequest(attrs));
          return {
            group_id: jid,
            action,
            applied: `${requests.length} pending join request(s)`,
            join_requests: requests,
          };
        }
        case "approve_join_requests":
        case "reject_join_requests": {
          const verdict = action === "approve_join_requests" ? "approve" : "reject";
          const results = await sock.groupRequestParticipantsUpdate(jid, ids, verdict);
          this.groupCache.delete(jid);
          return {
            group_id: jid,
            action,
            applied: `${verdict} ${ids.length} join request(s)`,
            // A refused approval is not a cue to send an invite, so no invite_needed here.
            participants: results.map((entry, index) => this.participantResult(entry, ids[index], false)),
          };
        }
        case "set_announcement_only":
        case "set_info_locked":
        case "set_add_mode":
        case "set_join_approval":
        case "set_disappearing": {
          if (!setting) throw new WazapError("INVALID_ID", `The "${action}" action needs a value.`);
          await setting.apply(sock, jid);
          this.groupCache.delete(jid);
          return { group_id: jid, action, applied: setting.applied };
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

    sock.ev.on("messaging-history.set", (batch) => this.ingestHistory(batch));

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
      this.handling("chats", () => this.db.transaction(() => chats.forEach((chat) => this.ingestChat(chat))), undefined);
    });

    sock.ev.on("chats.update", (updates) => {
      this.handling(
        "chats",
        () =>
          this.db.transaction(() => {
            for (const update of updates) {
              if (!update.id) continue;
              const jid = this.canonical(update.id);
              if (isNoiseJid(jid)) continue;
              this.writeChat(jid, { ...update, id: jid });
            }
          }),
        undefined
      );
    });

    sock.ev.on("chats.delete", (ids) => {
      for (const id of ids) {
        this.handling("chat delete", () => void this.forgetChat(this.canonical(id), true).catch((err: unknown) => logError("chat delete", err)), undefined);
      }
    });

    sock.ev.on("contacts.upsert", (contacts) => {
      this.handling("contacts", () => this.db.transaction(() => contacts.forEach((contact) => this.ingestContact(contact))), undefined);
    });

    sock.ev.on("contacts.update", (updates) => {
      this.handling(
        "contacts",
        () =>
          this.db.transaction(() => {
            for (const update of updates) if (update.id) this.ingestContact({ ...update, id: update.id });
          }),
        undefined
      );
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (this.historyPending === 0 || this.stopped) {
        this.receiveMessages(messages, type);
        return;
      }
      // While history is being stored, new messages land at once and marks on messages wait for it.
      const marks = messages.filter((raw) => this.isMark(raw));
      this.receiveMessages(messages.filter((raw) => !marks.includes(raw)), type);
      if (marks.length > 0) this.afterHistory(() => this.receiveMessages(marks, type, true));
    });

    sock.ev.on("messages.delete", (item) => {
      // The other side asked that these go; the database honours it the way the
      // phone does, vectors and files included.
      if ("all" in item) {
        this.handling("messages delete", () => void this.forgetChat(this.canonical(item.jid), false).catch((err: unknown) => logError("messages delete", err)), undefined);
        return;
      }
      const targets: MessageRef[] = [];
      for (const key of item.keys) {
        if (!key.remoteJid || !key.id) continue;
        targets.push({ chatJid: this.canonical(key.remoteJid), fromMe: Boolean(key.fromMe), keyId: key.id });
      }
      const at = Date.now();
      this.markLater("messages delete", () => this.retract(targets, at));
    });

    sock.ev.on("messages.update", (updates) => {
      this.markLater("messages update", () => {
        for (const { key, update } of updates) this.applyUpdate(key, update);
      });
    });

    // In a group, each member's receipt arrives on its own; the status is theirs combined.
    sock.ev.on("message-receipt.update", (items) => {
      this.markLater(
        "receipts",
        () =>
          this.db.transaction(() => {
            for (const { key, receipt } of items) {
              const jid = key.remoteJid ? this.canonical(key.remoteJid) : undefined;
              // The account's other devices confirm its messages too; they are not members.
              if (!jid || !key.fromMe || !receipt.userJid || this.isMe(receipt.userJid)) continue;
              const moments = momentsOf(receipt);
              this.db.messages.receipt(messageIdFor(key, jid), this.canonical(receipt.userJid), {
                deliveredAt: moments.delivered ?? null,
                readAt: moments.read ?? null,
                playedAt: moments.played ?? null,
              });
            }
          })
      );
    });

    sock.ev.on("messages.reaction", (items) => {
      this.markLater(
        "reactions",
        () => {
          for (const { key, reaction } of items) {
            const jid = key.remoteJid ? this.canonical(key.remoteJid) : undefined;
            if (!jid) continue;
            const author = reaction.key?.fromMe
              ? this.ownJid()
              : this.canonical(reaction.key?.participant || reaction.key?.remoteJid || "");
            if (!author) continue;
            const at = protoNumber(reaction.senderTimestampMs) || Date.now();
            this.react(messageIdFor(key, jid), author, reaction.text ?? "", at);
          }
        }
      );
    });

    sock.ev.on("groups.upsert", (groups) => {
      this.handling("groups", () => groups.forEach((meta) => this.cacheGroup(this.canonical(meta.id), meta)), undefined);
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

  /**
   * One messages.update entry: a revoke takes its target back; otherwise an
   * edit replaces the words, a receipt raises the status of the account's own
   * message, a disappearing timer can only bring the deadline closer, and a
   * new timestamp that is not a receipt's re-dates what the message shows.
   */
  private applyUpdate(key: WAMessageKey, update: Partial<WAMessage>): void {
    const jid = key.remoteJid ? this.canonical(key.remoteJid) : undefined;
    if (!jid) return;
    const revoked = this.revokeTargets({ ...update, key } as WAMessage);
    if (revoked.length) {
      const at = protoNumber(update.messageTimestamp);
      this.retract(revoked, at === undefined ? Date.now() : at * 1000);
      return;
    }
    const db = this.db;
    const sid = messageIdFor(key, jid);
    const stored = db.messages.get(sid);
    if (stored === null) return;
    const raw = this.rawOf(stored);
    if (raw === null) return;
    const merged = { ...raw, ...update, key: raw.key } as WAMessage;
    if (this.config.retention === true) {
      const deadline = messageExpiry(merged);
      if (deadline !== undefined && db.messages.setExpiry(stored.sid, deadline)) this.armExpiry();
      if (db.messages.get(stored.sid) === null) {
        this.armExpiry();
        return;
      }
    }
    const edited = update.message?.editedMessage?.message;
    const redated = update.messageTimestamp && typeof update.status !== "number" ? update.messageTimestamp : undefined;
    if (edited || redated !== undefined) {
      // A receipt's messageTimestamp is when it was delivered or read, not when
      // the message was sent; any other update's is the message's own. The
      // row keeps its place in time; what the message shows follows the update.
      const next: WAMessage = { ...raw, ...(edited ? { message: edited } : {}), ...(redated === undefined ? {} : { messageTimestamp: redated }) };
      const editedAt = edited ? (protoNumber(update.messageTimestamp) ?? 0) * 1000 || Date.now() : stored.editedAt;
      this.writeVersion(next, stored, editedAt);
      if (edited) this.embedFeed?.kick();
    }
    // A receipt on a one-to-one message: sent, delivered, read, played.
    if (typeof update.status === "number" && stored.fromMe) db.messages.setStatus(stored.sid, update.status);
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
    return this.lids.isSelf(jid, this.ownJid(), this.sockClient?.user?.lid);
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
    const stored = this.readyDb()?.getMeta(IMPORT_META.contactsResyncedAt) ?? null;
    const at = stored === null ? Number.NaN : Number(stored);
    return Number.isFinite(at) ? at : null;
  }

  /**
   * Who the account has blocked, asked once per connection: WhatsApp pushes the
   * list only when it changes, so get_contact would otherwise say "not blocked"
   * for everyone until then. A failure costs only that answer, so it is logged.
   */
  private async loadBlocklist(sock: WASocket, generation: number): Promise<void> {
    // A stand-in socket without the call has no blocklist to give, and nothing worth logging.
    if (typeof sock.fetchBlocklist !== "function") return;
    try {
      const blocklist = await sock.fetchBlocklist();
      if (generation !== this.generation || this.stopped) return;
      this.blocked.clear();
      for (const jid of blocklist) if (jid) this.blocked.add(this.canonical(jid));
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
    this.readyDb()?.setMeta(IMPORT_META.contactsResyncedAt, String(Date.now()));
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
    if (this.storageState === "preparing") throw this.preparingError();
    if (this.storageState === "failed" && this.storageFault !== null) throw this.storageFault;
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
        return this.sendMedia(chatId, payload.source, {
          caption: payload.caption,
          asDocument: payload.asDocument,
          asVoice: payload.asVoice,
          asGif: payload.asGif,
        });
      case "poll":
        return this.sendPoll(chatId, payload.question, payload.options, payload.multiSelect);
      case "location":
        return this.sendLocation(chatId, payload.latitude, payload.longitude, payload.name, payload.address);
      case "forward":
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

    const db = this.db;
    if (!this.hasChat(jid) && db.identity.contact(jid) === null) {
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

  private async assertGroupAdmin(jid: string, action: GroupAction | "delete_message"): Promise<void> {
    const meta = await this.groupMeta(jid);
    const mine = this.myParticipation(meta);
    if (!mine) throw new WazapError("NOT_A_PARTICIPANT", `The linked account is not in ${jid}.`);
    if (!isAdmin(mine)) {
      throw new WazapError(
        "NOT_ADMIN",
        `"${action}" needs admin rights in "${meta.subject}".`,
        "Ask an admin of the group to make the linked account an admin, or to make this change themselves"
      );
    }
  }

  /** The invite a message carries, checked before WhatsApp is asked about it. */
  private inviteMessageOf(messageId: string): {
    raw: WAMessage;
    message: proto.Message.IGroupInviteMessage;
    code: string;
    groupJid: string;
    name: string | null;
  } {
    const raw = this.messageOrThrow(messageId);
    const message = normalizeMessageContent(raw.message)?.groupInviteMessage;
    if (!message) {
      throw new WazapError(
        "INVALID_ID",
        `Message ${messageId} is not a group invite.`,
        'Pass a message_id whose type is "invite", or the invite link as invite'
      );
    }
    const expires = protoNumber(message.inviteExpiration) ?? 0;
    // Baileys empties the code of an invite once it has been accepted.
    if (!message.inviteCode || !message.groupJid || (expires > 0 && expires * 1000 <= Date.now())) {
      throw new WazapError(
        "WHATSAPP_ERROR",
        `The invite in ${messageId} has expired or was already used.`,
        "Ask the sender for a fresh invite"
      );
    }
    return { raw, message, code: message.inviteCode, groupJid: message.groupJid, name: message.groupName || null };
  }

  private async inviteLink(jid: string): Promise<string> {
    const sock = this.ensureConnected();
    const code = await sock.groupInviteCode(jid);
    if (!code) throw new WazapError("WHATSAPP_ERROR", `WhatsApp returned no invite code for ${jid}.`);
    return `https://chat.whatsapp.com/${code}`;
  }

  private participantResult(
    entry: { status: string; jid: string | undefined },
    fallback?: string,
    inviteable = true
  ): ParticipantResult {
    const id = entry.jid ? this.canonical(entry.jid) : (fallback ?? "");
    if (entry.status === "200") return { id, status: "ok" };
    if (inviteable && INVITE_NEEDED_CODES.has(entry.status)) {
      return { id, status: "invite_needed", reason: entry.status };
    }
    return { id, status: "failed", reason: entry.status };
  }

  /**
   * One pending join request. Baileys hands over the raw attributes of WhatsApp's
   * node untyped: `jid`, and `request_time` (seconds) and `request_method` when sent.
   */
  private joinRequest(attrs: { [key: string]: string }): JoinRequest {
    const id = this.canonical(attrs.jid ?? "");
    const seconds = Number(attrs.request_time);
    return {
      id,
      name: this.displayName(id),
      requested_at: seconds > 0 ? isoWithOffset(seconds * 1000) : null,
      method: attrs.request_method || null,
    };
  }

  private resolveId(input: string): string {
    return this.lids.resolve(input);
  }

  /** A sender filter: the account's own id, however it is spelled, is "me" — its messages are stored without a sender. */
  private senderFilter(from: string | undefined): string | undefined {
    if (from === undefined) return undefined;
    if (from === "me") return "me";
    const jid = this.resolveId(from);
    return this.ownJid() !== "" && this.isMe(jid) ? "me" : jid;
  }

  /** A contact mutation keys on a person: groups and noise jids are caller errors, not contacts. */
  private personJid(input: string): string {
    const jid = this.resolveId(input);
    if (isGroupId(jid) || isNoiseJid(jid)) {
      throw new WazapError("INVALID_ID", `"${input}" is not a person's contact id.`, "Pass a phone number or a contact id");
    }
    return jid;
  }

  /** The pn/lid fields a ContactAction carries, from the id itself and the lid table. */
  private contactJids(jid: string): Pick<proto.SyncActionValue.IContactAction, "lidJid" | "pnJid"> {
    const alias = this.lids.aliasOf(jid);
    if (jid.endsWith("@lid")) return alias ? { lidJid: jid, pnJid: alias } : { lidJid: jid };
    return alias ? { pnJid: jid, lidJid: alias } : { pnJid: jid };
  }

  /** Canonical form, or the input unchanged for jids wazap does not address
   * (status broadcasts, newsletters). */
  private canonical(jid: string): string {
    return this.lids.canonical(jid);
  }

  /**
   * The lid → number table under the two names it had while ids and naming
   * kept separate copies of it; tests still read both. A copy, so nothing
   * writes a pairing past learnLid.
   */
  private get lidToPn(): ReadonlyMap<string, string> {
    return new Map(this.lids);
  }

  private get lidPhones(): ReadonlyMap<string, string> {
    return this.lidToPn;
  }

  /**
   * WhatsApp usually keys a contact by its phone jid and names the LID on the
   * side, leaving `phoneNumber` empty, so the pairing has to be read off `id`.
   */
  private relearnLid(contact: BaileysContact): void {
    if (!contact.lid) return;
    if (contact.phoneNumber) this.learnLid(contact.lid, contact.phoneNumber);
    else if (contact.id?.endsWith("@s.whatsapp.net")) this.learnLid(contact.lid, contact.id);
  }

  /**
   * A pairing WhatsApp stated in a field meant for it, so ids may follow it:
   * the number becomes canonical, and the database makes the lid and the
   * number one person and one chat — names, notes and history included — so
   * nothing splits. The contact and chat rows move at once; a chat's messages
   * fold in behind it, in chunks.
   */
  private learnLid(lid: string, pn: string): void {
    if (!lid || !pn || this.stopped) return;
    const paired = this.lids.learn(lid, pn);
    const db = this.readyDb();
    if (db === null) return;
    const key = lidKey(lid);
    const phone = this.lids.phoneOf(key);
    if (phone === undefined || (!paired && db.identity.phoneOfLid(key) === phone)) return;
    try {
      const fold = db.learnLidPhone(key, phone).then(
        (report) => (report.mediaPaths.length > 0 ? this.scheduleFileCleanup() : undefined),
        (err: unknown) => logError("lid pairing", err)
      );
      this.folds.add(fold);
      void fold.finally(() => this.folds.delete(fold));
      this.namedContactsCache = null;
    } catch (err) {
      logError("lid pairing", err);
    }
  }

  /**
   * Ask Baileys for the numbers behind the LIDs we are about to name. It answers
   * from the table the account has already synced, so this is a lookup and not a
   * fetch, and it covers LIDs no chat, contact or group ever paired.
   */
  private async learnLidPhones(jids: Iterable<string>): Promise<void> {
    const missing = [...new Set(jids)].filter((jid) => jid.endsWith("@lid") && this.lids.phoneOf(jid) === undefined);
    if (missing.length === 0) return;
    const mappings = await this.sockClient?.signalRepository?.lidMapping?.getPNsForLIDs(missing).catch(() => null);
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
    const db = this.readyDb();
    if (isGroupId(jid)) {
      return db?.identity.chat(jid)?.name || this.groupCache.get(jid)?.subject || jid;
    }

    const contact = db?.identity.contact(jid) ?? null;
    const chat = db !== null && chatKindOf(jid) === "direct" ? db.identity.chat(jid) : null;
    const name =
      realName(contact?.name) ||
      realName(contact?.verifiedName) ||
      realName(contact?.notify) ||
      realName(contact?.pushName) ||
      realName(chat?.name);
    if (name) return name;
    const hinted = realName(hint);
    if (hinted) return hinted;

    const alias = this.lids.aliasOf(jid);
    const phoneJid = jid.endsWith("@lid") ? alias : jid;
    const digits = (phoneJid ?? jid).split("@")[0] ?? "";
    if ((phoneJid ?? jid).endsWith("@s.whatsapp.net")) return digits;
    return jid.endsWith("@lid") ? `unknown (lid …${digits.slice(-4)})` : jid;
  }

  /** The user's note on a person or a chat, from the database. */
  private noteFor(jid: string): string | undefined {
    return this.readyDb()?.identity.notes(jid)?.note ?? undefined;
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
        this.messageOrThrow(messageId);
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
      throw new WazapError(
        "MEDIA_UNAVAILABLE",
        `Could not download the media of ${messageId}: ${describe(err)}`,
        "Ask the sender to resend it"
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
   * Live messages both ways, same notify gate as transcription: a history sync
   * must not POST the backlog, and stubs or system notices are not events. That
   * gate is also what keeps wazap's own sends quiet in production, since Baileys
   * re-emits a local send as an `append`; `sentByWazap` is the id-level backstop
   * for an echo that does arrive as `notify`. Failures stay on
   * `webhook.last_error` and never reject this path.
   */
  private queueWebhook(arrived: readonly WAMessage[], transcribing: ReadonlyMap<string, Promise<void>>): void {
    if (this.stopped || this.webhook.settings().kind !== "ready") return;
    for (const raw of arrived) {
      if (!isUserMessage(raw)) continue;
      try {
        const jid = this.canonical(raw.key.remoteJid ?? "");
        const sid = messageIdFor(raw.key, jid);
        if (raw.key.fromMe && raw.key.id && this.sentByWazap.has(raw.key.id)) continue;
        const event = raw.key.fromMe ? "message_sent" : "message_received";
        void this.postMessageEvent({ sid, jid, event, transcript: transcribing.get(sid) }).catch((err) => {
          logError("webhook", err);
        });
      } catch (err) {
        logError("webhook", err);
      }
    }
  }

  /**
   * A transcript lands after ingestion returns, so a message that just went onto
   * the transcribe queue waits for it, bounded, before the view is built: the
   * view reads the transcript from the database fresh, so the wait is the whole
   * reason a voice note's webhook can carry its words. The wait is on that one
   * message's transcript, never on the queue, so a note is never held for the
   * notes behind it. The timer is unreferenced so it can never hold the process
   * open. Before the POST, and before every retry, the message must still be
   * there: deleted or expired meanwhile, it is not sent.
   */
  private async postMessageEvent(args: {
    sid: string;
    jid: string;
    event: "message_received" | "message_sent";
    transcript?: Promise<void>;
  }): Promise<void> {
    if (args.transcript !== undefined) {
      await Promise.race([args.transcript, sleep(WEBHOOK_TRANSCRIPT_WAIT_MS, undefined, { ref: false })]);
    }
    if (!this.hasMessage(args.sid)) return;
    if (this.stopped) {
      logError("webhook", `dropped ${args.event} for ${args.sid}: the service stopped while waiting for a transcript`);
      return;
    }
    const message = this.storedOrThrow(args.sid);
    await this.webhook.notify(
      asWebhookPayload({
        event: args.event,
        view: this.viewOfStored(message),
        account: this.accountRecord,
        isSelfChat: this.isMe(message.chatJid),
      }),
      () => this.hasMessage(args.sid)
    );
  }

  /**
   * Only what genuinely arrived, which is why this hangs off the notify branch
   * rather than off ingestMessages: a history sync replays a backlog, and
   * transcribing all of it is a bill nobody asked for. Incoming voice notes
   * only, and only ones whose length WhatsApp stated and kept short, since an
   * audio file is something the sender chose to attach and a recording of
   * unknown length is unbounded. Anything skipped here is still one
   * transcribe_audio call away. A service on its way out starts nothing. Each
   * sid it enqueued carries the promise that settles when that one transcript
   * does, which is what a held webhook event waits on.
   */
  private queueTranscripts(arrived: readonly WAMessage[]): Map<string, Promise<void>> {
    const queued = new Map<string, Promise<void>>();
    if (this.stopped || this.transcribeQueue === null) return queued;
    for (const raw of arrived) {
      if (raw.key.fromMe || messageType(raw) !== "voice") continue;
      const seconds = voiceSeconds(raw);
      if (seconds === undefined || seconds > AUTO_TRANSCRIBE_MAX_SECONDS) continue;
      const sid = messageIdFor(raw.key, this.canonical(raw.key.remoteJid ?? ""));
      if ((this.readyDb()?.messages.get(sid)?.transcript ?? null) !== null) continue;
      queued.set(sid, this.transcribeQueue.enqueue(sid));
    }
    return queued;
  }

  /** The stored message a reader may see under any spelling of its id, or MESSAGE_NOT_FOUND. */
  private storedOrThrow(messageId: string): StoredMessage {
    const db = this.db;
    const message = db.messages.get(messageId);
    if (message !== null) return message;
    this.settleExpired(db, messageId);
    throw missingMessage(messageId);
  }

  /**
   * The protobuf of a message a reader may see, for the send paths that quote,
   * forward, react to or edit it. A row the database holds only as text (from
   * the old recall index) stands in with its key and time.
   */
  /**
   * The stored message for an action that needs its key: a message held only
   * as text answers with a key and its timestamp, enough to react to, edit or
   * delete it. An action that needs its content asks contentOrThrow.
   */
  private messageOrThrow(messageId: string): WAMessage {
    const message = this.storedOrThrow(messageId);
    return this.rawOf(message) ?? this.keyOnly(message);
  }

  /**
   * The stored message with its content, for a quote or a forward: Baileys
   * reads the content of both, and one held only as text (words carried over
   * from an older recall index) has none to give, so it is refused here.
   */
  private contentOrThrow(messageId: string): WAMessage {
    const message = this.storedOrThrow(messageId);
    const raw = this.rawOf(message);
    if (raw === null || !raw.message) {
      throw new WazapError(
        "MESSAGE_NOT_FOUND",
        `Message ${messageId} is held only as text, so it cannot be quoted or forwarded.`,
        "Send its words as a new message, without reply_to"
      );
    }
    return raw;
  }

  private chatOfOrThrow(messageId: string): string {
    return this.storedOrThrow(messageId).chatJid;
  }

  /**
   * The stored protobuf as the plain object Baileys hands out: only the fields
   * it carries, so a key without a participant has none, as on the wire.
   * Null for a row that carries only text.
   */
  private rawOf(message: StoredMessage): WAMessage | null {
    if (message.raw === null) return null;
    try {
      const decoded = proto.WebMessageInfo.decode(message.raw);
      return proto.WebMessageInfo.toObject(decoded, { longs: Number }) as unknown as WAMessage;
    } catch {
      return null;
    }
  }

  private keyOnly(message: StoredMessage): WAMessage {
    return {
      key: { remoteJid: message.chatJid, fromMe: message.fromMe, id: message.keyId },
      messageTimestamp: Math.floor(message.ts / 1000),
    };
  }

  /** What Baileys asks for when it retries a send or opens a poll vote: the stored protobuf's content. */
  private storedProto(key: WAMessageKey): proto.IMessage | undefined {
    const db = this.readyDb();
    if (db === null || !key.remoteJid || !key.id) return undefined;
    const message = db.messages.get(messageIdFor(key, this.canonical(key.remoteJid)));
    return (message === null ? null : this.rawOf(message))?.message ?? undefined;
  }

  /** The words a reader sees for a message: its rendering, and the transcript after it. */
  private viewTextOf(message: StoredMessage): string {
    const raw = this.rawOf(message);
    if (raw !== null) return viewText(raw, this.transcriptOf(message));
    const text = message.text ?? "";
    return message.transcript === null ? text : `${text} "${message.transcript}"`;
  }

  /**
   * Views of many stored messages: their reactions, votes and receipts read in
   * three queries for the lot, and each name and note looked up once.
   */
  private viewsOfStored(messages: readonly StoredMessage[]): MessageView[] {
    if (messages.length <= 1) return messages.map((message) => this.viewOfStored(message));
    const lookups = this.viewLookups(messages);
    return messages.map((message) => this.viewOfStored(message, lookups));
  }

  private viewLookups(messages: readonly StoredMessage[]): ViewLookups {
    const marks = this.db.messages.marksOf(messages.map((message) => message.id));
    const names = new Map<string, string>();
    const notes = new Map<string, string | undefined>();
    const lookups: ViewLookups = {
      marks,
      nameFor: (jid, pushName) => {
        const key = `${jid}\u0000${pushName ?? ""}`;
        let name = names.get(key);
        if (name === undefined) {
          name = this.displayName(jid, pushName);
          names.set(key, name);
        }
        return name;
      },
      noteFor: (jid) => {
        if (!notes.has(jid)) notes.set(jid, this.noteFor(jid));
        return notes.get(jid);
      },
    };
    return lookups;
  }

  private viewOfStored(message: StoredMessage, lookups?: ViewLookups): MessageView {
    const raw = this.rawOf(message);
    if (raw === null) return this.textOnlyView(message);
    const db = this.db;
    const nameOf = lookups?.nameFor ?? ((jid: string, pushName?: string) => this.displayName(jid, pushName));
    const noteOf = lookups?.noteFor ?? ((jid: string) => this.noteFor(jid));
    const chatJid = message.chatJid;
    const sender = raw.key.fromMe
      ? this.ownJid()
      : chatJid.endsWith("@s.whatsapp.net")
        ? chatJid
        : this.canonical(raw.key.participant || raw.participant || raw.key.remoteJid || "") || this.ownJid();
    // The pushName is what the sender calls themselves: a person the message
    // mentions, or who reacted or voted, must not borrow it.
    const view = buildMessageView(raw, {
      canonical: (jid) => this.canonical(jid),
      nameFor: (jid) => nameOf(jid, jid === sender ? (raw.pushName ?? undefined) : undefined),
      noteFor: (jid) => noteOf(jid),
      ownId: this.ownJid(),
      chatId: chatJid,
      edited: message.editedAt !== null,
      reactions: (lookups === undefined ? db.messages.reactions(message.sid) : (lookups.marks.reactions.get(message.id) ?? [])).flatMap(
        (reaction) => (reaction.jid === null ? [] : [{ emoji: reaction.emoji, sender: reaction.jid }])
      ),
      votes: (lookups === undefined ? db.messages.votes(message.sid) : (lookups.marks.votes.get(message.id) ?? [])).flatMap((vote) => {
        const choice = parseChoice(vote.choice);
        return vote.jid === null || choice === null ? [] : [{ voter: vote.jid, choice }];
      }),
      receipt: this.receiptOf(message, lookups === undefined ? undefined : (lookups.marks.receipts.get(message.id) ?? [])),
      transcript: this.transcriptOf(message),
    });
    // A payload wazap does not model has no protobuf field to keep it: what it
    // read as when it arrived is what the row says.
    if (message.type === "unknown" && view.type !== "unknown") {
      view.type = "unknown";
      view.text = message.text ?? view.text;
    }
    return view;
  }

  /**
   * How far one of the account's own messages got: the status it was stored
   * with, raised by every receipt since, each person's latest moments. The
   * account itself is no recipient.
   */
  private receiptOf(message: StoredMessage, stored?: readonly StoredReceipt[]): Receipt | undefined {
    if (!message.fromMe) return undefined;
    const merged: Receipt = {};
    if (message.status !== null) raiseStatus(merged, message.status);
    for (const receipt of stored ?? this.db.messages.receipts(message.sid)) {
      if (receipt.jid === null || this.isMe(receipt.jid)) continue;
      raiseUser(merged, receipt.jid, {
        ...(receipt.deliveredAt === null ? {} : { delivered: receipt.deliveredAt }),
        ...(receipt.readAt === null ? {} : { read: receipt.readAt }),
        ...(receipt.playedAt === null ? {} : { played: receipt.playedAt }),
      });
    }
    return merged.status === undefined ? undefined : merged;
  }

  /** A message the database holds only as text: enough to quote it, name its chat and sender, and date it. */
  private textOnlyView(message: StoredMessage): MessageView {
    const sender = message.fromMe ? this.ownJid() : (message.senderJid ?? message.chatJid);
    const phone = phoneOf(sender);
    const note = this.noteFor(sender);
    return {
      message_id: message.sid,
      chat_id: message.chatJid,
      from_me: message.fromMe,
      sender: {
        id: sender,
        name: this.displayName(sender),
        ...(phone !== undefined ? { phone } : {}),
        ...(note !== undefined ? { note } : {}),
      },
      type: message.type as MessageType,
      text: this.viewTextOf(message),
      timestamp: isoWithOffset(message.ts),
      age: formatAge(message.ts),
      has_media: false,
      forwarded: false,
      edited: message.editedAt !== null,
    };
  }

  private async fetchOlder(sock: WASocket, anchor: StoredMessage, limit: number): Promise<void> {
    const raw = this.rawOf(anchor) ?? this.keyOnly(anchor);
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

  /** The newest message of a chat a reader may see, as the protobuf a chat action names. */
  private lastMessageOf(chatJid: string): WAMessage | null {
    const last = this.readyDb()?.messages.chatPage(chatJid, { limit: 1 }).items[0];
    return last === undefined ? null : (this.rawOf(last) ?? this.keyOnly(last));
  }

  /**
   * A chat the list shows: one that has had a message, or that WhatsApp
   * described. A deleted chat has neither until something new arrives; the
   * status feed and noise jids are never chats.
   */
  private listed(chat: ChatRecord): boolean {
    if (chat.kind === "status" || isNoiseJid(chat.jid)) return false;
    return chat.lastMessageId !== null || chat.proto !== null;
  }

  private matchesChatFilter(chat: ChatRecord, filter: ChatFilter): boolean {
    const group = isGroupId(chat.jid);
    switch (filter) {
      case "unread":
        return !chat.archived && chat.unread > 0;
      case "groups":
        return !chat.archived && group;
      case "individual":
        return !chat.archived && !group;
      case "archived":
        return chat.archived;
      case "all":
        return !chat.archived;
    }
  }

  private chatSummary(chat: ChatRecord, described: BaileysChat | null): ChatSummary {
    const jid = chat.jid;
    const last = chat.lastMessageId === null ? null : (this.db.messages.byIds([chat.lastMessageId])[0] ?? this.db.messages.lastVisible(chat.id));
    const muteEnd = chat.mutedUntil ?? 0;
    const note = this.noteFor(jid);
    const summary: ChatSummary = {
      chat_id: jid,
      name: this.displayName(jid),
      type: isGroupId(jid) ? "group" : "individual",
      unread_count: Math.max(0, chat.unread),
      last_message: last
        ? {
            text: last.text ?? "",
            timestamp: isoWithOffset(last.ts),
            from_me: last.fromMe,
          }
        : null,
      ...(note ? { note } : {}),
      archived: chat.archived,
      pinned: Boolean(chat.pinned),
      muted_until: muteEnd > Date.now() ? isoWithOffset(muteEnd) : null,
    };
    // A group we left is delivered as read-only; individual chats never are.
    if (isGroupId(jid) && described?.readOnly) summary.left = true;
    return summary;
  }

  private contactSummary(jid: string): ContactSummary {
    const db = this.db;
    const contact = db.identity.contact(jid);
    const phoneJid = jid.endsWith("@lid") ? (this.lids.phoneOf(jid) ?? jid) : jid;
    const number = phoneJid.endsWith("@s.whatsapp.net") ? (phoneJid.split("@")[0] ?? null) : null;
    const notes = db.identity.notes(jid);
    const tags = [...(notes?.tags ?? [])].sort();
    return {
      contact_id: jid,
      name: this.displayName(jid),
      ...(notes?.note ? { note: notes.note } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(notes && Object.keys(notes.fields).length > 0 ? { fields: notes.fields } : {}),
      number,
      is_my_contact: realName(contact?.name) !== "",
      is_business: Boolean(contact?.verifiedName),
    };
  }

  private sentResult(sent: WAMessage | undefined, jid: string, text: string): SentMessage {
    if (!sent) {
      return { message_id: `unknown_${jid}_${randomUUID()}`, chat_id: jid, text, timestamp: isoWithOffset(Date.now()) };
    }
    if (!sent.key.remoteJid) sent = { ...sent, key: { ...sent.key, remoteJid: jid } };
    const sid = messageIdFor(sent.key, jid);
    if (!this.stopped) {
      if (sent.key.id) this.sentByWazap.note(sent.key.id);
      // Stored now, so the reply can be quoted at once; Baileys' echo lands on the same row.
      this.handling(
        "sent message",
        () => {
          const result = this.storeRaw(sent, jid);
          if (result !== null && this.kept(result)) this.embedFeed?.kick();
        },
        undefined
      );
    }
    return { message_id: sid, chat_id: jid, text, timestamp: isoWithOffset(messageTimestampMs(sent)) };
  }

  private ingestChat(chat: BaileysChat): void {
    if (!chat.id) return;
    if (chat.lidJid && chat.pnJid) this.learnLid(chat.lidJid, chat.pnJid);
    const jid = this.canonical(chat.id);
    if (isNoiseJid(jid)) return;
    this.writeChat(jid, { ...definedOnly(chat), id: jid });
  }

  /**
   * A chat's fields merged over what is stored, the way the snapshot used to
   * merge them: the list columns (name, archive, pin, mute, unread) and the
   * rest of WhatsApp's description, which never carries an embedded message.
   */
  private writeChat(jid: string, fields: Partial<BaileysChat>): void {
    const db = this.db;
    const current = db.identity.chat(jid);
    const previous = current?.proto ? chatOf(current.proto) : null;
    const merged = chatMetadata({ ...(previous ?? {}), ...fields, id: jid } as BaileysChat);
    const bytes = encodeChat(merged);
    db.identity.upsertChat({
      jid,
      ...("name" in fields ? { name: fields.name ?? null } : {}),
      ...("archived" in fields ? { archived: Boolean(fields.archived) } : {}),
      ...("pinned" in fields ? { pinned: protoNumber(fields.pinned) ?? null } : {}),
      ...("muteEndTime" in fields ? { mutedUntil: protoNumber(fields.muteEndTime) ?? null } : {}),
      ...("unreadCount" in fields ? { unread: Math.max(0, fields.unreadCount ?? 0) } : {}),
      ...(bytes === null ? {} : { proto: bytes }),
    });
  }

  private ingestContact(contact: BaileysContact): void {
    if (!contact.id) return;
    this.relearnLid(contact);
    const jid = this.canonical(contact.id);
    if (isNoiseJid(jid) || chatKindOf(jid) !== "direct") return;
    // Baileys sends a contact with the fields it does not know set to
    // undefined; only what it states is written, or a name learned earlier
    // would be erased with "unknown".
    const fields = definedOnly(contact);
    const input = {
      ...(fields.name === undefined ? {} : { name: fields.name ?? null }),
      ...(fields.notify === undefined ? {} : { notify: fields.notify ?? null }),
      ...(fields.verifiedName === undefined ? {} : { verifiedName: fields.verifiedName ?? null }),
    };
    // A contact event puts the person in the address book, even one that names nothing.
    this.db.identity.upsertContact({ jid, ...input, listed: true });
    if ("name" in input) this.namedContactsCache = null;
  }

  /**
   * A history batch — thousands of messages — in transactions of a bounded
   * duration, the event loop running between them, so live messages, timers
   * and tool calls are not held for the whole batch. Contacts, chats and the
   * batch's revokes go first; a revoke or a clear that lands between two
   * transactions is a barrier the later ones honour. Batches are stored one
   * after another, in the order they came, and history counts as received
   * once a batch is stored.
   */
  /**
   * A messages.upsert as the service takes it: stored, then announced when it
   * is new. `deferred` marks waited for a history batch, and are stored even
   * while a stop waits for that batch; a stopping service announces nothing.
   */
  private receiveMessages(messages: WAMessage[], type: string, deferred = false): void {
    if (messages.length === 0) return;
    let stored: WAMessage[] = [];
    if (!deferred) {
      stored = this.handling("messages", () => this.db.transaction(() => this.ingestMessages(messages)), []);
    } else if (this.readyDb() !== null) {
      try {
        stored = this.db.transaction(() => this.fileMessages(messages));
      } catch (err) {
        logError("messages", err);
      }
    }
    if (type === "notify" && !this.stopped) {
      for (const raw of messages) {
        if (raw.key.fromMe) continue;
        this.lastInboundAt = Math.max(this.lastInboundAt ?? 0, messageTimestampMs(raw));
      }
      const transcribing = this.queueTranscripts(stored);
      this.queueWebhook(stored, transcribing);
      this.noteArrivals(stored);
    }
  }

  private ingestHistory(batch: HistorySetEvent): void {
    // A batch received before the stop is stored; one arriving after it began is not.
    if (this.stopped) return;
    this.afterHistory(() => this.storeHistory(batch).catch((err: unknown) => logError("history sync", err)));
  }

  /**
   * Runs `work` now when no history batch is being stored, or right after the
   * one under way — and after anything already waiting on it. A mark aimed at
   * a message of that batch lands once the message is stored, instead of
   * finding nothing and being lost. With nothing pending the work starts at
   * once, so a small batch or a mark is stored before emit returns.
   */
  private afterHistory(work: () => unknown): void {
    const run = async (): Promise<void> => {
      await work();
    };
    const guarded = (): Promise<void> => run().catch((err: unknown) => logError("history sync", err));
    this.historyPending++;
    const done = (): void => {
      this.historyPending--;
    };
    this.historyWork = this.historyPending === 1 ? guarded().finally(done) : this.historyWork.then(guarded).finally(done);
  }

  /**
   * A mark on a stored message — an edit, a status, a receipt, a reaction, a
   * delete — as the service applies it, behind a history batch still being
   * stored when there is one.
   */
  private markLater(what: string, work: () => void): void {
    if (this.stopped) return;
    if (this.historyPending === 0) {
      this.handling(what, work, undefined);
      return;
    }
    // A stop waits for the history it received, and for the marks that arrived with it.
    this.afterHistory(() => {
      if (this.readyDb() === null) return;
      try {
        work();
      } catch (err) {
        logError(what, err);
      }
    });
  }

  /** A message whose whole meaning is a mark on another one: a reaction, a vote, a revoke. */
  private isMark(raw: WAMessage): boolean {
    return reactionOf(raw) !== undefined || voteOf(raw) !== undefined || this.revokeTargets(raw).length > 0;
  }

  private async storeHistory({ chats, contacts, messages, lidPnMappings, isLatest, progress }: HistorySetEvent): Promise<void> {
    const all = messages ?? [];
    // WhatsApp sends the history once: a stop waits for a batch it already
    // received to be stored, so nothing here gives up on `stopped`.
    const db = this.readyDb();
    if (db === null) return;
    try {
      for (const mapping of lidPnMappings ?? []) this.learnLid(mapping.lid, mapping.pn);
      db.transaction(() => {
        for (const contact of contacts) this.ingestContact(contact);
        for (const chat of chats) this.ingestChat(chat);
        this.retractRevokes(all);
      });
    } catch (err) {
      logError("history sync", err);
    }
    for (let next = 0; next < all.length; ) {
      if (!db.isOpen) return;
      const from = next;
      try {
        next = db.transaction(() => this.storeMessages(all, from, HISTORY_CHUNK_MS));
      } catch (err) {
        logError("history sync", err);
        return;
      }
      if (next < all.length) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.historyReceived = true;
    this.releaseHistoryWaiters();
    if (isLatest === true || progress === 100) this.markSyncDone();
  }

  /** Every history batch received so far is stored. */
  private async historyIdle(): Promise<void> {
    for (;;) {
      const pending = this.historyWork;
      await pending;
      if (pending === this.historyWork) return;
    }
  }

  /**
   * Files what a batch carries: revokes first, wherever their target landed or
   * lands later in the batch; reactions and votes onto their message; a story
   * apart; every other message through the database's barriers. Returns the
   * messages that were stored, which is what a webhook, a wait and the
   * transcription queue may act on.
   */
  private ingestMessages(messages: WAMessage[]): WAMessage[] {
    if (this.stopped) return [];
    return this.fileMessages(messages);
  }

  private fileMessages(messages: WAMessage[]): WAMessage[] {
    this.retractRevokes(messages);
    const stored: WAMessage[] = [];
    this.storeMessages(messages, 0, Infinity, stored);
    return stored;
  }

  /** The revokes a batch carries, before any of its messages: a revoked message must not be stored for a moment. */
  private retractRevokes(messages: readonly WAMessage[]): void {
    for (const raw of messages) {
      const targets = this.revokeTargets(raw);
      if (targets.length > 0 && !isStatusJid(raw.key.remoteJid ?? "")) this.retract(targets, messageTimestampMs(raw));
    }
  }

  /**
   * Stores `messages` from `from` on, until `budgetMs` have passed; returns
   * the index to continue from. The revokes among them are already applied.
   */
  private storeMessages(messages: readonly WAMessage[], from: number, budgetMs: number, stored: WAMessage[] = []): number {
    const started = performance.now();
    let index = from;
    for (; index < messages.length; index++) {
      if (index > from && index % 32 === 0 && performance.now() - started > budgetMs) break;
      const raw = messages[index]!;
      try {
        if (!raw.key?.remoteJid || (!raw.message && !isStubEvent(raw))) continue;
        if (isStatusJid(raw.key.remoteJid)) {
          this.ingestStory(raw);
          continue;
        }
        const jid = this.canonical(raw.key.remoteJid);
        if (isNoiseJid(jid) || isControlMessage(raw)) continue;
        this.learnPushName(raw, jid);
        if (this.applyReaction(raw, jid)) continue;
        if (this.applyVote(raw, jid)) continue;
        if (!this.keepOverEarlierCall(raw, jid)) continue;
        const result = this.storeRaw(raw, jid);
        if (result === null || !this.kept(result)) continue;
        this.noteInbound(Boolean(raw.key.fromMe), messageTimestampMs(raw));
        this.foldVotesOnto(raw, jid);
        stored.push(raw);
      } catch (err) {
        // One message the database refuses must not cost the rest of its batch.
        logError("message store", err);
      }
    }
    if (stored.length > 0) this.embedFeed?.kick();
    return index;
  }

  private kept(result: UpsertResult): boolean {
    return result.outcome === "inserted" || result.outcome === "updated" || result.outcome === "stale";
  }

  /** A timestamp the database files as given: a clock days ahead is today, as the import leaves it out. */
  private plausibleTs(ts: number): number {
    const now = Date.now();
    return !Number.isSafeInteger(ts) || ts <= 0 || ts > now + FUTURE_SLACK_MS ? now : ts;
  }

  /**
   * One message as the database stores it: the rendering the tools show, the
   * quote it answers, who wrote it, its delivery status and, under
   * WAZAP_RETENTION, its disappearing deadline. A time days in the future is
   * a device's clock gone wrong: the message is filed, and dated, as now.
   */
  private messageInput(raw: WAMessage, chatJid: string): { input: MessageInput; raw: WAMessage } | null {
    const keyId = raw.key.id;
    if (!keyId) return null;
    const seconds = protoNumber(raw.messageTimestamp);
    const ts = this.plausibleTs(seconds === undefined ? Date.now() : seconds * 1000);
    if (seconds === undefined || ts !== seconds * 1000) raw = { ...raw, messageTimestamp: Math.floor(ts / 1000) };
    const fromMe = Boolean(raw.key.fromMe);
    let expiresAt: number | null = null;
    if (this.config.retention === true) expiresAt = messageExpiry(raw) ?? null;
    if (chatJid === STATUS_JID) expiresAt = Math.min(expiresAt ?? Infinity, ts + STORY_TTL_MS);
    const sender = this.senderOf(raw, chatJid);
    let bytes: Uint8Array | null;
    try {
      bytes = proto.WebMessageInfo.encode(raw).finish();
    } catch {
      bytes = null;
    }
    const input: MessageInput = {
      chatJid,
      keyId,
      fromMe,
      ...(sender === undefined ? {} : { senderJid: sender }),
      ts,
      type: messageType(raw),
      text: messageText(raw),
      raw: bytes,
      quotedSid: quotedMessageId(raw, { canonical: (jid) => this.canonical(jid), ownId: this.ownJid(), chatId: chatJid }) ?? null,
      status: fromMe && typeof raw.status === "number" ? raw.status : null,
      expiresAt,
    };
    return { input, raw };
  }

  /** The sender the database files a message under; undefined for the other side of a direct chat. */
  private senderOf(raw: WAMessage, chatJid: string): string | null | undefined {
    if (raw.key.fromMe) return null;
    if (chatJid.endsWith("@s.whatsapp.net")) return undefined;
    const from = raw.key.participant || raw.participant || raw.key.remoteJid || "";
    if (!from) return null;
    const jid = this.canonical(from);
    return chatKindOf(jid) === "direct" && !isNoiseJid(jid) ? jid : null;
  }

  /** Stores a message and what its protobuf already carries: the receipts of a synced message of the account's own. */
  private storeRaw(raw: WAMessage, chatJid: string): UpsertResult | null {
    const prepared = this.messageInput(raw, chatJid);
    if (prepared === null) return null;
    const db = this.db;
    const result = db.messages.upsert(prepared.input);
    if (result.sid !== null && (result.outcome === "inserted" || result.outcome === "updated")) {
      for (const receipt of raw.key.fromMe ? (raw.userReceipt ?? []) : []) {
        if (!receipt.userJid || this.isMe(receipt.userJid)) continue;
        const moments = momentsOf(receipt);
        db.messages.receipt(result.sid, this.canonical(receipt.userJid), {
          deliveredAt: moments.delivered ?? null,
          readAt: moments.read ?? null,
          playedAt: moments.played ?? null,
        });
      }
    }
    if (result.outcome === "inserted") {
      // A chat that only ever arrived as messages still lists after a clear, as it always did.
      const chat = db.identity.chat(chatJid);
      if (chat !== null && chat.proto === null && chat.kind !== "status") {
        const bytes = encodeChat({ id: chat.jid } as BaileysChat);
        if (bytes !== null) db.identity.upsertChat({ jid: chat.jid, proto: bytes });
      }
    }
    if (prepared.input.expiresAt !== null && prepared.input.expiresAt !== undefined) this.armExpiry();
    if (result.outcome === "expired") void this.sweepExpired();
    return result;
  }

  /** A new version of a stored message: an edit, or a new date; the row keeps its id and its place in time. */
  private writeVersion(next: WAMessage, stored: StoredMessage, editedAt: number | null): void {
    const prepared = this.messageInput(next, stored.chatJid);
    if (prepared === null) return;
    const { input } = prepared;
    this.db.messages.upsert({ ...input, ts: stored.ts, editedAt, expiresAt: input.expiresAt ?? null });
  }

  /**
   * A story is a message on the status feed with its author as the sender. It
   * lists nowhere but get_stories, wakes no wait, and goes after a day, as on
   * the phone; a revoked one leaves nothing behind.
   */
  private ingestStory(raw: WAMessage): void {
    if (raw.key.fromMe || isControlMessage(raw) || messageType(raw) === "system") return;
    const revoked = this.revokeTargets(raw);
    if (revoked.length) {
      this.retract(
        revoked.map((target) => ({ ...target, chatJid: STATUS_JID })),
        messageTimestampMs(raw)
      );
      return;
    }
    if (messageTimestampMs(raw) + STORY_TTL_MS <= Date.now()) return;
    this.learnPushName(raw, STATUS_JID);
    const result = this.storeRaw(raw, STATUS_JID);
    if (result !== null && this.kept(result)) this.noteInbound(false, messageTimestampMs(raw));
  }

  /**
   * A reaction is not a message in the chat, it is a mark on one: it goes onto
   * the target and is never filed on its own, whether it arrives live or in a
   * history sync. True when `raw` was a reaction.
   */
  private applyReaction(raw: WAMessage, chatJid: string): boolean {
    const reaction = reactionOf(raw);
    if (!reaction) return false;
    const author = raw.key.fromMe ? this.ownJid() : this.canonical(raw.key.participant || raw.key.remoteJid || chatJid);
    const target = messageIdFor(reaction.targetKey, chatJid);
    if (author) this.react(target, author, reaction.text, messageTimestampMs(raw));
    return true;
  }

  /** One author's reaction, or its withdrawal (empty); the newer of two never loses to the older. */
  private react(target: string, author: string, emoji: string, at: number): void {
    const db = this.db;
    db.messages.react(target, author, emoji || null, this.plausibleTs(at));
  }

  /**
   * A vote on a poll, or a response to an event, is a mark on that message the
   * way a reaction is: once it can be read it goes onto the poll and is never
   * filed on its own. One that cannot be read yet — its poll is not stored, or
   * no spelling of the two jids opens it — stays a line of its own, and is
   * tried again when the poll arrives. True when `raw` was folded.
   */
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
    // A withdrawal is kept as an empty choice, so an older vote arriving after it cannot bring it back.
    if (voter) this.db.messages.vote(target.sid, voter, JSON.stringify(reading.choice), this.plausibleTs(vote.at));
    return true;
  }

  /**
   * The poll or event a vote points at, by its id, in the vote's chat under
   * every name that chat goes by: the voter's device may key the poll under a
   * lid where this account filed it under the number, or the other way round.
   */
  private voteTarget(vote: EncryptedVote, chatJid: string): { sid: string; raw: WAMessage } | undefined {
    const remote = vote.targetKey.remoteJid;
    const chats = [chatJid, remote ? this.canonical(remote) : "", this.lids.phoneOf(chatJid), this.lids.lidOf(chatJid)];
    const mine = Boolean(vote.targetKey.fromMe);
    const db = this.db;
    for (const chat of new Set(chats)) {
      if (!chat) continue;
      for (const fromMe of [mine, !mine]) {
        const stored = db.messages.get(messageIdFor({ ...vote.targetKey, fromMe }, chat));
        const raw = stored === null ? null : this.rawOf(stored);
        if (raw && (vote.kind === "poll" ? pollOf(raw) !== undefined : isEvent(raw))) return { sid: stored!.sid, raw };
      }
    }
    return undefined;
  }

  /**
   * Every jid WhatsApp may have bound a vote to for the author of `raw`: the
   * ones its key carries, device dropped, each with the number or lid it pairs
   * with — ours in both forms when the message is our own. The order is fixed,
   * so every retry tries the same spellings the same way.
   */
  private voteSpellings(raw: WAMessage): string[] {
    const key = raw.key;
    return this.lids.spellings(
      key.fromMe
        ? [this.ownJid(), this.sockClient?.user?.id, this.sockClient?.user?.lid]
        : [key.participant, key.participantAlt, raw.participant, key.remoteJid, key.remoteJidAlt]
    );
  }

  /** Votes and responses that arrived before their poll or event fold onto it the moment it lands. */
  private foldVotesOnto(raw: WAMessage, chatJid: string): void {
    if (pollOf(raw) === undefined && !isEvent(raw)) return;
    const db = this.db;
    let walked = 0;
    for (let before: number | undefined; walked < EARLY_VOTE_SCAN; ) {
      const page = db.messages.chatPage(chatJid, { limit: 200, ...(before === undefined ? {} : { before }) });
      for (const waiting of page.items) {
        walked++;
        // A vote no poll could open is stored as the system line it reads as.
        if (waiting.type !== "system" || waiting.raw === null) continue;
        const vote = this.rawOf(waiting);
        if (vote === null || voteOf(vote)?.targetKey.id !== raw.key.id) continue;
        if (this.applyVote(vote, chatJid)) db.messages.delete(waiting.sid);
      }
      if (page.nextBefore === null) break;
      before = page.nextBefore;
    }
  }

  /**
   * One call can reach the account three ways: wazap's own tracker, the stub
   * baileys synthesises on a timeout, and WhatsApp's later call-log message.
   * Each carries a different id, so only nearness in time pairs them up, and
   * whichever says more about the call is the one kept; the other is deleted
   * for good, so a replay cannot bring the pair back.
   */
  private keepOverEarlierCall(raw: WAMessage, chatJid: string): boolean {
    const info = callInfo(raw);
    if (!info) return true;
    const db = this.db;
    const chat = db.identity.chat(chatJid);
    if (chat === null) return true;
    const at = this.plausibleTs(messageTimestampMs(raw));
    const sid = messageIdFor(raw.key, chat.jid);
    const nearby = db.messages.recent({ since: Math.max(1, at - CALL_DEDUPE_WINDOW_MS), until: at + CALL_DEDUPE_WINDOW_MS, limit: 200 });
    for (const known of nearby.items) {
      if (known.type !== "call" || known.chatJid !== chat.jid || known.sid === sid) continue;
      const other = this.rawOf(known);
      const otherInfo = other === null ? undefined : callInfo(other);
      if (other === null || !otherInfo) continue;
      // A redial inside the window is two calls, and wazap knows it built both.
      if (isTrackedCall(raw) && isTrackedCall(other)) continue;
      if (callDetail(raw, info) <= callDetail(other, otherInfo)) return false;
      db.messages.delete(known.sid);
      return true;
    }
    return true;
  }

  /** A live call goes in the way any message does, so everything downstream carries it. */
  private storeCall(entry: CallEntry): void {
    this.handling("call", () => this.db.transaction(() => this.ingestMessages([callMessage(entry)])), []);
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

  /** The name a sender publishes, as WhatsApp attaches it to their messages; written only when it changed. */
  private learnPushName(raw: WAMessage, chatJid: string): void {
    const name = raw.pushName?.trim();
    if (!name || raw.key.fromMe) return;
    const sender = this.canonical(raw.key.participant || raw.participant || chatJid);
    if (!sender || this.isMe(sender) || isNoiseJid(sender) || chatKindOf(sender) !== "direct") return;
    const db = this.db;
    if (db.identity.contact(sender)?.pushName === name) return;
    db.identity.upsertContact({ jid: sender, pushName: name });
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

  /**
   * One unreferenced timer per account, on the earliest deadline the database
   * holds: a disappearing message under WAZAP_RETENTION, or a story's day.
   * Reads already hide a message the moment its deadline passes; the timer is
   * what takes its words, vector and files off the disk while nobody reads.
   */
  private armExpiry(): void {
    const db = this.readyDb();
    if (this.stopped || db === null) return;
    const next = db.messages.nextExpiry();
    if (next === null) {
      if (this.expiryTimer) clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
      this.expiryAt = undefined;
      return;
    }
    if (this.expiryTimer !== null && this.expiryAt !== undefined && this.expiryAt <= next) return;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryAt = next;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expiryAt = undefined;
      void this.sweepExpired();
    }, Math.max(1, Math.min(2_147_483_647, next - Date.now())));
    this.expiryTimer.unref();
  }

  private sweepExpired(): Promise<void> {
    this.expirySweep = this.expirySweep
      .then(async () => {
        const db = this.readyDb();
        if (this.stopped || db === null) return;
        await db.messages.expireDue();
        await this.scheduleFileCleanup();
        this.armExpiry();
      })
      .catch((err: unknown) => logError("message expiry", err));
    return this.expirySweep;
  }

  private requireCleanupOwner(): void {
    if (this.stopped) throw new WazapError("NOT_CONNECTED", "The service stopped before local cleanup could complete.",
      "Reconnect and verify the operation; WhatsApp may already have accepted it");
  }
}

const ADMIN_ACTIONS = new Set<GroupAction>([
  "add",
  "remove",
  "promote",
  "demote",
  "set_subject",
  "set_description",
  "set_picture",
  "remove_picture",
  "get_invite_link",
  "revoke_invite_link",
  "list_join_requests",
  "approve_join_requests",
  "reject_join_requests",
  "set_announcement_only",
  "set_info_locked",
  "set_add_mode",
  "set_join_approval",
  "set_disappearing",
]);

const PARTICIPANT_ACTIONS = new Set<GroupAction>([
  "add",
  "remove",
  "promote",
  "demote",
  "approve_join_requests",
  "reject_join_requests",
]);

interface GroupSetting {
  applied: string;
  apply: (sock: WASocket, jid: string) => Promise<void>;
}

const DAY_SECONDS = 86_400;

/** The values each setting action takes, what each asks WhatsApp for, and how the result reads. */
const GROUP_SETTINGS: Partial<Record<GroupAction, Record<string, GroupSetting>>> = {
  set_announcement_only: {
    on: { applied: "only admins can send messages", apply: (sock, jid) => sock.groupSettingUpdate(jid, "announcement") },
    off: {
      applied: "every member can send messages",
      apply: (sock, jid) => sock.groupSettingUpdate(jid, "not_announcement"),
    },
  },
  set_info_locked: {
    on: { applied: "only admins can edit the group info", apply: (sock, jid) => sock.groupSettingUpdate(jid, "locked") },
    off: {
      applied: "every member can edit the group info",
      apply: (sock, jid) => sock.groupSettingUpdate(jid, "unlocked"),
    },
  },
  set_add_mode: {
    admins: { applied: "only admins can add members", apply: (sock, jid) => sock.groupMemberAddMode(jid, "admin_add") },
    all: { applied: "every member can add members", apply: (sock, jid) => sock.groupMemberAddMode(jid, "all_member_add") },
  },
  set_join_approval: {
    on: { applied: "admins approve new members", apply: (sock, jid) => sock.groupJoinApprovalMode(jid, "on") },
    off: { applied: "new members join without approval", apply: (sock, jid) => sock.groupJoinApprovalMode(jid, "off") },
  },
  // The durations WhatsApp offers; 0 is what Baileys turns into "off".
  set_disappearing: {
    off: { applied: "disappearing messages off", apply: (sock, jid) => sock.groupToggleEphemeral(jid, 0) },
    "24h": {
      applied: "disappearing messages set to 24h",
      apply: (sock, jid) => sock.groupToggleEphemeral(jid, DAY_SECONDS),
    },
    "7d": {
      applied: "disappearing messages set to 7d",
      apply: (sock, jid) => sock.groupToggleEphemeral(jid, 7 * DAY_SECONDS),
    },
    "90d": {
      applied: "disappearing messages set to 90d",
      apply: (sock, jid) => sock.groupToggleEphemeral(jid, 90 * DAY_SECONDS),
    },
  },
};

/** The setting a value names, or INVALID_ID with a fix listing the values the action takes. */
function settingFor(action: GroupAction, value: string | undefined, choices: Record<string, GroupSetting>): GroupSetting {
  const key = (value ?? "").trim().toLowerCase();
  if (Object.hasOwn(choices, key)) return choices[key];
  const allowed = Object.keys(choices)
    .map((choice) => `"${choice}"`)
    .join(", ");
  throw new WazapError(
    "INVALID_ID",
    key ? `"${value}" is not a value the "${action}" action takes.` : `The "${action}" action needs a value.`,
    `Pass value as one of ${allowed}`
  );
}

/** WhatsApp answers "cannot add, invite them instead" with these codes. */
const INVITE_NEEDED_CODES = new Set(["403", "409"]);

/** How long a pinned message stays pinned, by the hours manage_chat takes: WhatsApp's 24 hours, 7 days and 30 days. */
const PIN_SECONDS: Record<number, 86_400 | 604_800 | 2_592_000> = { 24: 86_400, 168: 604_800, 720: 2_592_000 };

/** The code in a chat.whatsapp.com link, or a bare code. What is refused is not repeated back. */
function inviteCodeOf(invite: string): string {
  const trimmed = invite.trim();
  const match =
    /^(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{10,64})\/?(?:[?#].*)?$/i.exec(trimmed) ??
    /^([A-Za-z0-9]{10,64})$/.exec(trimmed);
  if (!match?.[1]) {
    throw new WazapError(
      "INVALID_ID",
      "The invite is neither a https://chat.whatsapp.com/ link nor an invite code.",
      "Pass the link exactly as it was shared"
    );
  }
  return match[1];
}

/** WhatsApp's refusal of an invite. Baileys builds its message from WhatsApp's answer, which does not carry the code. */
function inviteRefused(err: unknown): WazapError {
  if (err instanceof WazapError) return err;
  return new WazapError(
    "WHATSAPP_ERROR",
    `WhatsApp refused the invite: ${describe(err)}.`,
    "The link may be reset, expired or mistyped: ask for a fresh invite"
  );
}

/**
 * A wrong WAZAP_TRANSCRIBE_* value must not take a running server down with it.
 * Everything else still works, so the complaint is logged once and kept, and the
 * tool that needs it reports it instead of transcribing.
 */
function readTranscribeConfig(dataDir: string): TranscribeSettings | WazapError {
  try {
    return readTranscribeSettings(process.env, dataDir);
  } catch (err) {
    const fault = asWazapError(err);
    logError("transcribe settings", fault);
    return fault;
  }
}

/** Same rule as transcribe: a wrong WAZAP_RECALL_* value degrades to feature-off, never a crash. */
function readRecallConfig(dataDir: string): RecallSettings | WazapError {
  try {
    return readRecallSettings(process.env, dataDir);
  } catch (err) {
    const fault = asWazapError(err);
    logError("recall settings", fault);
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

/** A result limit a caller left out or spelled wrong reads as the tools' own default. */
function pageLimit(limit: number): number {
  return Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 20;
}

/** A stored poll choice: the JSON array of option names; null for anything else. */
function parseChoice(choice: string): string[] | null {
  try {
    const parsed = JSON.parse(choice) as unknown;
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "string") ? parsed : null;
  } catch {
    return null;
  }
}

/** WhatsApp's description of a chat, as the database keeps it. */
function chatOf(bytes: Uint8Array): BaileysChat | null {
  return decodeChat(Buffer.from(bytes).toString("base64"));
}

function encodeChat(chat: BaileysChat): Uint8Array | null {
  const b64 = encode(() => proto.Conversation.encode(chat as proto.IConversation).finish());
  return b64 === null ? null : new Uint8Array(Buffer.from(b64, "base64"));
}
