import type { McpTransport } from "./mcp-http.js";
import { logError } from "./logger.js";

interface Session {
  transport: McpTransport;
  owner: string;
  lastSeen: number;
}

/** Session ids are routing hints, not credentials. Check ownership before touching TTL. */
export class HttpSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly max: number) {}

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  get(id: string, owner: string): McpTransport | undefined {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) return undefined;
    session.lastSeen = Date.now();
    return session.transport;
  }

  /** How many sessions are live; what the per-credential and overall caps bound. */
  get size(): number {
    return this.sessions.size;
  }

  add(id: string, transport: McpTransport, owner: string): void {
    this.sessions.set(id, { transport, owner, lastSeen: Date.now() });
    const owned = [...this.sessions].filter(([, session]) => session.owner === owner);
    if (owned.length > Math.min(32, this.max)) {
      const oldest = owned.filter(([other]) => other !== id).sort(([, a], [, b]) => a.lastSeen - b.lastSeen)[0];
      if (oldest) this.drop(oldest[0]);
    }
    while (this.sessions.size > this.max) {
      let oldest: string | undefined;
      let oldestAt = Infinity;
      for (const [other, session] of this.sessions) {
        if (other !== id && session.lastSeen < oldestAt) {
          oldest = other;
          oldestAt = session.lastSeen;
        }
      }
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  /**
   * A transport that closed leaves the registry, unless a revival has since
   * put a new one under the same id: an old transport's close must not drop it.
   */
  forget(id: string, transport?: McpTransport): void {
    if (transport !== undefined && this.sessions.get(id)?.transport !== transport) return;
    this.sessions.delete(id);
  }

  private drop(id: string): void {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (session) void session.transport.close().catch((err: unknown) => logError("session close", err));
  }

  sweep(cutoff: number): void {
    for (const [id, session] of this.sessions) if (session.lastSeen < cutoff) this.drop(id);
  }

  close(): void {
    for (const id of this.sessions.keys()) this.drop(id);
  }
}
