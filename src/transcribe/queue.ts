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

  constructor(private readonly run: (id: string) => Promise<void>) {}

  /** Ignores an id already queued or in flight. */
  enqueue(id: string): void {
    if (this.inFlight === id || this.pending.includes(id)) return;
    this.pending.push(id);
    if (this.inFlight === null) void this.drain();
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
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
