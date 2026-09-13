/**
 * Baileys message ids this process sent, kept only long enough for WhatsApp to
 * echo them back. This is a backstop, not the mechanism: Baileys re-emits a local
 * send as an `append`, and the webhook path runs on `notify` only, so that gate is
 * what keeps wazap from announcing its own sends. Do not delete it believing this
 * replaces it. What lands here is an echo that arrives as `notify` anyway, such as
 * a server-side redelivery or a future send path. Identity is the bare `key.id`,
 * unique per sender and stable while a chat jid is re-canonicalised, never the
 * composite message id and never the text.
 */
export const SENT_TTL_MS = 10 * 60_000;

export class SentIds {
  private readonly noted = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? SENT_TTL_MS;
    this.clock = opts.now ?? Date.now;
  }

  note(id: string): void {
    this.prune();
    this.noted.set(id, this.clock());
  }

  has(id: string): boolean {
    this.prune();
    return this.noted.has(id);
  }

  get size(): number {
    this.prune();
    return this.noted.size;
  }

  /** No timer: a long-lived service prunes on the reads and writes it already does. */
  private prune(): void {
    const cutoff = this.clock() - this.ttlMs;
    for (const [id, at] of this.noted) {
      if (at <= cutoff) this.noted.delete(id);
    }
  }
}
