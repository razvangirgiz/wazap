/**
 * The embedding feed of one account: it walks the account database's
 * embedding queue — messages stored with words, or whose words changed, since
 * the feed last looked — embeds them in batches and stores each vector with
 * the content hash of the words it was made from, so a message edited or
 * transcribed meanwhile is simply refused and queued again. Ingestion never
 * waits on it and never sees it fail: a sick backend is retried with backoff;
 * after a few failures in a row the feed pauses, says why, keeps the whole
 * queue, and tries again later on its own or on the next message.
 *
 * The queue lives in the database, so a restart resumes it instead of walking
 * the history again, and a message stored below the newest one (a history
 * batch, an older page) is queued like any other. The first time a model is
 * fed, a refill queues the messages already stored, in bounded steps whose
 * place survives a restart. The feed yields to the event loop between steps
 * and pages. A text the embedding server refuses as input (400, 413, 422) is
 * bisected out of its batch and taken off the queue, so it is not sent again
 * until its words change — but only once another text of the same attempt was
 * embedded: a server that refuses everything is failing, not reading bad input,
 * and nothing leaves the queue for it.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { contentHash, type AccountDb, type BacklogItem, type StoredMessage } from "../db/index.js";
import { WazapError } from "../errors.js";
import { logError } from "../logger.js";

/** Texts per embedding request; llama.cpp pools them in one pass. */
const BATCH = 32;
/** And at most this many characters per request, a conservative token bound. */
const BATCH_CHARS = 8_192;
/** Queue rows one page looks at. */
const SCAN = 2_000;
/** Stored messages one refill step looks at: a few milliseconds of the event loop, even with a cold page cache. */
const REFILL_STEP = 500;
const RETRY_INIT_MS = 500;
const RETRY_MAX_MS = 8_000;
/** Consecutive batch failures after which the feed pauses until a later retry. */
const MAX_FAILURES = 5;
/** The first retry after a pause, doubling up to the second. */
const RETRY_LATER_MS = 60_000;
const RETRY_LATER_MAX_MS = 15 * 60_000;

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
  /** Backoff timings; tests shorten them. */
  retry?: { initMs?: number; maxMs?: number; laterMs?: number; laterMaxMs?: number };
}

interface Work {
  message: StoredMessage;
  words: string;
}

/** Every text of an attempt was refused: the server is failing, whatever status it chose. */
class RefusedAll extends Error {
  constructor(refusal: unknown) {
    super(`the embedding server refused every text it was sent: ${describeError(refusal)}`);
  }
}

export class EmbedFeed {
  /** Why embedding is paused right now, or null while it works; cleared by the next success. */
  failing: string | null = null;
  private draining: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private failures = 0;
  /** Embedding calls that landed; how a refused text is told from a refusing server. */
  private successes = 0;
  private pauses = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly options: EmbedFeedOptions) {}

  /** True while a walk runs or is owed. */
  get busy(): boolean {
    return this.draining !== null;
  }

  /** Messages queued and not yet embedded or skipped. */
  get pending(): number {
    const db = this.options.db();
    if (db === null) return 0;
    try {
      return db.vectors.queueSize();
    } catch {
      return 0;
    }
  }

  /**
   * Something may have been queued: walk the queue, now or right after the
   * walk under way. A paused feed tries once more at once, without the backoff
   * of a fresh failure: a new message is as good a moment as the retry timer.
   */
  kick(): void {
    if (this.stopped) return;
    if (this.draining !== null) {
      this.again = true;
      return;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.draining = this.drain()
      .catch((err: unknown) => logError("recall index", err))
      .finally(() => {
        this.draining = null;
        if (this.again && !this.stopped) {
          this.again = false;
          this.kick();
        }
      });
  }

  /** Settles once nothing is left to embed or every attempt stopped. */
  async idle(): Promise<void> {
    while (this.draining !== null) await this.draining;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.wake?.();
    await this.idle();
  }

  private current(): AccountDb | null {
    if (this.stopped) return null;
    const db = this.options.db();
    return db !== null && db.isOpen ? db : null;
  }

  private async drain(): Promise<void> {
    let db = this.current();
    if (db === null) return;
    let refilling = db.vectors.feed(this.options.model).refilling;
    while (refilling) {
      await turn();
      db = this.current();
      if (db === null) return;
      refilling = db.vectors.refill(REFILL_STEP);
    }
    let before: number | undefined;
    for (;;) {
      await turn();
      db = this.current();
      if (db === null) return;
      const page = db.vectors.queued({ model: this.options.model, limit: BATCH, scanCap: SCAN, ...(before === undefined ? {} : { before }) });
      if (page.items.length > 0 && !(await this.embedItems(db, page.items))) return;
      if (!page.hasMore || page.nextBefore === null) return;
      // A page keeps its place only once its batch landed: a retry happens inside embedBatch.
      before = page.nextBefore;
    }
  }

  /** Embeds what has words and stores each vector; false when the feed stopped or paused on the way. */
  private async embedItems(db: AccountDb, items: readonly BacklogItem[]): Promise<boolean> {
    const work: Work[] = [];
    const nothing: number[] = [];
    let chars = 0;
    for (const item of items) {
      const message = db.messages.get(item.sid);
      if (message === null) continue;
      const words = this.options.words(message);
      if (words === null) {
        nothing.push(item.id);
        continue;
      }
      if (work.length > 0 && chars + words.length > BATCH_CHARS) {
        if (!(await this.embedBatch(db, work.splice(0)))) return false;
        chars = 0;
      }
      work.push({ message, words });
      chars += words.length;
    }
    if (nothing.length > 0 && db.isOpen) db.vectors.dequeue(nothing);
    return work.length === 0 || this.embedBatch(db, work);
  }

  /**
   * One batch, retried with backoff while the server fails. A batch the
   * server refuses as input is bisected (see attempt); the texts it refused
   * alone leave the queue only when another text of the same attempt was
   * embedded. False when the feed stopped or paused on the way.
   */
  private async embedBatch(db: AccountDb, work: Work[]): Promise<boolean> {
    const retry = this.options.retry ?? {};
    for (;;) {
      if (this.stopped || !db.isOpen) return false;
      const refused: Work[] = [];
      const start = this.successes;
      try {
        await this.attempt(db, work, refused, start);
        if (this.stopped || !db.isOpen) return false;
        if (refused.length > 0 && this.successes === start) throw new RefusedAll(this.lastRefusal);
        if (refused.length > 0) {
          logError("recall index", `skipping ${refused.length} message(s) the embedding server refuses as input`);
          db.vectors.dequeue(refused.map((entry) => entry.message.id));
        }
        return true;
      } catch (err) {
        if (this.stopped || !db.isOpen) return false;
        this.failures++;
        if (this.failures >= MAX_FAILURES) {
          if (this.failing === null) logError("recall index", err);
          this.failing = `indexing paused after ${MAX_FAILURES} failed embedding calls: ${describeError(err)}`;
          this.pauseUntilRetry();
          return false;
        }
        const delay = Math.min(retry.maxMs ?? RETRY_MAX_MS, (retry.initMs ?? RETRY_INIT_MS) * 2 ** (this.failures - 1));
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

  private lastRefusal: unknown = null;

  /**
   * Embeds `work` and stores the vectors. A refusal of the input halves the
   * batch, depth first, down to the single texts refused, which are collected
   * in `refused`. A part of the batch that was refused whole, with nothing of
   * the attempt embedded before it, is the server refusing everything: that
   * throws, so a failing server never costs more than a few requests nor
   * takes anything off the queue. Any other failure throws as it is.
   */
  private async attempt(db: AccountDb, work: Work[], refused: Work[], start: number): Promise<void> {
    try {
      const vectors = await this.options.embed(work.map((entry) => entry.words));
      if (!db.isOpen || this.stopped) return;
      db.transaction(() => {
        work.forEach((entry, i) => {
          const vector = vectors[i];
          if (vector === undefined) return;
          const { message } = entry;
          // Refused when the message was deleted, expired, edited or transcribed meanwhile.
          db.vectors.put(message.sid, this.options.model, vector, contentHash(message.text, message.transcript));
        });
      });
      this.successes++;
      this.failures = 0;
      this.pauses = 0;
      this.failing = null;
    } catch (err) {
      if (!(err instanceof WazapError && err.code === "RECALL_BAD_INPUT")) throw err;
      this.lastRefusal = err;
      if (work.length === 1) {
        refused.push(work[0]!);
        return;
      }
      const before = this.successes;
      const mid = Math.ceil(work.length / 2);
      await this.attempt(db, work.slice(0, mid), refused, start);
      if (this.stopped || !db.isOpen) return;
      await this.attempt(db, work.slice(mid), refused, start);
      if (this.successes === before && this.successes === start) throw new RefusedAll(err);
    }
  }

  /** A later retry, doubling while the server keeps failing; kick() retries at once instead. */
  private pauseUntilRetry(): void {
    if (this.stopped || this.retryTimer !== null) return;
    const retry = this.options.retry ?? {};
    const delay = Math.min(retry.laterMaxMs ?? RETRY_LATER_MAX_MS, (retry.laterMs ?? RETRY_LATER_MS) * 2 ** this.pauses);
    this.pauses++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kick();
    }, delay);
    // A pause must not keep the process alive on its own.
    this.retryTimer.unref();
  }
}

/** One turn of the event loop, so a timer or a message is not held up by a walk. */
function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function describeError(err: unknown): string {
  if (err instanceof WazapError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
