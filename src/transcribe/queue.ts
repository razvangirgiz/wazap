import { logError } from "../logger.js";

/**
 * Single-flight FIFO for background transcription. Ingestion must never wait on
 * a transcript and must never see one fail, so enqueue returns at once and a
 * failed run is logged and dropped.
 */
export class TranscribeQueue {
  private readonly pending: string[] = [];
  private inFlight: string | null = null;
  private waiters: Array<() => void> = [];
  /** One entry per id queued or in flight, which is also how a repeat enqueue is spotted. */
  private readonly settling = new Map<string, { promise: Promise<void>; settle: () => void }>();

  constructor(private readonly run: (id: string) => Promise<void>) {}

  /**
   * Settles when this id's own run settles, so a caller can wait for one
   * transcript without waiting for the queue behind it. It never rejects: a run
   * that failed settles like one that worked, because ingestion must never see a
   * transcription fail. An id already queued or in flight hands back the promise
   * already outstanding, so two enqueues of one id share one settle.
   */
  enqueue(id: string): Promise<void> {
    const outstanding = this.settling.get(id);
    if (outstanding !== undefined) return outstanding.promise;
    let settle!: () => void;
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.settling.set(id, { promise, settle });
    this.pending.push(id);
    if (this.inFlight === null) void this.drain();
    return promise;
  }

  get size(): number {
    return this.pending.length + (this.inFlight === null ? 0 : 1);
  }

  get busy(): boolean {
    return this.inFlight !== null;
  }

  /** Resolves when nothing is queued or running. */
  idle(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const id = this.pending.shift()!;
      this.inFlight = id;
      try {
        await this.run(id);
      } catch (err) {
        logError(`transcribe ${id}`, err);
      }
      this.inFlight = null;
      const done = this.settling.get(id);
      this.settling.delete(id);
      done?.settle();
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
