/**
 * Where each client's catch-up summary left off, per account (v5
 * `catchup_marks`). A client is whatever the service names the caller by —
 * an OAuth client id, a token label, `local` — and its mark is the newest
 * message id its last complete summary covered, with the one before it kept
 * so that summary can be given again.
 *
 *   marks.get("claude")                    // { throughId, previousId, updatedAt } or null
 *   marks.advance("claude", 123456789)     // previous = current through, through = 123456789, in one statement
 *   marks.repeat("claude")                 // the window the last summary covered: (previousId, throughId]
 *
 * A mark only moves forward: two summaries racing each other cannot take a
 * client back to a window it already saw, and the one that loses keeps the
 * window before it for `repeat`.
 */
import type { Connection } from "./connection.js";
import { StorageError } from "./errors.js";

export interface CatchupMark {
  client: string;
  /** The newest message id the last complete summary covered. */
  throughId: number;
  /** The mark before that summary; null when it was the client's first. */
  previousId: number | null;
  updatedAt: number;
}

export interface CatchupAdvance {
  /** False when the mark already covers `throughId`, or `expectedThroughId` no longer holds. */
  advanced: boolean;
  /** The mark after the call; null only for a client with none when nothing was written. */
  mark: CatchupMark | null;
}

const MAX_CLIENT_CHARS = 200;

interface MarkRow {
  client: string;
  through_id: number;
  previous_id: number | null;
  updated_at: number;
}

function markOf(row: MarkRow): CatchupMark {
  return { client: row.client, throughId: row.through_id, previousId: row.previous_id, updatedAt: row.updated_at };
}

function checkClient(client: string): string {
  if (typeof client !== "string" || client.length === 0 || client.length > MAX_CLIENT_CHARS) {
    throw new StorageError("INVALID_INPUT", `A catch-up client is a name of 1 to ${MAX_CLIENT_CHARS} characters.`);
  }
  return client;
}

function checkId(id: number, name: string): number {
  if (!Number.isSafeInteger(id) || id < 0) throw new StorageError("INVALID_INPUT", `${name} must be a message id (a non-negative integer).`);
  return id;
}

export class CatchupMarks {
  constructor(private readonly c: Connection) {}

  get(client: string): CatchupMark | null {
    const row = this.c.get<MarkRow>(
      "SELECT client, through_id, previous_id, updated_at FROM catchup_marks WHERE client = ?",
      checkClient(client)
    );
    return row === undefined ? null : markOf(row);
  }

  /**
   * Moves the client's mark to `throughId` after a complete summary, keeping
   * the mark it had as `previousId` — one statement, so the pair is never seen
   * half-written. A mark at or past `throughId` stays as it is. With
   * `expectedThroughId`, the move happens only while the mark is still that
   * one (null: the client has none yet), so a summary built over a mark that
   * another call has moved since does not advance it.
   */
  advance(client: string, throughId: number, options: { expectedThroughId?: number | null } = {}): CatchupAdvance {
    const name = checkClient(client);
    const through = checkId(throughId, "throughId");
    const expected = options.expectedThroughId;
    if (expected !== undefined && expected !== null) checkId(expected, "expectedThroughId");
    return this.c.write(() => {
      const now = this.c.now();
      let changed: number;
      if (expected === undefined || expected === null) {
        changed = this.c.run(
          `INSERT INTO catchup_marks(client, through_id, previous_id, updated_at) VALUES (?, ?, NULL, ?)
           ON CONFLICT(client) DO UPDATE SET previous_id = catchup_marks.through_id, through_id = excluded.through_id,
             updated_at = excluded.updated_at
           WHERE excluded.through_id > catchup_marks.through_id AND ? = 0`,
          name,
          through,
          now,
          expected === null ? 1 : 0
        );
      } else {
        changed = this.c.run(
          `UPDATE catchup_marks SET previous_id = through_id, through_id = ?, updated_at = ?
           WHERE client = ? AND through_id = ? AND through_id < ?`,
          through,
          now,
          name,
          expected,
          through
        );
      }
      return { advanced: changed > 0, mark: this.get(name) };
    });
  }

  /**
   * The window the client's last complete summary covered, to give it again:
   * messages with an id above `afterId` (none: the summary had no mark before
   * it) up to `throughId`. Null for a client with no mark. Changes nothing.
   */
  repeat(client: string): { afterId: number | null; throughId: number } | null {
    const mark = this.get(client);
    return mark === null ? null : { afterId: mark.previousId, throughId: mark.throughId };
  }

  /** Forgets a client's mark; its next summary is a first one again. */
  reset(client: string): boolean {
    return this.c.write(() => this.c.run("DELETE FROM catchup_marks WHERE client = ?", checkClient(client)) > 0);
  }
}
