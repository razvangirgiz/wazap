/**
 * The one background transcriber of the process. Every account with automatic
 * transcription registers here, and the worker runs one note at a time across
 * all of them — a second whisper.cpp run would fight the first for the
 * machine — taking the accounts in turn, so a backlog on one does not starve
 * another.
 *
 * The queue itself is each account's database (see db/transcripts.ts), so the
 * worker keeps no work of its own: a restart finds the queue where it was, and
 * a run a crash interrupted is recovered, its attempt counted, the first time
 * the worker sees that database. A note is tried at most three times, with a
 * wait between attempts; a failure that another attempt cannot fix gives up at
 * once and says why (see failure.ts). A note whose account is not connected
 * spends no attempt and waits. A provider that cannot take any note — not
 * ready, refusing the key — pauses the whole worker, 30 s at first and twice as
 * long each time up to 15 minutes; once a pause is over one note probes the
 * provider before any other note's media is downloaded.
 *
 * Ingestion never waits on the worker and never sees it fail. kick() is how a
 * new note is noticed at once; timers cover retries and accounts coming back.
 */
import type { AccountDb, TranscribeItem } from "../db/index.js";
import { logError } from "../logger.js";
import { classifyFailure, type Failure } from "./failure.js";

export interface TranscribeSource {
  /** For logs: the account id. */
  readonly name: string;
  /** The account's open database, or null while it cannot serve (preparing, stopped). */
  db(): AccountDb | null;
  /** Whether a run may start: the account is connected. */
  ready(): boolean;
  /** Transcribes one queued note and stores the transcript; throws what went wrong. */
  run(sid: string): Promise<void>;
}

export interface TranscribeWorkerOptions {
  /** Waits before the second and the third attempt. */
  retryDelaysMs?: readonly number[];
  maxAttempts?: number;
  /** The wait of a note that could not start through no fault of its own. */
  blockedDelayMs?: number;
  /** How often an account that cannot serve yet is looked at again. */
  pollMs?: number;
  /** The first pause of a provider that cannot take any note, doubled each time up to the second. */
  pauseMs?: number;
  pauseMaxMs?: number;
  /** The clock pauses are measured on; tests move it. */
  now?: () => number;
}

const DEFAULTS: Required<TranscribeWorkerOptions> = {
  retryDelaysMs: [10_000, 60_000],
  maxAttempts: 3,
  blockedDelayMs: 30_000,
  pollMs: 10_000,
  pauseMs: 30_000,
  pauseMaxMs: 15 * 60_000,
  now: Date.now,
};

/** The wake for a note due now that a pass could not run: soon, never a spin. */
const MIN_WAKE_MS = 1_000;

interface Running {
  source: TranscribeSource;
  db: AccountDb;
  item: TranscribeItem;
  /** Its source left while it ran: the claim was already given back. */
  abandoned: boolean;
}

export class TranscribeWorker {
  private options: Required<TranscribeWorkerOptions>;
  private readonly sources: TranscribeSource[] = [];
  /** Databases whose leftover runs were recovered. */
  private readonly recovered = new WeakSet<AccountDb>();
  /** The source after the one served last. */
  private cursor = 0;
  private draining: Promise<void> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private running: Running | null = null;
  /** Until when the provider is left alone, and why; pauses in a row since the last run it took. */
  private pausedUntil = 0;
  private pauseReason: string | null = null;
  private pauses = 0;
  /** Callers waiting for a note to leave the queue, by source and sid. */
  private readonly waiters = new Map<TranscribeSource, Map<string, Array<() => void>>>();

  constructor(options: TranscribeWorkerOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Changes the timings from here on; tests shorten them. Returns the previous ones. */
  configure(options: TranscribeWorkerOptions): Required<TranscribeWorkerOptions> {
    const previous = this.options;
    this.options = { ...previous, ...options };
    return previous;
  }

  register(source: TranscribeSource): void {
    if (!this.sources.includes(source)) this.sources.push(source);
    this.kick();
  }

  /**
   * The account stops: nothing more of it runs. A run of its under way keeps
   * its promise but gives its claim back now, while the database is still open,
   * so a stop costs the note no attempt. Its waiters are released.
   */
  unregister(source: TranscribeSource): void {
    const index = this.sources.indexOf(source);
    if (index >= 0) {
      this.sources.splice(index, 1);
      if (this.cursor > index) this.cursor--;
    }
    const running = this.running;
    if (running !== null && running.source === source && !running.abandoned) {
      running.abandoned = true;
      try {
        if (running.db.isOpen) running.db.transcripts.release(running.item.id, null, 0);
      } catch (err) {
        logError(`transcribe ${source.name}`, err);
      }
    }
    const waiting = this.waiters.get(source);
    this.waiters.delete(source);
    for (const resolvers of waiting?.values() ?? []) for (const resolve of resolvers) resolve();
  }

  /** Something may be due: look now, or right after the look under way. */
  kick(): void {
    if (this.draining !== null) {
      this.again = true;
      return;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.draining = this.drain()
      .catch((err: unknown) => logError("transcribe", err))
      .finally(() => {
        this.draining = null;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /**
   * Settles once `sid` is no longer queued on `source`: transcribed, given up
   * on, gone, or its account stopped. A retry scheduled for later keeps it
   * queued. It never rejects.
   */
  settled(source: TranscribeSource, sid: string): Promise<void> {
    if (!this.sources.includes(source) || !this.queued(source, sid)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let bySid = this.waiters.get(source);
      if (bySid === undefined) this.waiters.set(source, (bySid = new Map()));
      const list = bySid.get(sid) ?? [];
      list.push(resolve);
      bySid.set(sid, list);
    });
  }

  /** The pause under way: why, and until when (epoch ms); null while the provider is being used. */
  paused(): { reason: string; until: number } | null {
    return this.pauseReason !== null && this.options.now() < this.pausedUntil ? { reason: this.pauseReason, until: this.pausedUntil } : null;
  }

  /** Ends a pause now, as if its time were up; tests use it. */
  resume(): void {
    this.pausedUntil = 0;
    this.pauseReason = null;
    this.pauses = 0;
    this.kick();
  }

  /** Settles once nothing is due that could run now; retries scheduled for later do not count. */
  async idle(): Promise<void> {
    while (this.draining !== null) await this.draining;
  }

  private async drain(): Promise<void> {
    for (;;) {
      // A turn first: a kick from inside a store's transaction must not read before it commits.
      await turn();
      const pick = this.pick();
      if (pick === null) break;
      await this.runOne(pick.source, pick.db, pick.item);
    }
    this.releaseSettled();
    this.schedule();
  }

  /** The next note to run, the accounts taken in turn; null when none can run now. */
  private pick(): { source: TranscribeSource; db: AccountDb; item: TranscribeItem } | null {
    if (this.options.now() < this.pausedUntil) return null;
    const count = this.sources.length;
    for (let offset = 0; offset < count; offset++) {
      const index = (this.cursor + offset) % count;
      const source = this.sources[index]!;
      const db = this.open(source);
      if (db === null || !source.ready()) continue;
      let item: TranscribeItem | null;
      try {
        item = db.transcripts.next();
      } catch (err) {
        logError(`transcribe ${source.name}`, err);
        continue;
      }
      if (item === null) continue;
      this.cursor = (index + 1) % count;
      return { source, db, item };
    }
    return null;
  }

  /** The source's database when open, with what a stopped process left under way recovered once. */
  private open(source: TranscribeSource): AccountDb | null {
    let db: AccountDb | null;
    try {
      db = source.db();
    } catch {
      return null;
    }
    if (db === null || !db.isOpen || db.readOnly) return null;
    if (!this.recovered.has(db)) {
      try {
        db.transcripts.recover(this.options.maxAttempts);
        this.recovered.add(db);
      } catch (err) {
        logError(`transcribe ${source.name}`, err);
        return null;
      }
    }
    return db;
  }

  private async runOne(source: TranscribeSource, db: AccountDb, item: TranscribeItem): Promise<void> {
    let attempts: number | null;
    try {
      attempts = db.transcripts.claim(item.id);
    } catch (err) {
      logError(`transcribe ${source.name}`, err);
      return;
    }
    if (attempts === null) return;
    const running: Running = { source, db, item, abandoned: false };
    this.running = running;
    let failure: Failure | null = null;
    try {
      await source.run(item.sid);
    } catch (err) {
      failure = classifyFailure(err);
    } finally {
      this.running = null;
    }
    if (running.abandoned || !db.isOpen) return;
    try {
      this.settle(source, db, item, attempts, failure);
    } catch (err) {
      logError(`transcribe ${source.name}`, err);
    }
    if (db.isOpen && db.transcripts.state(item.sid)?.state !== "queued") this.release(source, item.sid);
  }

  private settle(source: TranscribeSource, db: AccountDb, item: TranscribeItem, attempts: number, failure: Failure | null): void {
    const queue = db.transcripts;
    if (failure?.kind !== "paused" && failure?.kind !== "waiting") this.unpause();
    if (failure === null || failure.kind === "gone") {
      queue.remove(item.id);
      return;
    }
    if (failure.kind === "paused") {
      // The note is not at fault and stays first in line: it probes the provider when the pause is over.
      queue.release(item.id, failure.reason, 0);
      this.pause(failure.reason);
      return;
    }
    if (failure.kind === "waiting") {
      queue.release(item.id, failure.reason, this.options.blockedDelayMs);
      return;
    }
    if (failure.kind === "permanent" || attempts >= this.options.maxAttempts) {
      queue.fail(item.id, failure.reason);
      logError(`transcribe ${source.name}`, `gave up on a voice note after ${attempts} attempt(s): ${failure.reason}`);
      return;
    }
    const delays = this.options.retryDelaysMs;
    const delay = delays[Math.min(attempts - 1, delays.length - 1)] ?? 0;
    queue.retry(item.id, failure.reason, delay);
    logError(`transcribe ${source.name}`, `${failure.reason}; attempt ${attempts} of ${this.options.maxAttempts}, next in ${Math.round(delay / 1000)} s`);
  }

  /** No note is run until the pause is over; each pause in a row is twice as long, up to the cap. */
  private pause(reason: string): void {
    const delay = Math.min(this.options.pauseMaxMs, this.options.pauseMs * 2 ** this.pauses);
    this.pauses++;
    this.pausedUntil = this.options.now() + delay;
    this.pauseReason = reason;
    logError("transcribe", `${reason}; pausing transcription for ${Math.round(delay / 1000)} s`);
  }

  /** The provider took a note (or answered about one): pauses start from the shortest again. */
  private unpause(): void {
    this.pausedUntil = 0;
    this.pauseReason = null;
    this.pauses = 0;
  }

  /** Whether `sid` is still queued (waiting or running) on the source's database. */
  private queued(source: TranscribeSource, sid: string): boolean {
    const db = this.open(source);
    if (db === null) return false;
    try {
      return db.transcripts.state(sid)?.state === "queued";
    } catch {
      return false;
    }
  }

  private release(source: TranscribeSource, sid: string): void {
    const bySid = this.waiters.get(source);
    const resolvers = bySid?.get(sid);
    if (bySid === undefined || resolvers === undefined) return;
    bySid.delete(sid);
    if (bySid.size === 0) this.waiters.delete(source);
    for (const resolve of resolvers) resolve();
  }

  /** Waiters whose note left the queue some other way: a transcribe_audio call, a delete. */
  private releaseSettled(): void {
    for (const [source, bySid] of [...this.waiters]) {
      for (const sid of [...bySid.keys()]) if (!this.queued(source, sid)) this.release(source, sid);
    }
  }

  /**
   * A wake for the earliest retry due, and a slower look while an account that
   * has notes waiting cannot serve them (not connected, preparing). The timer
   * never holds the process open.
   */
  private schedule(): void {
    const pausedFor = this.pausedUntil - this.options.now();
    let delay = pausedFor > 0 ? pausedFor : Infinity;
    for (const source of this.sources) {
      let db: AccountDb | null;
      try {
        db = source.db();
      } catch {
        db = null;
      }
      if (pausedFor > 0) break;
      if (db === null || !db.isOpen) {
        delay = Math.min(delay, this.options.pollMs);
        continue;
      }
      let dueIn: number | null;
      try {
        dueIn = db.transcripts.dueIn();
      } catch {
        continue;
      }
      if (dueIn === null) continue;
      // A note due now that this pass could not run is looked at again shortly, never in a spin.
      delay = Math.min(delay, source.ready() ? dueIn || MIN_WAKE_MS : Math.max(dueIn, this.options.pollMs));
    }
    if (delay === Infinity) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, Math.max(0, delay));
    this.timer.unref();
  }
}

/** One turn of the event loop. */
function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The process's worker, shared by every account. */
export const transcribeWorker = new TranscribeWorker();
