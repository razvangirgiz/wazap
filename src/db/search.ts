/**
 * Substring search, newest first. A query of three or more characters goes
 * through the trigram index (case- and diacritic-insensitive, so "SEDINT"
 * finds "ședință"); a shorter one cannot, and walks recent messages instead.
 * Both stop after a bounded number of candidates and say so, because "no
 * hit within the cap" is not "no such message".
 */
import type { Connection } from "./connection.js";
import { idLowerBound, idUpperBound } from "./ids.js";
import type { Identity } from "./identity.js";
import { chatCondition, type Messages } from "./messages.js";
import type { SQLInputValue } from "./sqlite.js";
import type { MessageFilter, TextSearchInput, TextSearchResult } from "./types.js";

/**
 * Messages the short-query scan matches in JavaScript before it stops and
 * reports scanCapped: about 40 ms at 100k messages, where 50k took 93 ms.
 */
export const DEFAULT_SCAN_CAP = 20_000;
/** FTS candidates the trigram path examines before it stops; each costs a fraction of a scanned row. */
export const DEFAULT_TRIGRAM_CAP = 50_000;
const FTS_BATCH = 256;
const MIN_TRIGRAM_CHARS = 3;
const NO_UPPER_BOUND = Number.MAX_SAFE_INTEGER;

/** What the trigram tokenizer does to text, for the paths that match in JavaScript. */
export function foldText(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "");
}

/** A filter turned into ids and one SQL condition over `m`; null when it can match nothing. */
export interface ResolvedFilter {
  lower: number;
  upper: number;
  where: string;
  params: SQLInputValue[];
  /** Whether the filter needs more than an id range; a pure range lets the vector scan skip the join. */
  narrowsRows: boolean;
  since?: number;
  until?: number;
}

export function ftsPhrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

export class Search {
  constructor(
    private readonly c: Connection,
    private readonly identity: Identity,
    private readonly messages: Messages
  ) {}

  resolveFilter(filter: MessageFilter): ResolvedFilter | null {
    const conditions = ["m.deleted_at IS NULL", "(m.expires_at IS NULL OR m.expires_at > ?)"];
    const params: SQLInputValue[] = [this.c.now()];
    let narrowsRows = false;
    if (filter.chat !== undefined) {
      const chat = this.identity.chat(filter.chat);
      if (chat === null) return null;
      const inChat = chatCondition(this.identity.chatIdsOf(chat));
      conditions.push(inChat.sql);
      params.push(...inChat.params);
      narrowsRows = true;
    }
    if (filter.from !== undefined) {
      if (filter.from === "me") {
        conditions.push("m.from_me = 1");
      } else {
        const contactIds = this.identity.contactIdsOf(filter.from);
        if (contactIds.length === 0) return null;
        if (contactIds.length === 1) {
          conditions.push("m.sender_id = ?");
          params.push(contactIds[0]!);
        } else {
          conditions.push("m.sender_id IN (SELECT value FROM json_each(?))");
          params.push(JSON.stringify(contactIds));
        }
      }
      narrowsRows = true;
    }
    if (filter.since !== undefined) {
      conditions.push("m.ts >= ?");
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      conditions.push("m.ts <= ?");
      params.push(filter.until);
    }
    const lower = filter.since === undefined ? 0 : idLowerBound(filter.since);
    const upper = filter.until === undefined ? NO_UPPER_BOUND : idUpperBound(filter.until);
    if (upper <= lower) return null;
    return {
      lower,
      upper,
      where: conditions.join(" AND "),
      params,
      narrowsRows,
      ...(filter.since === undefined ? {} : { since: filter.since }),
      ...(filter.until === undefined ? {} : { until: filter.until }),
    };
  }

  text(input: TextSearchInput): TextSearchResult {
    const limit = Math.min(1_000, Math.max(1, Math.floor(input.limit)));
    const query = input.query.trim();
    const mode = [...query].length >= MIN_TRIGRAM_CHARS ? "trigram" : "scan";
    const cap = Math.max(1, Math.floor(input.scanCap ?? (mode === "trigram" ? DEFAULT_TRIGRAM_CAP : DEFAULT_SCAN_CAP)));
    const filter = this.resolveFilter(input);
    if (filter === null) return { items: [], hasMore: false, nextBefore: null, mode, scanCapped: false };
    const upper = Math.min(input.before ?? NO_UPPER_BOUND, filter.upper);
    const found = mode === "trigram" ? this.trigramIds(query, filter, upper, limit + 1, cap) : this.scanIds(query, filter, upper, limit + 1, cap);
    const hasMore = found.ids.length > limit;
    const ids = hasMore ? found.ids.slice(0, limit) : found.ids;
    const items = this.messages.byIds(ids);
    if (hasMore) return { items, hasMore, nextBefore: ids[ids.length - 1]!, mode, scanCapped: false };
    if (found.cappedAt !== null) return { items, hasMore: true, nextBefore: found.cappedAt, mode, scanCapped: true };
    return { items, hasMore: false, nextBefore: null, mode, scanCapped: false };
  }

  /**
   * Newest FTS matches in batches, each batch filtered against `messages`,
   * until `want` ids pass or `cap` candidates were examined. `cappedAt` is the
   * cursor to resume from when the cap stopped it.
   */
  trigramIds(
    match: string,
    filter: ResolvedFilter,
    upper: number,
    want: number,
    cap: number,
    matchExpression = ftsPhrase(match)
  ): { ids: number[]; cappedAt: number | null } {
    const ids: number[] = [];
    let cursor = upper;
    let examined = 0;
    for (;;) {
      const batch = this.c
        .all<{ id: number }>(
          `SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ? AND rowid < ? AND rowid >= ?
           ORDER BY rowid DESC LIMIT ?`,
          matchExpression,
          cursor,
          filter.lower,
          FTS_BATCH
        )
        .map((row) => row.id);
      if (batch.length === 0) return { ids, cappedAt: null };
      examined += batch.length;
      const passing = this.c.all<{ id: number }>(
        `SELECT m.id FROM messages m WHERE m.id IN (SELECT value FROM json_each(?)) AND ${filter.where}
         ORDER BY m.id DESC LIMIT ?`,
        JSON.stringify(batch),
        ...filter.params,
        want - ids.length
      );
      for (const row of passing) ids.push(row.id);
      if (ids.length >= want) return { ids, cappedAt: null };
      cursor = batch[batch.length - 1]!;
      if (batch.length < FTS_BATCH) return { ids, cappedAt: null };
      if (examined >= cap) return { ids, cappedAt: cursor };
    }
  }

  /** The short-query path: recent messages newest first, matched in JavaScript, at most `cap` of them. */
  private scanIds(query: string, filter: ResolvedFilter, upper: number, want: number, cap: number): { ids: number[]; cappedAt: number | null } {
    const needle = foldText(query);
    const ids: number[] = [];
    let examined = 0;
    const rows = this.c
      .stmt(
        `SELECT m.id, m.text, m.transcript FROM messages m
         WHERE m.id < ? AND m.id >= ? AND ${filter.where} ORDER BY m.id DESC`
      )
      .iterate(upper, filter.lower, ...filter.params) as Iterable<{ id: number; text: string | null; transcript: string | null }>;
    for (const row of rows) {
      examined++;
      if (
        needle === "" ||
        (row.text !== null && foldText(row.text).includes(needle)) ||
        (row.transcript !== null && foldText(row.transcript).includes(needle))
      ) {
        ids.push(row.id);
        if (ids.length >= want) return { ids, cappedAt: null };
      }
      if (examined >= cap) return { ids, cappedAt: row.id };
    }
    return { ids, cappedAt: null };
  }
}
