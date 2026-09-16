/**
 * The living-memory index for one account: an append-only meta log, a flat
 * int8 vector file and a small state file, under accounts/<id>/recall/.
 *
 *   meta.jsonl   {"op":"put", sid, jid, ts, sender, text, model, row}
 *                {"op":"del", sid}
 *   vectors.bin  `row` indexes fixed-stride records, `dims` int8 each. A put's
 *                vector is L2-normalized before quantization, so cosine
 *                similarity is a plain dot product / 127.
 *   state.json   {version, model, dims, quant, offsets: {<history file>: bytes}}
 *
 * Nothing here is read through RAM caches of WhatsApp's own store: replaying
 * meta.jsonl is how the index learns what it holds, so a crash mid-write can
 * only lose the tail, and the per-file byte offsets are what boot
 * reconciliation walks forward from.
 */
import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { WazapError } from "../errors.js";
import type { EmbedModelSpec } from "./models.js";
import type { RankedHit, RecallItem, RecallQuery, RecallRecord } from "./types.js";

/** viewText can run long; a bounded text keeps meta.jsonl honest on big histories. */
export const TEXT_CAP = 2048;
/** Rewrite meta+vectors when more than this share of rows is dead. */
const COMPACT_DEAD_RATIO = 0.3;
/** v3: rows may carry a message expiry. A v2 row simply has none, so v2 migrates in place. */
const STATE_VERSION = 3;
const MIGRATES_FROM = 2;
const QUANT = "int8";
/** The index holds message text; it gets history's permissions, not the defaults. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** Owner call: fresh matches rank first. 0.5^(age/half-life) scales similarity. */
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
/** A literal query token shorter than this is too common to name anything. */
const MIN_TOKEN_LEN = 4;
/** What one matched rare token adds, before its document frequency scales it down. */
const TOKEN_BOOST = 0.02;
/** All token bonuses together may add at most this — a neighbour reorder, never a rescue. */
const TOKEN_BOOST_MAX = 0.05;
/** Reranking costs a text pass per candidate; only the top of the list gets it. */
const RERANK_WINDOW = 100;
/** One chat holds at most this many leading slots; further hits yield to other chats first. */
const CHAT_SLOT_CAP = 3;
/** Word overlap at or above this marks a candidate a near-duplicate of a picked hit. */
const NEAR_DUP_JACCARD = 0.8;

interface MetaPut extends RecallItem {
  op: "put";
  model: string;
  row: number;
}

interface MetaDel {
  op: "del";
  sid: string;
}

type MetaLine = MetaPut | MetaDel;

interface RecallState {
  version: number;
  model: string;
  dims: number;
  quant: string;
  /** history/<file>.jsonl → bytes already indexed. */
  offsets: Record<string, number>;
}

function normalize(vector: number[]): number[] {
  let norm = 0;
  for (const x of vector) norm += x * x;
  if (norm === 0) throw new WazapError("RECALL_FAILED", "embedding server returned a zero vector");
  const inv = 1 / Math.sqrt(norm);
  return vector.map((x) => x * inv);
}

function quantize(vector: number[], dims: number): Int8Array {
  if (vector.length !== dims) {
    throw new WazapError(
      "RECALL_FAILED",
      `embedding has ${vector.length} dimensions, the index expects ${dims}`
    );
  }
  const out = new Int8Array(dims);
  const unit = normalize(vector);
  for (let i = 0; i < dims; i++) {
    out[i] = Math.round(Math.max(-1, Math.min(1, unit[i]!)) * 127);
  }
  return out;
}

function recencyDecay(ageMs: number): number {
  return Math.pow(0.5, Math.max(0, ageMs) / RECENCY_HALF_LIFE_MS);
}

/** Case- and diacritic-insensitive fold, so "Cata" and "cată" are one token. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

interface TextProfile {
  /** Folded, whitespace-collapsed text — the exact-duplicate key. */
  norm: string;
  /** Every folded word; the near-duplicate overlap check. */
  words: Set<string>;
  /**
   * Folded word runs of ≥4 chars, plus whitespace chunks of ≥4 once inner
   * punctuation is stripped — "17:30" and "1730" land on the same token.
   * Membership only: "cata" never matches "catalin".
   */
  literals: Set<string>;
}

function textProfile(text: string): TextProfile {
  const folded = fold(text);
  const words = new Set<string>();
  const literals = new Set<string>();
  for (const match of folded.matchAll(/[\p{L}\p{N}]+/gu)) {
    words.add(match[0]);
    if (match[0].length >= MIN_TOKEN_LEN) literals.add(match[0]);
  }
  for (const chunk of folded.split(/\s+/)) {
    const compact = chunk.replace(/[^\p{L}\p{N}]+/gu, "");
    if (compact.length >= MIN_TOKEN_LEN) literals.add(compact);
  }
  return { norm: folded.replace(/\s+/g, " ").trim(), words, literals };
}

/** Word Jaccard — two texts sharing most of their words are one answer. */
function nearDuplicate(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared) >= NEAR_DUP_JACCARD;
}

export class RecallStore {
  private live = new Map<string, RecallRecord>();
  /** Rows in append order; the head is the eviction frontier. */
  private order: number[] = [];
  /** sid → rows it has occupied, newest last; stale entries are dead rows. */
  private bySid = new Map<string, number[]>();
  private vectors = new Int8Array(0);
  private nextRow = 0;
  private deadRows = 0;
  private state: RecallState;
  private metaFH: FileHandle | null = null;
  private vecFH: FileHandle | null = null;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly dir: string,
    private readonly spec: EmbedModelSpec,
    private readonly maxRows: number
  ) {
    this.state = {
      version: STATE_VERSION,
      model: spec.alias,
      dims: spec.dims,
      quant: QUANT,
      offsets: {},
    };
  }

  private get metaPath(): string {
    return join(this.dir, "meta.jsonl");
  }
  private get vectorsPath(): string {
    return join(this.dir, "vectors.bin");
  }
  private get statePath(): string {
    return join(this.dir, "state.json");
  }

  /**
   * Load or create the index. A state file that names another model or
   * geometry, or files that cannot be replayed, mean the index belongs to a
   * different world: it is wiped and backfill rebuilds it from history. A v2
   * index is the same world without expiries and is kept: rebuilding it would
   * re-embed every message and lose rows whose history is gone. Under
   * WAZAP_RETENTION, deadlines found in history still expire migrated rows.
   */
  static async open(dir: string, spec: EmbedModelSpec, maxRows: number): Promise<RecallStore> {
    const store = new RecallStore(dir, spec, maxRows);
    await Promise.all([store.metaPath, store.vectorsPath, store.statePath].map((path) => rm(`${path}.tmp`, { force: true })));
    let state: RecallState;
    let metaText: string;
    let vectorBytes: Buffer;
    try {
      [state, metaText, vectorBytes] = await Promise.all([
        readFile(store.statePath, "utf8").then((raw) => JSON.parse(raw) as RecallState),
        readFile(store.metaPath, "utf8"),
        readFile(store.vectorsPath),
      ]);
    } catch {
      // A partial index is not an empty append target: old text/vector bytes
      // must not survive or become mismatched with rows numbered from zero.
      await store.wipe();
      return store;
    }
    const migrating = state.version === MIGRATES_FROM;
    if ((state.version !== STATE_VERSION && !migrating) || state.model !== spec.alias || state.dims !== spec.dims || state.quant !== QUANT) {
      await store.wipe();
      return store;
    }
    store.state = { ...state, version: STATE_VERSION };
    const rows = Math.floor(vectorBytes.length / spec.dims);
    const vectors = new Int8Array(vectorBytes.subarray(0, rows * spec.dims));
    try {
      store.replay(metaText, rows);
    } catch {
      await store.wipe();
      return store;
    }
    store.vectors = vectors;
    if (migrating) await store.writeState();
    if (store.deadRows > store.nextRow * COMPACT_DEAD_RATIO && store.deadRows > 0) {
      await store.compact();
    }
    return store;
  }

  /** Rebuild the in-RAM view from the log; throws when meta references missing rows. */
  private replay(metaText: string, vectorRows: number): void {
    for (const line of metaText.split("\n")) {
      if (line.trim() === "") continue;
      const entry = JSON.parse(line) as MetaLine;
      if (entry.op === "del") {
        this.removeLive(entry.sid);
        continue;
      }
      if (entry.op !== "put" || entry.row >= vectorRows || entry.model !== this.spec.alias) {
        throw new WazapError("RECALL_FAILED", "meta.jsonl does not match vectors.bin");
      }
      if (entry.expiresAt !== undefined && (!Number.isSafeInteger(entry.expiresAt) || entry.expiresAt < 0)) {
        throw new WazapError("RECALL_FAILED", "Invalid message expiry in recall index.");
      }
      const record: RecallRecord = {
        ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
        sid: entry.sid,
        jid: entry.jid,
        ts: entry.ts,
        sender: entry.sender,
        type: entry.type,
        text: entry.text,
        row: entry.row,
      };
      this.putLive(record);
      this.nextRow = Math.max(this.nextRow, entry.row + 1);
    }
  }

  private putLive(record: RecallRecord): void {
    this.removeLive(record.sid);
    this.live.set(record.sid, record);
    this.order.push(record.row);
    const rows = this.bySid.get(record.sid) ?? [];
    rows.push(record.row);
    this.bySid.set(record.sid, rows);
  }

  /** Drop a sid's live records and count their rows dead; used by replay and writes. */
  private removeLive(sid: string): void {
    const rows = this.bySid.get(sid);
    if (rows === undefined) return;
    this.deadRows += rows.length;
    this.bySid.delete(sid);
    this.live.delete(sid);
  }

  /** Only the derived index's owned files, including interrupted rewrite stages. */
  static async clearFiles(dir: string): Promise<void> {
    await Promise.all(["meta.jsonl", "vectors.bin", "state.json"].flatMap((name) =>
      [name, `${name}.tmp`].map((file) => rm(join(dir, file), { force: true }))));
  }

  private async wipe(): Promise<void> {
    await this.closeHandles();
    await RecallStore.clearFiles(this.dir);
    this.live.clear();
    this.order = [];
    this.bySid.clear();
    this.vectors = new Int8Array(0);
    this.nextRow = 0;
    this.deadRows = 0;
    this.state.offsets = {};
  }

  /** The serialized write path: appends, evictions and compaction never overlap. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work, work);
    this.writes = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async handles(): Promise<{ meta: FileHandle; vec: FileHandle }> {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    this.metaFH ??= await open(this.metaPath, "a", FILE_MODE);
    this.vecFH ??= await open(this.vectorsPath, "a", FILE_MODE);
    return { meta: this.metaFH!, vec: this.vecFH! };
  }

  private async closeHandles(): Promise<void> {
    const { metaFH, vecFH } = this;
    this.metaFH = null;
    this.vecFH = null;
    await Promise.all([metaFH?.close().catch(() => {}), vecFH?.close().catch(() => {})]);
  }

  /**
   * Append items with their vectors. A sid already in the index leaves a
   * tombstone first — edits re-index under the same sid and the newest put
   * wins on replay. Offsets are the caller's job, advanced only after this
   * resolves.
   */
  add(items: RecallItem[], vectors: number[][]): Promise<void> {
    if (items.length !== vectors.length) {
      throw new WazapError("RECALL_FAILED", `add() got ${items.length} items and ${vectors.length} vectors`);
    }
    return this.enqueue(async () => {
      if (this.closed || items.length === 0) return;
      const { meta, vec } = await this.handles();
      const live = items.flatMap((item, i) => Date.now() < (item.expiresAt ?? Infinity) ? [{ item, vector: vectors[i]! }] : []);
      items = live.map(({ item }) => item);
      vectors = live.map(({ vector }) => vector);
      if (!items.length) return;
      const lines: string[] = [];
      const rows = new Int8Array(items.length * this.spec.dims);
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const row = this.nextRow++;
        if (this.bySid.has(item.sid)) lines.push(JSON.stringify({ op: "del", sid: item.sid } satisfies MetaDel));
        const put: MetaPut = {
          op: "put",
          sid: item.sid,
          jid: item.jid,
          ts: item.ts,
          sender: item.sender,
          type: item.type,
          text: item.text.slice(0, TEXT_CAP),
          ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
          model: this.spec.alias,
          row,
        };
        lines.push(JSON.stringify(put));
        // The temp buffer is laid out by batch index; on disk it lands as the
        // next `items.length` rows, which is exactly what `row` counts up to.
        rows.set(quantize(vectors[i]!, this.spec.dims), i * this.spec.dims);
        this.putLive({ ...item, text: put.text, row });
      }
      // RAM mirrors the file: grown first so a query between the two appends
      // can never read a row the vector file does not have yet.
      const grown = new Int8Array(this.nextRow * this.spec.dims);
      grown.set(this.vectors);
      grown.set(rows, this.vectors.length);
      this.vectors = grown;
      await vec!.appendFile(Buffer.from(rows.buffer, rows.byteOffset, rows.byteLength));
      await vec!.sync();
      await meta!.appendFile(lines.join("\n") + "\n", "utf8");
      await meta!.sync();
      await this.enforceCap();
      await this.maybeCompact();
    });
  }

  /** Tombstone sids — deleted or retracted messages must leave the index. */
  remove(sids: string[]): Promise<void> {
    return this.tombstone(sids);
  }

  /**
   * Tombstone every row filed under these chats: a cleared or deleted chat
   * leaves the index whole, rows the live store no longer holds included.
   */
  removeChats(jids: string[]): Promise<void> {
    const chats = new Set(jids);
    return this.tombstone(() => [...this.live.values()].filter((record) => chats.has(record.jid)).map((record) => record.sid));
  }

  /** Privacy cleanup also covers rows absent from the bounded live message store. */
  removeMatching(test: (record: RecallRecord) => boolean): Promise<void> {
    return this.tombstone(() => [...this.live.values()].filter(test).map((record) => record.sid));
  }

  private tombstone(sids: string[] | (() => string[])): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return;
      const hits = (typeof sids === "function" ? sids() : sids).filter((sid) => this.bySid.has(sid));
      if (hits.length === 0) {
        if (this.deadRows > 0) await this.compact();
        return;
      }
      const { meta } = await this.handles();
      for (const sid of hits) this.removeLive(sid);
      await meta!.appendFile(hits.map((sid) => JSON.stringify({ op: "del", sid } satisfies MetaDel)).join("\n") + "\n", "utf8");
      await meta!.sync();
      // Deletion is a privacy operation, not just a ranking tombstone. Rewrite
      // the old text and vector bytes even below the normal dead-row threshold.
      await this.compact();
    });
  }

  /** The oldest live records past maxRows leave a tombstone each. */
  private async enforceCap(): Promise<void> {
    const excess = this.live.size - this.maxRows;
    if (excess <= 0) return;
    const byRow = new Map<number, RecallRecord>();
    for (const record of this.live.values()) byRow.set(record.row, record);
    const evict: string[] = [];
    const kept: number[] = [];
    let remaining = excess;
    for (const row of this.order) {
      const record = byRow.get(row);
      if (record === undefined) continue; // Dead row refs leave the frontier here.
      if (remaining > 0) {
        evict.push(record.sid);
        remaining--;
      } else {
        kept.push(row);
      }
    }
    this.order = kept;
    if (evict.length === 0) return;
    const { meta } = await this.handles();
    for (const sid of evict) this.removeLive(sid);
    await meta!.appendFile(evict.map((sid) => JSON.stringify({ op: "del", sid } satisfies MetaDel)).join("\n") + "\n", "utf8");
    await meta!.sync();
  }

  /** Advance the indexed tail of one history file and persist the state. */
  advanceOffset(file: string, bytes: number): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return;
      this.state.offsets[file] = bytes;
      await this.writeState();
    });
  }

  private async writeState(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.state)}\n`, { mode: FILE_MODE });
    await rename(tmp, this.statePath);
  }

  offsets(): Readonly<Record<string, number>> {
    return this.state.offsets;
  }

  get count(): number {
    return this.live.size;
  }

  /** Deadline-only recovery also covers rows no longer present in bounded history. */
  expirations(): Array<{ sid: string; jid: string; at: number }> {
    return [...this.live.values()].flatMap((item) => item.expiresAt === undefined ? [] :
      [{ sid: item.sid, jid: item.jid, at: item.expiresAt }]);
  }

  record(sid: string): RecallRecord | undefined {
    return this.live.get(sid);
  }

  /**
   * Brute-force cosine over live rows, filtered the way search_messages
   * filters, then ranked by similarity × recency decay. Exact, zero-dep and
   * fast enough at living-memory sizes (50k × 768d int8). The floor applies
   * to raw similarity — rerank() then reorders the survivors, never rescues
   * what the floor dropped.
   */
  query(q: RecallQuery, nowMs = Date.now()): RankedHit[] {
    const unit = normalize(q.vector);
    const floor = q.minSimilarity ?? 0;
    const hits: RankedHit[] = [];
    for (const record of this.live.values()) {
      if (record.expiresAt !== undefined && nowMs >= record.expiresAt) continue;
      if (q.chatId !== undefined && record.jid !== q.chatId) continue;
      if (q.sinceMs !== undefined && record.ts < q.sinceMs) continue;
      if (q.untilMs !== undefined && record.ts > q.untilMs) continue;
      if (q.from !== undefined && record.sender !== q.from) continue;
      const offset = record.row * this.spec.dims;
      let dot = 0;
      for (let i = 0; i < this.spec.dims; i++) dot += unit[i]! * this.vectors[offset + i]!;
      const similarity = dot / 127;
      if (similarity <= 0 || similarity < floor) continue;
      hits.push({ record, similarity, score: similarity * recencyDecay(nowMs - record.ts) });
    }
    hits.sort((a, b) => b.score - a.score);
    return this.rerank(hits, q);
  }

  /**
   * The bounded reordering pass over the strongest candidates, run after the
   * similarity floor has already decided what counts as an answer.
   *
   * First, literal tokens: embeddings are weak on names and identifiers, so a
   * query token a hit carries verbatim earns a small bonus. A token's weight
   * fades with its document frequency in the candidate set — a token in every
   * candidate is common and adds nothing — and the total is capped, so the
   * bonus reorders near-equal scores and can never lift a weak hit over a
   * strong semantic one.
   *
   * Then diversity: a greedy walk picks in score order, but a near-duplicate
   * of a picked hit, or a hit from a chat that already holds CHAT_SLOT_CAP
   * slots, trails the list instead of filling it. Nothing is dropped and no
   * score is invented — demoted hits keep their score and sit behind the
   * picked ones, so a query scoped to a single chat comes back unchanged.
   */
  private rerank(sorted: RankedHit[], q: RecallQuery): RankedHit[] {
    // A raw caller may omit limit; then the window itself is the cap.
    const cap = Number.isFinite(q.limit) ? q.limit : sorted.length;
    const candidates = sorted.slice(0, Math.max(cap, RERANK_WINDOW)).map((hit) => ({ hit, ...textProfile(hit.record.text) }));
    if (candidates.length === 0) return [];

    const wanted = q.text === undefined ? new Set<string>() : textProfile(q.text).literals;
    if (wanted.size > 0) {
      const df = new Map<string, number>();
      for (const token of wanted) {
        let count = 0;
        for (const c of candidates) if (c.literals.has(token)) count++;
        if (count > 0 && count < candidates.length) df.set(token, count);
      }
      if (df.size > 0) {
        for (const c of candidates) {
          let bonus = 0;
          for (const [token, count] of df) {
            if (c.literals.has(token)) bonus += TOKEN_BOOST * (1 - count / candidates.length);
          }
          c.hit = { ...c.hit, score: c.hit.score + Math.min(TOKEN_BOOST_MAX, bonus) };
        }
        candidates.sort((a, b) => b.hit.score - a.hit.score);
      }
    }

    const picked: RankedHit[] = [];
    const overflow: RankedHit[] = [];
    const dups: RankedHit[] = [];
    const perChat = new Map<string, number>();
    const chosen: TextProfile[] = [];
    for (const c of candidates) {
      if (chosen.some((p) => p.norm === c.norm || nearDuplicate(p.words, c.words))) {
        dups.push(c.hit);
        continue;
      }
      const held = perChat.get(c.hit.record.jid) ?? 0;
      if (held >= CHAT_SLOT_CAP) {
        overflow.push(c.hit);
        continue;
      }
      perChat.set(c.hit.record.jid, held + 1);
      picked.push(c.hit);
      chosen.push(c);
    }
    return [...picked, ...overflow, ...dups].slice(0, cap);
  }

  private async maybeCompact(): Promise<void> {
    if (this.nextRow === 0 || this.deadRows <= this.nextRow * COMPACT_DEAD_RATIO) return;
    await this.compact();
  }

  /**
   * Rewrite both files keeping only live rows, in insertion order, and renumber
   * rows densely. Runs inside the write queue, so appends cannot interleave.
   */
  private async compact(): Promise<void> {
    await this.closeHandles();
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    const liveByRow = new Map<number, RecallRecord>();
    for (const record of this.live.values()) liveByRow.set(record.row, record);
    const lines: string[] = [];
    const keptVectors: number[] = [];
    const newOrder: number[] = [];
    this.bySid.clear();
    this.live.clear();
    let row = 0;
    for (const oldRow of this.order) {
      const record = liveByRow.get(oldRow);
      if (record === undefined) continue;
      const moved = { ...record, row };
      const put: MetaPut = { ...moved, op: "put", model: this.spec.alias };
      lines.push(JSON.stringify(put));
      keptVectors.push(oldRow);
      newOrder.push(row);
      this.live.set(moved.sid, moved);
      const rows = this.bySid.get(moved.sid) ?? [];
      rows.push(row);
      this.bySid.set(moved.sid, rows);
      row++;
    }
    const packed = new Int8Array(row * this.spec.dims);
    for (let i = 0; i < keptVectors.length; i++) {
      packed.set(
        this.vectors.subarray(keptVectors[i]! * this.spec.dims, (keptVectors[i]! + 1) * this.spec.dims),
        i * this.spec.dims
      );
    }
    const vecTmp = `${this.vectorsPath}.tmp`;
    const metaTmp = `${this.metaPath}.tmp`;
    await writeFile(vecTmp, Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength), {
      mode: FILE_MODE,
    });
    await writeFile(metaTmp, lines.join("\n") + (lines.length > 0 ? "\n" : ""), { mode: FILE_MODE });
    const fhs = await Promise.all([open(vecTmp, "r"), open(metaTmp, "r")]);
    try {
      await Promise.all([fhs[0].sync(), fhs[1].sync()]);
    } finally {
      await Promise.all([fhs[0].close(), fhs[1].close()]);
    }
    // vectors first: a crash between the renames leaves old meta (which names
    // rows past the new file) — replay throws and the index rebuilds — while
    // new meta over old vectors would silently pair wrong vectors to sids.
    await rename(vecTmp, this.vectorsPath);
    await rename(metaTmp, this.metaPath);
    this.vectors = packed;
    this.order = newOrder;
    this.nextRow = row;
    this.deadRows = 0;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writes.catch(() => {});
    await this.closeHandles();
  }
}
