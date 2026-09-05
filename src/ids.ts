import { WazapError } from "./errors.js";

const PHONE_EXAMPLE = "Use international format, e.g. +15550100";

/** Digits of a phone number in international format, or INVALID_PHONE. */
export function normalizePhone(input: string): string {
  const digits = input
    .trim()
    .replace(/^\+/, "")
    .replace(/[\s\-().]/g, "");
  if (!/^\d+$/.test(digits) || digits.startsWith("0") || digits.length < 8 || digits.length > 15) {
    throw new WazapError(
      "INVALID_PHONE",
      `"${input.trim()}" is not a phone number in international format.`,
      PHONE_EXAMPLE,
    );
  }
  return digits;
}

export function isGroupId(jid: string): boolean {
  return jid.endsWith("@g.us");
}

/**
 * Jids that address nobody: the status feed, the `0@s.whatsapp.net` pseudo-chat
 * WhatsApp files its own notices under, and anything malformed. They must never
 * reach a chat list, a digest or the store.
 *
 * Stated as what to refuse rather than what to keep, so a jid kind wazap has
 * not met yet — a broadcast list, a channel — still reaches the user instead of
 * being silently swallowed, and a stored one is never purged.
 */
/** The pseudo-chat WhatsApp delivers stories (status updates) on; the author is the participant. */
export const STATUS_JID = "status@broadcast";

export function isStatusJid(jid: string): boolean {
  return jid.toLowerCase() === STATUS_JID;
}

export function isNoiseJid(jid: string): boolean {
  const at = jid.lastIndexOf("@");
  if (at === -1) return true;
  const user = jid.slice(0, at);
  const domain = jid.slice(at + 1).toLowerCase();
  if (domain === "broadcast") return user.toLowerCase() === "status";
  if (domain === "s.whatsapp.net" || domain === "c.us") return /^0+$/.test(user) || !/^\d+$/.test(user);
  return user === "";
}

/**
 * Canonicalize anything a caller may pass as a chat id.
 * Individuals become `<digits>@s.whatsapp.net`, groups stay `<id>@g.us`.
 * A `@lid` is translated through `lidToPn` when the mapping is known; without
 * one the lid is kept, because it still addresses the chat.
 */
export function resolveChatId(input: string, lidToPn?: (lid: string) => string | undefined): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) throw new WazapError("INVALID_ID", "Empty chat id.", "Pass an id from list_chats or search_contacts");

  const at = trimmed.lastIndexOf("@");
  if (at === -1) return `${normalizePhone(trimmed)}@s.whatsapp.net`;

  const user = trimmed.slice(0, at).split(":")[0]!;
  const domain = trimmed.slice(at + 1).toLowerCase();

  if (domain === "g.us") {
    if (!/^[\w.@-]+$/.test(user)) throw new WazapError("INVALID_ID", `"${trimmed}" is not a valid group id.`);
    return `${user}@g.us`;
  }

  if (domain === "lid") {
    const mapped = lidToPn?.(`${user}@lid`);
    if (mapped) return `${digitsOrThrow(mapped, trimmed)}@s.whatsapp.net`;
    return `${user}@lid`;
  }

  if (domain === "s.whatsapp.net" || domain === "c.us") {
    return `${digitsOrThrow(user, trimmed)}@s.whatsapp.net`;
  }

  throw new WazapError(
    "INVALID_ID",
    `"${trimmed}" is not a WhatsApp id.`,
    "Expected a phone number, <digits>@s.whatsapp.net or <id>@g.us",
  );
}

function digitsOrThrow(value: string, original: string): string {
  const digits = value.split("@")[0]!.split(":")[0]!;
  if (!/^\d+$/.test(digits)) throw new WazapError("INVALID_ID", `"${original}" is not a WhatsApp id.`);
  return digits;
}

/** Message keys themselves may contain underscores; only the first two separate fields. */
export function splitMessageId(sid: string): { origin: string; jid: string; key: string } {
  const first = sid.indexOf("_"),
    second = first < 0 ? -1 : sid.indexOf("_", first + 1);
  if (second < 0) return { origin: "", jid: "", key: sid };
  return { origin: sid.slice(0, first + 1), jid: sid.slice(first + 1, second), key: sid.slice(second + 1) };
}
