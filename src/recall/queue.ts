/**
 * Single-flight FIFO that turns messages into index writes. Ingestion must
 * never wait on the index and must never see it fail: feed() returns at once,
 * a sick backend makes the queue retry rather than drop, and a dead one stops
 * the queue — the messages stay safe because history offsets only ever
 * advance behind writes that committed.
 *
 * One drain at a time collects up to BATCH texts into a single embedding
 * call. Tombstones travel the same queue so a delete can never be overtaken
 * by the put it deletes; inside one batch the last op per sid wins.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { WazapError } from "../errors.js";
import { logError } from "../logger.js";
import type { RecallStore } from "./store.js";
import type { RecallItem } from "./types.js";

/** Texts per embedding request; llama.cpp pools them in one pass. */
const BATCH = 32;
/**
 * And at most this many characters per request — a conservative token bound
 * (≤1 token/char) that keeps one call inside the sidecar's physical batch.
 */
const BATCH_CHARS = 8_192;
const RETRY_INIT_MS = 500;
const RETRY_MAX_MS = 8_000;
/** Consecutive batch failures after which indexing is declared dead. */
const MAX_FAILURES = 5;

/** One queue entry: an index write when `item` is set, a whole chat's tombstone when `chats` is, a tombstone otherwise. */
export interface RecallOp {
  sid: string;
  item?: RecallItem;
  /** The jids of a cleared or deleted chat; `sid` is then only the queue key. */
  chats?: string[];
}

/**
 * "Everything enqueued so far has been committed" is the only thing a seal
 * may ever mean, so one is just the file's byte size at read time plus the
 * enqueue sequence it waits behind.
 */
interface Seal {
  file: string;
  bytes: number;
  mark: number;
}

export class RecallQueue {
  /** Insertion-ordered; a re-enqueued sid moves to the back so last write wins. */
  private readonly pending = new Map<string, { seq: number; op: RecallOp }>();
  private readonly seals = new Map<string, Seal>();
  private seq = 0;
  /** Highest sequence committed to the index; seals compare against this. */
  private committed = 0;
  private draining = false;
  private stopped = false;
  private failures = 0;
  /** Wakes a retry sleep early so stop() is not held by the backoff. */
  private stopNow: (() => void) | null = null;
  /** Set once the queue gives up: the index is behind and stays behind. */
  private deadReason: string | null = null;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly store: RecallStore,
    private readonly embed: (texts: string[]) => Promise<number[][]>,
    /** Test seam: shorter retries so a dead engine fails fast. */
    private readonly retry: { attempts?: number; baseMs?: number; maxMs?: number } = {}
  ) {}

  get size(): number {
    return this.pending.size;
  }

  get dead(): string | null {
    return this.deadReason;
  }

  /** The op a sid is queued with, for skip-if-unchanged diffs at feed time. */
  queued(sid: string): RecallOp | undefined {
    return this.pending.get(sid)?.op;
  }

  enqueue(op: RecallOp): void {
    if (this.stopped || this.deadReason !== null) return;
    this.pending.delete(op.sid);
    this.pending.set(op.sid, { seq: ++this.seq, op });
    void this.drain();
  }

  /**
   * A chat cleared or deleted. Puts still waiting for it are older than that,
   * so they go now; one entry then tombstones every row the index holds for
   * it, in its turn, and a put queued after it still lands.
   */
  forgetChats(jids: string[]): void {
    if (this.stopped || this.deadReason !== null || jids.length === 0) return;
    const chats = new Set(jids);
    for (const [key, entry] of this.pending) {
      if (entry.op.item !== undefined && chats.has(entry.op.item.jid)) this.pending.delete(key);
    }
    this.enqueue({ sid: `chats:${jids.join(",")}`, chats: jids });
  }

  /**
   * Ops read out of one history file, plus the file's byte size at read time.
   * The offset in state.json moves to `bytes` once every op enqueued so far —
   * these and anything still queued from before — is durably in the index.
   */
  feed(ops: RecallOp[], seal?: { file: string; bytes: number }): void {
    if (this.stopped || this.deadReason !== null) return;
    for (const op of ops) {
      this.pending.delete(op.sid);
      this.pending.set(op.sid, { seq: ++this.seq, op });
    }
    if (seal !== undefined) this.seals.set(seal.file, { ...seal, mark: this.seq });
    void this.drain();
  }

  /** Resolves when nothing is queued or in flight — also on stop or death. */
  idle(): Promise<void> {
    if (this.settled()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** The service is going away: in-flight work finishes, the rest is dropped. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopNow?.();
    await this.idle();
  }

  private settled(): boolean {
    return !this.draining && (this.pending.size === 0 || this.stopped || this.deadReason !== null);
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.size > 0 && !this.stopped && this.deadReason === null) {
        const batch: [string, { seq: number; op: RecallOp }][] = [];
        let chars = 0;
        for (const entry of this.pending) {
          const len = entry[1].op.item?.text.length ?? 0;
          if (batch.length >= BATCH || (batch.length > 0 && chars + len > BATCH_CHARS)) break;
          batch.push(entry);
          chars += len;
        }
        for (const [sid] of batch) this.pending.delete(sid);
        try {
          await this.commit(batch.map(([, entry]) => entry.op));
        } catch (err) {
          // The batch goes back ahead of everything else so order survives —
          // except a sid re-enqueued while the batch was in flight, whose newer
          // entry is already pending and must not be overtaken by the stale one.
          const rest = [...this.pending.entries()];
          const requeued = new Set(rest.map(([sid]) => sid));
          this.pending.clear();
          for (const [sid, entry] of batch) if (!requeued.has(sid)) this.pending.set(sid, entry);
          for (const [sid, entry] of rest) this.pending.set(sid, entry);
          this.failures++;
          if (this.failures >= (this.retry.attempts ?? MAX_FAILURES)) {
            this.deadReason = err instanceof Error ? err.message : String(err);
            logError("recall index", err);
            this.pending.clear();
            break;
          }
          const wait = Math.min(
            (this.retry.baseMs ?? RETRY_INIT_MS) * 2 ** (this.failures - 1),
            this.retry.maxMs ?? RETRY_MAX_MS
          );
          await Promise.race([sleep(wait), new Promise<void>((resolve) => (this.stopNow = resolve))]);
          this.stopNow = null;
          continue;
        }
        for (const [, entry] of batch) this.committed = entry.seq;
        this.failures = 0;
        // A seal that fails to land stays queued and retries on the next feed.
        await this.applySeals().catch((err: unknown) => logError("recall index seal", err));
      }
      // A seal that arrived behind an empty queue has nothing to wait for and
      // still owes the file its offset.
      if (!this.stopped && this.deadReason === null)
        await this.applySeals().catch((err: unknown) => logError("recall index seal", err));
    } finally {
      this.draining = false;
      if (this.settled()) this.wake();
    }
  }

  /** One batch's puts share an embedding call; tombstones cost no vectors. */
  private async commit(ops: RecallOp[]): Promise<void> {
    // Chats first: a put in the same batch was queued after the chat was forgotten.
    const chats = ops.flatMap((op) => op.chats ?? []);
    const dels = ops.filter((op) => op.item === undefined && op.chats === undefined).map((op) => op.sid);
    const puts = ops.flatMap((op) => (op.item === undefined ? [] : [op.item]));
    if (chats.length > 0) await this.store.removeChats(chats);
    if (dels.length > 0) await this.store.remove(dels);
    await this.commitPuts(puts);
  }

  /**
   * A 4xx from the embed server names the input, not the backend — one text
   * over the model's context window fails the whole request and would retry
   * forever. The batch is bisected until only the bad text is left, and that
   * single message is dropped: the index loses one unembeddable entry rather
   * than dying behind a poison pill that every restart would re-feed.
   */
  private async commitPuts(puts: RecallItem[]): Promise<void> {
    if (puts.length === 0) return;
    try {
      const vectors = await this.embed(puts.map((item) => item.text));
      await this.store.add(puts, vectors);
    } catch (err) {
      if (!(err instanceof WazapError && err.code === "RECALL_BAD_INPUT")) throw err;
      if (puts.length === 1) {
        logError(`recall index: dropping unembeddable message ${puts[0].sid}`, err);
        return;
      }
      const mid = Math.ceil(puts.length / 2);
      await this.commitPuts(puts.slice(0, mid));
      await this.commitPuts(puts.slice(mid));
    }
  }

  private async applySeals(): Promise<void> {
    for (const [file, seal] of this.seals) {
      if (seal.mark > this.committed) continue;
      await this.store.advanceOffset(file, seal.bytes);
      this.seals.delete(file);
    }
  }
}
