/**
 * catch_up (F2-2): what the user missed, in one call, within a token budget.
 *
 * Each account scans its own window (catchup-scan.ts); this merges the
 * accounts, lays the entries out in section order, spends the budget and
 * renders one line per entry, as text and as structured content built from
 * the same entries.
 *
 * The budget, in the order it is spent (tokens are rendered characters / 4):
 * 1. the skeleton — every entry's line without a quote, in section order —
 *    until the page is full; what does not fit goes to `more`, with a cursor;
 * 2. quotes, by priority: the ask of someone waiting (240 characters), a
 *    mention or reply (200), a person's newest message (160), a group's hot
 *    message (120); one per chat, at most 60 per page;
 * 3. when they do not all fit, the lowest-priority quotes shrink to 80
 *    characters, and then the lowest-priority ones go.
 *
 * The cursor is opaque and fixes the window (each account's since and until
 * ids, the instant the digest started) and the place (section, offset), so a
 * page reads what the first page read whatever arrived in between. The
 * client's mark moves to the window's top only after the whole digest was
 * given — a digest with no `more`, or its last page — and only by
 * compare-and-set, so two catch-ups of one client racing each other move it
 * once.
 */
import { z } from "zod";
import type { AccountSource } from "./account-hub.js";
import {
  CATCHUP_SECTIONS,
  tsOfId,
  type AddressedEntry,
  type CallsEntry,
  type CatchupQuote,
  type CatchupScan,
  type CatchupSection,
  type CatchupWindow,
  type CatchupWindowSpec,
  type DirectEntry,
  type GroupEntry,
  type WaitingEntry,
  type WindowBasis,
} from "./catchup-scan.js";
import { asWazapError, WazapError } from "./errors.js";
import { isoWithOffset } from "./messages.js";
import { signalsOf, type Signal } from "./signals.js";
import type { ToolResult } from "./tool-runtime.js";
import type { WhatsAppApi } from "./wa-types.js";

export const DEFAULT_BUDGET_TOKENS = 2_500;
export const MIN_BUDGET_TOKENS = 500;
export const MAX_BUDGET_TOKENS = 8_000;
/** Quotes read back in full per page. */
const MAX_QUOTES = 60;
/** What a quote shrinks to before it is dropped. */
const SHORT_QUOTE = 80;
/** A quote's length by the section it belongs to; the order is the priority. */
const QUOTE_CAPS: Partial<Record<CatchupSection, number>> = { waiting: 240, addressed: 200, direct: 160, groups: 120 };
/** A poll's question or an event's line, in the skeleton. */
const TITLE_CHARS = 80;
const CURSOR_VERSION = 1;

const HOUR = 3_600_000;

// ---------------------------------------------------------------- input and output

export const CATCHUP_INPUT = {
  since: z
    .string()
    .min(1)
    .optional()
    .describe(
      '"last" (default): since this client\'s last complete catch-up, or the last 24 h the first time; "previous": that catch-up again; or an ISO date/time'
    ),
  hours: z
    .number()
    .min(1)
    .max(336)
    .optional()
    .describe("An explicit window of the last N hours instead; it never moves the catch-up mark"),
  budget_tokens: z
    .number()
    .int()
    .min(MIN_BUDGET_TOKENS)
    .max(MAX_BUDGET_TOKENS)
    .default(DEFAULT_BUDGET_TOKENS)
    .describe("How long the answer may be, in tokens (500-8000)"),
  include: z
    .array(z.enum(CATCHUP_SECTIONS))
    .min(1)
    .optional()
    .describe("Only these sections; the mark moves only when every section was given"),
  cursor: z.string().min(1).optional().describe("more.cursor from the previous page"),
};

const loose = z.object({}).passthrough();
const windowShape = z.object({
  since: z.string(),
  until: z.string(),
  hours: z.number(),
  basis: z.string(),
});

/** The structured content catch_up answers with; every entry keeps its own short keys. */
export const CATCHUP_OUTPUT = {
  window: windowShape,
  accounts: z.array(
    z
      .object({
        account_id: z.string(),
        name: z.string(),
        status: z.string(),
        sync: z.string().optional(),
        window: windowShape.optional(),
        mark: z.object({ moved: z.boolean(), why: z.string().optional(), next_since: z.string().optional() }).optional(),
        error: z.object({ code: z.string(), message: z.string() }).optional(),
      })
      .passthrough()
  ),
  waiting: z.array(loose),
  addressed: z.array(loose),
  missed_calls: z.array(loose),
  direct: z.array(loose),
  groups: z.array(loose),
  stories: z.array(loose),
  footer: loose.nullable(),
  more: z
    .object({ cursor: z.string(), remaining: z.record(z.number()), approx_tokens: z.number() })
    .nullable(),
  approx_tokens: z.number(),
  account_id: z.string().nullable(),
};

export interface CatchupArgs {
  since?: string;
  hours?: number;
  budget_tokens?: number;
  include?: CatchupSection[];
  cursor?: string;
  account_id?: string;
}

/** What catch_up needs from the tool runtime. */
export interface CatchupContext {
  hub: AccountSource;
  /** The account the call resolved to. */
  accountId: string;
  wa: WhatsAppApi;
  /** Who is catching up: an OAuth client id, a token's label, or `local`. */
  client: string;
  /** The clock a first page starts at; Date.now when omitted (the bench fixes it). */
  now?: () => number;
}

// ---------------------------------------------------------------- cursor

interface CursorAccount {
  id: string;
  s: number;
  u: number;
  b: WindowBasis;
  adv: 0 | 1;
  x: number | null;
}

interface CursorState {
  v: number;
  /** The client the digest was built for, hashed: a cursor does not move another client's mark. */
  k: string;
  t: number;
  i: CatchupSection[];
  a: CursorAccount[];
  sec: CatchupSection;
  o: number;
}

function clientKey(client: string): string {
  let hash = 2166136261;
  for (let i = 0; i < client.length; i++) {
    hash ^= client.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

function badCursor(reason: string): WazapError {
  return new WazapError("INVALID_ID", `That cursor cannot be used: ${reason}.`, "Pass more.cursor exactly as the previous catch_up returned it, or call catch_up without a cursor");
}

function decodeCursor(cursor: string, client: string): CursorState {
  let state: CursorState;
  try {
    state = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorState;
  } catch {
    throw badCursor("it is not a catch_up cursor");
  }
  const ids = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;
  if (
    state === null ||
    typeof state !== "object" ||
    state.v !== CURSOR_VERSION ||
    typeof state.k !== "string" ||
    !ids(state.t) ||
    !Array.isArray(state.i) ||
    !state.i.every((section) => CATCHUP_SECTIONS.includes(section)) ||
    !Array.isArray(state.a) ||
    state.a.length === 0 ||
    !state.a.every(
      (account) =>
        account !== null &&
        typeof account.id === "string" &&
        ids(account.s) &&
        ids(account.u) &&
        typeof account.b === "string" &&
        (account.adv === 0 || account.adv === 1) &&
        (account.x === null || ids(account.x))
    ) ||
    !CATCHUP_SECTIONS.includes(state.sec) ||
    !ids(state.o)
  ) {
    throw badCursor("it is not a catch_up cursor");
  }
  if (state.k !== clientKey(client)) throw badCursor("it belongs to another client's catch-up");
  return state;
}

// ---------------------------------------------------------------- formatting

function clock(ms: number, now: number): string {
  const at = new Date(ms);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  if (at.toDateString() === today.toDateString()) return time;
  const days = (now - ms) / 86_400_000;
  const weekday = at.toLocaleDateString("en-GB", { weekday: "short" });
  if (days < 6 && days > -1) return `${weekday} ${time}`;
  return `${at.getDate()} ${at.toLocaleDateString("en-GB", { month: "short" })} ${time}`;
}

function age(ms: number, now: number): string {
  const elapsed = Math.max(0, now - ms);
  if (elapsed >= 86_400_000) return `${Math.floor(elapsed / 86_400_000)}d`;
  if (elapsed >= HOUR) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed >= 60_000) return `${Math.floor(elapsed / 60_000)}m`;
  return "now";
}

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60} min`;
}

const MEDIA_WORDS: Record<string, [string, string]> = {
  image: ["photo", "photos"],
  video: ["video", "videos"],
  voice: ["voice note", "voice notes"],
  audio: ["audio", "audios"],
  document: ["document", "documents"],
  sticker: ["sticker", "stickers"],
  location: ["location", "locations"],
  contact: ["contact card", "contact cards"],
};

function mediaLabel(media: Partial<Record<string, number>>, polls: number): string {
  const parts = Object.entries(media).flatMap(([type, n]) => {
    const words = MEDIA_WORDS[type];
    return n === undefined || n === 0 || words === undefined ? [] : [`${n} ${n === 1 ? words[0] : words[1]}`];
  });
  if (polls > 0) parts.push(plural(polls, "poll"));
  return parts.join(", ");
}

function windowOf(window: CatchupWindow, now: number): { since: string; until: string; hours: number; basis: WindowBasis } {
  const since = tsOfId(window.sinceId + 1);
  const until = window.basis === "previous" ? tsOfId(window.untilId) + 999 : now;
  return {
    since: isoWithOffset(since),
    until: isoWithOffset(until),
    hours: Math.round(((until - since) / HOUR) * 10) / 10,
    basis: window.basis,
  };
}

function windowPhrase(window: CatchupWindow, now: number): string {
  const since = tsOfId(window.sinceId + 1);
  switch (window.basis) {
    case "last":
      return `since your last catch-up (${clock(since, now)})`;
    case "first_run":
      return "the last 24 h (first catch-up here)";
    case "mark_expired":
      return "the last 24 h (the last catch-up was over 7 days ago)";
    case "previous":
      return `the previous catch-up again (${clock(since, now)} – ${clock(tsOfId(window.untilId), now)})`;
    case "hours":
      return `the last ${Math.round((now - since) / HOUR)} h`;
    case "since":
      return `since ${clock(since, now)}`;
  }
}

// ---------------------------------------------------------------- entries as items

/** A quote as placed: the message's words cut to their level, and for someone waiting, what they sent after the ask. */
type Quoted = { text: string; signals: Signal[]; then?: string } | null;

interface Item {
  section: CatchupSection;
  account: string;
  /** One quote per chat: the account and the chat. */
  chatKey: string;
  quoteId: number | null;
  /** Someone waiting: their newest message after the ask, sharing the ask's quote. */
  thenId: number | null;
  line(quote: Quoted): string;
  data(quote: Quoted): Record<string, unknown>;
}

interface AccountView {
  id: string;
  name: string;
  source: WhatsAppApi;
  scan: CatchupScan | null;
  error: WazapError | null;
}

const SECTION_TITLES: Record<CatchupSection, string> = {
  waiting: "Waiting on you",
  addressed: "Mentions, replies and polls",
  calls: "Missed calls",
  direct: "People",
  groups: "Groups",
  stories: "Stories",
};

const STRUCTURED_KEYS: Record<CatchupSection, string> = {
  waiting: "waiting",
  addressed: "addressed",
  calls: "missed_calls",
  direct: "direct",
  groups: "groups",
  stories: "stories",
};

function sigOf(quote: NonNullable<Quoted>): { sig?: string } {
  return quote.signals.length === 0 ? {} : { sig: quote.signals.join(",") };
}

function quoteSuffix(quote: Quoted, withSignals: boolean): string {
  if (quote === null) return "";
  const markers = withSignals && quote.signals.length > 0 ? ` [${quote.signals.join(",")}]` : "";
  const then = quote.then === undefined ? "" : ` · then "${quote.then}"`;
  return `${quote.text === "" ? "" : ` — "${quote.text}"`}${markers}${then}`;
}

/** Shortest a "then" quote is worth showing. */
const THEN_MIN = 20;

/**
 * An ask and what followed it inside one quote of `level` characters: the
 * ask keeps at least two thirds when both are long, the rest goes to the
 * newer message, which is left out when too little room remains.
 */
function composeQuote(ask: string, then: string | null, level: number): { text: string; then?: string } {
  if (then === null) return { text: cut(ask, level) };
  if (ask === "") return { text: "", then: cut(then, level) };
  const thenChars = [...then].length;
  const askText = cut(ask, level - Math.min(thenChars, Math.floor(level / 3)));
  const room = level - [...askText].length;
  return room < THEN_MIN ? { text: askText } : { text: askText, then: cut(then, room) };
}

function itemsOf(view: AccountView, multi: boolean, now: number): Item[] {
  const scan = view.scan!;
  const account = view.id;
  const tag = multi ? { acct: account } : {};
  const key = (chat: string): string => `${account}|${chat}`;
  const items: Item[] = [];

  scan.waiting.forEach((entry: WaitingEntry) => {
    items.push({
      section: "waiting",
      account,
      chatKey: key(entry.chat),
      quoteId: entry.ask.type === "voice" && !entry.ask.transcribed ? null : entry.ask.id,
      thenId: entry.thenId ?? null,
      line: (quote) => {
        const who = `${entry.name}${entry.note ? ` (${entry.note})` : ""}${entry.group ? " [group]" : ""}${entry.business ? " [business]" : entry.unknown ? " [not saved]" : ""}`;
        const parts = [
          `- ${who}`,
          ...(entry.from ? [`${entry.from} asks`] : []),
          `since ${clock(entry.ask.ts, now)} (${age(entry.ask.ts, now)})`,
          ...(entry.sinceYou > 1 ? [`${entry.sinceYou} msgs since you`] : []),
          ...(entry.newSinceLast ? ["new"] : []),
          ...(entry.ask.type === "voice" || entry.ask.type === "audio"
            ? [`voice${entry.ask.voice ? ` ${entry.ask.voice}` : ""}${entry.ask.transcribed ? "" : ", not transcribed"}`]
            : []),
          ...(entry.signals.length > 0 ? [entry.signals.join(",")] : []),
          ...(entry.callAfter
            ? [
                `then ${entry.callAfter.outgoing ? "you called" : "they called"} ${clock(entry.callAfter.ts, now)}${entry.callAfter.seconds ? ` (${durationLabel(entry.callAfter.seconds)})` : ""}`,
              ]
            : []),
        ];
        return `${parts.join(" · ")}${quoteSuffix(quote, false)} · ${entry.chat}`;
      },
      data: (quote) => ({
        ...tag,
        chat: entry.chat,
        name: entry.name,
        ...(entry.note ? { note: entry.note } : {}),
        ...(entry.group ? { group: true, from: entry.from } : {}),
        ...(entry.business ? { business: true } : {}),
        ...(entry.unknown ? { unknown: true } : {}),
        at: clock(entry.ask.ts, now),
        ...(entry.sinceYou > 1 ? { n: entry.sinceYou } : {}),
        ...(entry.newSinceLast ? { new: true } : {}),
        ...(entry.ask.type === "text" ? {} : { type: entry.ask.type }),
        ...(entry.ask.voice ? { voice: entry.ask.voice } : {}),
        ...(entry.ask.type === "voice" || entry.ask.type === "audio" ? { transcribed: entry.ask.transcribed } : {}),
        ...(entry.signals.length > 0 ? { sig: entry.signals.join(",") } : {}),
        ...(entry.callAfter
          ? {
              call_after: {
                at: clock(entry.callAfter.ts, now),
                ...(entry.callAfter.outgoing ? { outgoing: true } : {}),
                ...(entry.callAfter.seconds ? { seconds: entry.callAfter.seconds } : {}),
              },
            }
          : {}),
        ...(quote && quote.text !== "" ? { q: quote.text } : {}),
        ...(quote?.then === undefined ? {} : { then: quote.then }),
      }),
    });
  });

  scan.addressed.forEach((entry: AddressedEntry) => {
    const verb =
      entry.kind === "mention" ? "mentioned you" : entry.kind === "reply" ? "replied to you" : entry.kind === "poll" ? "asks for your vote" : "invites you";
    items.push({
      section: "addressed",
      account,
      chatKey: key(entry.chat),
      quoteId: entry.kind === "mention" || entry.kind === "reply" ? entry.id : null,
      thenId: null,
      line: (quote) =>
        `- ${entry.name} · ${entry.from} ${verb} · ${clock(entry.ts, now)}${entry.more > 0 ? ` (+${entry.more} more)` : ""}${
          entry.title ? `: "${cut(entry.title, TITLE_CHARS)}"` : ""
        }${quoteSuffix(quote, true)} · ${entry.chat}`,
      data: (quote) => ({
        ...tag,
        chat: entry.chat,
        name: entry.name,
        kind: entry.kind,
        from: entry.from,
        at: clock(entry.ts, now),
        ...(entry.more > 0 ? { more: entry.more } : {}),
        ...(entry.title ? { title: cut(entry.title, TITLE_CHARS) } : {}),
        ...(quote ? { q: quote.text, ...sigOf(quote) } : {}),
      }),
    });
  });

  scan.calls.forEach((entry: CallsEntry) => {
    items.push({
      section: "calls",
      account,
      chatKey: key(entry.chat),
      quoteId: null,
      thenId: null,
      line: () =>
        `- ${entry.name}${entry.group ? ` (in ${entry.group})` : ""} · ${entry.count} missed ${entry.video ? "video" : "voice"} call${entry.count === 1 ? "" : "s"} · last ${clock(entry.lastTs, now)}${
          entry.calledBack ? " · you called back" : ""
        }${entry.wroteAfter ? " · you wrote after" : ""} · ${entry.chat}`,
      data: () => ({
        ...tag,
        chat: entry.chat,
        name: entry.name,
        n: entry.count,
        ...(entry.video ? { video: true } : {}),
        last: clock(entry.lastTs, now),
        ...(entry.group ? { group: entry.group } : {}),
        ...(entry.calledBack ? { called_back: true } : {}),
        ...(entry.wroteAfter ? { wrote_after: true } : {}),
      }),
    });
  });

  scan.direct.forEach((entry: DirectEntry) => {
    const media = mediaLabel(entry.media, entry.polls);
    items.push({
      section: "direct",
      account,
      chatKey: key(entry.chat),
      quoteId: entry.quoteId,
      thenId: null,
      line: (quote) => {
        const who = `${entry.name}${entry.note ? ` (${entry.note})` : ""}${entry.business ? " [business]" : entry.unknown ? " [not saved]" : ""}${entry.muted ? " [muted]" : ""}`;
        const more = quote !== null && entry.count > 1 ? ` (+${entry.count - 1} more)` : "";
        return `- ${who} · ${entry.count} new · ${clock(entry.newestTs, now)}${media ? ` · ${media}` : ""}${quoteSuffix(quote, true)}${more} · ${entry.chat}`;
      },
      data: (quote) => ({
        ...tag,
        chat: entry.chat,
        name: entry.name,
        ...(entry.note ? { note: entry.note } : {}),
        n: entry.count,
        at: clock(entry.newestTs, now),
        ...(Object.keys(entry.media).length > 0 ? { media: entry.media } : {}),
        ...(entry.polls > 0 ? { polls: entry.polls } : {}),
        ...(entry.business ? { business: true } : {}),
        ...(entry.unknown ? { unknown: true } : {}),
        ...(entry.muted ? { muted: true } : {}),
        ...(quote
          ? { q: quote.text, ...sigOf(quote), ...(entry.count > 1 ? { more_in_chat: entry.count - 1 } : {}) }
          : {}),
      }),
    });
  });

  scan.groups.forEach((entry: GroupEntry) => {
    const media = mediaLabel(entry.media, entry.polls);
    items.push({
      section: "groups",
      account,
      chatKey: key(entry.chat),
      quoteId: entry.hotId,
      thenId: null,
      line: (quote) =>
        `- ${entry.name} · ${entry.count} new from ${entry.senders}${entry.top.length > 0 ? ` (${entry.top.join(", ")})` : ""}${media ? ` · ${media}` : ""}${
          entry.addressed ? " · addresses you" : ""
        }${quoteSuffix(quote, true)} · ${entry.chat}`,
      data: (quote) => ({
        ...tag,
        chat: entry.chat,
        name: entry.name,
        n: entry.count,
        senders: entry.senders,
        top: entry.top,
        at: clock(entry.newestTs, now),
        ...(Object.keys(entry.media).length > 0 ? { media: entry.media } : {}),
        ...(entry.polls > 0 ? { polls: entry.polls } : {}),
        ...(entry.addressed ? { addressed: true } : {}),
        ...(quote ? { hot: quote.text, ...sigOf(quote) } : {}),
      }),
    });
  });

  const muted = scan.mutedGroups;
  if (muted !== null) {
    items.push({
      section: "groups",
      account,
      chatKey: key("#muted"),
      quoteId: null,
      thenId: null,
      line: () => `- Muted or archived: ${plural(muted.groups, "group")}, ${muted.count} new (${muted.names.join(", ")}${muted.groups > muted.names.length ? ", …" : ""})`,
      data: () => ({ ...tag, muted_or_archived: true, groups: muted.groups, n: muted.count, names: muted.names }),
    });
  }

  const stories = scan.stories;
  if (stories !== null) {
    items.push({
      section: "stories",
      account,
      chatKey: key("#stories"),
      quoteId: null,
      thenId: null,
      line: () => `- ${plural(stories.count, "story", "stories")} from ${stories.authors.join(", ")}${stories.more > 0 ? ` +${stories.more}` : ""}`,
      data: () => ({ ...tag, n: stories.count, authors: stories.authors, ...(stories.more > 0 ? { more: stories.more } : {}) }),
    });
  }
  return items;
}

// ---------------------------------------------------------------- the run

function specOf(args: CatchupArgs): CatchupWindowSpec {
  if (args.hours !== undefined) {
    if (args.since !== undefined && args.since.trim() !== "last") {
      throw new WazapError("INVALID_ID", "Pass either hours or since, not both.", 'Use hours: 24 for the last day, or since: "2026-09-16T18:00"');
    }
    return { kind: "hours", hours: args.hours };
  }
  const since = args.since?.trim() ?? "last";
  if (since === "last") return { kind: "last" };
  if (since === "previous") return { kind: "previous" };
  const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(since);
  const ms = Date.parse(bareDate ? `${since}T00:00:00` : since);
  if (Number.isNaN(ms)) {
    throw new WazapError(
      "INVALID_ID",
      `since is not "last", "previous" or a date: "${since}".`,
      'Pass "last", "previous", "2026-09-16" or "2026-09-16T18:00:00+03:00"'
    );
  }
  return { kind: "since", ms };
}

function missingSupport(id: string): WazapError {
  return new WazapError("SERVICE_ERROR", `Account "${id}" cannot give a catch-up.`, "Restart the wazap server so every account runs this version");
}

/** Which accounts a call covers: the one it names, or every live account when it names none and there are several. */
function targetsOf(args: CatchupArgs, ctx: CatchupContext, cursor: CursorState | null): Array<{ id: string; wa: WhatsAppApi }> {
  if (cursor !== null) {
    if (args.account_id !== undefined && (cursor.a.length !== 1 || cursor.a[0]!.id !== args.account_id)) {
      throw badCursor(`it continues a catch-up of ${cursor.a.map((account) => account.id).join(", ")}`);
    }
    return cursor.a.map((account) => {
      const binding = ctx.hub.binding(account.id);
      if (binding === undefined) throw badCursor(`account "${account.id}" is no longer served`);
      return binding;
    });
  }
  const live = ctx.hub.bindings();
  if (args.account_id !== undefined || live.length <= 1) return [{ id: ctx.accountId, wa: ctx.wa }];
  return live;
}

type Mark = { moved: boolean; why?: string; next_since?: string };

/** Moves the mark when the whole digest was given, and says why not otherwise. */
async function settleMark(view: AccountView, client: string, final: boolean, complete: boolean): Promise<Mark> {
  const scan = view.scan!;
  const window = scan.window;
  if (!window.advance) return { moved: false, why: window.basis === "hours" || window.basis === "since" ? "explicit_window" : "previous" };
  if (!final) return { moved: false, why: "more_pages" };
  if (!complete) return { moved: false, why: "partial_include" };
  if (scan.connection.status !== "connected") return { moved: false, why: "not_connected" };
  if (scan.connection.sync !== "done") return { moved: false, why: "sync_in_progress" };
  if (window.untilId === 0 || (window.expected !== null && window.untilId <= window.expected)) return { moved: false, why: "nothing_new" };
  if (typeof view.source.catchUpAdvance !== "function") return { moved: false, why: "unsupported" };
  try {
    const result = await view.source.catchUpAdvance(client, window.untilId, window.expected);
    return result.advanced ? { moved: true, next_since: isoWithOffset(tsOfId(window.untilId)) } : { moved: false, why: "moved_by_another_call" };
  } catch (err) {
    return { moved: false, why: `failed: ${asWazapError(err).code}` };
  }
}

export async function runCatchUp(args: CatchupArgs, ctx: CatchupContext): Promise<ToolResult> {
  const budget = Math.min(MAX_BUDGET_TOKENS, Math.max(MIN_BUDGET_TOKENS, Math.floor(args.budget_tokens ?? DEFAULT_BUDGET_TOKENS)));
  const budgetChars = budget * 4;
  const cursor = args.cursor === undefined ? null : decodeCursor(args.cursor, ctx.client);
  const include: CatchupSection[] =
    cursor?.i ?? (args.include === undefined ? [...CATCHUP_SECTIONS] : CATCHUP_SECTIONS.filter((section) => args.include!.includes(section)));
  const complete = include.length === CATCHUP_SECTIONS.length;
  const spec = cursor === null ? specOf(args) : null;
  const targets = targetsOf(args, ctx, cursor);
  const multi = targets.length > 1;
  const now = cursor?.t ?? (ctx.now ?? Date.now)();

  // Each account's scan; one that fails is reported, the others still answer.
  const views: AccountView[] = await Promise.all(
    targets.map(async (target): Promise<AccountView> => {
      const name = ctx.hub.record(target.id)?.name ?? target.id;
      const view: AccountView = { id: target.id, name, source: target.wa, scan: null, error: null };
      try {
        if (typeof target.wa.catchUpScan !== "function") throw missingSupport(target.id);
        const fixed = cursor?.a.find((account) => account.id === target.id);
        view.scan = await target.wa.catchUpScan({
          client: ctx.client,
          include,
          at: now,
          window:
            fixed === undefined
              ? spec!
              : { kind: "fixed", window: { sinceId: fixed.s, untilId: fixed.u, basis: fixed.b, advance: fixed.adv === 1, expected: fixed.x, at: now } },
        });
      } catch (err) {
        view.error = asWazapError(err);
      }
      return view;
    })
  );
  const answered = views.filter((view) => view.scan !== null);
  if (answered.length === 0) throw views[0]!.error ?? missingSupport(targets[0]!.id);

  // Every entry in section order; within a section, account by account.
  const byAccount = answered.map((view) => itemsOf(view, multi, now));
  const all: Item[] = CATCHUP_SECTIONS.flatMap((section) => byAccount.flatMap((items) => items.filter((item) => item.section === section)));
  let start = 0;
  if (cursor !== null) {
    const order = CATCHUP_SECTIONS.indexOf(cursor.sec);
    const sectionStart = all.findIndex((item) => CATCHUP_SECTIONS.indexOf(item.section) >= order);
    if (sectionStart === -1) start = all.length;
    else {
      const inSection = all.filter((item) => item.section === cursor.sec).length;
      start = sectionStart + (all[sectionStart]!.section === cursor.sec ? Math.min(cursor.o, inSection) : 0);
    }
  }
  const rest = all.slice(start);

  const header = headerLines(views, multi, now, cursor !== null);
  const footer = footerLines(answered, multi);
  const linesChars = (lines: readonly string[]): number => lines.reduce((n, line) => n + line.length + 1, 0);
  const headerChars = linesChars(header);
  const footerChars = footer.length === 0 ? 0 : linesChars(footer) + 1;
  const skeletonChars = new Map(all.map((item) => [item, item.line(null).length + 1]));
  const longestName = Math.max(...answered.map((view) => view.name.length));
  const headingChars = (item: Item): number => `## ${SECTION_TITLES[item.section]}${multi ? ` · ${"x".repeat(longestName)}` : ""} (99)`.length + 1;
  const headingKey = (item: Item): string => (multi ? `${item.section}|${item.account}` : item.section);
  const template: CursorState = {
    v: CURSOR_VERSION,
    k: clientKey(ctx.client),
    t: now,
    i: include,
    a: answered.map((view) => {
      const window = view.scan!.window;
      return { id: view.id, s: window.sinceId, u: window.untilId, b: window.basis, adv: window.advance ? 1 : 0, x: window.expected };
    }),
    sec: "waiting",
    o: 0,
  };
  const moreChars = 140 + encodeCursor({ ...template, sec: "addressed", o: 999 }).length;

  // 1. The skeleton: all of it with the footer, or as much as fits before a `more` line (at least one entry).
  const skeletonOf = (items: readonly Item[]): number => {
    let chars = items.length > 0 ? 1 : 0;
    let key = "";
    for (const item of items) {
      if (headingKey(item) !== key) {
        key = headingKey(item);
        chars += headingChars(item);
      }
      chars += skeletonChars.get(item)!;
    }
    return chars;
  };
  let page: Item[] = rest;
  let final = headerChars + skeletonOf(rest) + footerChars <= budgetChars;
  if (!final) {
    let chars = 1;
    let key = "";
    let taken = 0;
    for (const item of rest) {
      const heading = headingKey(item) === key ? 0 : headingChars(item);
      if (taken > 0 && headerChars + chars + heading + skeletonChars.get(item)! + moreChars > budgetChars) break;
      chars += heading + skeletonChars.get(item)!;
      key = headingKey(item);
      taken++;
    }
    page = rest.slice(0, taken);
    final = taken === rest.length;
  }
  const spare = budgetChars - headerChars - skeletonOf(page) - (final ? footerChars : moreChars);

  // 2. Quotes by priority, one per chat, read back in full for at most 60 messages.
  const quotedChats = new Set<string>();
  const candidates: Item[] = [];
  let reads = 0;
  for (const section of CATCHUP_SECTIONS) {
    if (QUOTE_CAPS[section] === undefined) continue;
    for (const item of page) {
      if (item.section !== section || (item.quoteId === null && item.thenId === null) || quotedChats.has(item.chatKey)) continue;
      if (reads + (item.quoteId === null ? 0 : 1) + (item.thenId === null ? 0 : 1) > MAX_QUOTES) break;
      reads += (item.quoteId === null ? 0 : 1) + (item.thenId === null ? 0 : 1);
      quotedChats.add(item.chatKey);
      candidates.push(item);
    }
  }
  const texts = await readQuotes(candidates, answered);
  type Placed = { item: Item; full: string; then: string | null; signals: Signal[]; level: number };
  const placed: Placed[] = [];
  for (const item of candidates) {
    const full = item.quoteId === null ? "" : (texts.get(`${item.account}|${item.quoteId}`)?.text ?? "");
    const then = item.thenId === null ? "" : (texts.get(`${item.account}|${item.thenId}`)?.text ?? "");
    if (full === "" && then === "") continue;
    placed.push({
      item,
      full,
      then: then === "" ? null : then,
      signals: item.section === "waiting" ? [] : [...signalsOf(full)],
      level: QUOTE_CAPS[item.section]!,
    });
  }
  const quoteAt = (entry: Placed, level: number): Quoted => (level === 0 ? null : { ...composeQuote(entry.full, entry.then, level), signals: entry.signals });
  const extra = (entry: Placed, level: number): number => entry.item.line(quoteAt(entry, level)).length - skeletonChars.get(entry.item)! + 1;
  let spent = placed.reduce((n, entry) => n + extra(entry, entry.level), 0);
  // 3. Too long: the lowest-priority quotes shrink to 80 characters, then go.
  for (let i = placed.length - 1; i >= 0 && spent > spare; i--) {
    const entry = placed[i]!;
    if (entry.level <= SHORT_QUOTE) continue;
    spent -= extra(entry, entry.level) - extra(entry, SHORT_QUOTE);
    entry.level = SHORT_QUOTE;
  }
  for (let i = placed.length - 1; i >= 0 && spent > spare; i--) {
    const entry = placed[i]!;
    spent -= extra(entry, entry.level);
    entry.level = 0;
  }
  const quotes = new Map(placed.filter((entry) => entry.level > 0).map((entry) => [entry.item, quoteAt(entry, entry.level)]));

  // The mark, once the whole digest was given.
  const marks = new Map<string, Mark>();
  for (const view of answered) marks.set(view.id, await settleMark(view, ctx.client, final, complete));

  // Render.
  const lines = [...header];
  let key = "";
  for (const item of page) {
    if (headingKey(item) !== key) {
      key = headingKey(item);
      lines.push(headingOf(item, page, answered, multi));
    }
    lines.push(item.line(quotes.get(item) ?? null));
  }
  if (all.length === 0) lines.push(nothingLine(answered, now));
  let more: { cursor: string; remaining: Record<string, number>; approx_tokens: number } | null = null;
  const remainingItems = all.slice(start + page.length);
  if (!final) {
    const next = remainingItems[0]!;
    const offset = all.slice(0, start + page.length).filter((item) => item.section === next.section).length;
    const remaining: Record<string, number> = {};
    for (const item of remainingItems) remaining[STRUCTURED_KEYS[item.section]] = (remaining[STRUCTURED_KEYS[item.section]] ?? 0) + 1;
    const quotesLeft = remainingItems.filter((item) => item.quoteId !== null || item.thenId !== null).length;
    const approx = Math.ceil((skeletonOf(remainingItems) + footerChars) / 4) + quotesLeft * 30;
    more = { cursor: encodeCursor({ ...template, sec: next.section, o: offset }), remaining, approx_tokens: approx };
    const counts = Object.entries(remaining)
      .map(([section, n]) => `${section} ${n}`)
      .join(", ");
    lines.push("", `More: ${plural(remainingItems.length, "entry", "entries")} left (${counts}; ~${approx} tokens). Call catch_up with cursor: "${more.cursor}"`);
  } else {
    if (footer.length > 0) lines.push("", ...footer);
    for (const view of answered) {
      const mark = marks.get(view.id)!;
      const label = multi ? `${view.name}: ` : "";
      if (mark.moved) lines.push(`${label}The next catch-up starts after ${clock(Date.parse(mark.next_since!), now)}; since: "previous" gives this one again.`);
      else if (mark.why === "moved_by_another_call") lines.push(`${label}Another catch-up of this client finished first; the next one starts where that one ended.`);
    }
  }
  const text = lines.join("\n");

  const structured: Record<string, unknown> = {
    window: unionWindow(answered, now),
    accounts: views.map((view) =>
      view.scan === null
        ? { account_id: view.id, name: view.name, status: "error", error: { code: view.error!.code, message: view.error!.message } }
        : {
            account_id: view.id,
            name: view.name,
            status: view.scan.connection.status,
            ...(view.scan.connection.status !== "connected" && view.scan.connection.since !== null ? { status_since: view.scan.connection.since } : {}),
            ...(view.scan.connection.sync === "done" ? {} : { sync: view.scan.connection.sync }),
            ...(multi ? { window: windowOf(view.scan.window, now) } : {}),
            mark: marks.get(view.id),
          }
    ),
    waiting: [],
    addressed: [],
    missed_calls: [],
    direct: [],
    groups: [],
    stories: [],
    footer: final ? footerData(answered, multi) : null,
    more,
    approx_tokens: Math.ceil(text.length / 4),
    account_id: multi ? null : answered[0]!.id,
  };
  for (const item of page) (structured[STRUCTURED_KEYS[item.section]] as unknown[]).push(item.data(quotes.get(item) ?? null));
  return { content: [{ type: "text", text }], structuredContent: structured };
}

async function readQuotes(candidates: readonly Item[], views: readonly AccountView[]): Promise<Map<string, CatchupQuote>> {
  const out = new Map<string, CatchupQuote>();
  for (const view of views) {
    const ids = candidates
      .filter((item) => item.account === view.id)
      .flatMap((item) => [item.quoteId, item.thenId].filter((id): id is number => id !== null));
    if (ids.length === 0 || typeof view.source.catchUpQuotes !== "function") continue;
    for (const quote of await view.source.catchUpQuotes(ids)) out.set(`${view.id}|${quote.id}`, quote);
  }
  return out;
}

function headingOf(item: Item, page: readonly Item[], views: readonly AccountView[], multi: boolean): string {
  const same = page.filter((other) => other.section === item.section && (!multi || other.account === item.account));
  const count = item.section === "stories" ? "" : ` (${same.filter((other) => !other.chatKey.endsWith("|#muted")).length})`;
  const account = multi ? ` · ${views.find((view) => view.id === item.account)!.name}` : "";
  return `## ${SECTION_TITLES[item.section]}${account}${count}`;
}

function headerLines(views: readonly AccountView[], multi: boolean, now: number, continued: boolean): string[] {
  const title = continued ? "# WhatsApp catch-up, continued" : "# WhatsApp catch-up";
  const stale = (view: AccountView): string => {
    const connection = view.scan?.connection;
    if (connection === undefined || connection.status === "connected") return "";
    const since = connection.since === null ? "" : ` since ${clock(Date.parse(connection.since), now)}`;
    return ` · ${connection.status}${since}: what arrived after that is not here yet`;
  };
  if (!multi) {
    const view = views[0]!;
    return [`${title} · ${windowPhrase(view.scan!.window, now)}${stale(view)}`];
  }
  return [
    `${title} · ${views.length} accounts`,
    ...views.map((view) =>
      view.scan === null
        ? `- ${view.name} (${view.id}): unavailable — ${view.error!.code}: ${view.error!.message}`
        : `- ${view.name} (${view.id}): ${windowPhrase(view.scan.window, now)}${stale(view)}`
    ),
  ];
}

function nothingLine(views: readonly AccountView[], now: number): string {
  const disconnected = views.some((view) => view.scan!.connection.status !== "connected");
  return disconnected ? "Nothing new is stored for this window." : `Nothing new, checked up to ${clock(now, now)}.`;
}

function skippedParts(scan: CatchupScan): string[] {
  const { noCatchup, leftGroups, newsletters, broadcasts } = scan.skipped;
  const parts: string[] = [];
  if (noCatchup.chats > 0) parts.push(`${plural(noCatchup.chats, "chat")} tagged #no-catchup (${noCatchup.messages} msgs)`);
  if (leftGroups.chats > 0) parts.push(`${plural(leftGroups.chats, "group")} you left (${leftGroups.messages} msgs)`);
  if (newsletters.chats > 0) parts.push(`${plural(newsletters.chats, "channel")} (${newsletters.messages} msgs)`);
  if (broadcasts.chats > 0) parts.push(`${plural(broadcasts.chats, "broadcast list")} (${broadcasts.messages} msgs)`);
  return parts;
}

function footerLines(views: readonly AccountView[], multi: boolean): string[] {
  const lines: string[] = [];
  for (const view of views) {
    const scan = view.scan!;
    const label = multi ? `${view.name}: ` : "";
    if (scan.voiceUntranscribedCount > 0) {
      const more = scan.voiceUntranscribedCount - scan.voiceUntranscribed.length;
      lines.push(
        `${label}Voice notes not transcribed (${scan.voiceUntranscribedCount}): ${scan.voiceUntranscribed.join(", ")}${more > 0 ? `, +${more}` : ""} — transcribe_audio reads one.`
      );
    }
    const skipped = skippedParts(scan);
    if (skipped.length > 0) lines.push(`${label}Left out: ${skipped.join(" · ")}.`);
    if (scan.connection.sync !== "done") lines.push(`${label}History sync is still running; some messages may not be here yet.`);
    if (scan.connection.mentionsIndexing) lines.push(`${label}Mentions in older messages are still being indexed.`);
  }
  return lines;
}

function footerData(views: readonly AccountView[], multi: boolean): Record<string, unknown> {
  const per = views.map((view) => {
    const scan = view.scan!;
    const { noCatchup, leftGroups, newsletters, broadcasts } = scan.skipped;
    const skipped: Record<string, { chats: number; messages: number }> = {};
    if (noCatchup.chats > 0) skipped.no_catchup = noCatchup;
    if (leftGroups.chats > 0) skipped.left_groups = leftGroups;
    if (newsletters.chats > 0) skipped.newsletters = newsletters;
    if (broadcasts.chats > 0) skipped.broadcasts = broadcasts;
    const more = scan.voiceUntranscribedCount - scan.voiceUntranscribed.length;
    return {
      ...(multi ? { acct: view.id } : {}),
      ...(scan.voiceUntranscribed.length > 0 ? { voice_untranscribed: scan.voiceUntranscribed } : {}),
      ...(more > 0 ? { voice_untranscribed_more: more } : {}),
      ...(Object.keys(skipped).length > 0 ? { skipped } : {}),
      ...(scan.connection.sync !== "done" ? { history_sync: scan.connection.sync } : {}),
      ...(scan.connection.mentionsIndexing ? { mentions_indexing: true } : {}),
    };
  });
  return multi ? { accounts: per } : per[0]!;
}

function unionWindow(views: readonly AccountView[], now: number): { since: string; until: string; hours: number; basis: string } {
  const each = views.map((view) => windowOf(view.scan!.window, now));
  const since = Math.min(...each.map((window) => Date.parse(window.since)));
  const until = Math.max(...each.map((window) => Date.parse(window.until)));
  const bases = new Set(each.map((window) => window.basis));
  return {
    since: isoWithOffset(since),
    until: isoWithOffset(until),
    hours: Math.round(((until - since) / HOUR) * 10) / 10,
    basis: bases.size === 1 ? [...bases][0]! : "mixed",
  };
}
