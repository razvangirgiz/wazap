import { WazapError } from "./errors.js";

/**
 * Token bucket over the write tools. An agent that loops on send_message would
 * otherwise burn through WhatsApp's own spam thresholds and get the number
 * banned, which is not recoverable from this side.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    /** What ran out, so a tool with a bucket of its own does not blame the writes. */
    private readonly what: string = "Write",
  ) {
    this.tokens = perMinute;
    this.last = now();
  }

  get enabled(): boolean {
    return this.perMinute > 0;
  }

  /** Consume one token, or throw RATE_LIMITED with the wait in the fix. */
  take(): void {
    if (!this.enabled) return;
    const now = this.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.last) * this.perMinute) / 60_000);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const seconds = Math.max(1, Math.ceil(((1 - this.tokens) * 60_000) / this.perMinute / 1000));
    throw new WazapError(
      "RATE_LIMITED",
      `${this.what} rate limit reached (${this.perMinute}/minute).`,
      `Wait ${seconds} seconds`,
    );
  }
}
