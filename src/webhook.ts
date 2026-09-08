/**
 * W1 outbound webhook: one URL, one shared secret, one live event
 * (`message_received`). Delivery never throws into the WhatsApp or MCP path.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { WAZAP_VERSION } from "./config.js";
import { WazapError, asWazapError } from "./errors.js";
import { logError } from "./logger.js";
import { stripPasted } from "./transcribe/index.js";
import type { MessageView, WebhookInfo } from "./wa-types.js";

export const WEBHOOK_EVENT = "message_received" as const;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_ON_FIX = "run `wazap config webhook on`";
export const WEBHOOK_URL_FIX = "set WAZAP_WEBHOOK_URL to an https:// URL, or http:// on 127.0.0.1";

const OFF = new Set(["", "off", "0", "no", "none", "false"]);
const ON = new Set(["on", "1", "true", "yes"]);
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export type WebhookSettings =
  | { kind: "off" }
  | { kind: "ready"; url: string; secret: string }
  | { kind: "invalid"; detail: string; fix: string };

export interface WebhookMessage {
  message_id: string;
  chat_id: string;
  from_me: boolean;
  type: string;
  text: string;
  timestamp: string;
  sender: { id: string; name: string; phone?: string };
}

export interface WebhookEnvelope {
  event: typeof WEBHOOK_EVENT;
  id: string;
  created_at: string;
  test?: true;
  message: WebhookMessage;
}

export type WebhookTestResult = { ok: true } | { ok: false; error: string; fix: string };

export type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The one place the webhook environment becomes typed. */
export function readWebhookSettings(env: NodeJS.ProcessEnv = process.env): WebhookSettings {
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

  const urlRaw = stripPasted(env.WAZAP_WEBHOOK_URL ?? "").replace(/\/+$/, "");
  const secret = stripPasted(env.WAZAP_WEBHOOK_SECRET ?? "");
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
 * The body is posted over this URL and the secret rides with the signature, so
 * plain http is refused unless it points back at this machine.
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

export function asWebhookMessage(view: MessageView): WebhookMessage {
  return {
    message_id: view.message_id,
    chat_id: view.chat_id,
    from_me: view.from_me,
    type: view.type,
    text: view.text,
    timestamp: view.timestamp,
    sender: {
      id: view.sender.id,
      name: view.sender.name,
      ...(view.sender.phone === undefined ? {} : { phone: view.sender.phone }),
    },
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

/** Posts `message_received` when the webhook is on and valid. Never throws. */
export class WebhookSink {
  lastError: string | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly post: WebhookFetch = fetch,
  ) {}

  settings(): WebhookSettings {
    return readWebhookSettings(this.env);
  }

  info(): WebhookInfo {
    return webhookInfo(this.settings(), this.lastError);
  }

  async notify(message: WebhookMessage): Promise<void> {
    const settings = this.settings();
    if (settings.kind !== "ready") return;
    await this.postEvent(liveEnvelope(message), settings);
  }

  async sendTest(): Promise<WebhookTestResult> {
    const settings = this.settings();
    switch (settings.kind) {
      case "off":
        return { ok: false, error: "Webhook is off.", fix: WEBHOOK_ON_FIX };
      case "invalid":
        return { ok: false, error: settings.detail, fix: settings.fix };
      case "ready":
        return this.postEvent(testEnvelope(), settings);
      default: {
        const _exhaustive: never = settings;
        return _exhaustive;
      }
    }
  }

  private async postEvent(
    payload: WebhookEnvelope,
    settings: Extract<WebhookSettings, { kind: "ready" }>,
  ): Promise<WebhookTestResult> {
    const body = JSON.stringify(payload);
    try {
      const response = await this.post(settings.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": `wazap/${WAZAP_VERSION}`,
          "x-wazap-event": payload.event,
          "x-wazap-signature": webhookSignature(body, settings.secret),
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (response.ok) {
        this.lastError = null;
        return { ok: true };
      }
      const error = `HTTP ${response.status} from ${hostOf(settings.url)}`;
      this.lastError = error;
      logError("webhook", error);
      return { ok: false, error, fix: "check the webhook URL is reachable and returns 2xx" };
    } catch (err) {
      const error = describePostError(err, settings.url);
      this.lastError = error;
      logError("webhook", err);
      return { ok: false, error, fix: "check the webhook URL is reachable and returns 2xx" };
    }
  }
}

function liveEnvelope(message: WebhookMessage): WebhookEnvelope {
  return {
    event: WEBHOOK_EVENT,
    id: randomUUID(),
    created_at: new Date().toISOString(),
    message,
  };
}

function testEnvelope(): WebhookEnvelope {
  const created_at = new Date().toISOString();
  return {
    event: WEBHOOK_EVENT,
    id: randomUUID(),
    created_at,
    test: true,
    message: {
      message_id: "test",
      chat_id: "test@s.whatsapp.net",
      from_me: false,
      type: "text",
      text: "wazap webhook test",
      timestamp: created_at,
      sender: { id: "wazap", name: "wazap" },
    },
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function describePostError(err: unknown, url: string): string {
  const host = hostOf(url);
  if (err instanceof Error && err.name === "TimeoutError") return `timed out reaching ${host}`;
  const cause = err instanceof Error ? err.message : String(err);
  return `could not reach ${host} (${cause})`;
}
