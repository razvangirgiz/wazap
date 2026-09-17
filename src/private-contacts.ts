/**
 * The `#private` tag: someone the user keeps out of what an assistant is
 * handed without asking. The draft context find_contact attaches keeps only
 * the user's style statistics for them, never their messages, and a catch-up
 * should not quote them either. Nothing is hidden from a tool asked for that
 * chat by name: this is about what is volunteered.
 *
 * The tag goes with the person, not only their chat: what they write in a
 * group is theirs too, so a group's context and a catch-up leave it out.
 *
 * Tags are stored normalized (lowercase, without "#"), so the tag a user files
 * as "#private" or "Private" is `private`. Groups carry no tags.
 */
import { chatKindOf, type AccountDb } from "./db/index.js";

export const PRIVATE_TAG = "private";

/** Whether a contact's stored tags include `#private`. */
export function hasPrivateTag(tags: readonly string[] | null | undefined): boolean {
  return tags?.includes(PRIVATE_TAG) === true;
}

/** Whether the person behind a chat (any spelling of their jid) carries `#private`; false for a group or a stranger. */
export function isPrivateChat(db: AccountDb, chatJid: string): boolean {
  return chatKindOf(chatJid) === "direct" && isPrivateSender(db, chatJid);
}

/**
 * Whether the person who wrote a message (its sender's phone jid or lid)
 * carries `#private`: their words in a group are left out like their chat.
 * Null, the user's own message, is never private.
 */
export function isPrivateSender(db: AccountDb, senderJid: string | null | undefined): boolean {
  if (senderJid === null || senderJid === undefined || chatKindOf(senderJid) !== "direct") return false;
  return hasPrivateTag(db.identity.notes(senderJid)?.tags);
}
