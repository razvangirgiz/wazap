/**
 * What a failed background transcription means for the note behind it:
 *
 * - transient: worth another attempt later — a download that timed out, a
 *   provider answering 429 or 5xx, whisper.cpp crashing;
 * - permanent: another attempt gets the same answer — media WhatsApp no
 *   longer holds, audio a provider refuses as input, a file too large;
 * - waiting: nothing is wrong with the note, but its account cannot serve it
 *   now (not connected, not linked, stopping), so no attempt is spent on it;
 * - paused: nothing is wrong with the note, but the provider cannot take any
 *   note now (not ready, refusing the key, read-only), so no attempt is spent
 *   and the whole worker pauses instead of trying note after note;
 * - gone: the message was deleted, expired or is no longer one to transcribe.
 *
 * A reason is a few words for status and logs. It never carries what was said,
 * a media URL, or a provider's answer.
 */
import { WazapError } from "../errors.js";

export type FailureKind = "transient" | "permanent" | "waiting" | "paused" | "gone";

export interface Failure {
  kind: FailureKind;
  reason: string;
}

/** Marks travel beside the error, never on it, so nothing about them reaches a tool's answer. */
const marks = new WeakMap<object, Failure>();

/** Says what a failure means where it is known best: in the provider that raised it. */
export function markFailure<E extends Error>(err: E, kind: FailureKind, reason: string): E {
  marks.set(err, { kind, reason });
  return err;
}

/** Media download statuses that mean WhatsApp no longer serves the file, even after a re-upload request. */
const MEDIA_GONE = new Set([403, 404, 410, 412]);

const WAITING: Partial<Record<string, string>> = {
  NOT_CONNECTED: "not connected",
  NOT_LINKED: "not linked",
  SESSION_EXPIRED: "not linked",
  SESSION_CORRUPT: "not linked",
};

const PAUSED: Partial<Record<string, string>> = {
  TRANSCRIBE_UNAVAILABLE: "transcription is not ready",
  READ_ONLY: "read-only",
};

export function classifyFailure(err: unknown): Failure {
  if (typeof err === "object" && err !== null) {
    const marked = marks.get(err);
    if (marked !== undefined) return marked;
  }
  if (err instanceof WazapError) {
    const waiting = WAITING[err.code];
    if (waiting !== undefined) return { kind: "waiting", reason: waiting };
    const paused = PAUSED[err.code];
    if (paused !== undefined) return { kind: "paused", reason: paused };
    switch (err.code) {
      case "MESSAGE_NOT_FOUND":
        return { kind: "gone", reason: "message gone" };
      case "FILE_TOO_LARGE":
        return { kind: "permanent", reason: "media too large" };
      case "MEDIA_UNAVAILABLE": {
        const cause = (err as { cause?: unknown }).cause;
        // Without a download behind it, the message simply carries no audio to fetch.
        if (cause === undefined) return { kind: "permanent", reason: "no audio to transcribe" };
        const status = httpStatusOf(cause);
        if (status === undefined) return { kind: "transient", reason: "media download failed" };
        return MEDIA_GONE.has(status)
          ? { kind: "permanent", reason: `media no longer on WhatsApp (HTTP ${status})` }
          : { kind: "transient", reason: `media download failed (HTTP ${status})` };
      }
      case "TRANSCRIBE_FAILED":
        return { kind: "transient", reason: "transcription failed" };
      case "WHATSAPP_ERROR":
        // What a tool call wraps any error it does not know in: a provider crash as much as a socket hiccup.
        return { kind: "transient", reason: "unexpected error" };
      default:
        return { kind: "transient", reason: err.code.toLowerCase().replace(/_/g, " ") };
    }
  }
  if (err instanceof Error && (err as { code?: unknown }).code === "CLOSED") return { kind: "waiting", reason: "stopping" };
  return { kind: "transient", reason: "unexpected error" };
}

/** A Boom error's status (what Baileys throws), or a plain `status` / `statusCode`. */
function httpStatusOf(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const boom = (cause as { output?: { statusCode?: unknown } }).output?.statusCode;
  for (const value of [boom, (cause as { status?: unknown }).status, (cause as { statusCode?: unknown }).statusCode]) {
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return undefined;
}
