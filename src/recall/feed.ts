/**
 * The embedding feed of one account: it walks the account database's
 * embedding queue — messages stored with words, or whose words changed, since
 * the feed last looked — embeds them in batches and stores each vector with
 * the content hash of the words it was made from, so a message edited or
 * transcribed meanwhile is simply refused and queued again. Ingestion never
 * waits on it and never sees it fail: a sick backend is retried with backoff,
 * and a dead one stops the feed and says why.
 *
 * The queue lives in the database, so a restart resumes it instead of walking
 * the history again, and a message stored below the newest one (a history
 * batch, an older page) is queued like any other. The first time a model is
 * fed, a refill queues the messages already stored, in bounded steps whose
 * place survives a restart. The feed yields to the event loop between steps
 * and pages. A text the embedding server refuses as input is bisected out of
 * its batch and taken off the queue, so it is not sent again until its words
 * change.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { contentHash, type AccountDb, type BacklogItem, type StoredMessage } from "../db/index.js";
import { WazapError } from "../errors.js";
import { logError } from "../logger.js";

/** Texts per embedding request; llama.cpp pools them in one pass. */
const BATCH = 32;
/** And at most this many characters per request, a conservative token bound. */
const BATCH_CHARS = 8_192;
/** Stored messages one refill step looks at, and queue rows one page looks at. */
const SCAN = 2_000;
const RETRY_INIT_MS = 500;
const RETRY_MAX_MS = 8_000;
/** Consecutive batch failures after which the feed is declared dead. */
const MAX_FAILURES = 5;

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

interface Work {
  message: StoredMessage;
  words: string;
}

export class EmbedFeed {
  /** Why the feed stopped for good, or null while it runs. */
  dead: string | null = null;
  private draining: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private failures = 0;
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

  /** Something may have been queued: walk the queue, now or right after the walk under way. */
  kick(): void {
    if (this.stopped || this.dead !== null) return;
    if (this.draining !== null) {
      this.again = true;
      return;
    }
    this.draining = this.drain()
      .catch((err: unknown) => logError("recall index", err))
      .finally(() => {
        this.draining = null;
        if (this.again && !this.stopped && this.dead === null) {
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
    this.wake?.();
    await this.idle();
  }

  private current(): AccountDb | null {
    if (this.stopped || this.dead !== null) return null;
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
      refilling = db.vectors.refill(SCAN);
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

  /** Embeds what has words and stores each vector; false when the feed stopped or died on the way. */
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

  private async embedBatch(db: AccountDb, work: Work[]): Promise<boolean> {
    for (;;) {
      if (this.stopped || this.dead !== null) return false;
      try {
        const vectors = await this.options.embed(work.map((entry) => entry.words));
        if (!db.isOpen || this.stopped) return false;
        db.transaction(() => {
          work.forEach((entry, i) => {
            const vector = vectors[i];
            if (vector === undefined) return;
            const { message } = entry;
            // Refused when the message was deleted, expired, edited or transcribed meanwhile.
            db.vectors.put(message.sid, this.options.model, vector, contentHash(message.text, message.transcript));
          });
        });
        this.failures = 0;
        return true;
      } catch (err) {
        if (this.stopped || !db.isOpen) return false;
        if (err instanceof WazapError && err.code === "RECALL_BAD_INPUT") {
          // The input, not the backend: halve the batch until the refused text is
          // alone, then take it off the queue rather than resend it forever.
          this.failures = 0;
          if (work.length === 1) {
            logError("recall index: skipping a message the embedding server refuses", err);
            db.vectors.dequeue([work[0]!.message.id]);
            return true;
          }
          const mid = Math.ceil(work.length / 2);
          return (await this.embedBatch(db, work.slice(0, mid))) && (await this.embedBatch(db, work.slice(mid)));
        }
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

/** One turn of the event loop, so a timer or a message is not held up by a walk. */
function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function describeError(err: unknown): string {
  if (err instanceof WazapError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
