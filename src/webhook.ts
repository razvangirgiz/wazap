/**
 * W1 outbound webhook: three live events (`message_received`, `message_sent`
 * and `connection`). Global URL and secret live in `.env`; an account may
 * override either. Delivery never throws into the WhatsApp or MCP path.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { WAZAP_VERSION } from "./config.js";
import { WazapError, asWazapError } from "./errors.js";
import { logError } from "./logger.js";
import { redact, stripPasted } from "./transcribe/index.js";
import type { ConnectionStatus, MessageType, MessageView, WebhookInfo } from "./wa-types.js";

export const WEBHOOK_EVENTS = ["message_received", "message_sent", "connection"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** What `webhook test` posts when `--event` does not name another one. */
export const WEBHOOK_EVENT = "message_received" as const;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_TEXT_MAX = 2000;
export const WEBHOOK_RETRY_DELAYS_MS = [200, 500] as const;
export const WEBHOOK_ON_FIX = "run `wazap config webhook on`";
export const WEBHOOK_URL_FIX = "set WAZAP_WEBHOOK_URL to an https:// URL, or http:// on 127.0.0.1";
export const WEBHOOK_TEST_FIX = "run `wazap webhook test`";
export const WEBHOOK_EVENT_FIX = `pass one of ${WEBHOOK_EVENTS.join(", ")}`;

export const WEBHOOK_KINDS = ["text", "audio", "image", "other"] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];

export type WebhookConnectionStatus = "linked" | "disconnected" | "expired";

const OFF = new Set(["", "off", "0", "no", "none", "false"]);
const ON = new Set(["on", "1", "true", "yes"]);
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export type WebhookSettings =
  | { kind: "off" }
  | { kind: "ready"; url: string; secret: string }
  | { kind: "invalid"; detail: string; fix: string };

/** Per-account URL/secret win over `WAZAP_WEBHOOK_URL` / `WAZAP_WEBHOOK_SECRET`. */
export interface WebhookOverride {
  url?: string;
  secret?: string;
}

/** The account the payload names, and whose override the sink prefers. */
export interface WebhookAccount {
  id: string;
  name: string;
  webhook_url?: string;
  webhook_secret?: string;
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

export type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Test seams and the account whose override the sink prefers. */
export interface WebhookSinkOptions {
  post?: WebhookFetch;
  retryDelays?: readonly number[];
  account?: WebhookAccount;
}

/** The one place the webhook environment becomes typed. */
export function readWebhookSettings(
  env: NodeJS.ProcessEnv = process.env,
  override: WebhookOverride = {},
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
  const missingUrl = urlRaw === "";
  const missingSecret = secret === "";
  if (missingUrl && missingSecret) {
    return { kind: "invalid", detail: "on without a URL or a secret", fix: WEBHOOK_ON_FIX };
  }
  if (missingUrl) return { kind: "invalid", detail: "on without a URL", fix: WEBHOOK_ON_FIX };
  if (missingSecret) return { kind: "invalid", detail: "on without a secret", fix: WEBHOOK_ON_FIX };

  try {
    return { kind: "ready", url: requireWebhookUrl(urlRaw), secret };
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
    throw new WazapError("INVALID_ID", `Not a URL: ${url}`, WEBHOOK_URL_FIX);
  }
  if (parsed.protocol === "https:") return url;
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (parsed.protocol === "http:" && LOOPBACK.has(host)) return url;
  throw new WazapError("INVALID_ID", `Refusing a non-https webhook URL: ${url}`, WEBHOOK_URL_FIX);
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

export function webhookInfo(settings: WebhookSettings, lastError: string | null): WebhookInfo {
  switch (settings.kind) {
    case "off":
      return { enabled: false, valid: true, last_error: null };
    case "ready":
      return { enabled: true, valid: true, last_error: lastError };
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

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    opts: WebhookSinkOptions = {},
  ) {
    this.post = opts.post ?? fetch;
    this.retryDelays = opts.retryDelays ?? WEBHOOK_RETRY_DELAYS_MS;
    this.account = opts.account;
  }

  settings(): WebhookSettings {
    return readWebhookSettings(this.env, {
      url: this.account?.webhook_url,
      secret: this.account?.webhook_secret,
    });
  }

  info(): WebhookInfo {
    return webhookInfo(this.settings(), this.lastError);
  }

  /**
   * True only when the consumer accepted the POST, so a caller whose event has no
   * later transition to recover with can tell a delivery from a drop. Still never
   * throws.
   */
  async notify(payload: WebhookPayload): Promise<boolean> {
    try {
      const settings = this.settings();
      if (settings.kind !== "ready") return false;
      return (await this.postEvent(payload, settings)).ok;
    } catch (err) {
      const settings = this.settings();
      const secret = settings.kind === "ready" ? settings.secret : "";
      this.lastError = redact(err instanceof Error ? err.message : String(err), secret);
      logError("webhook", this.lastError);
      return false;
    }
  }

  async sendTest(event: WebhookEvent = WEBHOOK_EVENT): Promise<WebhookTestResult> {
    const settings = this.settings();
    switch (settings.kind) {
      case "off":
        return { ok: false, error: "Webhook is off.", fix: WEBHOOK_ON_FIX };
      case "invalid":
        return { ok: false, error: settings.detail, fix: settings.fix };
      case "ready":
        return this.postEvent(testPayload(event, this.account), settings);
      default: {
        const _exhaustive: never = settings;
        return _exhaustive;
      }
    }
  }

  private async postEvent(
    payload: WebhookPayload,
    settings: Extract<WebhookSettings, { kind: "ready" }>,
  ): Promise<WebhookTestResult> {
    const body = JSON.stringify(payload);
    const attempts = 1 + this.retryDelays.length;
    let last: WebhookTestResult = { ok: false, error: "webhook POST failed", fix: "check the webhook URL is reachable and returns 2xx" };
    for (let i = 0; i < attempts; i++) {
      last = await this.postOnce(body, payload.event, settings);
      if (last.ok) {
        this.lastError = null;
        return last;
      }
      const delay = this.retryDelays[i];
      if (delay !== undefined) {
        logError("webhook", `${last.error}; retry ${i + 1}/${this.retryDelays.length}`);
        if (delay > 0) await sleep(delay);
      }
    }
    this.lastError = last.error;
    logError("webhook", last.error);
    return last;
  }

  private async postOnce(
    body: string,
    event: WebhookEvent,
    settings: Extract<WebhookSettings, { kind: "ready" }>,
  ): Promise<WebhookTestResult> {
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
      if (response.ok) return { ok: true };
      return failResult(`HTTP ${response.status} from ${hostOf(settings.url)}`, settings.secret);
    } catch (err) {
      return failResult(describePostError(err, settings.url, settings.secret), settings.secret);
    }
  }
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
    return url;
  }
}

function describePostError(err: unknown, url: string, secret: string): string {
  const host = hostOf(url);
  if (err instanceof Error && err.name === "TimeoutError") return `timed out reaching ${host}`;
  const cause = redact(err instanceof Error ? err.message : String(err), secret);
  return `could not reach ${host} (${cause})`;
}

function failResult(error: string, secret: string): WebhookTestResult {
  return {
    ok: false,
    error: redact(error, secret),
    fix: "check the webhook URL is reachable and returns 2xx",
  };
}
