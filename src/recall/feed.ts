/**
 * The embedding feed of one account: it walks the account database's backlog
 * — visible messages with words and no vector from the model — embeds them in
 * batches and stores each vector with the content hash of the words it was
 * made from, so a message edited or transcribed meanwhile is simply refused
 * and picked up again. Ingestion never waits on it and never sees it fail: a
 * sick backend is retried with backoff, and a dead one stops the feed and says
 * why.
 *
 * A walk goes from the newest message down. Once a walk has reached the
 * bottom, later walks stop at the newest id the previous one started from, so
 * a new message costs a short walk, not a scan of the history; a message
 * below that line whose vector went stale (an edit, a transcript) is named
 * with touch().
 */
import { setTimeout as sleep } from "node:timers/promises";
import { contentHash, type AccountDb, type StoredMessage } from "../db/index.js";
import { WazapError } from "../errors.js";
import { logError } from "../logger.js";

/** Texts per embedding request; llama.cpp pools them in one pass. */
const BATCH = 32;
/** And at most this many characters per request, a conservative token bound. */
const BATCH_CHARS = 8_192;
/** Rows the backlog examines per call before it hands back a cursor. */
const SCAN = 2_000;
const RETRY_INIT_MS = 500;
const RETRY_MAX_MS = 8_000;
/** Consecutive batch failures after which the feed is declared dead. */
const MAX_FAILURES = 5;
/** Stale messages named by touch() kept at once; past it the next full walk finds them. */
const TOUCHED_MAX = 1_000;

export interface EmbedFeedOptions {
  /** The open database, or null while it is not ready (preparing, stopped). */
  db: () => AccountDb | null;
  model: string;
  /**
   * The words the index embeds for a message, capped to the model's window,
   * or null when it carries nothing worth embedding (a placeholder, a reaction).
   */
  words: (message: StoredMessage) => string | null;
  embed: (texts: string[]) => Promise<number[][]>;
}

export class EmbedFeed {
  /** Why the feed stopped for good, or null while it runs. */
  dead: string | null = null;
  private draining: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  /** Ids at or below this were walked by a finished walk. */
  private watermark = 0;
  private readonly touched = new Set<string>();
  private failures = 0;
  private wake: (() => void) | null = null;
  /** Unembedded messages the current walk has in hand; what status reports as pending. */
  private inHand = 0;

  constructor(private readonly options: EmbedFeedOptions) {}

  /** True while a walk runs or is owed. */
  get busy(): boolean {
    return this.draining !== null;
  }

  get pending(): number {
    return this.inHand + this.touched.size;
  }

  /** New words somewhere above the watermark, or `full` for a walk from the top to the bottom. */
  kick(full = false): void {
    if (this.stopped || this.dead !== null) return;
    if (full) this.watermark = 0;
    if (this.draining !== null) {
      this.again = true;
      return;
    }
    this.draining = this.drain().finally(() => {
      this.draining = null;
      this.inHand = 0;
      if (this.again && !this.stopped && this.dead === null) {
        this.again = false;
        this.kick();
      }
    });
  }

  /** A message whose vector went stale below the watermark: an edit or a transcript. */
  touch(sid: string): void {
    if (this.stopped || this.dead !== null) return;
    if (this.touched.size < TOUCHED_MAX) this.touched.add(sid);
    else this.watermark = 0;
    this.kick();
  }

  /** Settles once nothing is left to embed or every attempt stopped. */
  async idle(): Promise<void> {
    while (this.draining !== null) await this.draining;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.idle();
  }

  private async drain(): Promise<void> {
    await this.drainTouched();
    const db = this.options.db();
    if (db === null || this.stopped) return;
    const top = db.messages.recent({ since: 0, limit: 1 }).items[0]?.id ?? 0;
    let before: number | undefined;
    for (;;) {
      const current = this.options.db();
      if (current === null || this.stopped || this.dead !== null) return;
      const page = current.vectors.backlog({ model: this.options.model, limit: BATCH, scanCap: SCAN, ...(before === undefined ? {} : { before }) });
      const floor = this.watermark;
      const items = page.items.filter((item) => item.id > floor);
      this.inHand = items.length;
      if (items.length > 0 && !(await this.embedItems(current, items))) return;
      const reachedFloor = page.nextBefore === null || page.nextBefore <= floor || items.length < page.items.length;
      if (!page.hasMore || reachedFloor) break;
      // A retry keeps its place: only a batch that landed moves the cursor down.
      before = page.nextBefore ?? undefined;
      await this.drainTouched();
    }
    this.watermark = Math.max(this.watermark, top);
  }

  private async drainTouched(): Promise<void> {
    while (this.touched.size > 0 && !this.stopped && this.dead === null) {
      const db = this.options.db();
      if (db === null) return;
      const sids = [...this.touched].slice(0, BATCH);
      const stale = sids.filter((sid) => db.vectors.get(sid)?.model !== this.options.model);
      if (stale.length > 0 && !(await this.embedItems(db, stale.map((sid) => ({ sid }))))) return;
      for (const sid of sids) this.touched.delete(sid);
    }
  }

  /** Embeds what has words and stores each vector; false when the feed stopped or died on the way. */
  private async embedItems(db: AccountDb, items: ReadonlyArray<{ sid: string }>): Promise<boolean> {
    const work: Array<{ message: StoredMessage; words: string }> = [];
    let chars = 0;
    for (const item of items) {
      const message = db.messages.get(item.sid);
      if (message === null) continue;
      const words = this.options.words(message);
      if (words === null) continue;
      if (work.length > 0 && chars + words.length > BATCH_CHARS) {
        if (!(await this.embedBatch(db, work.splice(0)))) return false;
        chars = 0;
      }
      work.push({ message, words });
      chars += words.length;
    }
    return work.length === 0 || this.embedBatch(db, work);
  }

  private async embedBatch(db: AccountDb, work: Array<{ message: StoredMessage; words: string }>): Promise<boolean> {
    for (;;) {
      if (this.stopped || this.dead !== null) return false;
      try {
        const vectors = await this.options.embed(work.map((entry) => entry.words));
        if (!db.isOpen || this.stopped) return false;
        work.forEach((entry, i) => {
          const vector = vectors[i];
          if (vector === undefined) return;
          const { message } = entry;
          // Refused when the message was deleted, expired, edited or transcribed meanwhile.
          db.vectors.put(message.sid, this.options.model, vector, contentHash(message.text, message.transcript));
        });
        this.failures = 0;
        return true;
      } catch (err) {
        if (this.stopped || !db.isOpen) return false;
        this.failures++;
        if (this.failures >= MAX_FAILURES) {
          this.dead = `indexing stopped after ${MAX_FAILURES} failed embedding calls: ${describeError(err)}`;
          logError("recall index", err);
          return false;
        }
        const delay = Math.min(RETRY_MAX_MS, RETRY_INIT_MS * 2 ** (this.failures - 1));
        // A referenced sleep, so a waiting caller keeps the process alive; stop() wakes it.
        await Promise.race([
          sleep(delay),
          new Promise<void>((resolve) => {
            this.wake = resolve;
          }),
        ]);
        this.wake = null;
      }
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof WazapError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
