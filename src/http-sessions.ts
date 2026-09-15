import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logError } from "./logger.js";

interface Session {
  transport: StreamableHTTPServerTransport;
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

  get(id: string, owner: string): StreamableHTTPServerTransport | undefined {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) return undefined;
    session.lastSeen = Date.now();
    return session.transport;
  }

  add(id: string, transport: StreamableHTTPServerTransport, owner: string): void {
    this.sessions.set(id, { transport, owner, lastSeen: Date.now() });
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

  forget(id: string): void {
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
