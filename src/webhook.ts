/**
 * W1 outbound webhook: one URL, one shared secret, one live event
 * (`message_received`). Delivery never throws into the WhatsApp or MCP path.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { WAZAP_VERSION } from "./config.js";
import { WazapError, asWazapError } from "./errors.js";
import { logError } from "./logger.js";
import { redact, stripPasted } from "./transcribe/index.js";
import type { MessageView, WebhookInfo } from "./wa-types.js";

export const WEBHOOK_EVENT = "message_received" as const;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_TEXT_MAX = 500;
export const WEBHOOK_RETRY_DELAYS_MS = [200, 500] as const;
export const WEBHOOK_ON_FIX = "run `wazap config webhook on`";
export const WEBHOOK_URL_FIX = "set WAZAP_WEBHOOK_URL to an https:// URL, or http:// on 127.0.0.1";
export const WEBHOOK_TEST_FIX = "run `wazap webhook test`";

const OFF = new Set(["", "off", "0", "no", "none", "false"]);
const ON = new Set(["on", "1", "true", "yes"]);
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export type WebhookSettings =
  | { kind: "off" }
  | { kind: "ready"; url: string; secret: string }
  | { kind: "invalid"; detail: string; fix: string };

/** The JSON body. HMAC is over this exact UTF-8 string. */
export interface WebhookPayload {
  event: typeof WEBHOOK_EVENT;
  from: string;
  chat_id: string;
  ts: string;
  text: string;
  message_id: string;
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

export function previewText(text: string): string {
  if (text.length <= WEBHOOK_TEXT_MAX) return text;
  return `${text.slice(0, WEBHOOK_TEXT_MAX - 1)}…`;
}

export function asWebhookPayload(view: MessageView): WebhookPayload {
  return {
    event: WEBHOOK_EVENT,
    from: view.sender.phone ?? view.sender.id,
    chat_id: view.chat_id,
    ts: view.timestamp,
    text: previewText(view.text),
    message_id: view.message_id,
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
    private readonly retryDelays: readonly number[] = WEBHOOK_RETRY_DELAYS_MS,
  ) {}

  settings(): WebhookSettings {
    return readWebhookSettings(this.env);
  }

  info(): WebhookInfo {
    return webhookInfo(this.settings(), this.lastError);
  }

  async notify(payload: WebhookPayload): Promise<void> {
    try {
      const settings = this.settings();
      if (settings.kind !== "ready") return;
      await this.postEvent(payload, settings);
    } catch (err) {
      const settings = this.settings();
      const secret = settings.kind === "ready" ? settings.secret : "";
      this.lastError = redact(err instanceof Error ? err.message : String(err), secret);
      logError("webhook", this.lastError);
    }
  }

  async sendTest(): Promise<WebhookTestResult> {
    const settings = this.settings();
    switch (settings.kind) {
      case "off":
        return { ok: false, error: "Webhook is off.", fix: WEBHOOK_ON_FIX };
      case "invalid":
        return { ok: false, error: settings.detail, fix: settings.fix };
      case "ready":
        return this.postEvent(testPayload(), settings);
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
      last = await this.postOnce(body, settings);
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
    settings: Extract<WebhookSettings, { kind: "ready" }>,
  ): Promise<WebhookTestResult> {
    try {
      const response = await this.post(settings.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": `wazap/${WAZAP_VERSION}`,
          "x-wazap-event": WEBHOOK_EVENT,
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

function testPayload(): WebhookPayload {
  return {
    event: WEBHOOK_EVENT,
    from: "wazap",
    chat_id: "test@s.whatsapp.net",
    ts: new Date().toISOString(),
    text: "wazap webhook test",
    message_id: "test",
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
