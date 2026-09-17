/**
 * Where each client's catch-up summary left off, per account (v5
 * `catchup_marks`). A client is whatever the service names the caller by —
 * an OAuth client id, a token label, `local` — and its mark is the newest
 * stored_seq its last complete summary covered (the order messages reached the
 * account, so one filed late is still after it) and when that summary started,
 * with the mark before it kept so that summary can be given again.
 *
 *   marks.get("claude")                          // { throughSeq, throughAt, previousSeq, previousAt, updatedAt } or null
 *   marks.advance("claude", 4812, { at })        // previous = current, through = 4812 at `at`, in one statement
 *   marks.repeat("claude")                       // the window the last summary covered: (afterSeq, throughSeq]
 *
 * A mark only moves forward: two summaries racing each other cannot take a
 * client back to a window it already saw, and the one that loses keeps the
 * window before it for `repeat`.
 */
import type { Connection } from "./connection.js";
import { StorageError } from "./errors.js";
import { STORED_SEQ_TOP } from "./messages.js";

export interface CatchupMark {
  client: string;
  /** The newest stored_seq the last complete summary covered. */
  throughSeq: number;
  /** When that summary started. */
  throughAt: number;
  /** The mark before that summary; null when it was the client's first. */
  previousSeq: number | null;
  previousAt: number | null;
  updatedAt: number;
}

export interface CatchupAdvance {
  /** False when the mark already covers `throughSeq`, or `expectedThroughSeq` no longer holds. */
  advanced: boolean;
  /** The mark after the call; null only for a client with none when nothing was written. */
  mark: CatchupMark | null;
}

const MAX_CLIENT_CHARS = 200;

interface MarkRow {
  client: string;
  through_seq: number;
  through_at: number;
  previous_seq: number | null;
  previous_at: number | null;
  updated_at: number;
}

function markOf(row: MarkRow): CatchupMark {
  return {
    client: row.client,
    throughSeq: row.through_seq,
    throughAt: row.through_at,
    previousSeq: row.previous_seq,
    previousAt: row.previous_at,
    updatedAt: row.updated_at,
  };
}

function checkClient(client: string): string {
  if (typeof client !== "string" || client.length === 0 || client.length > MAX_CLIENT_CHARS) {
    throw new StorageError("INVALID_INPUT", `A catch-up client is a name of 1 to ${MAX_CLIENT_CHARS} characters.`);
  }
  return client;
}

function checkCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new StorageError("INVALID_INPUT", `${name} must be a non-negative integer.`);
  return value;
}

const COLUMNS = "client, through_seq, through_at, previous_seq, previous_at, updated_at";

export class CatchupMarks {
  constructor(private readonly c: Connection) {}

  get(client: string): CatchupMark | null {
    const row = this.c.get<MarkRow>(`SELECT ${COLUMNS} FROM catchup_marks WHERE client = ?`, checkClient(client));
    return row === undefined ? null : markOf(row);
  }

  /**
   * Moves the client's mark to `throughSeq`, reached by a summary that started
   * at `at` (now by default), after it was given whole, keeping the mark it
   * had as the previous one — one statement, so the pair is never seen
   * half-written. A `throughSeq` past the newest stored_seq handed out is held
   * to it: a mark never covers what has not arrived. A mark at or past
   * `throughSeq` stays as it is. With
   * `expectedThroughSeq`, the move happens only while the mark is still that
   * one (null: the client has none yet), so a summary built over a mark that
   * another call has moved since does not advance it.
   */
  advance(client: string, throughSeq: number, options: { at?: number; expectedThroughSeq?: number | null } = {}): CatchupAdvance {
    const name = checkClient(client);
    const asked = checkCount(throughSeq, "throughSeq");
    const expected = options.expectedThroughSeq;
    if (expected !== undefined && expected !== null) checkCount(expected, "expectedThroughSeq");
    return this.c.write(() => {
      const now = this.c.now();
      const at = options.at === undefined ? now : checkCount(options.at, "at");
      const through = Math.min(asked, this.c.get<{ top: number }>(`SELECT ${STORED_SEQ_TOP} AS top`)?.top ?? 0);
      let changed: number;
      if (expected === undefined || expected === null) {
        changed = this.c.run(
          `INSERT INTO catchup_marks(client, through_seq, through_at, previous_seq, previous_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)
           ON CONFLICT(client) DO UPDATE SET previous_seq = catchup_marks.through_seq, previous_at = catchup_marks.through_at,
             through_seq = excluded.through_seq, through_at = excluded.through_at, updated_at = excluded.updated_at
           WHERE excluded.through_seq > catchup_marks.through_seq AND ? = 0`,
          name,
          through,
          at,
          now,
          expected === null ? 1 : 0
        );
      } else {
        changed = this.c.run(
          `UPDATE catchup_marks SET previous_seq = through_seq, previous_at = through_at, through_seq = ?, through_at = ?, updated_at = ?
           WHERE client = ? AND through_seq = ? AND through_seq < ?`,
          through,
          at,
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
   * messages stored after `afterSeq` (null: the summary had no mark before it,
   * and read by time up to when it started) up to `throughSeq`, with when each
   * end was reached. Null for a client with no mark. Changes nothing.
   */
  repeat(client: string): { afterSeq: number | null; afterAt: number | null; throughSeq: number; throughAt: number } | null {
    const mark = this.get(client);
    return mark === null
      ? null
      : { afterSeq: mark.previousSeq, afterAt: mark.previousAt, throughSeq: mark.throughSeq, throughAt: mark.throughAt };
  }

  /** Forgets a client's mark; its next summary is a first one again. */
  reset(client: string): boolean {
    return this.c.write(() => this.c.run("DELETE FROM catchup_marks WHERE client = ?", checkClient(client)) > 0);
  }
}
