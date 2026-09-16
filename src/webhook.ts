/**
 * W1 outbound webhook: three live events (`message_received`, `message_sent`
 * and `connection`), of which only `message_received` is posted unless
 * `WAZAP_WEBHOOK_EVENTS` asks for more. Global URL, secret and event list live
 * in `.env`; an account may override any of the three. Delivery never throws
 * into the WhatsApp or MCP path.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WAZAP_VERSION } from "./config.js";
import { WazapError, asWazapError } from "./errors.js";
import { log, logError } from "./logger.js";
import { redact, stripPasted } from "./transcribe/index.js";
import { discardResponse } from "./http-response.js";
import type { ConnectionStatus, MessageType, MessageView, WebhookDelivery, WebhookInfo } from "./wa-types.js";

export const WEBHOOK_EVENTS = ["message_received", "message_sent", "connection"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** What `webhook test` posts when `--event` does not name another one. */
export const WEBHOOK_EVENT = "message_received" as const;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_TEXT_MAX = 2000;
export const WEBHOOK_RETRY_DELAYS_MS = [200, 500] as const;
/** Parallel POSTs a busy chat may hold; the rest queue behind them in order. */
export const WEBHOOK_MAX_INFLIGHT = 4;
/** A dead consumer must not grow memory: past this many queued events, new ones drop. */
export const WEBHOOK_MAX_BACKLOG = 256;
/** Inside a run of identical failures, or of drops, one log line per this many. */
export const WEBHOOK_LOG_EVERY = 100;
/** The counters reach disk at most this often, so a run of failures is not a run of writes. */
export const WEBHOOK_STATS_WRITE_MS = 5_000;
/** Failed events in a row before doctor calls delivery broken rather than flaky. */
export const WEBHOOK_FAILING_AFTER = 3;
export const WEBHOOK_ON_FIX = "run `wazap config webhook on`";
export const WEBHOOK_URL_FIX = "set WAZAP_WEBHOOK_URL to an https:// URL, or http:// on 127.0.0.1";
export const WEBHOOK_TEST_FIX = "run `wazap webhook test`";
export const WEBHOOK_EVENT_FIX = `pass one of ${WEBHOOK_EVENTS.join(", ")}`;
export const WEBHOOK_EVENTS_DEFAULT: readonly WebhookEvent[] = ["message_received"] as const;
export const WEBHOOK_EVENTS_FIX = `set WAZAP_WEBHOOK_EVENTS to all or a comma-separated list of ${WEBHOOK_EVENTS.join(", ")}`;

export const WEBHOOK_KINDS = ["text", "audio", "image", "other"] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];

export type WebhookConnectionStatus = "linked" | "disconnected" | "expired";

const OFF = new Set(["", "off", "0", "no", "none", "false"]);
const ON = new Set(["on", "1", "true", "yes"]);
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export type WebhookSettings =
  | { kind: "off" }
  | { kind: "ready"; url: string; secret: string; events: readonly WebhookEvent[] }
  | { kind: "invalid"; detail: string; fix: string };

/** Per-account values win over `WAZAP_WEBHOOK_URL`, `_SECRET` and `_EVENTS`. */
export interface WebhookOverride {
  url?: string;
  secret?: string;
  events?: string;
}

/** The account the payload names, and whose override the sink prefers. */
export interface WebhookAccount {
  id: string;
  name: string;
  webhook_url?: string;
  webhook_secret?: string;
  webhook_events?: string;
}

/** The JSON body of a message event. HMAC is over this exact UTF-8 string. */
export interface WebhookMessagePayload {
  event: "message_received" | "message_sent";
  from: string;
  chat_id: string;
  ts: string;
  timestamp: string;
  text: string;
  truncated: boolean;
  kind: WebhookKind;
  from_me: boolean;
  is_self_chat: boolean;
  message_id: string;
  account_id: string;
  account_name: string;
}

export interface WebhookConnectionPayload {
  event: "connection";
  status: WebhookConnectionStatus;
  timestamp: string;
  account_id: string;
  account_name: string;
}

export type WebhookPayload = WebhookMessagePayload | WebhookConnectionPayload;

/** The preview and whether it had to be cut, so the payload never decides twice. */
export interface WebhookText {
  text: string;
  truncated: boolean;
}

/** A message event, as the service knows it at the moment it posts. */
export interface WebhookMessageEvent {
  event: "message_received" | "message_sent";
  view: MessageView;
  account: Pick<WebhookAccount, "id" | "name">;
  isSelfChat: boolean;
}

export interface WebhookConnectionEvent {
  status: WebhookConnectionStatus;
  account: Pick<WebhookAccount, "id" | "name">;
  at: number;
}

export type WebhookTestResult = { ok: true } | { ok: false; error: string; fix: string };

/** One POST: a failure also says whether trying the same request again can help. */
type WebhookAttempt = { ok: true } | { ok: false; error: string; fix: string; retry: boolean };

const WEBHOOK_REACH_FIX = "check the webhook URL is reachable and returns 2xx";

export type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Test seams and the account whose override the sink prefers. */
export interface WebhookSinkOptions {
  post?: WebhookFetch;
  retryDelays?: readonly number[];
  account?: WebhookAccount;
  maxInflight?: number;
  maxBacklog?: number;
  /** Where the delivery counters are kept for another process to read; unset keeps them in memory only. */
  statsFile?: string;
  statsWriteMs?: number;
}

/** The one place the webhook environment becomes typed. */
export function readWebhookSettings(
  env: NodeJS.ProcessEnv = process.env,
  override: WebhookOverride = {}
): WebhookSettings {
  const raw = stripPasted(env.WAZAP_WEBHOOK ?? "");
  const flag = raw.toLowerCase();
  if (OFF.has(flag)) return { kind: "off" };
  if (!ON.has(flag)) {
    return {
      kind: "invalid",
      detail: `unknown setting "${raw}"`,
      fix: "set WAZAP_WEBHOOK to on or off",
    };
  }

  const overrideUrl = stripPasted(override.url ?? "");
  const overrideSecret = stripPasted(override.secret ?? "");
  const urlRaw = (overrideUrl || stripPasted(env.WAZAP_WEBHOOK_URL ?? "")).replace(/\/+$/, "");
  const secret = overrideSecret || stripPasted(env.WAZAP_WEBHOOK_SECRET ?? "");
  const overrideEvents = stripPasted(override.events ?? "");
  const eventsRaw = overrideEvents || stripPasted(env.WAZAP_WEBHOOK_EVENTS ?? "");
  const missingUrl = urlRaw === "";
  const missingSecret = secret === "";
  if (missingUrl && missingSecret) {
    return { kind: "invalid", detail: "on without a URL or a secret", fix: WEBHOOK_ON_FIX };
  }
  if (missingUrl) return { kind: "invalid", detail: "on without a URL", fix: WEBHOOK_ON_FIX };
  if (missingSecret) return { kind: "invalid", detail: "on without a secret", fix: WEBHOOK_ON_FIX };

  try {
    return { kind: "ready", url: requireWebhookUrl(urlRaw), secret, events: parseWebhookEvents(eventsRaw) };
  } catch (err) {
    const failure = asWazapError(err);
    return { kind: "invalid", detail: failure.message, fix: failure.fix ?? WEBHOOK_URL_FIX };
  }
}

/**
 * The body is posted over this URL and the secret signs it, so plain http is
 * refused unless it points back at this machine.
 */
export function requireWebhookUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WazapError("INVALID_ID", "Invalid webhook URL.", WEBHOOK_URL_FIX);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new WazapError(
      "INVALID_ID",
      "Webhook URLs must not contain userinfo credentials or a fragment.",
      WEBHOOK_URL_FIX
    );
  }
  if (parsed.protocol === "https:") return url;
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (parsed.protocol === "http:" && LOOPBACK.has(host)) return url;
  throw new WazapError("INVALID_ID", "Refusing a non-https webhook URL.", WEBHOOK_URL_FIX);
}

/** `sha256=<hex>` of the exact UTF-8 body, the value of `X-Wazap-Signature`. */
export function webhookSignature(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Timing-safe compare of a received signature header to the body we signed. */
export function webhookSignatureMatches(body: string, secret: string, header: string): boolean {
  const expected = Buffer.from(webhookSignature(body, secret));
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function previewText(text: string): WebhookText {
  if (text.length <= WEBHOOK_TEXT_MAX) return { text, truncated: false };
  return { text: `${text.slice(0, WEBHOOK_TEXT_MAX - 1)}…`, truncated: true };
}

/**
 * Every message type collapses into one of four buckets a consumer can switch
 * on. A recorded note (`voice`) and an attached file (`audio`) share `audio`,
 * because both carry speech and both can arrive transcribed.
 */
const KIND_BY_TYPE: Record<MessageType, WebhookKind> = {
  text: "text",
  image: "image",
  audio: "audio",
  voice: "audio",
  video: "other",
  document: "other",
  sticker: "other",
  location: "other",
  contact: "other",
  poll: "other",
  reaction: "other",
  deleted: "other",
  view_once: "other",
  call: "other",
  event: "other",
  invite: "other",
  system: "other",
  unknown: "other",
};

/**
 * `--event` as typed on the command line. The one place a string becomes an
 * event, so nothing downstream has to widen the union back to `string`.
 */
export function parseWebhookEvent(raw: string | undefined): WebhookEvent {
  if (raw === undefined) return WEBHOOK_EVENT;
  const value = raw.trim();
  const known = WEBHOOK_EVENTS.find((event) => event === value);
  if (known === undefined) {
    throw new WazapError("INVALID_ID", `Unknown webhook event "${raw}".`, WEBHOOK_EVENT_FIX);
  }
  return known;
}

/**
 * `WAZAP_WEBHOOK_EVENTS` as an operator typed it. An unset list is the 0.16.0
 * set, so a consumer that answers every POST without reading `event` keeps
 * hearing only what it already handled.
 */
export function parseWebhookEvents(raw: string): readonly WebhookEvent[] {
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  if (tokens.length === 0) return WEBHOOK_EVENTS_DEFAULT;
  const wanted = new Set<WebhookEvent>();
  for (const token of tokens) {
    const value = token.toLowerCase();
    if (value === "all") {
      for (const event of WEBHOOK_EVENTS) wanted.add(event);
      continue;
    }
    const known = WEBHOOK_EVENTS.find((event) => event === value);
    if (known === undefined) {
      throw new WazapError("INVALID_ID", `Unknown webhook event "${token}".`, WEBHOOK_EVENTS_FIX);
    }
    wanted.add(known);
  }
  return WEBHOOK_EVENTS.filter((event) => wanted.has(event));
}

export function webhookKind(type: MessageType): WebhookKind {
  return KIND_BY_TYPE[type];
}

/**
 * `null` is a state nobody outside wazap can act on, so it posts nothing:
 * `linking` and `connecting` are steps on the way to `connected`, and
 * `not_linked` is the state before any credentials exist. Every credential
 * failure collapses to `expired`, the one thing a consumer does something about.
 */
const CONNECTION_STATUS: Record<ConnectionStatus, WebhookConnectionStatus | null> = {
  not_linked: null,
  linking: null,
  connecting: null,
  connected: "linked",
  disconnected: "disconnected",
  logged_out: "expired",
  session_corrupt: "expired",
  auth_failure: "expired",
};

export function webhookConnectionStatus(status: ConnectionStatus): WebhookConnectionStatus | null {
  return CONNECTION_STATUS[status];
}

/**
 * The same instant as the local-offset `ts`, never a fresh read of the clock. The
 * instant is the sender's to state, and a peer that states a nonsense one would
 * otherwise cost the whole delivery, so an unparseable `ts` costs this one field.
 */
function utcTimestamp(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
}

export function asWebhookPayload({ event, view, account, isSelfChat }: WebhookMessageEvent): WebhookMessagePayload {
  const { text, truncated } = previewText(view.transcript ?? view.text);
  return {
    event,
    from: view.sender.phone ?? view.sender.id,
    chat_id: view.chat_id,
    ts: view.timestamp,
    timestamp: utcTimestamp(view.timestamp),
    text,
    truncated,
    kind: webhookKind(view.type),
    from_me: view.from_me,
    is_self_chat: isSelfChat,
    message_id: view.message_id,
    account_id: account.id,
    account_name: account.name,
  };
}

export function asConnectionPayload({ status, account, at }: WebhookConnectionEvent): WebhookConnectionPayload {
  return {
    event: "connection",
    status,
    timestamp: new Date(at).toISOString(),
    account_id: account.id,
    account_name: account.name,
  };
}

export function webhookInfo(
  settings: WebhookSettings,
  lastError: string | null,
  delivery?: WebhookDelivery
): WebhookInfo {
  switch (settings.kind) {
    case "off":
      return { enabled: false, valid: true, last_error: null };
    case "ready":
      return delivery === undefined
        ? { enabled: true, valid: true, last_error: lastError }
        : { enabled: true, valid: true, last_error: lastError, delivery };
    case "invalid":
      return { enabled: true, valid: false, last_error: settings.detail };
    default: {
      const _exhaustive: never = settings;
      return _exhaustive;
    }
  }
}

/** Posts an event when the webhook is on and valid. Never throws. */
export class WebhookSink {
  lastError: string | null = null;
  private readonly post: WebhookFetch;
  private readonly retryDelays: readonly number[];
  private readonly account?: WebhookAccount;
  private readonly maxInflight: number;
  private readonly maxBacklog: number;
  private inFlight = 0;
  private readonly backlog: Array<() => void> = [];
  private readonly delivery: WebhookDelivery = {
    delivered: 0,
    failed: 0,
    dropped: 0,
    consecutive_failures: 0,
    last_success_at: null,
    last_failure_at: null,
    last_failure: null,
    last_dropped_at: null,
  };
  /** Drops since the last delivery, for the log; `delivery.dropped` is the total. */
  private droppedSinceDelivery = 0;
  /** The error a run last logged, so a changed error is logged at once. */
  private loggedFailure: string | null = null;
  private readonly statsFile?: string;
  private readonly statsWriteMs: number;
  private statsWrittenAt = 0;
  private statsTimer: NodeJS.Timeout | null = null;
  private statsWriteFailed = false;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    opts: WebhookSinkOptions = {}
  ) {
    this.post = opts.post ?? fetch;
    this.retryDelays = opts.retryDelays ?? WEBHOOK_RETRY_DELAYS_MS;
    this.account = opts.account;
    this.maxInflight = opts.maxInflight ?? WEBHOOK_MAX_INFLIGHT;
    this.maxBacklog = opts.maxBacklog ?? WEBHOOK_MAX_BACKLOG;
    this.statsFile = opts.statsFile;
    this.statsWriteMs = opts.statsWriteMs ?? WEBHOOK_STATS_WRITE_MS;
  }

  /**
   * `wazap status` runs in a process of its own, so the counters it reads come
   * from this file. A change after a quiet spell writes at once; the rest wait
   * out statsWriteMs, so a receiver refusing a busy chat costs a write every
   * few seconds rather than one per event.
   */
  private saveStats(): void {
    if (this.statsFile === undefined || this.statsTimer !== null) return;
    const wait = this.statsWrittenAt + this.statsWriteMs - Date.now();
    if (wait <= 0) {
      this.writeStats();
      return;
    }
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      this.writeStats();
    }, wait);
    this.statsTimer.unref();
  }

  /** Writes a change the rate limit is still holding back. The service calls it on stop. */
  flushStats(): void {
    if (this.statsTimer === null) return;
    clearTimeout(this.statsTimer);
    this.statsTimer = null;
    this.writeStats();
  }

  private writeStats(): void {
    if (this.statsFile === undefined) return;
    this.statsWrittenAt = Date.now();
    try {
      writeWebhookDelivery(this.statsFile, this.delivery);
    } catch (err) {
      // A data dir that refuses this write refuses the next one too; say it once.
      if (!this.statsWriteFailed) logError("webhook", `could not save delivery counters: ${String(err)}`);
      this.statsWriteFailed = true;
    }
  }

  settings(): WebhookSettings {
    return readWebhookSettings(this.env, {
      url: this.account?.webhook_url,
      secret: this.account?.webhook_secret,
      events: this.account?.webhook_events,
    });
  }

  info(): WebhookInfo {
    return webhookInfo(this.settings(), this.lastError, { ...this.delivery });
  }

  private recordSuccess(): void {
    const failures = this.delivery.consecutive_failures;
    const drops = this.droppedSinceDelivery;
    if (failures > 0 || drops > 0) {
      const lost = [failures > 0 ? `${failures} failures` : "", drops > 0 ? `${drops} dropped` : ""];
      log(`webhook delivered again after ${lost.filter((part) => part !== "").join(" and ")}`);
    }
    this.delivery.delivered++;
    this.delivery.consecutive_failures = 0;
    this.delivery.last_success_at = new Date().toISOString();
    this.droppedSinceDelivery = 0;
    this.loggedFailure = null;
    this.saveStats();
  }

  /**
   * A receiver that refused every event once logged a line per event, thousands
   * of them, and nobody noticed. A run now logs its first failure, any change of
   * error, and a count every WEBHOOK_LOG_EVERY failures; recordSuccess says when
   * it ends.
   */
  private recordFailure(error: string): void {
    this.delivery.failed++;
    const failures = ++this.delivery.consecutive_failures;
    this.delivery.last_failure_at = new Date().toISOString();
    this.delivery.last_failure = error;
    if (error !== this.loggedFailure) logError("webhook", error);
    else if (failures % WEBHOOK_LOG_EVERY === 0) logError("webhook", `${error} (${failures} failures in a row)`);
    this.loggedFailure = error;
    this.saveStats();
  }

  private recordDrop(error: string): void {
    this.delivery.dropped++;
    this.delivery.last_dropped_at = new Date().toISOString();
    const drops = ++this.droppedSinceDelivery;
    if (drops === 1) logError("webhook", error);
    else if (drops % WEBHOOK_LOG_EVERY === 0) {
      logError("webhook", `${error} (${drops} dropped since the last delivery)`);
    }
    this.saveStats();
  }

  /**
   * True only when the consumer accepted the POST, so a caller whose event has no
   * later transition to recover with can tell a delivery from a drop. Still never
   * throws.
   */
  async notify(payload: WebhookPayload, current: () => boolean = () => true): Promise<boolean> {
    const isCurrent = (): boolean => { try { return current(); } catch { return false; } };
    if (!isCurrent()) return false;
    // An event nobody subscribed to used to take a slot before it was filtered,
    // so it could push a wanted one out of a full backlog. It counts nowhere.
    if (!this.subscribed(payload)) return false;
    // A busy chat used to open one POST per message, unbounded. Slots beyond
    // maxInflight wait in FIFO order; a full backlog drops the event rather
    // than letting a dead consumer grow memory inside a live process.
    while (this.inFlight >= this.maxInflight) {
      if (!isCurrent()) return false;
      if (this.backlog.length >= this.maxBacklog) {
        this.lastError = `backlog full (${this.maxBacklog} queued); dropped ${payload.event}`;
        this.recordDrop(this.lastError);
        return false;
      }
      // A woken waiter re-checks: a fresh notify may have taken the freed slot.
      await new Promise<void>((resolve) => this.backlog.push(resolve));
    }
    this.inFlight++;
    try {
      if (!isCurrent()) return false;
      const settings = this.settings();
      if (settings.kind !== "ready") return false;
      if (!settings.events.includes(payload.event)) return false;
      const result = await this.postEvent(payload, settings, isCurrent);
      if (result === null) return false; // Retention cancellation is not a receiver failure.
      if (result.ok) this.recordSuccess();
      else this.recordFailure(result.error);
      return result.ok;
    } catch {
      this.lastError = "Webhook delivery failed.";
      this.recordFailure(this.lastError);
      return false;
    } finally {
      this.inFlight--;
      this.backlog.shift()?.();
    }
  }

  private subscribed(payload: WebhookPayload): boolean {
    const settings = this.settings();
    return settings.kind === "ready" && settings.events.includes(payload.event);
  }

  async sendTest(event: WebhookEvent = WEBHOOK_EVENT): Promise<WebhookTestResult> {
    const settings = this.settings();
    switch (settings.kind) {
      case "off":
        return { ok: false, error: "Webhook is off.", fix: WEBHOOK_ON_FIX };
      case "invalid":
        return { ok: false, error: settings.detail, fix: settings.fix };
      case "ready": {
        if (!settings.events.includes(event)) {
          return {
            ok: false,
            error: `Webhook event "${event}" is not enabled.`,
            fix: enableEventFix(settings.events, event, this.account),
          };
        }
        const result = await this.postEvent(testPayload(event, this.account), settings);
        // Test events have no retention predicate and cannot be cancelled.
        if (!result!.ok) logError("webhook", result!.error);
        return result!;
      }
      default: {
        const _exhaustive: never = settings;
        return _exhaustive;
      }
    }
  }

  private async postEvent(
    payload: WebhookPayload,
    settings: Extract<WebhookSettings, { kind: "ready" }>,
    isCurrent: () => boolean = () => true
  ): Promise<WebhookTestResult | null> {
    const body = JSON.stringify(payload);
    const attempts = 1 + this.retryDelays.length;
    let last: WebhookAttempt = { ok: false, error: "webhook POST failed", fix: WEBHOOK_REACH_FIX, retry: false };
    for (let i = 0; i < attempts; i++) {
      if (!isCurrent()) return null;
      last = await this.postOnce(body, payload.event, settings);
      if (last.ok) {
        this.lastError = null;
        return last;
      }
      const delay = this.retryDelays[i];
      // A refusal would only be refused again, and each retry is one more POST
      // the receiver has to turn away.
      if (!last.retry || delay === undefined) break;
      // Inside a run of failures a retry line says nothing the run's own lines do not.
      if (this.delivery.consecutive_failures === 0) {
        logError("webhook", `${last.error}; retry ${i + 1}/${this.retryDelays.length}`);
      }
      if (delay > 0) await sleep(delay);
    }
    this.lastError = last.error;
    return { ok: false, error: last.error, fix: last.fix };
  }

  private async postOnce(
    body: string,
    event: WebhookEvent,
    settings: Extract<WebhookSettings, { kind: "ready" }>
  ): Promise<WebhookAttempt> {
    try {
      const response = await this.post(settings.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": `wazap/${WAZAP_VERSION}`,
          "x-wazap-event": event,
          "x-wazap-signature": webhookSignature(body, settings.secret),
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      await discardResponse(response);
      if (response.ok) return { ok: true };
      const host = hostOf(settings.url);
      if (retryableStatus(response.status)) {
        return failAttempt(`HTTP ${response.status} from ${host}`, settings.secret, WEBHOOK_REACH_FIX, true);
      }
      const refused = refusal(response.status);
      return failAttempt(
        `HTTP ${response.status} from ${host}, not retried: ${refused.hint}`,
        settings.secret,
        refused.fix,
        false
      );
    } catch (err) {
      return failAttempt(describePostError(err, settings.url), settings.secret, WEBHOOK_REACH_FIX, true);
    }
  }
}

/** A list is set whole, so enabling one event means naming the ones already on. */
function enableEventFix(active: readonly WebhookEvent[], event: WebhookEvent, account?: WebhookAccount): string {
  const both = WEBHOOK_EVENTS.filter((known) => active.includes(known) || known === event).join(",");
  if (account?.webhook_events === undefined) return `set WAZAP_WEBHOOK_EVENTS=${both}, or all`;
  return `set webhook_events for "${account.id}" in accounts.json to ${both}, or all`;
}

function testPayload(event: WebhookEvent, account?: Pick<WebhookAccount, "id" | "name">): WebhookPayload {
  const now = new Date().toISOString();
  const named = { account_id: account?.id ?? "default", account_name: account?.name ?? "default" };
  if (event === "connection") return { event, status: "linked", timestamp: now, ...named };
  return {
    event,
    from: "wazap",
    chat_id: "test@s.whatsapp.net",
    ts: now,
    timestamp: now,
    text: "wazap webhook test",
    truncated: false,
    kind: "text",
    from_me: event === "message_sent",
    is_self_chat: false,
    message_id: "test",
    ...named,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "configured webhook endpoint";
  }
}

function describePostError(err: unknown, url: string): string {
  const host = hostOf(url);
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
    return `timed out reaching ${host}`;
  return `could not reach ${host}`;
}

function failAttempt(error: string, secret: string, fix: string, retry: boolean): WebhookAttempt {
  return { ok: false, error: redact(error, secret), fix, retry };
}

/**
 * What can pass on its own: a timeout, a rate limit, a receiver that is down.
 * Any other 4xx is the receiver refusing this exact request, and it would
 * refuse the retry the same way.
 */
function retryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

/** A hint short enough to ride on the error line, and the repair that goes with it. */
function refusal(status: number): { hint: string; fix: string } {
  if (status === 401 || status === 403) {
    return {
      hint: "the receiver refuses the request; check the API key or secret it expects",
      fix: "give the receiver the API key or secret it expects, then run `wazap webhook test`",
    };
  }
  if (status === 404 || status === 410) {
    return {
      hint: "the receiver has no endpoint at that URL",
      fix: "point the webhook URL at the receiver's endpoint, then run `wazap webhook test`",
    };
  }
  if (status === 413) {
    return {
      hint: "the receiver refuses a body this size",
      fix: "raise the receiver's request size limit, then run `wazap webhook test`",
    };
  }
  return {
    hint: "the receiver refuses the request as sent",
    fix: "check what the receiver expects and what its log says, then run `wazap webhook test`",
  };
}

/** The repair for a failure as `last_failure` words it, for a reader in another process. */
export function webhookFailureFix(failure: string): string {
  const status = Number(/^HTTP (\d{3}) from /.exec(failure)?.[1]);
  if (Number.isInteger(status) && status >= 400 && !retryableStatus(status)) return refusal(status).fix;
  return "make the receiver reachable and answer 2xx, then run `wazap webhook test`";
}

/** Atomic and 0600, the same contract as daemon.json: a reader sees the old counters or the new ones. */
function writeWebhookDelivery(file: string, delivery: WebhookDelivery): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(delivery, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

const DELIVERY_COUNTS = ["delivered", "failed", "dropped", "consecutive_failures"] as const;
const DELIVERY_TEXTS = ["last_success_at", "last_failure_at", "last_failure", "last_dropped_at"] as const;

/** The counters a server left in an account dir, or null when it never posted or the file is not that shape. */
export function readWebhookDelivery(file: string): WebhookDelivery | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const row = parsed as Record<string, unknown>;
  const delivery: Record<string, unknown> = {};
  for (const key of DELIVERY_COUNTS) {
    const value = row[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
    delivery[key] = value;
  }
  for (const key of DELIVERY_TEXTS) {
    const value = row[key];
    if (value !== null && typeof value !== "string") return null;
    delivery[key] = value;
  }
  return delivery as unknown as WebhookDelivery;
}
