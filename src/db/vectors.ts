/**
 * Semantic search over stored embeddings, and the hybrid search that fuses
 * it with the trigram index.
 *
 * Vectors keep recall's conventions so an existing index imports without
 * re-embedding: L2-normalized, quantized to int8 as round(x * 127), so the
 * cosine similarity against a unit query is dot(query, vec) / 127. The
 * similarity floor applies to that raw cosine.
 *
 * The scan is exact brute force over the rows the filters leave, on the
 * calling thread. It needs only a read connection, so it can move to a
 * worker with a read-only open of the same file unchanged.
 */
import { createHash } from "node:crypto";
import type { Connection } from "./connection.js";
import { StorageError } from "./errors.js";
import { secondOf, secondOfId } from "./ids.js";
import type { Identity } from "./identity.js";
import type { Messages } from "./messages.js";
import { DEFAULT_SCAN_CAP, DEFAULT_TRIGRAM_CAP, foldText, ftsPhrase, type ResolvedFilter, type Search } from "./search.js";
import type { SQLInputValue } from "./sqlite.js";
import type { MessageFilter, Page, StoredMessage } from "./types.js";

/** Reciprocal Rank Fusion's damping constant, the value from the original paper. */
export const RRF_K = 60;
const DEFAULT_CANDIDATES = 100;
const DEFAULT_BACKLOG_SCAN = 20_000;
/** A hybrid query word shorter than this names too much to be worth an index lookup. */
const MIN_TOKEN_CHARS = 4;
const MAX_TOKENS = 8;
const NO_UPPER_BOUND = Number.MAX_SAFE_INTEGER;
/** The model the embedding queue is kept for; the queue triggers test for this key. */
const FEED_MODEL_META = "embed_model";
/** The refill's descending id cursor, present while a refill is owed. */
const REFILL_META = "embed_refill_before";
const DEFAULT_QUEUE_SCAN = 2_000;

export function unitVector(vector: ArrayLike<number>): Float64Array {
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    const x = vector[i]!;
    if (!Number.isFinite(x)) throw new StorageError("INVALID_INPUT", "An embedding holds a non-finite value.");
    norm += x * x;
  }
  if (norm === 0) throw new StorageError("INVALID_INPUT", "An embedding cannot be the zero vector.");
  const inv = 1 / Math.sqrt(norm);
  const unit = new Float64Array(vector.length);
  for (let i = 0; i < vector.length; i++) unit[i] = vector[i]! * inv;
  return unit;
}

/** The old recall index's quantization, byte for byte, so its vectors import as they are: normalize, clamp, round(x * 127). */
export function quantizeVector(vector: ArrayLike<number>): Int8Array {
  const unit = unitVector(vector);
  const out = new Int8Array(unit.length);
  for (let i = 0; i < unit.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, unit[i]!)) * 127);
  return out;
}

/**
 * The words an embedding is made from, as a short digest: text and transcript,
 * with null kept distinct from empty. The backlog hands it out with each item
 * and put() stores a vector only while the message still says exactly that.
 */
export function contentHash(text: string | null, transcript: string | null): string {
  const part = (value: string | null): string => (value === null ? "\u0000" : `\u0001${value}`);
  return createHash("sha256").update(`${part(text)}\u0002${part(transcript)}`).digest("hex").slice(0, 32);
}

/** Cosine similarity of a unit query against a stored int8 vector. */
export function int8Similarity(unit: Float64Array, vec: Int8Array): number {
  let dot = 0;
  const n = unit.length;
  let i = 0;
  for (; i + 3 < n; i += 4) {
    dot += unit[i]! * vec[i]! + unit[i + 1]! * vec[i + 1]! + unit[i + 2]! * vec[i + 2]! + unit[i + 3]! * vec[i + 3]!;
  }
  for (; i < n; i++) dot += unit[i]! * vec[i]!;
  return dot / 127;
}

/**
 * The words of a hybrid query worth looking up, folded and unique. Words of
 * four or more letters go to the trigram index; three-letter words join them
 * when there is nothing longer, or when they carry a digit or are an acronym
 * ("PIN"). Words under three characters cannot use the index: only digits and
 * acronyms ("42", "BT") are kept, and they go through the bounded short-query
 * scan — "e", "la" or "de" would only ever match everything.
 */
export function hybridWords(query: string): { trigram: string[]; short: string[] } {
  const seen = new Set<string>();
  const words: Array<{ folded: string; length: number; significant: boolean }> = [];
  for (const original of query.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const folded = foldText(original);
    if (seen.has(folded)) continue;
    seen.add(folded);
    words.push({ folded, length: [...folded].length, significant: /\p{N}/u.test(original) || /^\p{Lu}{2,}$/u.test(original) });
  }
  const hasLong = words.some((word) => word.length >= MIN_TOKEN_CHARS);
  const trigram = words
    .filter((word) => word.length >= MIN_TOKEN_CHARS || (word.length === 3 && (!hasLong || word.significant)))
    .map((word) => word.folded);
  const short = words.filter((word) => word.length < 3 && word.significant).map((word) => word.folded);
  return { trigram: trigram.slice(0, MAX_TOKENS), short: short.slice(0, Math.max(0, MAX_TOKENS - trigram.length)) };
}

/** Every word a hybrid query looks up, index words first. */
export function hybridTokens(query: string): string[] {
  const { trigram, short } = hybridWords(query);
  return [...trigram, ...short];
}

/** A fixed-size min-heap on score: the K best of a stream without sorting the stream. */
class TopK {
  private readonly scores: number[] = [];
  private readonly ids: number[] = [];
  constructor(private readonly k: number) {}

  get floor(): number {
    return this.scores.length < this.k ? -Infinity : this.scores[0]!;
  }

  push(score: number, id: number): void {
    if (this.scores.length < this.k) {
      this.scores.push(score);
      this.ids.push(id);
      this.up(this.scores.length - 1);
    } else if (score > this.scores[0]!) {
      this.scores[0] = score;
      this.ids[0] = id;
      this.down(0);
    }
  }

  sorted(): Array<{ id: number; score: number }> {
    return this.ids.map((id, i) => ({ id, score: this.scores[i]! })).sort((a, b) => b.score - a.score || b.id - a.id);
  }

  private swap(a: number, b: number): void {
    [this.scores[a], this.scores[b]] = [this.scores[b]!, this.scores[a]!];
    [this.ids[a], this.ids[b]] = [this.ids[b]!, this.ids[a]!];
  }

  private up(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.scores[parent]! <= this.scores[i]!) return;
      this.swap(parent, i);
      i = parent;
    }
  }

  private down(i: number): void {
    const n = this.scores.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let least = i;
      if (left < n && this.scores[left]! < this.scores[least]!) least = left;
      if (right < n && this.scores[right]! < this.scores[least]!) least = right;
      if (least === i) return;
      this.swap(least, i);
      i = least;
    }
  }
}

export interface BacklogItem {
  id: number;
  sid: string;
  type: string;
  ts: number;
  text: string | null;
  transcript: string | null;
  /** Pass to put() with the vector made from this text and transcript. */
  contentHash: string;
}

export interface VectorSearchInput extends MessageFilter {
  model: string;
  vector: ArrayLike<number>;
  limit: number;
  /** Raw cosine a hit must reach; 0 keeps every positive match. */
  minSimilarity?: number;
  /** Rank by similarity × 0.5^(age / halfLife) instead of plain similarity; the floor still applies to similarity. */
  recencyHalfLifeMs?: number;
}

export interface VectorHit {
  message: StoredMessage;
  similarity: number;
  score: number;
}

export interface HybridSearchInput extends MessageFilter {
  query: string;
  model: string;
  /** The embedded query; without it the search is lexical only and says so. */
  vector?: ArrayLike<number> | null;
  limit: number;
  /** Raw cosine a hit found only by meaning must reach; lexical hits need none. */
  minSimilarity: number;
  lexicalCandidates?: number;
  semanticCandidates?: number;
  /** FTS rows examined on the lexical side before it stops. */
  scanCap?: number;
}

export interface HybridHit {
  message: StoredMessage;
  score: number;
  /** 1-based rank among lexical candidates, when it was one. */
  lexicalRank: number | null;
  /** 1-based rank among semantic candidates, when it was one. */
  semanticRank: number | null;
  similarity: number | null;
}

export interface HybridResult {
  hits: HybridHit[];
  semantic: boolean;
  lexicalCapped: boolean;
}

export class Vectors {
  constructor(
    private readonly c: Connection,
    private readonly identity: Identity,
    private readonly messages: Messages,
    private readonly search: Search
  ) {}

  /**
   * Stores a message's embedding. A float vector is normalized and quantized;
   * an Int8Array is taken as already quantized (the recall import path).
   * `hash` is the contentHash of the words the vector was made from — the
   * backlog item's — and the vector is stored only while the message still
   * says exactly those words. Returns false for an unknown, deleted, expired
   * or textless message, and for one edited or transcribed since.
   */
  put(sid: string, model: string, vector: ArrayLike<number> | Int8Array, hash: string): boolean {
    const vec = vector instanceof Int8Array ? vector : quantizeVector(vector);
    if (vec.length === 0) throw new StorageError("INVALID_INPUT", "An embedding cannot be empty.");
    return this.c.write(() => {
      const key = this.messages.visibleKey(sid);
      if (key === null) return false;
      const words = this.c.get<{ text: string | null; transcript: string | null }>(
        "SELECT text, transcript FROM messages WHERE id = ?",
        key.id
      )!;
      if (words.text === null && words.transcript === null) return false;
      if (contentHash(words.text, words.transcript) !== hash) return false;
      this.c.run(
        `INSERT INTO embeddings(message_id, model, content_hash, vec) VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET model = excluded.model, content_hash = excluded.content_hash, vec = excluded.vec`,
        key.id,
        model,
        hash,
        new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
      );
      // Done for the fed model; a vector from another model leaves the message still owed one.
      const fed = this.meta(FEED_MODEL_META);
      if (fed === model) this.c.run("DELETE FROM embed_queue WHERE message_id = ?", key.id);
      else if (fed !== null) this.c.run("INSERT OR IGNORE INTO embed_queue(message_id) VALUES (?)", key.id);
      return true;
    });
  }

  get(sid: string): { model: string; vector: Int8Array } | null {
    const key = this.messages.visibleKey(sid);
    if (key === null) return null;
    const row = this.c.get<{ model: string; vec: Uint8Array }>("SELECT model, vec FROM embeddings WHERE message_id = ?", key.id);
    return row === undefined ? null : { model: row.model, vector: new Int8Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength) };
  }

  count(model?: string): number {
    const row =
      model === undefined
        ? this.c.get<{ n: number }>("SELECT count(*) AS n FROM embeddings")
        : this.c.get<{ n: number }>("SELECT count(*) AS n FROM embeddings WHERE model = ?", model);
    return row?.n ?? 0;
  }

  /**
   * Visible messages with text and no embedding from `model`, newest first.
   * At most `scanCap` messages are examined per call; `nextBefore` resumes.
   */
  backlog(options: { model: string; limit: number; before?: number; scanCap?: number }): Page<BacklogItem> {
    const limit = Math.max(1, Math.floor(options.limit));
    const cap = Math.max(1, Math.floor(options.scanCap ?? DEFAULT_BACKLOG_SCAN));
    const rows = this.c
      .stmt(
        `SELECT m.id, (CASE WHEN m.from_me = 1 THEN 'true' ELSE 'false' END) || '_' || coalesce(ck.jid, c.jid) || '_' || m.key_id AS sid,
           m.type, m.ts, m.text, m.transcript,
           EXISTS (SELECT 1 FROM embeddings e WHERE e.message_id = m.id AND e.model = ?) AS embedded
         FROM messages m CROSS JOIN chats c ON c.id = m.chat_id LEFT JOIN chats ck ON ck.id = c.merged_into
         WHERE m.id < ? AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?)
           AND m.ts > coalesce(c.cleared_through_ts, 0) AND (m.text IS NOT NULL OR m.transcript IS NOT NULL)
         ORDER BY m.id DESC`
      )
      .iterate(options.model, options.before ?? NO_UPPER_BOUND, this.c.now()) as Iterable<Omit<BacklogItem, "contentHash"> & { embedded: number }>;
    const items: BacklogItem[] = [];
    let examined = 0;
    for (const row of rows) {
      examined++;
      if (row.embedded === 0) {
        if (items.length === limit) return { items, hasMore: true, nextBefore: items[items.length - 1]!.id };
        const { embedded: _embedded, ...item } = row;
        items.push({ ...item, contentHash: contentHash(item.text, item.transcript) });
      }
      if (examined >= cap) return { items, hasMore: true, nextBefore: row.id };
    }
    return { items, hasMore: false, nextBefore: null };
  }

  /**
   * Starts, or keeps, feeding `model`: from here on a message stored with
   * words, or whose words change, is queued for it. A model fed for the first
   * time — or instead of another — owes a refill of the messages already
   * stored; `refilling` says one is still owed, and refill() pays it in steps.
   */
  feed(model: string): { refilling: boolean } {
    return this.c.write(() => {
      const current = this.meta(FEED_MODEL_META);
      if (current !== model) {
        this.setMeta(FEED_MODEL_META, model);
        this.setMeta(REFILL_META, String(NO_UPPER_BOUND));
      }
      return { refilling: this.meta(REFILL_META) !== null };
    });
  }

  /** Stops keeping the queue: no model is fed, and nothing stays queued. */
  unfeed(): void {
    this.c.write(() => {
      if (this.meta(FEED_MODEL_META) === null && this.meta(REFILL_META) === null) return;
      this.setMeta(FEED_MODEL_META, null);
      this.setMeta(REFILL_META, null);
      this.c.run("DELETE FROM embed_queue");
    });
  }

  /**
   * One step of the refill: the next `scan` stored messages down from the
   * cursor, of which those with words and no vector from the fed model are
   * queued. The cursor is stored with the step, so a restart resumes below
   * it. True while more is owed.
   */
  refill(scan = DEFAULT_QUEUE_SCAN): boolean {
    const span = Math.max(1, Math.floor(scan));
    return this.c.write(() => {
      const cursor = this.meta(REFILL_META);
      const model = this.meta(FEED_MODEL_META);
      if (cursor === null) return false;
      if (model === null) {
        this.setMeta(REFILL_META, null);
        return false;
      }
      const before = Number(cursor);
      const boundary = this.c.get<{ id: number }>("SELECT id FROM messages WHERE id < ? ORDER BY id DESC LIMIT 1 OFFSET ?", before, span - 1);
      const lower = boundary?.id ?? 0;
      this.c.run(
        `INSERT OR IGNORE INTO embed_queue(message_id)
           SELECT m.id FROM messages m
           WHERE m.id < ? AND m.id >= ? AND m.deleted_at IS NULL AND (m.text IS NOT NULL OR m.transcript IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.message_id = m.id AND e.model = ?)`,
        before,
        lower,
        model
      );
      if (boundary === undefined) {
        this.setMeta(REFILL_META, null);
        return false;
      }
      this.setMeta(REFILL_META, String(boundary.id));
      return true;
    });
  }

  /**
   * Queued messages to embed for `model`, newest first, each with the hash of
   * the words to embed. A queued row that needs nothing — its message gone,
   * hidden, expired, without words, or already holding a vector of these
   * words — leaves the queue on the way. At most `scanCap` rows are looked at
   * per call; `nextBefore` resumes below them.
   */
  queued(options: { model: string; limit: number; before?: number; scanCap?: number }): Page<BacklogItem> {
    const limit = Math.max(1, Math.floor(options.limit));
    const cap = Math.max(limit, Math.floor(options.scanCap ?? DEFAULT_QUEUE_SCAN));
    return this.c.write(() => {
      const rows = this.c.all<
        Omit<BacklogItem, "contentHash" | "sid"> & { sid: string | null; live: number | null; embeddedHash: string | null }
      >(
        `SELECT q.message_id AS id,
           (CASE WHEN m.from_me = 1 THEN 'true' ELSE 'false' END) || '_' || coalesce(ck.jid, c.jid) || '_' || m.key_id AS sid,
           m.type, m.ts, m.text, m.transcript,
           (m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?) AND m.ts > coalesce(c.cleared_through_ts, 0)) AS live,
           (SELECT e.content_hash FROM embeddings e WHERE e.message_id = m.id AND e.model = ?) AS embeddedHash
         FROM embed_queue q LEFT JOIN messages m ON m.id = q.message_id
           LEFT JOIN chats c ON c.id = m.chat_id LEFT JOIN chats ck ON ck.id = c.merged_into
         WHERE q.message_id < ? ORDER BY q.message_id DESC LIMIT ?`,
        this.c.now(),
        options.model,
        options.before ?? NO_UPPER_BOUND,
        cap
      );
      const items: BacklogItem[] = [];
      const done: number[] = [];
      for (const row of rows) {
        const hash = row.sid === null ? null : contentHash(row.text, row.transcript);
        if (row.sid === null || row.live !== 1 || (row.text === null && row.transcript === null) || row.embeddedHash === hash) {
          done.push(row.id);
          continue;
        }
        if (items.length === limit) {
          this.dequeueIds(done);
          return { items, hasMore: true, nextBefore: items[items.length - 1]!.id };
        }
        items.push({ id: row.id, sid: row.sid, type: row.type, ts: row.ts, text: row.text, transcript: row.transcript, contentHash: hash! });
      }
      this.dequeueIds(done);
      const hasMore = rows.length === cap;
      return { items, hasMore, nextBefore: hasMore ? rows[rows.length - 1]!.id : null };
    });
  }

  /** Takes messages off the queue for good, until their words change: nothing to embed, or words the server refuses. */
  dequeue(ids: readonly number[]): void {
    if (ids.length === 0) return;
    this.c.write(() => this.dequeueIds(ids));
  }

  /** Messages queued and not yet looked at; the refill still owed is not counted. */
  queueSize(): number {
    return this.c.get<{ n: number }>("SELECT count(*) AS n FROM embed_queue")?.n ?? 0;
  }

  private dequeueIds(ids: readonly number[]): void {
    if (ids.length === 0) return;
    this.c.run("DELETE FROM embed_queue WHERE message_id IN (SELECT value FROM json_each(?))", JSON.stringify(ids));
  }

  private meta(key: string): string | null {
    return this.c.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
  }

  private setMeta(key: string, value: string | null): void {
    if (value === null) this.c.run("DELETE FROM meta WHERE key = ?", key);
    else this.c.run("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", key, value);
  }

  /** Brute-force cosine over the filtered rows; the best `limit` above the floor, hydrated. */
  vectorSearch(input: VectorSearchInput): VectorHit[] {
    const limit = Math.max(1, Math.floor(input.limit));
    const filter = this.search.resolveFilter(input);
    if (filter === null) return [];
    const ranked = this.rank(filter, input.model, unitVector(input.vector), limit, input.minSimilarity ?? 0, input.recencyHalfLifeMs);
    const messages = new Map(this.messages.byIds(ranked.map((hit) => hit.id)).map((message) => [message.id, message]));
    return ranked
      .flatMap((hit) => {
        const message = messages.get(hit.id);
        return message === undefined ? [] : [{ message, similarity: hit.similarity, score: hit.score }];
      })
      .slice(0, limit);
  }

  private rank(
    filter: ResolvedFilter,
    model: string,
    unit: Float64Array,
    limit: number,
    floor: number,
    halfLifeMs: number | undefined
  ): Array<{ id: number; similarity: number; score: number }> {
    const now = this.c.now();
    const top = new TopK(limit);
    const similarities = new Map<number, number>();
    // A scan of embeddings alone cannot see a clear barrier whose purge has not
    // run yet; while one is pending, the scan goes through messages and chats.
    const joined = filter.narrowsRows || this.messages.purgePending();
    const rows = this.scanRows(filter, model, joined);
    // Rows in the boundary seconds of since/until need their exact millisecond checked.
    const edgeLow = filter.since === undefined ? null : secondOf(filter.since);
    const edgeHigh = filter.until === undefined ? null : secondOf(filter.until);
    for (const row of rows) {
      const id = row[0] as number;
      const bytes = row[1] as Uint8Array;
      if (bytes.byteLength !== unit.length) continue;
      const similarity = int8Similarity(unit, new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      if (similarity <= 0 || similarity < floor) continue;
      const age = now - secondOfId(id) * 1000;
      const score = halfLifeMs === undefined ? similarity : similarity * Math.pow(0.5, Math.max(0, age) / halfLifeMs);
      if (score <= top.floor) continue;
      if (!joined && (secondOfId(id) === edgeLow || secondOfId(id) === edgeHigh) && !this.inTimeRange(id, filter)) continue;
      top.push(score, id);
      similarities.set(id, similarity);
    }
    const expired = joined ? null : this.expiredIds(now);
    return top
      .sorted()
      .filter((hit) => expired === null || !expired.has(hit.id))
      .map((hit) => ({ id: hit.id, similarity: similarities.get(hit.id)!, score: hit.score }));
  }

  /**
   * The rows to score, as [id, vec] arrays. With only a time range the scan
   * reads embeddings alone — tombstones carry no embedding, and ids are
   * chronological — and expired rows are dropped afterwards; chat or sender
   * filters drive the scan from the messages index instead.
   */
  private scanRows(filter: ResolvedFilter, model: string, joined: boolean): Iterable<unknown[]> {
    if (!joined) {
      return this.c
        .arrayStmt("SELECT message_id, vec FROM embeddings WHERE model = ? AND message_id >= ? AND message_id < ?")
        .iterate(model, filter.lower, filter.upper) as Iterable<unknown[]>;
    }
    const params: SQLInputValue[] = [model, filter.lower, filter.upper, ...filter.params];
    return this.c
      .arrayStmt(
        `SELECT e.message_id, e.vec FROM messages m CROSS JOIN chats c ON c.id = m.chat_id CROSS JOIN embeddings e ON e.message_id = m.id
         WHERE e.model = ? AND m.id >= ? AND m.id < ? AND ${filter.where}`
      )
      .iterate(...params) as Iterable<unknown[]>;
  }

  private inTimeRange(id: number, filter: ResolvedFilter): boolean {
    const row = this.c.get<{ ts: number }>("SELECT ts FROM messages WHERE id = ?", id);
    if (row === undefined) return false;
    return (filter.since === undefined || row.ts >= filter.since) && (filter.until === undefined || row.ts <= filter.until);
  }

  /** Messages past their deadline the sweep has not reached yet; normally none. */
  private expiredIds(now: number): Set<number> {
    return new Set(
      this.c
        .all<{ id: number }>(
          `SELECT id FROM messages INDEXED BY messages_expiry
           WHERE expires_at IS NOT NULL AND deleted_at IS NULL AND expires_at <= ?`,
          now
        )
        .map((row) => row.id)
    );
  }

  /**
   * Substring words and meaning in one call. The lexical side looks each
   * query word up in the trigram index and ranks the newest candidates by how
   * many words they carry; the semantic side ranks by cosine. Reciprocal Rank
   * Fusion merges the two. A hit only the semantic side found must clear
   * `minSimilarity`, so a question with no answer comes back empty.
   */
  hybrid(input: HybridSearchInput): HybridResult {
    const limit = Math.max(1, Math.floor(input.limit));
    const filter = this.search.resolveFilter(input);
    const semantic = input.vector !== undefined && input.vector !== null;
    if (filter === null) return { hits: [], semantic, lexicalCapped: false };

    const lexical = this.lexicalCandidates(input.query, filter, input.lexicalCandidates ?? DEFAULT_CANDIDATES, input.scanCap);
    const semanticRanked = semantic
      ? this.rank(filter, input.model, unitVector(input.vector!), input.semanticCandidates ?? DEFAULT_CANDIDATES, 0, undefined)
      : [];

    const fused = new Map<number, { score: number; lexicalRank: number | null; semanticRank: number | null; similarity: number | null }>();
    lexical.ids.forEach((id, index) => {
      fused.set(id, { score: 1 / (RRF_K + index + 1), lexicalRank: index + 1, semanticRank: null, similarity: null });
    });
    semanticRanked.forEach((hit, index) => {
      const entry = fused.get(hit.id);
      const contribution = 1 / (RRF_K + index + 1);
      if (entry !== undefined) {
        entry.score += contribution;
        entry.semanticRank = index + 1;
        entry.similarity = hit.similarity;
      } else if (hit.similarity >= input.minSimilarity) {
        fused.set(hit.id, { score: contribution, lexicalRank: null, semanticRank: index + 1, similarity: hit.similarity });
      }
    });
    const best = [...fused.entries()].sort((a, b) => b[1].score - a[1].score || b[0] - a[0]).slice(0, limit);
    const messages = new Map(this.messages.byIds(best.map(([id]) => id)).map((message) => [message.id, message]));
    const hits = best.flatMap(([id, entry]) => {
      const message = messages.get(id);
      return message === undefined ? [] : [{ message, ...entry }];
    });
    return { hits, semantic, lexicalCapped: lexical.capped };
  }

  /**
   * The lexical side of hybrid search. Each query word brings its own newest
   * `want` matches, so a rare word's old match is not crowded out by newer
   * messages sharing only a common word; the messages carrying every index word
   * are one more source, so an old message made only of common words is found
   * too; digits and acronyms under three characters go through the bounded
   * short-query scan. Candidates are scored by the words they carry, each
   * weighted by its rarity among the matches seen, plus a bonus when the whole
   * query appears verbatim; ties go to the newest. `capped` says some source had
   * more matches than were examined.
   */
  private lexicalCandidates(query: string, filter: ResolvedFilter, want: number, scanCap: number | undefined): { ids: number[]; capped: boolean } {
    const { trigram, short } = hybridWords(query);
    const tokens = [...trigram, ...short];
    if (tokens.length === 0) return { ids: [], capped: false };
    const perWordCap = Math.max(1, Math.floor((scanCap ?? DEFAULT_TRIGRAM_CAP) / (trigram.length + 1)));
    const perShortCap = Math.max(1, Math.floor(Math.min(scanCap ?? DEFAULT_SCAN_CAP, DEFAULT_SCAN_CAP) / Math.max(1, short.length)));
    const candidates = new Set<number>();
    const weights = new Map<string, number>();
    let capped = false;
    const take = (found: { ids: number[]; cappedAt: number | null }): number => {
      if (found.ids.length > want || found.cappedAt !== null) capped = true;
      for (const id of found.ids.slice(0, want)) candidates.add(id);
      return found.ids.length;
    };
    for (const token of trigram) {
      weights.set(token, 1 / Math.log2(2 + take(this.search.trigramIds(token, filter, filter.upper, want + 1, perWordCap))));
    }
    for (const token of short) {
      weights.set(token, 1 / Math.log2(2 + take(this.search.scanIds(token, filter, filter.upper, want + 1, perShortCap))));
    }
    if (trigram.length > 1) {
      const everyWord = trigram.map(ftsPhrase).join(" AND ");
      take(this.search.trigramIds(query, filter, filter.upper, want + 1, perWordCap, everyWord));
    }
    if (candidates.size === 0) return { ids: [], capped };
    const phrase = foldText(query).replace(/\s+/g, " ").trim();
    const scores = new Map<number, number>();
    for (const row of this.c.all<{ id: number; text: string | null; transcript: string | null }>(
      "SELECT id, text, transcript FROM messages WHERE id IN (SELECT value FROM json_each(?))",
      JSON.stringify([...candidates])
    )) {
      const haystack = foldText(`${row.text ?? ""}\n${row.transcript ?? ""}`);
      let score = 0;
      for (const token of tokens) if (haystack.includes(token)) score += weights.get(token)!;
      if (tokens.length > 1 && haystack.replace(/\s+/g, " ").includes(phrase)) score += 1;
      scores.set(row.id, score);
    }
    const ids = [...candidates].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || b - a).slice(0, want);
    return { ids, capped };
  }
}
