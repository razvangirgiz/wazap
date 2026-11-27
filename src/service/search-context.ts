/**
 * Bounded contextual retrieval over the existing conversation index. Context
 * is read fresh, not copied into an embedding or response cache: a retraction,
 * edit or new #private tag therefore takes effect on the next search.
 */
import {
  diminutivesOf,
  foldText,
  inflectionForms,
  isRealName,
  nameWords,
  type AccountDb,
  type StoredMessage,
  type HybridHit,
} from "../db/index.js";
import { QUERY_STOPWORDS } from "../db/vectors.js";
import { withoutPrivateQuote, type NoCatchupChats, type PrivatePeople } from "../private-contacts.js";
import { contentTokens } from "../search-query.js";
import type { SearchContext, SearchOptions } from "../wa-types.js";
import type { MessageViews } from "./views.js";
import type { AccountIdentity } from "./identity.js";
import { isFirstName } from "../db/names.js";

export const CONTEXT_CANDIDATES = 50;
export const CONTEXT_SHOWN = 5;
/** How far back from the newest message a hit's chat is read for what it said later, and how much of that is shown. */
export const LATER_SCAN = 200;
export const LATER_SHOWN = 2;
/** Words every chat repeats: sharing them says nothing about sharing a subject. */
const CHAT_FILLER = new Set(
  "buna ziua seara dimineata salut hello multumesc mersi maine astazi acum bine poate foarte doar mult inca deja atunci toate totul vreau trebuie putem thanks thank okay today tomorrow just like will".split(" ")
);
const CONTEXT_TEXT_CHARS = 600;
const NAME_PREPOSITIONS = new Set(["pentru", "lui", "pe", "cu", "despre", "for", "about"]);
const TEMPORAL_NAMES = new Set(
  "january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday ianuarie februarie martie aprilie mai iunie iulie august septembrie octombrie noiembrie decembrie luni marti miercuri joi vineri sambata duminica".split(
    " "
  )
);

/** Only the named author's private words are authorized by a from filter. */
export function allowedContext(
  message: StoredMessage,
  people: PrivatePeople | null,
  authorIds: readonly number[]
): boolean {
  return (
    people === null || !people.message(message) || (message.senderId !== null && authorIds.includes(message.senderId))
  );
}

export function contextRows(
  db: AccountDb,
  message: StoredMessage,
  opts: SearchOptions,
  people: PrivatePeople | null,
  author?: string
): StoredMessage[] {
  const authorIds = author === undefined ? [] : db.identity.contactIdsOf(author);
  const rows = db.messages.around(message.sid, {
    ...(opts.sinceMs === undefined ? {} : { since: opts.sinceMs }),
    ...(opts.untilMs === undefined ? {} : { until: opts.untilMs }),
  });
  // A direct reply carries a real relation even when it is hours apart. The
  // source still has to be visible, in the same chat and inside explicit dates.
  if (message.quotedSid !== null) {
    const quoted = db.messages.get(message.quotedSid);
    if (
      quoted !== null &&
      quoted.chatJid === message.chatJid &&
      !rows.some((row) => row.id === quoted.id) &&
      quoted.ts >= (opts.sinceMs ?? 0) &&
      quoted.ts <= (opts.untilMs ?? Number.MAX_SAFE_INTEGER)
    )
      rows.push(quoted);
  }
  return rows.filter((row) => allowedContext(row, people, authorIds)).sort((a, b) => a.id - b.id);
}

/** A message's subject words, each cut to five letters: Romanian and English endings move, the start of a word seldom does. */
function subjectStems(message: StoredMessage): Set<string> {
  const stems = new Set<string>();
  for (const word of `${message.text ?? ""}\n${message.transcript ?? ""}\n${message.ocrText ?? ""}\n${message.docText ?? ""}`.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const folded = foldText(word);
    if ([...folded].length < 4 || QUERY_STOPWORDS.has(folded) || CHAT_FILLER.has(folded)) continue;
    stems.add([...folded].slice(0, 5).join(""));
  }
  return stems;
}

/**
 * What a hit's chat said later on the same subject, past its window: a plan
 * changed two weeks on rarely repeats the words of the question, but it
 * repeats the plan's. The newest messages sharing two of the hit's subject
 * words, at most LATER_SHOWN, chronological; inside the search's dates.
 */
export function laterRows(
  db: AccountDb,
  anchor: StoredMessage,
  window: readonly StoredMessage[],
  opts: SearchOptions,
  people: PrivatePeople | null,
  author?: string,
  candidates?: readonly StoredMessage[],
  stemsFor: (message: StoredMessage) => Set<string> = subjectStems
): StoredMessage[] {
  const subject = stemsFor(anchor);
  if (subject.size < 2) return [];
  const authorIds = author === undefined ? [] : db.identity.contactIdsOf(author);
  const shown = new Set(window.map((row) => row.id));
  return (candidates ?? db.messages.later(anchor.sid, {
      limit: LATER_SCAN,
      ...(opts.sinceMs === undefined ? {} : { since: opts.sinceMs }),
      ...(opts.untilMs === undefined ? {} : { until: opts.untilMs }),
    }))
    .filter((row) => !shown.has(row.id) && allowedContext(row, people, authorIds))
    .filter((row) => [...stemsFor(row)].filter((stem) => subject.has(stem)).length >= 2)
    .slice(0, LATER_SHOWN)
    .reverse();
}

/** `laterRows` for the hits whose windows are shown. */
export function laterOf(
  db: AccountDb,
  hits: readonly StoredMessage[],
  rows: ReadonlyMap<number, StoredMessage[]>,
  opts: SearchOptions,
  people: PrivatePeople | null,
  author?: string
): Map<number, StoredMessage[]> {
  const stems = new Map<number, { text: string | null; transcript: string | null; ocrText: string | null; docText: string | null; words: Set<string> }>();
  const stemsFor = (message: StoredMessage): Set<string> => {
    let cached = stems.get(message.id);
    if (cached === undefined || cached.text !== message.text || cached.transcript !== message.transcript || cached.ocrText !== message.ocrText || cached.docText !== message.docText) {
      cached = { text: message.text, transcript: message.transcript, ocrText: message.ocrText, docText: message.docText, words: subjectStems(message) };
      stems.set(message.id, cached);
    }
    return cached.words;
  };
  const shown = hits.slice(0, CONTEXT_SHOWN);
  const groups = new Map<string, StoredMessage[]>();
  const candidates = new Map<number, readonly StoredMessage[]>();
  for (const hit of shown) {
    if (stemsFor(hit).size < 2) continue;
    const group = groups.get(hit.chatJid) ?? [];
    group.push(hit);
    groups.set(hit.chatJid, group);
  }
  for (const hits of groups.values()) {
    if (hits.length < 2) continue;
    const group = hits.flatMap((hit) => {
      const anchor = db.messages.get(hit.sid);
      if (anchor === null) { candidates.set(hit.id, []); return []; }
      return [{ hit, anchor }];
    });
    if (group.length < 2) continue;
    group.sort((a, b) => a.anchor.id - b.anchor.id);
    const first = group[0]!.anchor;
    if (group.some(({ anchor }) => anchor.chatJid !== first.chatJid)) continue;
    const shared = db.messages.later(first.sid, {
      limit: LATER_SCAN,
      ...(opts.sinceMs === undefined ? {} : { since: opts.sinceMs }),
      ...(opts.untilMs === undefined ? {} : { until: opts.untilMs }),
    });
    for (const { hit, anchor } of group) {
      if (anchor.ts < first.ts) continue;
      const suffix = shared.filter((row) => row.id > anchor.id && row.ts >= anchor.ts);
      if (shared.length < LATER_SCAN || suffix.length === LATER_SCAN) candidates.set(hit.id, suffix);
    }
  }
  return new Map(shown.map((hit) => [hit.id, laterRows(db, hit, rows.get(hit.id) ?? [hit], opts, people, author, candidates.get(hit.id), stemsFor)]));
}

/**
 * A small, bounded coverage bonus refines the existing hybrid rank. It never
 * admits an unqualified hit or changes the model's meaning-only floor.
 */
export function rankWithContext(
  hits: readonly HybridHit[],
  query: string,
  rows: ReadonlyMap<number, StoredMessage[]>,
  identity?: AccountIdentity
): HybridHit[] {
  const tokens = contentTokens(query);
  if (tokens.length < 2) return [...hits];
  const score = (hit: HybridHit): number => {
    const context = rows.get(hit.message.id) ?? [hit.message];
    const body = context.map((m) => `${m.text ?? ""}\n${m.transcript ?? ""}\n${m.ocrText ?? ""}\n${m.docText ?? ""}`).join("\n");
    const text = foldText(body);
    const labelText =
      identity === undefined
        ? ""
        : [...new Set(context.flatMap((m) => [m.chatJid, ...(m.senderJid === null ? [] : [m.senderJid])]))]
            .map((jid) => identity.displayName(jid))
            .filter(isRealName)
            .join("\n");
    const words = new Set(nameWords(`${body}\n${labelText}`).flatMap(inflectionForms));
    const coverage =
      tokens.filter((token) => text.includes(token) || inflectionForms(token).some((form) => words.has(form))).length /
      tokens.length;
    return hit.score + 0.008 * coverage;
  };
  return hits
    .map((hit, index) => ({ hit, index, rank: score(hit) }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map(({ hit, rank }) => ({ ...hit, contextScore: rank }));
}

const MAX_PERSON_BOOST_CHATS = 5;

/**
 * If a broad query names a person who has 1..MAX_PERSON_BOOST_CHATS direct
 * chats in this account, returns those chats and the query with the person
 * name stripped, so semantic search can also match messages inside their chat
 * that do not repeat their name.
 */
export function extractPersonBoost(
  db: AccountDb,
  identity: AccountIdentity,
  query: string,
  noCatchup: NoCatchupChats | null
): { chats: string[]; strippedQuery: string; names: ReadonlySet<string> } | null {
  const words = [...query.matchAll(/[\p{L}\p{N}]+/gu)];
  if (words.length < 2) return null;
  // Title Case formatting (excluding ALL-CAPS acronyms like UK, DSV) is not a person signal.
  if (words.filter((word) => /^\p{Lu}\p{Ll}/u.test(word[0])).length > words.length / 2) return null;
  const candidates = words
    .map((match, index) => ({ match, index, folded: foldText(match[0]) }))
    .filter(
      ({ match, folded }) =>
        /^\p{Lu}\p{Ll}{2,}$/u.test(match[0]) && !TEMPORAL_NAMES.has(folded) && !QUERY_STOPWORDS.has(folded)
    );
  if (candidates.length === 0) return null;

  const directChats = db.identity
    .directChatNames()
    .filter((chat) => noCatchup === null || !noCatchup.chatIds.has(chat.id));
  if (directChats.length === 0) return null;

  const chatWordSets = directChats.map((chat) => {
    const labels = [...chat.names, identity.displayName(chat.jid)].filter(isRealName);
    return { jid: chat.jid, words: new Set(labels.flatMap(nameWords)) };
  });

  const matchedChatJids = new Set<string>();
  const matchedIndices = new Set<number>();
  const matchedNames = new Set<string>();

  for (const cand of candidates) {
    const forms = inflectionForms(cand.folded);
    const wanted = new Set<string>(forms);
    for (const form of forms) for (const related of diminutivesOf(form)) wanted.add(related);
    const chatsForWord = chatWordSets.filter(({ words: chatWords }) => [...wanted].some((w) => chatWords.has(w)));
    if (chatsForWord.length >= 1 && chatsForWord.length <= MAX_PERSON_BOOST_CHATS) {
      for (const chat of chatsForWord) matchedChatJids.add(chat.jid);
      matchedIndices.add(cand.index);
      matchedNames.add(cand.folded);
    }
  }

  if (matchedChatJids.size === 0 || matchedChatJids.size > MAX_PERSON_BOOST_CHATS) return null;

  const drop = new Set<number>(matchedIndices);
  for (const idx of matchedIndices) {
    if (idx > 0 && foldText(words[idx - 1]![0]) === "lui") drop.add(idx - 1);
  }
  const strippedQuery = words
    .filter((_, idx) => !drop.has(idx))
    .map((word) => word[0])
    .join(" ")
    .trim();
  if (contentTokens(strippedQuery).length < 1) return null;
  return { chats: [...matchedChatJids], strippedQuery, names: matchedNames };
}

/**
 * A meaning-only hit about Luna cannot answer a question explicitly naming
 * Rex. Mid-sentence title-case names are evidence constraints, not inferred
 * sender filters. Romanian case endings reuse the contact resolver's forms.
 * Acronyms and the sentence's first word are left to the existing rankings.
 */
export function namedEvidence(
  hits: readonly HybridHit[],
  query: string,
  rows: ReadonlyMap<number, StoredMessage[]>,
  identity: AccountIdentity,
  knownPersonNames?: ReadonlySet<string>
): HybridHit[] {
  const words = [...query.matchAll(/[\p{L}\p{N}]+/gu)];
  // Title Case is formatting (excluding ALL-CAPS acronyms), not evidence that every noun is a proper name.
  if (words.filter((word) => /^\p{Lu}\p{Ll}/u.test(word[0])).length > words.length / 2) return [...hits];
  const names = words.filter(
    (word, i) =>
      i > 0 &&
      /^\p{Lu}\p{Ll}{2,}$/u.test(word[0]) &&
      !TEMPORAL_NAMES.has(foldText(word[0])) &&
      (inflectionForms(foldText(word[0])).some(isFirstName) ||
        knownPersonNames?.has(foldText(word[0])) === true ||
        NAME_PREPOSITIONS.has(foldText(words[i - 1]![0])))
  );
  if (names.length === 0) return [...hits];
  return hits.filter((hit) => {
    const context = rows.get(hit.message.id) ?? [hit.message];
    const text = context.map((m) => `${m.text ?? ""}\n${m.transcript ?? ""}\n${m.ocrText ?? ""}\n${m.docText ?? ""}`).join("\n");
    const labels = new Set(context.flatMap((m) => [m.chatJid, ...(m.senderJid === null ? [] : [m.senderJid])]));
    const tokens = new Set(
      nameWords(text + "\n" + [...labels].map((jid) => identity.displayName(jid)).join("\n")).flatMap(inflectionForms)
    );
    return names.every((name) => inflectionForms(foldText(name[0])).some((form) => tokens.has(form)));
  });
}

/** The top five windows, each chronological, compact and carrying exact source ids, with what the chat said later on it. */
export function renderContexts(
  hits: readonly StoredMessage[],
  rows: ReadonlyMap<number, StoredMessage[]>,
  views: MessageViews,
  people: PrivatePeople | null,
  author?: string,
  query = "",
  later: ReadonlyMap<number, StoredMessage[]> = new Map()
): SearchContext[] {
  const render = (stored: readonly StoredMessage[]): SearchContext["messages"] =>
    views.viewsOfStored(stored).map((view) => {
      const safe = people === null ? view : withoutPrivateQuote(view, people, author);
      const base = safe.transcript ?? safe.text;
      const ocrInline = safe.ocr_text === undefined || safe.ocr_text === "" ? "" : safe.ocr_text.replace(/\s*\r?\n\s*/g, " · ").replace(/[ \t]{2,}/g, " ").trim();
      const docInline = safe.doc_text === undefined || safe.doc_text === "" ? "" : safe.doc_text.replace(/\s*\r?\n\s*/g, " · ").replace(/[ \t]{2,}/g, " ").trim();
      const extras = [ocrInline !== "" ? `[ocr: ${ocrInline}]` : "", docInline !== "" ? `[doc: ${docInline}]` : ""].filter(Boolean);
      const text = extras.length > 0 ? `${base} ${extras.join(" ")}` : base;
      const excerpt = contextExcerpt(text, query);
      return {
        message_id: safe.message_id,
        chat_id: safe.chat_id,
        from_me: safe.from_me,
        sender: safe.sender,
        timestamp: safe.timestamp,
        type: safe.type,
        ...excerpt,
        ...(safe.quoted === undefined
          ? {}
          : { quoted: { ...safe.quoted, text: safe.quoted.text.slice(0, CONTEXT_TEXT_CHARS) } }),
      };
    });
  return hits.slice(0, CONTEXT_SHOWN).flatMap((anchor) => {
    const stored = rows.get(anchor.id);
    if (stored === undefined || !stored.some((m) => m.id === anchor.id)) return [];
    const after = later.get(anchor.id) ?? [];
    return [{ anchor_id: anchor.sid, messages: render(stored), ...(after.length === 0 ? {} : { later: render(after) }), bounded: true as const }];
  });
}

/** A contiguous source excerpt near the query, keeping its original offset and truncation explicit. */
export function contextExcerpt(
  text: string,
  query: string
): { text: string; text_offset?: number; text_truncated?: true } {
  if (text.length <= CONTEXT_TEXT_CHARS) return { text };
  const tokens = contentTokens(query);
  const positions: Array<{ at: number; token: string }> = [];
  for (const word of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const folded = foldText(word[0]);
    for (const token of tokens) if (folded.includes(token)) positions.push({ at: word.index, token });
    if (positions.length >= 128) break;
  }
  let best = 0;
  let score = 0;
  for (const position of positions) {
    const start = Math.max(0, Math.min(text.length - CONTEXT_TEXT_CHARS, position.at - 150));
    const coverage = new Set(
      positions.filter((p) => p.at >= start && p.at < start + CONTEXT_TEXT_CHARS).map((p) => p.token)
    ).size;
    if (coverage > score) {
      best = start;
      score = coverage;
    }
  }
  return {
    text: text.slice(best, best + CONTEXT_TEXT_CHARS),
    text_truncated: true,
    ...(best > 0 ? { text_offset: best } : {}),
  };
}
