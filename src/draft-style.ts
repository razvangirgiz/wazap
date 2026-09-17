/**
 * What a draft is written after (F2-3): the recent exchange in a chat and how
 * the user writes there, attached by find_contact to a contact it resolved;
 * and the style check send_message runs on a text draft against the user's
 * own messages in that chat.
 *
 *   draftContextFor(db, jid, { recent: true, senderName })  // { style, recent }
 *   styleCheckFor(db, jid, "Bună ziua, vă trimit…")          // { warnings: ["address_mismatch"], basis, draft } or null
 *
 * Both read only the user's own messages for style, and never what wazap sent
 * (`via_wazap`), so an assistant does not learn its own drafts back. The check
 * never blocks a draft: it names mismatches, and only for a direct chat with
 * enough of the user's own history there to go on.
 */
import { chatKindOf, messageStyle, type AccountDb, type MessageStyle, type StyleStats } from "./db/index.js";
import { isoWithOffset } from "./messages.js";
import { privatePeople } from "./private-contacts.js";

/** The recent exchange a draft context carries, and how much of each message. */
export const CONTEXT_RECENT = 8;
export const CONTEXT_RECENT_CHARS = 200;
/** The user's own messages in a direct chat, in the last 90 days, a style check needs before it judges a draft. */
export const STYLE_CHECK_MIN_OWN = 5;
/**
 * The recipient's own messages a chat needs before it says which language they
 * write in. Three, not the five the user's style needs: only the language is
 * read from them, and the function-word tables already refuse a chat whose
 * messages are split (under 60% one way) or that they say nothing about. One
 * or two messages are a greeting; three are a chat.
 */
export const STYLE_CHECK_MIN_THEIRS = 3;
/** How far back, and how many of their messages, that reads. */
const THEIRS_DAYS = 90;
const THEIRS_SAMPLE = 200;
/** A draft is a length outlier above this many times the user's 90th percentile in the chat, and never under the floor. */
export const LENGTH_OUTLIER_FACTOR = 3;
export const LENGTH_OUTLIER_MIN_CHARS = 80;

export type StyleWarning = "language_mismatch" | "diacritics_mismatch" | "address_mismatch" | "length_outlier";

/**
 * Whose writing the draft was held against: the user's own messages in this
 * chat, or — when they have written too little here for that — the recipient's,
 * read for their language and nothing else.
 */
export type StyleBasis =
  | {
      from: "user";
      /** How the user writes in this chat, from their own messages. */
      own_messages: number;
      days: number;
      language: StyleStats["language"];
      diacritics: StyleStats["diacritics"];
      address: StyleStats["address"];
      length_chars: StyleStats["length_chars"];
    }
  | {
      from: "recipient";
      /** How many of their messages said which language they write in. */
      messages: number;
      days: number;
      language: "ro" | "en";
    };

export interface StyleCheck {
  /** Empty when the draft reads like the user; never a reason to refuse the draft. */
  warnings: StyleWarning[];
  basis: StyleBasis;
  /** What the draft reads as, by the same measures. */
  draft: MessageStyle;
}

export interface RecentLine {
  at: string;
  from_me: boolean;
  /** Who wrote it, in a group. */
  sender?: string;
  /** Its words, a voice note's transcript, or a placeholder like "[image] caption"; at most 200 characters. */
  text: string;
  transcribed?: true;
}

/**
 * The user's style as a draft context hands it out: with what language the
 * recipient writes in this chat. Without it, a chat the user has hardly
 * written in falls back to the account's language, and a draft to someone who
 * writes another one has nothing saying so.
 */
export interface DraftStyle extends StyleStats {
  /** What language the recipient writes here, from their own recent messages; left out when too few of them say. */
  their_language?: "ro" | "en";
}

export interface DraftContext {
  /** How the user writes in this chat, or across the account when they wrote too little here. */
  style?: DraftStyle;
  /** The last messages both ways, oldest first; left out for a `#private` contact, and in a group without a `#private` member's. */
  recent?: RecentLine[];
  /** The contact is tagged `#private`: style only. */
  private?: true;
}

/**
 * The context a draft to `chatJid` is written with, or null when the chat has
 * no history at all. `recent: false`, or a person tagged `#private` on this
 * account or on another (`others`, their numbers and lids), keeps only style.
 */
export function draftContextFor(
  db: AccountDb,
  chatJid: string,
  options: { recent: boolean; others?: readonly string[]; senderName: (jid: string) => string }
): DraftContext | null {
  const style = db.messages.styleFor(chatJid) ?? undefined;
  const context: DraftContext = {};
  if (style !== undefined && style.basis.own_messages > 0) context.style = style;
  const group = chatKindOf(chatJid) === "group";
  const people = privatePeople(db, options.others);
  if (!options.recent || (!group && people.names(chatJid))) {
    if (context.style === undefined) return null;
    return { ...context, private: true };
  }
  // In a group, what a #private member said (a voice note's words too) is left out, read a few more deep to fill in.
  const privateSender = new Map<string, boolean>();
  const shown = (senderJid: string | null): boolean => {
    if (!group || senderJid === null) return true;
    if (!privateSender.has(senderJid)) privateSender.set(senderJid, people.names(senderJid));
    return privateSender.get(senderJid) !== true;
  };
  const recent = db.messages
    .recentExchange(chatJid, { limit: group ? CONTEXT_RECENT * 3 : CONTEXT_RECENT, maxChars: CONTEXT_RECENT_CHARS })
    .filter((item) => item.fromMe || shown(item.senderJid))
    .slice(-CONTEXT_RECENT)
    .map((item) => {
      const line: RecentLine = { at: isoWithOffset(item.ts), from_me: item.fromMe, text: item.text };
      if (group && !item.fromMe && item.senderJid !== null) line.sender = options.senderName(item.senderJid);
      if (item.transcribed) line.transcribed = true;
      return line;
    });
  if (recent.length > 0) context.recent = recent;
  if (context.style !== undefined && !group) {
    const theirs = theirLanguageIn(db, chatJid, options.others);
    if (theirs !== null) context.style = { ...context.style, their_language: theirs.language };
  }
  return context.style === undefined && context.recent === undefined ? null : context;
}

/**
 * What language the other side writes in `chatJid`, from their own recent
 * messages, and how many of them said so; null when fewer than
 * STYLE_CHECK_MIN_THEIRS of them classify, or they are split between
 * languages. The reading is the one a draft gets — the function-word tables of
 * messageStyle, never diacritics, since most people write Romanian without
 * them.
 *
 * Nothing of a `#private` contact is read here, on this account or on another
 * (`others`): their words stay theirs, even to say which language they are in.
 * Groups have no one recipient, so they have no answer either.
 */
export function theirLanguageIn(db: AccountDb, chatJid: string, others?: readonly string[]): { language: "ro" | "en"; messages: number } | null {
  if (chatKindOf(chatJid) !== "direct" || privatePeople(db, others).names(chatJid)) return null;
  let ro = 0;
  let en = 0;
  for (const text of db.messages.theirTexts(chatJid, { days: THEIRS_DAYS, limit: THEIRS_SAMPLE })) {
    const { language } = messageStyle(text);
    if (language === "ro") ro++;
    else if (language === "en") en++;
  }
  const messages = ro + en;
  if (messages < STYLE_CHECK_MIN_THEIRS) return null;
  if (ro / messages >= 0.6) return { language: "ro", messages };
  if (en / messages >= 0.6) return { language: "en", messages };
  return null;
}

/**
 * How a text draft to a direct chat compares with the user's own messages
 * there in the last 90 days, what wazap sent left out. Null for a group.
 *
 * With fewer than STYLE_CHECK_MIN_OWN of the user's own messages there, the
 * account's style is no evidence about one person — but the language still is,
 * read off the recipient's own messages: a draft in another language than the
 * one they write in is language_mismatch, and nothing else is judged. The
 * user's own messages here win whenever there are enough of them.
 */
export function styleCheckFor(db: AccountDb, chatJid: string, text: string): StyleCheck | null {
  if (chatKindOf(chatJid) !== "direct") return null;
  const style = db.messages.styleFor(chatJid, { excludeViaWazap: true });
  const draft = messageStyle(text, { oneToOne: true });
  const known = (language: string): boolean => language === "ro" || language === "en";
  if (style === null || style.basis.scope !== "chat" || style.basis.own_messages < STYLE_CHECK_MIN_OWN) {
    const theirs = theirLanguageIn(db, chatJid);
    if (theirs === null || !known(draft.language) || theirs.language === draft.language) return null;
    return { warnings: ["language_mismatch"], basis: { from: "recipient", messages: theirs.messages, days: THEIRS_DAYS, language: theirs.language }, draft };
  }
  const warnings: StyleWarning[] = [];
  if (known(style.language) && known(draft.language) && style.language !== draft.language) warnings.push("language_mismatch");
  if (style.language === "ro" && draft.language === "ro" && draft.diacritics !== null) {
    if ((style.diacritics === "none" && draft.diacritics) || (style.diacritics === "most" && !draft.diacritics)) warnings.push("diacritics_mismatch");
  }
  if (style.address !== "unknown" && draft.address !== null && draft.address !== style.address) warnings.push("address_mismatch");
  if (draft.chars > Math.max(LENGTH_OUTLIER_FACTOR * style.length_chars.p90, LENGTH_OUTLIER_MIN_CHARS)) warnings.push("length_outlier");
  return {
    warnings,
    basis: {
      from: "user",
      own_messages: style.basis.own_messages,
      days: style.basis.days,
      language: style.language,
      diacritics: style.diacritics,
      address: style.address,
      length_chars: style.length_chars,
    },
    draft,
  };
}

const LANGUAGE: Record<string, string> = { ro: "Romanian", en: "English", other: "no clear language" };
const DIACRITICS: Record<StyleStats["diacritics"], string | null> = {
  none: "without diacritics",
  some: "sometimes with diacritics",
  most: "with diacritics",
  unknown: null,
};
const ADDRESS: Record<string, string> = { tu: "tu", dumneavoastra: "dumneavoastră" };

/** A style note in one line: "Romanian, without diacritics, on tu, ~40 characters (up to 90)". */
export function styleLine(style: Pick<StyleStats, "language" | "diacritics" | "address" | "length_chars">): string {
  const parts = [LANGUAGE[style.language] ?? style.language];
  const diacritics = DIACRITICS[style.diacritics];
  if (style.language === "ro" && diacritics !== null) parts.push(diacritics);
  if (style.address !== "unknown") parts.push(`on ${ADDRESS[style.address]}`);
  parts.push(`~${style.length_chars.p50} characters (up to ${style.length_chars.p90})`);
  return parts.join(", ");
}

/** The lines a draft preview adds for a style check that found something; none when it found nothing. */
export function styleCheckLines(check: StyleCheck | undefined): string[] {
  if (check === undefined || check.warnings.length === 0) return [];
  const { basis, draft } = check;
  if (basis.from === "recipient") {
    return [
      `Style check: the user has written too little in this chat to compare with, so the draft is read against the ${basis.messages} messages the recipient wrote here.`,
      `- language_mismatch: the draft is ${LANGUAGE[draft.language]}; the recipient writes ${LANGUAGE[basis.language]} here`,
      "Unless the user dictated these exact words, draft again to match, then show that preview.",
    ];
  }
  const said: Record<StyleWarning, string> = {
    language_mismatch: `the draft is ${LANGUAGE[draft.language]}; the user writes ${LANGUAGE[basis.language]} here`,
    diacritics_mismatch: draft.diacritics
      ? "the draft has diacritics; the user writes here without them"
      : "the draft has no diacritics; the user writes here with them",
    address_mismatch: `the draft says ${ADDRESS[draft.address ?? ""] ?? "?"}; the user says ${ADDRESS[basis.address] ?? "?"} here`,
    length_outlier: `the draft is ${draft.chars} characters; the user's messages here run up to ${basis.length_chars.p90}. Shorten only if nothing the user asked for is lost`,
  };
  const lines = [`Style check, against the user's last ${basis.own_messages} messages in this chat:`, ...check.warnings.map((warning) => `- ${warning}: ${said[warning]}`)];
  if (check.warnings.some((warning) => warning !== "length_outlier")) {
    lines.push("Unless the user dictated these exact words, draft again to match, then show that preview.");
  }
  return lines;
}
