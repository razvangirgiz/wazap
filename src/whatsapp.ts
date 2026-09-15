/**
 * WhatsApp service over Baileys. Baileys emits raw events rather than exposing
 * a queryable store, so this keeps a small in-memory store (chats, contacts,
 * messages by id) fed from those events, optionally persisted under the data
 * dir so a restart does not start blind.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import makeWASocket, {
  ALL_WA_PATCH_NAMES,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
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
import { asWazapError, RELINK_FIX, RESET_FIX, WazapError } from "./errors.js";
import { isGroupId, isNoiseJid, isStatusJid, normalizePhone, resolveChatId, STATUS_JID } from "./ids.js";
import { log, logError } from "./logger.js";
import { Notes } from "./notes.js";
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
import { decodeMessage, encode, Store, type HistoryRecord, type StoreSnapshot } from "./store.js";
import {
  buildMessageView,
  callInfo,
  formatAge,
  isCallPlaceholder,
  isControlMessage,
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
  protoNumber,
  quotedSenderJid,
  reactionOf,
  revokedTargetKey,
  searchableText,
  thumbnailOf,
  viewText,
  voiceSeconds,
} from "./messages.js";
import { PAIRING_TIMEOUT_MS, WA_BROWSER, prettyCode, startPairing } from "./pairing.js";
import {
  EMBED_MODELS,
  EmbedEngine,
  embedReady,
  RECALL_TEXT_CAP,
  RecallQueue,
  RecallStore,
  readRecallSettings,
  type RecallOp,
  type RecallRecord,
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
import { DraftStore, type Draft, type DraftPayload, type DraftView } from "./drafts.js";
import { RateLimiter } from "./ratelimit.js";
import { maskNumber } from "./ui.js";
import { SentIds } from "./sent-ids.js";
import {
  WebhookSink,
  asConnectionPayload,
  asWebhookPayload,
  webhookConnectionStatus,
  type WebhookConnectionStatus,
} from "./webhook.js";
import type {
  CallInfo,
  ChatAction,
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
  MediaResult,
  MediaSource,
  MessageType,
  OutgoingTarget,
  MessageView,
  PairingInfo,
  ParticipantResult,
  RecallAnswer,
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
const CALL_DEDUPE_SCAN = 20;
// Kept equal to MAX_MESSAGES_PER_CHAT in store.ts: the disk window and the
// in-memory window are the same, so keyword search covers all wazap keeps.
const HISTORY_STORE_CAP_PER_CHAT = 2_000;
/** A download is buffered in memory, so the biggest file it may pull is bounded. */
const MEDIA_DOWNLOAD_MAX_BYTES = 100_000_000;
/** Ten minutes of speech. Past that, auto-transcribing is a bill nobody asked for. */
const AUTO_TRANSCRIBE_MAX_SECONDS = 600;
/** How long a message event waits for the transcript of the voice note it carries. */
const WEBHOOK_TRANSCRIPT_WAIT_MS = 60_000;
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
  private lastInboundAt: number | null = null;
  /** Invalidated by every write on store.contacts; see namedContacts. */
  private namedContactsDirty = true;
  private namedContactsCache = 0;
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
  private readonly paths: AccountPaths;
  private readonly notes: Notes;
  /** The transcription environment, or the complaint about it. See `readTranscribeConfig`. */
  private readonly transcribe: TranscribeSettings | WazapError;
  /** The recall environment, or the complaint about it. Same rule as transcribe: a bad env is a line, not a crash. */
  private readonly recallEnv: RecallSettings | WazapError;
  /** The on-disk index; opened in loadPersisted, before history is replayed. */
  private recallStore: RecallStore | null = null;
  private recallQueue: RecallQueue | null = null;
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
    this.webhook = new WebhookSink(process.env, { account });
    const policy = accountPolicy(account, config);
    this.effectiveReadOnly = policy.readOnly;
    this.effectiveRateLimit = policy.rateLimit;
    this.writes = new RateLimiter(this.effectiveRateLimit);
    this.paths = paths;
    this.notes = new Notes(this.paths.notesFile);
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
    for (const timer of [this.storeSaveTimer, this.reconnectTimer, this.syncDeadline]) {
      if (timer) clearTimeout(timer);
    }
    this.storeSaveTimer = null;
    this.reconnectTimer = null;
    this.syncDeadline = null;
    this.stopCallSweep();
    this.releaseWaiters();
    this.wakeArrivalWaiters();
    await this.flushStore();
    this.teardownSocket();
    await this.stopRecall();
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
      (err: unknown) => this.abandonLink(err)
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
    this.account = account;
    this.lastError = null;
    this.onLinked?.(account);
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

  /** This account already has a chat, or messages, for this jid. Contacts do not count. */
  hasChat(jid: string): boolean {
    const id = this.canonical(jid);
    if (!id || isNoiseJid(id)) return false;
    return this.store.hasChat(id);
  }

  hasMessage(id: string): boolean {
    return this.store.hasMessage(id);
  }

  hasDraft(id: string): boolean {
    return this.drafts.has(id);
  }

  /**
   * People from the phone's address book: the only contact count worth
   * reporting. The store also holds everyone who ever appeared in a group and
   * every group itself, so its raw size says nothing about whether the address
   * book ever arrived.
   */
  namedContacts(): number {
    if (this.namedContactsDirty) {
      let named = 0;
      for (const [jid, contact] of this.store.contacts) {
        if (!isGroupId(jid) && realName(contact.name)) named++;
      }
      this.namedContactsCache = named;
      this.namedContactsDirty = false;
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
      last_error: this.lastError,
      webhook: this.webhook.info(),
      recall: this.recallStatus(),
    };
    const hints: string[] = [];
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
   * `lastInboundAt` is maintained as messages land — live upserts, history
   * replay and the on-disk reload all feed it — so status is a read, not a
   * scan of the whole store. A dropped newest message can leave it a touch
   * stale, which only ever delays the "phone may be offline" hint.
   */
  private latestInboundAt(): number | null {
    return this.lastInboundAt;
  }

  /** Every stored inbound message is evidence the phone link is alive. */
  private noteInbound(raw: WAMessage): void {
    if (raw.key.fromMe) return;
    this.lastInboundAt = Math.max(this.lastInboundAt ?? 0, messageTimestampMs(raw));
  }

  listChats(filter: ChatFilter, limit: number): Promise<Synced<ChatSummary[]>> {
    return this.guarded(async () => {
      this.ensureConnected();
      await this.waitForSync();
      const candidates = this.knownChats().filter((chat) => this.matchesChatFilter(chat, filter));
      // The lookup can teach a pairing, and a pairing changes which rows are
      // the same person, so it comes first and everything after it is one
      // synchronous pass: merge, sort, cut, render. Otherwise a chat merged
      // under its lid could render under its number and sit next to the row
      // that already had that number.
      await this.learnLidPhones(candidates.map((chat) => this.canonical(chat.id ?? "")));
      const merged = this.mergeAliases(candidates);
      // chatActivity resolves the ring's tail each time; a sort would run it
      // once per comparison, so it is priced once per chat instead.
      const activity = new Map(merged.map((chat) => [chat, this.chatActivity(chat)]));
      const chats = merged
        .sort((a, b) => activity.get(b)! - activity.get(a)!)
        .slice(0, limit)
        .map((chat) => this.chatSummary(chat));
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
        const ring = this.ofTypes(this.store.byChat.get(jid) ?? [], types);
        return this.synced(this.viewsFor(ring.slice(-limit), jid));
      }

      const anchor = this.messageOrThrow(before);
      let older = this.olderThan(jid, before, limit, types);
      if (older.length === 0) {
        await this.fetchOlder(sock, anchor, limit);
        older = this.olderThan(jid, before, limit, types);
      }
      return this.synced(this.viewsFor(older, jid));
    });
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
      const conversations: RecentConversation[] = [];
      await this.learnLidPhones(this.store.byChat.keys());
      // A group's metadata is what names a sender the address book does not
      // know; fetch it for the groups that spoke in the window, once each.
      const activeGroups = [...this.store.byChat.keys()].filter((jid) => {
        if (!isGroupId(jid) || this.groupCache.has(jid) || this.unreadableGroups.has(jid)) return false;
        const last = this.lastMessageOf(jid);
        return last !== null && messageTimestampMs(last) >= cutoff;
      });
      await Promise.all(activeGroups.slice(0, RECENT_GROUP_META_MAX).map((jid) => this.learnParticipants(jid)));

      for (const [jid, ring] of this.store.byChat) {
        if (isNoiseJid(jid)) continue;
        const chat = this.store.chats.get(jid);
        if (chat && !this.matchesChatFilter(chat, filter)) continue;
        if (!chat && (filter === "unread" || filter === (isGroupId(jid) ? "individual" : "groups"))) continue;

        // Rings are kept newest-last, so the window is a suffix: walk back to
        // its start instead of scanning a ring that can hold a thousand sids.
        const recent: string[] = [];
        for (let i = ring.length - 1; i >= 0; i--) {
          const raw = this.store.messages.get(ring[i]!);
          if (!raw) continue;
          if (messageTimestampMs(raw) < cutoff) break;
          recent.push(ring[i]!);
        }
        recent.reverse();
        if (recent.length === 0) continue;

        const messages = this.viewsFor(this.ofTypes(recent, types), jid).filter(
          (view) => includeSystem || view.type !== "system"
        );
        if (messages.length === 0) continue;
        conversations.push({
          chat_id: jid,
          chat_name: this.displayName(jid),
          ...(this.notes.noteFor(jid) ? { note: this.notes.noteFor(jid) } : {}),
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
  ): Promise<Synced<MessageView[]>> {
    return this.guarded(async () => {
      this.ensureConnected();
      await this.waitForSync();
      const needle = query.trim().toLowerCase();
      const scope = chatId === undefined ? undefined : this.resolveId(chatId);
      const from = opts.from === undefined ? undefined : opts.from === "me" ? this.ownJid() : this.resolveId(opts.from);
      const hits: Array<{ sid: string; jid: string; at: number }> = [];

      for (const [sid, raw] of this.store.messages) {
        const jid = this.store.chatOf.get(sid);
        if (!jid || isNoiseJid(jid) || (scope !== undefined && jid !== scope)) continue;
        const at = messageTimestampMs(raw);
        if ((opts.sinceMs !== undefined && at < opts.sinceMs) || (opts.untilMs !== undefined && at > opts.untilMs))
          continue;
        // The rendered text, not the bare placeholder, so a transcript is findable
        // by the words a reader can see — lowercased once, then held by the store.
        if (needle && !(this.store.searchLower(sid) ?? "").includes(needle)) continue;
        hits.push({ sid, jid, at });
      }

      hits.sort((a, b) => b.at - a.at);
      const views: MessageView[] = [];
      for (const hit of hits) {
        if (views.length >= limit) break;
        const view = this.viewOf(hit.sid, hit.jid);
        if (from !== undefined && view.sender.id !== from) continue;
        views.push(view);
      }
      return this.synced(views);
    });
  }

  /**
   * Semantic search over the living-memory index: the query is embedded, then
   * cosine-matched against every live row under the same filters
   * search_messages takes, ranked by similarity × recency decay. A hit still
   * in the store hydrates to a full view; one that fell out answers from the
   * index's own copy — reaching it is the whole point of the index.
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
      const store = this.readyRecall();
      const scope = chatId === undefined ? undefined : this.resolveId(chatId);
      const from = opts.from === undefined ? undefined : opts.from === "me" ? this.ownJid() : this.resolveId(opts.from);
      const [vector] = await this.recallEmbed([query], "query");
      const minSimilarity = this.recallEnv instanceof WazapError ? undefined : this.recallEnv.minSimilarity;
      const hits = store
        .query({
          vector: vector!,
          text: query,
          chatId: scope,
          sinceMs: opts.sinceMs,
          untilMs: opts.untilMs,
          from,
          minSimilarity,
          limit,
        })
        .map((hit) => {
          const live = this.store.messages.has(hit.record.sid);
          return {
            score: hit.score,
            similarity: hit.similarity,
            message: live ? this.viewOf(hit.record.sid, hit.record.jid) : this.indexView(hit.record),
            from_index: !live,
          };
        });
      return this.synced({ hits, index: this.recallStatus() });
    });
  }

  /**
   * The index a recall query may run on, or the refusal the tool reports.
   * "off" splits by cause: the feature disabled, or the history it derives
   * from not persisted; "degraded" carries the line the status already found.
   */
  private readyRecall(): RecallStore {
    const status = this.recallStatus();
    if (status.state === "degraded") {
      throw new WazapError("RECALL_UNAVAILABLE", status.detail ?? "Semantic recall is unavailable.", status.fix);
    }
    if (status.state === "off") {
      if (this.recallEnv instanceof WazapError || !this.recallEnv.enabled) {
        throw new WazapError("RECALL_UNAVAILABLE", "Semantic recall is off.", "Run `wazap config recall local`");
      }
      throw new WazapError(
        "RECALL_UNAVAILABLE",
        "Semantic recall needs message history kept on disk, which is off.",
        "Set WAZAP_PERSIST_HISTORY=1 and restart the server"
      );
    }
    // "ready" and "indexing" are only reached once the store opened.
    return this.recallStore!;
  }

  /**
   * What the index still knows about a message the live store dropped: enough
   * to quote it, name its chat and sender, and date it. get_message and
   * download_media can no longer see it — `from_index` says so.
   */
  private indexView(record: RecallRecord): MessageView {
    const sender = record.sender;
    const phone = phoneOf(sender);
    const note = this.notes.noteFor(sender);
    return {
      message_id: record.sid,
      chat_id: record.jid,
      from_me: this.isMe(sender),
      sender: {
        id: sender,
        name: this.displayName(sender),
        ...(phone !== undefined ? { phone } : {}),
        ...(note !== undefined ? { note } : {}),
      },
      type: record.type as MessageType,
      text: record.text,
      timestamp: isoWithOffset(record.ts),
      age: formatAge(record.ts),
      has_media: false,
      forwarded: false,
      edited: false,
    };
  }

  getMessage(messageId: string): Promise<MessageView> {
    return this.guarded(async () => {
      this.ensureConnected();
      this.messageOrThrow(messageId);
      return this.viewOf(messageId, this.store.chatOf.get(messageId) ?? "");
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
      const seen = new Set<string>();

      for (const jid of [...this.store.contacts.keys(), ...this.notes.fields.keys()]) {
        // A lid entry whose number is known is the same person as the phone entry.
        const person = this.canonical(jid);
        if (seen.has(person)) continue;
        seen.add(person);
        const contact = this.store.contacts.get(jid);
        const details = this.notes.fieldsFor(person) ?? this.notes.fieldsFor(jid);
        if (tag !== undefined && !(details?.tags ?? []).includes(tag)) continue;
        // Every name we might show, or someone the chat list calls "Carmen"
        // would not be findable by that name here.
        const known = [
          contact?.name,
          contact?.verifiedName,
          contact?.notify,
          this.store.pushNames.get(jid),
          this.store.pushNames.get(person),
        ].map(realName);
        const number = person.split("@")[0] ?? "";
        const hit =
          needle === "" ||
          known.some((name) => name?.toLowerCase().includes(needle)) ||
          (digits.length >= 5 && number.includes(digits)) ||
          (details?.tags ?? []).some((t) => t.includes(needle)) ||
          Object.entries(details?.fields ?? {}).some(
            ([key, value]) => key.includes(needle) || value.toLowerCase().includes(needle)
          );
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
          PROFILE_LOOKUP_MS
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
      return {
        messages: found.map((a) => this.viewOf(a.sid, a.jid)),
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
      this.recallForget(this.store.pruneStories(Date.now() - STORY_TTL_MS));
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
        const raw = this.store.messages.get(sid);
        if (!raw) continue;
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
          await this.writePreview(sid, made);
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
  }

  /** A preview whose message the store no longer holds is a leak; drop it at load. */
  private async prunePreviews(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.paths.previewsDir);
    } catch (err) {
      if (!isMissing(err)) logError("preview prune", err);
      return;
    }
    const keep = new Set([...this.store.messages.keys()].map((sid) => `${safeFilename(sid)}.jpg`));
    try {
      await Promise.all(
        names.filter((name) => !keep.has(name)).map((name) => rm(join(this.paths.previewsDir, name), { force: true }))
      );
    } catch (err) {
      logError("preview prune", err);
    }
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
      const cutoff = Date.now() - minAgeHours * 3_600_000;
      const horizon = Date.now() - maxAgeHours * 3_600_000;
      const found: UnansweredChat[] = [];
      for (const chat of this.mergeAliases(this.knownChats())) {
        if (chat.archived) continue;
        const jid = this.canonical(chat.id ?? "");
        if (isNoiseJid(jid)) continue;
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
      return this.synced(found.slice(0, limit));
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
      const current = this.notes.fieldsFor(jid);
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
      this.notes.updateFields(jid, { addTags, removeTags, set, removeFields: [...removeFields] });
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
    addressedToMe: boolean
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
      const raw = this.messageOrThrow(messageId);
      const info = mediaInfo(raw);
      if (!info) throw new WazapError("MEDIA_UNAVAILABLE", `Message ${messageId} carries no media.`);
      const buffer = await this.mediaBuffer(sock, messageId, raw);

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

  /**
   * Speech into text, once per message: a transcript already on hand is returned
   * as it is, because the local provider is slow and the API one is billed.
   */
  transcribeAudio(messageId: string, language?: string): Promise<TranscribeResult> {
    return this.guarded(async () => {
      const raw = this.messageOrThrow(messageId);
      const known = this.store.transcripts.get(messageId);
      if (known) return transcribeResult(known, true);

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
    language?: string
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
    // A message revoked while the transcription ran keeps nothing behind.
    if (!this.store.messages.has(messageId)) return transcribeResult(record, false);
    this.store.setTranscript(messageId, record);
    this.markStoreDirty();
    // The newest line for a sid wins on reload, so re-appending is what makes
    // the transcript outlive the process.
    await this.appendHistory([raw]);
    // With the transcript on it, the voice note finally carries searchable text.
    this.recallFeedRaw([raw]);
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

  /**
   * Resolves when the index queue has nothing left to embed or write. Same
   * rule as transcribeIdle: off the public API, here so tests can wait on the
   * queue instead of sleeping.
   */
  recallIdle(): Promise<void> {
    return this.recallQueue?.idle() ?? Promise.resolve();
  }

  /**
   * The on-disk semantic index opens only when recall is on and history is
   * persisted — a memory that outlives the history it is derived from would be
   * a leak, not a feature. A store that refuses to open leaves recall off.
   */
  private async openRecall(): Promise<void> {
    if (this.recallEnv instanceof WazapError || !this.recallEnv.enabled || !this.config.persistHistory) return;
    try {
      const spec = EMBED_MODELS[this.recallEnv.model];
      this.recallStore = await RecallStore.open(join(this.paths.root, "recall"), spec, this.recallEnv.maxRows);
      this.recallQueue = new RecallQueue(this.recallStore, (texts) => this.recallEmbed(texts, "document"));
      if (this.recallStore.count > 0) log(`recall index: ${this.recallStore.count} messages`);
    } catch (err) {
      logError("recall index", err);
      this.recallStore = null;
      this.recallQueue = null;
    }
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
   * Every sid a revoke or delete target may have been filed under: the
   * canonical chat jid, and the raw one — which differs for a message that
   * arrived under a lid before the pairing was learned and the chat folded.
   */
  private targetSids(target: WAMessageKey, fallbackJid: string): string[] {
    const jid = target.remoteJid ?? fallbackJid;
    const raw = messageIdFor(target, jid);
    const canonical = messageIdFor(target, this.canonical(jid));
    return canonical === raw ? [raw] : [raw, canonical];
  }

  /**
   * The ops one raw message turns into: the tombstone a revoke carries for the
   * message it takes back, and a put for whatever searchable text it carries.
   * Most messages produce one or the other; plenty produce neither.
   */
  private recallOpsFor(raw: WAMessage, jid: string, transcript?: TranscriptRecord): RecallOp[] {
    const ops: RecallOp[] = [];
    const target = revokedTargetKey(raw);
    if (target !== undefined) for (const sid of this.targetSids(target, jid)) ops.push({ sid });
    const sid = messageIdFor(raw.key, jid);
    const text = searchableText(raw, transcript ?? this.store.transcripts.get(sid));
    if (text !== null) {
      // Capped here, not only in the store, so the feed diff compares the text
      // the index would actually keep — an over-cap message is not fresh work
      // on every boot. The cap is the model's: e5's 512-token window takes
      // far less text than gemma's.
      const maxChars =
        this.recallEnv instanceof WazapError ? RECALL_TEXT_CAP : EMBED_MODELS[this.recallEnv.model].maxChars;
      const capped = text.slice(0, maxChars);
      ops.push({
        sid,
        item: { sid, jid, ts: messageTimestampMs(raw), sender: this.recallSender(raw, jid), type: messageType(raw), text: capped },
      });
    }
    return ops;
  }

  /** The same sender buildMessageView resolves, kept canonical at index time. */
  private recallSender(raw: WAMessage, jid: string): string {
    if (raw.key.fromMe) return this.ownJid();
    if (jid.endsWith("@s.whatsapp.net")) return jid;
    const from = raw.key.participant || raw.participant || raw.key.remoteJid || "";
    return from ? this.canonical(from) : this.ownJid();
  }

  private recallFeedRaw(messages: WAMessage[]): void {
    if (this.recallQueue === null || messages.length === 0) return;
    const ops: RecallOp[] = [];
    for (const raw of messages) {
      if (!raw.key?.remoteJid) continue;
      ops.push(...this.recallOpsFor(raw, this.canonical(raw.key.remoteJid)));
    }
    this.recallFeed(ops);
  }

  /**
   * The boot reconcile. A history file was just compacted to `bytes`, so a
   * matching stored offset means every line was already diffed and there is
   * nothing to do; otherwise every surviving record — including the ones the
   * per-chat cap just dropped — is diffed against the index, and the seal only
   * lands once the queue has committed them.
   */
  private recallFeedHistory(file: string, records: HistoryRecord[], bytes: number): void {
    const store = this.recallStore;
    if (this.recallQueue === null || store === null) return;
    if (store.offsets()[file] === bytes) return;
    const ops: RecallOp[] = [];
    for (const record of records) {
      const raw = decodeMessage(record.raw);
      if (!raw?.key?.remoteJid || (!raw.message && !isStubEvent(raw))) continue;
      const jid = this.canonical(raw.key.remoteJid);
      if (isNoiseJid(jid) || isControlMessage(raw)) continue;
      ops.push(...this.recallOpsFor(raw, jid, record.tr));
    }
    this.recallFeed(ops, { file, bytes });
  }

  /**
   * The sid-diff every feed goes through: a put is work only when the index
   * does not already hold exactly this text, and a tombstone only when there
   * is something to remove. One edge is deliberate — a put whose sid has a
   * tombstone still queued is dropped, because once deleted stays deleted.
   */
  private recallFeed(ops: RecallOp[], seal?: { file: string; bytes: number }): void {
    const queue = this.recallQueue;
    const store = this.recallStore;
    if (queue === null || store === null || this.stopped) return;
    const fresh = ops.filter((op) => {
      const queued = queue.queued(op.sid);
      if (op.item === undefined) {
        return queued === undefined ? store.record(op.sid) !== undefined : queued.item !== undefined;
      }
      if (queued !== undefined) return queued.item !== undefined && queued.item.text !== op.item.text;
      return store.record(op.sid)?.text !== op.item.text;
    });
    if (fresh.length > 0 || seal !== undefined) queue.feed(fresh, seal);
  }

  /** The store forgot these sids, so the index must too; a sid it never held diffs away. */
  private recallForget(sids: string[]): void {
    if (sids.length === 0) return;
    this.recallFeed(sids.map((sid) => ({ sid })));
  }

  private recallStatus(): RecallStatus {
    if (this.recallEnv instanceof WazapError) {
      return { state: "degraded", indexed: 0, pending: 0, detail: this.recallEnv.message, fix: this.recallEnv.fix };
    }
    if (!this.recallEnv.enabled || !this.config.persistHistory) return { state: "off", indexed: 0, pending: 0 };
    const indexed = this.recallStore?.count ?? 0;
    const pending = this.recallQueue?.size ?? 0;
    const dead = this.recallQueue?.dead;
    if (dead !== null && dead !== undefined) {
      return { state: "degraded", indexed, pending, detail: dead, fix: "Restart the wazap server" };
    }
    if (this.recallStore === null) {
      return { state: "degraded", indexed, pending, detail: "the recall index could not be opened" };
    }
    return { state: pending > 0 ? "indexing" : "ready", indexed, pending };
  }

  /**
   * Queue first, then the engine — releasing its claim on the shared sidecar
   * unblocks an embedding call in flight — then the store, whose own write
   * queue drains before it closes. An engine still coming up is released
   * whenever its start resolves.
   */
  private async stopRecall(): Promise<void> {
    const queueStop = this.recallQueue?.stop() ?? Promise.resolve();
    if (this.recallEngineP !== null) {
      void this.recallEngineP.then((engine) => engine.stop()).catch(() => {});
    }
    await queueStop;
    await this.recallStore?.close();
  }

  draft(payload: DraftPayload): Promise<DraftView> {
    return this.guarded(async () => {
      if (payload.kind === "media") await assertMediaSource(payload.source);
      const sock = this.ensureConnected();
      const jid = await this.assertOutgoing(payload.chatId, sock);
      const stored: DraftPayload =
        payload.kind === "forward"
          ? { ...payload, chatId: jid, text: (await this.getMessage(payload.messageId)).text }
          : { ...payload, chatId: jid };
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
      const quoted = replyTo === undefined ? undefined : this.messageOrThrow(replyTo);
      const sent = await sock.sendMessage(
        jid,
        mentions.length > 0 ? { text, mentions } : { text },
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
      await sock.sendMessage(jid, { text, edit: raw.key });
      return { message_id: messageId, chat_id: jid, text, timestamp: isoWithOffset(Date.now()) };
    });
  }

  reactToMessage(messageId: string, emoji: string): Promise<{ message_id: string; emoji: string }> {
    return this.guarded(async () => {
      const raw = this.messageOrThrow(messageId);
      const { sock, jid } = await this.prepareSend(this.chatOfOrThrow(messageId));
      await sock.sendMessage(jid, { react: { text: emoji, key: raw.key } });
      return { message_id: messageId, emoji };
    });
  }

  forwardMessage(messageId: string, toChatId: string): Promise<SentMessage> {
    return this.guarded(async () => {
      const raw = this.messageOrThrow(messageId);
      const { sock, jid } = await this.prepareSend(toChatId);
      const sent = await sock.sendMessage(jid, { forward: raw });
      return this.sentResult(sent, jid, messageText(raw));
    });
  }

  deleteMessage(messageId: string, forEveryone: boolean): Promise<{ message_id: string; for_everyone: boolean }> {
    return this.guarded(async () => {
      const raw = this.messageOrThrow(messageId);
      if (!forEveryone) {
        throw new WazapError(
          "WHATSAPP_ERROR",
          "WhatsApp only supports delete-for-everyone from a linked device; deleting for yourself alone is not available.",
          "Call delete_message again with for_everyone=true"
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
      // Deleted means out of the index too — the text does not get to linger on.
      this.recallForget([messageId]);
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
      const previous = this.store.contacts.get(jid);
      this.store.contacts.set(jid, { ...(previous ?? {}), id: jid, name: fullName });
      this.namedContactsDirty = true;
      this.markStoreDirty();
      return this.contactSummary(jid, this.store.contacts.get(jid));
    });
  }

  /** Take a person out of the account's contacts: the saved name goes, the chat stays. */
  removeContact(contactId: string): Promise<ContactSummary> {
    return this.guarded(async () => {
      const sock = this.beginWrite();
      const jid = this.personJid(contactId);
      await sock.removeContact(jid);
      const stored = this.store.contacts.get(jid);
      if (stored?.name !== undefined) {
        delete stored.name;
        this.namedContactsDirty = true;
        this.markStoreDirty();
      }
      return this.contactSummary(jid, stored);
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

  manageGroup(
    groupId: string,
    action: GroupAction,
    participantIds?: string[],
    value?: string
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
      const stored = this.ingestMessages(messages);
      if (type === "notify") {
        for (const raw of messages) {
          if (raw.key.fromMe) continue;
          this.lastInboundAt = Math.max(this.lastInboundAt ?? 0, messageTimestampMs(raw));
        }
        const transcribing = this.queueTranscripts(stored);
        this.queueWebhook(stored, transcribing);
        this.noteArrivals(stored);
      }
      void this.appendHistory(stored);
      this.markStoreDirty();
    });

    sock.ev.on("messages.delete", (item) => {
      // The other side asked that these go; the store honours it the way the
      // phone does, ring and index included.
      const sids: string[] = [];
      if ("all" in item) {
        const ring = this.store.byChat.get(this.canonical(item.jid)) ?? [];
        sids.push(...ring);
      } else {
        for (const key of item.keys) {
          if (!key.remoteJid) continue;
          sids.push(...this.targetSids(key, key.remoteJid));
        }
      }
      for (const sid of sids) this.store.dropMessage(sid);
      this.recallForget(sids);
      if (sids.length > 0) this.markStoreDirty();
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
          this.store.noteMessageChanged(sid);
          // New words for a sid the index may already hold: a re-feed writes
          // a fresh row and tombstones the old one.
          this.recallFeedRaw([raw]);
        }
        if (update.messageTimestamp) {
          raw.messageTimestamp = update.messageTimestamp;
          this.store.noteMessageChanged(sid);
        }
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
        this.store.react(target, author, reaction.text ?? "");
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
    if (jid.endsWith("@lid")) {
      const pn = this.lidToPn.get(jid);
      return pn ? { lidJid: jid, pnJid: pn } : { lidJid: jid };
    }
    const lid = this.phoneLids.get(jid);
    return lid ? { pnJid: jid, lidJid: lid } : { pnJid: jid };
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
      this.namedContactsDirty = true;
    }
    // Notes, tags and details filed under the lid belong to the same person.
    // mergeInto can only fail on the disk write — the in-memory merge already
    // happened — and a throw here would take the event handler down with it.
    try {
      this.notes.mergeInto(lid, jid);
    } catch (err) {
      logError("notes merge", err);
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
   * the transcribe queue waits for it, bounded, before the view is built:
   * `viewOf` reads `store.transcripts` fresh, so the wait is the whole reason a
   * voice note's webhook can carry its words. The wait is on that one message's
   * transcript, never on the queue, so a note is never held for the notes behind
   * it. The timer is unreferenced so it can never hold the process open.
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
    if (this.stopped) {
      logError("webhook", `dropped ${args.event} for ${args.sid}: the service stopped while waiting for a transcript`);
      return;
    }
    await this.webhook.notify(
      asWebhookPayload({
        event: args.event,
        view: this.viewOf(args.sid, args.jid),
        account: this.accountRecord,
        isSelfChat: this.isMe(args.jid),
      })
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
      if (this.store.transcripts.has(sid)) continue;
      queued.set(sid, this.transcribeQueue.enqueue(sid));
    }
    return queued;
  }

  private messageOrThrow(messageId: string): WAMessage {
    const raw = this.store.messages.get(messageId);
    if (!raw) {
      throw new WazapError(
        "MESSAGE_NOT_FOUND",
        `No message "${messageId}" is loaded.`,
        "Use a message_id from read_messages or search_messages"
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
    const details = this.notes.fieldsFor(jid) ?? this.notes.fieldsFor(this.canonical(jid));
    return {
      contact_id: jid,
      name: this.displayName(jid),
      ...(this.notes.noteFor(jid) ? { note: this.notes.noteFor(jid) } : {}),
      ...(details?.tags?.length ? { tags: details.tags } : {}),
      ...(details?.fields && Object.keys(details.fields).length > 0 ? { fields: details.fields } : {}),
      number,
      is_my_contact: realName(contact?.name) !== "",
      is_business: Boolean(contact?.verifiedName),
    };
  }

  private sentResult(sent: WAMessage | undefined, jid: string, text: string): SentMessage {
    if (!sent) {
      return { message_id: `unknown_${jid}_${randomUUID()}`, chat_id: jid, text, timestamp: isoWithOffset(Date.now()) };
    }
    const sid = messageIdFor(sent.key, jid);
    if (sent.key.id) this.sentByWazap.note(sent.key.id);
    this.store.putMessage(sid, jid, sent);
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
    this.namedContactsDirty = true;
  }

  private ingestMessages(messages: WAMessage[]): WAMessage[] {
    const stored: WAMessage[] = [];
    // A revoke deletes its target wherever the target landed first: an earlier
    // batch, or later in this one — delivery order is not guaranteed.
    const revoked = new Set<string>();
    for (const raw of messages) {
      const target = revokedTargetKey(raw);
      if (target) for (const sid of this.targetSids(target, raw.key.remoteJid ?? "")) revoked.add(sid);
    }
    for (const sid of revoked) this.store.dropMessage(sid);
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
      if (revoked.has(sid)) continue;
      if (!this.keepOverEarlierCall(raw, jid, sid)) continue;
      this.store.putMessage(sid, jid, raw);
      this.noteInbound(raw);
      stored.push(raw);
    }
    // Everything that reached the store is indexable work; the feed itself
    // decides which of these messages carry words worth embedding.
    this.recallFeedRaw(stored);
    return stored;
  }

  /**
   * A story is a message on the status pseudo-chat with its author as the
   * participant. It is kept apart from the chats: no ring, no history file,
   * no wait woken, and it goes after a day, as on the phone.
   */
  private ingestStory(raw: WAMessage): void {
    if (raw.key.fromMe || isControlMessage(raw) || messageType(raw) === "system") return;
    // A revoked status leaves nothing behind — not even the "[deleted]" stub.
    const target = revokedTargetKey(raw);
    if (target) {
      for (const sid of this.targetSids(target, STATUS_JID)) this.store.dropMessage(sid);
      return;
    }
    this.learnPushName(raw, STATUS_JID);
    this.store.putStory(messageIdFor(raw.key, STATUS_JID), STATUS_JID, raw);
    this.noteInbound(raw);
    this.recallForget(this.store.pruneStories(Date.now() - STORY_TTL_MS));
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
    if (author) this.store.react(target, author, reaction.text);
    return true;
  }

  /** Reactions an older snapshot filed as messages of their own move onto their targets. */
  private foldReactions(): void {
    for (const [sid, raw] of [...this.store.messages]) {
      const jid = this.store.chatOf.get(sid);
      if (jid !== undefined && this.applyReaction(raw, jid)) {
        this.store.dropMessage(sid);
        this.recallForget([sid]);
      }
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
      this.recallForget([known.sid]);
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
    if (!this.config.persistHistory || this.persistedLoaded) return;
    this.persistedLoaded = true;
    // The snapshot first: its contacts carry the lid-to-phone pairings, and a
    // history line whose message arrived under a lid can only be filed with
    // its chat once those are known. Loaded the other way round, the same
    // message sat in a ring under the lid and in one under the phone.
    await this.loadStoreSnapshot();
    // The index opens before history replays, so the replay can feed it.
    await this.openRecall();
    await this.loadHistoryStore();
  }

  private async loadStoreSnapshot(): Promise<void> {
    try {
      const text = await readFile(this.paths.storeFile, "utf8");
      this.store.hydrate(JSON.parse(text) as StoreSnapshot);
      this.namedContactsDirty = true;
      // Hydrated messages bypass ingest, so their timestamps are folded in
      // here — once per boot, which is the whole point of the field.
      for (const raw of this.store.messages.values()) this.noteInbound(raw);
      for (const contact of this.store.contacts.values()) this.relearnLid(contact);
      for (const [lid, pn] of this.store.lids) this.learnLid(lid, pn);
      for (const key of [...this.store.byChat.keys(), ...this.store.chats.keys(), ...this.store.contacts.keys()]) {
        if (key.endsWith("@lid")) this.foldAlias(key);
      }
      this.foldReactions();
      void this.prunePreviews();
      log(`store loaded: ${this.store.chats.size} chats, ${this.store.messages.size} messages`);
    } catch (err) {
      if (!isMissing(err)) logError("store load", err);
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
      await mkdir(this.paths.root, { recursive: true, mode: DIR_MODE });
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

    // A revoke's tombstone line wins over the line its target wrote, wherever
    // each sits in the file — and taking the target out of `newest` both keeps
    // it off the store and lets the compaction below drop its bytes from disk.
    const decoded = new Map<string, WAMessage>();
    const revoked = new Set<string>();
    for (const record of newest.values()) {
      const raw = decodeMessage(record.raw);
      if (!raw) continue;
      decoded.set(record.sid, raw);
      const target = revokedTargetKey(raw);
      if (target) for (const sid of this.targetSids(target, raw.key?.remoteJid ?? "")) revoked.add(sid);
    }
    for (const sid of revoked) {
      newest.delete(sid);
      this.store.dropMessage(sid);
    }

    const kept = [...newest.values()].sort((a, b) => a.ts - b.ts).slice(-HISTORY_STORE_CAP_PER_CHAT);

    // Rewrite compacted, so the file stays bounded across restarts — but only
    // when dedup or the cap actually dropped lines; an identical rewrite on
    // every boot is pure write I/O.
    const compacted = kept.map((record) => JSON.stringify(record)).join("\n");
    const written = kept.length > 0 ? `${compacted}\n` : "";
    if (written !== text) {
      const tmp = `${path}.tmp`;
      await writeFile(tmp, written, { mode: FILE_MODE });
      await rename(tmp, path);
    }

    // `newest`, not `kept`: a record the cap just dropped is exactly what the
    // index is for. The seal marks the file as it now stands on disk.
    this.recallFeedHistory(basename(path), [...newest.values()], Buffer.byteLength(written));

    let loaded = 0;
    for (const record of kept) {
      const raw = decoded.get(record.sid);
      if (!raw?.key?.remoteJid || (!raw.message && !isStubEvent(raw))) continue;
      const jid = this.canonical(raw.key.remoteJid);
      if (isNoiseJid(jid) || isControlMessage(raw)) continue;
      // The snapshot's copy is newer than the line written when the message arrived.
      if (this.store.messages.has(record.sid)) continue;
      if (this.applyReaction(raw, jid)) continue;
      if (!this.keepOverEarlierCall(raw, jid, record.sid)) continue;
      this.store.putMessage(record.sid, jid, raw);
      this.noteInbound(raw);
      if (record.tr) this.store.setTranscript(record.sid, record.tr);
      loaded++;
    }
    return loaded;
  }

  private async appendHistory(messages: WAMessage[]): Promise<void> {
    if (!this.config.persistHistory || messages.length === 0) return;
    const lines = new Map<string, string[]>();
    for (const raw of messages) {
      if (!raw.key?.remoteJid) continue;
      const encoded = encode(() => proto.WebMessageInfo.encode(raw).finish());
      if (!encoded) continue;
      const jid = this.canonical(raw.key.remoteJid);
      const sid = messageIdFor(raw.key, jid);
      const transcript = this.store.transcripts.get(sid);
      const record: HistoryRecord = {
        sid,
        ts: Math.floor(messageTimestampMs(raw) / 1000),
        raw: encoded,
        ...(transcript === undefined ? {} : { tr: transcript }),
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
