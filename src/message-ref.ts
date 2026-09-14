/**
 * The id a message answers to. Every tool reports `<fromMe>_<chat>_<stanza>`
 * over the chat's canonical jid — which is exactly the store key while nothing
 * about the chat changes. A chat first seen under a lid keeps the sids it was
 * filed under, so once WhatsApp pairs the lid with a number the same message
 * answers to two spellings: the store's own (the lid one) and the one views
 * now report (the phone one). An agent holding raw identifiers — a lid and a
 * stanza id — or an id a view reported before the pairing must still reach it:
 * unresolved identity is not a reason to refuse a read.
 */
import type { AccountBinding, AccountSource } from "./account-hub.js";
import { asWazapError } from "./errors.js";
import type { MessageView, WhatsAppApi } from "./wa-types.js";

export interface MessageRef {
  /** null when the caller gave `<chat>_<stanza>` with no direction prefix. */
  fromMe: boolean | null;
  chat: string;
  stanza: string;
}

const FULL_SID = /^(true|false)_([^_\s]+)_(.+)$/s;
const BARE_REF = /^([^_\s]+@[^_\s]+)_(.+)$/s;

/** A `<chat>_<stanza>` or `true|false_<chat>_<stanza>` id, or null when the input names neither. */
export function parseMessageRef(id: string): MessageRef | null {
  const full = FULL_SID.exec(id);
  if (full && full[2]!.includes("@")) return { fromMe: full[1] === "true", chat: full[2]!, stanza: full[3]! };
  const bare = BARE_REF.exec(id);
  if (bare) return { fromMe: null, chat: bare[1]!, stanza: bare[2]! };
  return null;
}

/**
 * The number a lid addresses, from the service's own tables. getContact
 * canonicalizes through the lid→pn map, so it answers even for a lid nobody
 * saved; a contact still keyed by its lid reports the paired number on
 * `number`. Both stay local in intent, though getContact may ask WhatsApp
 * twice, bounded — it only runs on a missed lookup.
 */
async function phoneAlias(wa: WhatsAppApi, lid: string): Promise<string | null> {
  const user = lid.split("@")[0] ?? "";
  const found = (await wa.searchContacts?.(user, 10).catch(() => undefined)) ?? [];
  const byLid = found.find((c) => c.contact_id === lid && c.number !== null);
  if (byLid?.number) return `${byLid.number}@s.whatsapp.net`;
  const resolved = await wa
    .getContact?.(lid)
    .then((c) => c.contact_id)
    .catch(() => undefined);
  return resolved !== undefined && resolved !== lid && resolved.endsWith("@s.whatsapp.net") ? resolved : null;
}

/**
 * The sid the store actually filed `messageId` under, when it differs. Raw
 * identifiers are tried as given, then with the chat's known alias: a lid the
 * account later paired with a number resolves both ways — the lid spelling of
 * a phone-filed message, and every prefix spelling, because the direction half
 * of a hand-built id is a guess.
 */
export async function resolveMessageId(wa: WhatsAppApi, messageId: string): Promise<string> {
  const has = (sid: string): boolean => wa.hasMessage?.(sid) === true;
  if (has(messageId)) return messageId;
  const ref = parseMessageRef(messageId);
  if (!ref) return messageId;

  const chats = [ref.chat];
  if (ref.chat.endsWith("@lid")) {
    const alias = await phoneAlias(wa, ref.chat);
    if (alias !== null) chats.push(alias);
  }
  const directions = ref.fromMe === null ? [true, false] : [ref.fromMe, !ref.fromMe];
  for (const chat of chats) {
    for (const fromMe of directions) {
      const candidate = `${fromMe}_${chat}_${ref.stanza}`;
      if (candidate !== messageId && has(candidate)) return candidate;
    }
  }
  return messageId;
}

/**
 * get_message by id, tolerant of the two spellings one message can have. When
 * the store key cannot be recovered — the id a view reported names the chat's
 * current canonical jid while the store still keys it by the lid it arrived
 * under — the chat's ring is scanned for a view reporting that very id: the
 * answer is the same either way, so it is returned instead of a not-found.
 */
export async function getMessageView(wa: WhatsAppApi, messageId: string): Promise<MessageView> {
  const sid = await resolveMessageId(wa, messageId);
  try {
    return await wa.getMessage(sid);
  } catch (err) {
    if (asWazapError(err).code !== "MESSAGE_NOT_FOUND") throw err;
    const ref = parseMessageRef(messageId);
    if (!ref) throw err;
    const ring = await wa.readMessages?.(ref.chat, 1000).catch(() => undefined);
    const found = ring?.data.find((m) => m.message_id === messageId || m.message_id === sid);
    if (found) return found;
    throw err;
  }
}

/**
 * The bindings a message_id lookup walks, in order: the account the call
 * resolved to first — it is where an explicit account_id or a findByMessage
 * hit put it — then every other live one. Pairings and filings are
 * per-account, so a miss on the first says nothing about the rest.
 */
function bindingsInOrder(hub: AccountSource, resolved: AccountBinding): AccountBinding[] {
  return [resolved, ...hub.bindings().filter((row) => row.id !== resolved.id)];
}

/**
 * getMessageView walked across every binding in turn. A message_id that names
 * nothing on the account the call resolved to can still live in another one's
 * store, under a spelling only that account resolves — the lid↔number pairing
 * that maps it is not shared between accounts, and findByMessage probes the
 * raw id alone. The resolved binding's own error comes back when no binding
 * answers, so a true miss reads the way it always did.
 */
export async function getMessageViewAcross(
  hub: AccountSource,
  resolved: AccountBinding,
  messageId: string
): Promise<{ binding: AccountBinding; message: MessageView }> {
  let miss: unknown;
  for (const binding of bindingsInOrder(hub, resolved)) {
    try {
      return { binding, message: await getMessageView(binding.wa, messageId) };
    } catch (err) {
      miss ??= err;
    }
  }
  throw miss;
}

/**
 * resolveMessageId walked across every binding in turn, for callers that need
 * the store key itself — downloadMedia reads the raw message by it, so the
 * probe is what the store confirms, not what a view could report. The first
 * binding whose store answers wins; when none does, the resolved binding and
 * its own resolution come back and the caller fails the way it always has.
 */
export async function resolveMessageIdAcross(
  hub: AccountSource,
  resolved: AccountBinding,
  messageId: string
): Promise<{ binding: AccountBinding; sid: string }> {
  let first: { binding: AccountBinding; sid: string } | undefined;
  for (const binding of bindingsInOrder(hub, resolved)) {
    const sid = await resolveMessageId(binding.wa, messageId).catch(() => messageId);
    first ??= { binding, sid };
    if (binding.wa.hasMessage?.(sid) === true) return { binding, sid };
  }
  return first ?? { binding: resolved, sid: messageId };
}
