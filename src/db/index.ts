/**
 * One WhatsApp account's storage: a single SQLite file,
 * `accounts/<id>/wazap.sqlite`, opened synchronously on the calling thread.
 *
 *   const db = AccountDb.open(path);
 *   await db.resume();                    // finishes folds and purges a stop interrupted
 *   db.messages.upsert({...});            // barriers enforced in the write
 *   db.search.text({ query: "factur", limit: 20 });
 *   await db.messages.clearChat(jid, Date.now());  // hidden at once, purged in chunks
 *   const paths = db.claimUnlinks();       // unlink each, then:
 *   const { rerecorded } = db.ackUnlinks(paths);  // recorded again meanwhile: recreate them
 *   db.close();
 *
 * The service (`WhatsAppService`) opens one per account at construction and
 * serves every read and write from it; the legacy JSON stores are imported
 * once at boot (`src/legacy-import/`) and never read again.
 *
 * What the wiring must know (F1-d, F1-e, and any new caller):
 * - Call resume() after every writable open, and unlink files only through
 *   claimUnlinks() / ackUnlinks().
 * - waiting() pages on each chat's last_ts, which moves as messages arrive: a
 *   chat can repeat or be skipped between pages. Treat the cursor as
 *   best-effort paging, not a snapshot.
 * - id_high and retracted only grow: a small row per second that lost a row to
 *   a purge, and one per deleted, retracted or expired message (status
 *   expiries included). Nothing prunes them.
 * - A timestamp is stored as given. One far in the future becomes the chat's
 *   last message until it is corrected; clamping implausible future
 *   timestamps is the service's job, before upsert.
 * - retracted makes a message key dead for good: a later upsert with that
 *   chat, direction and key is stored as a tombstone. sends therefore never
 *   stores a message before WhatsApp took it, and never retries a key once it
 *   reached the socket (see sends.ts).
 */
import { Connection, type CheckpointResult, type ConnectionOptions, type ConnectionSettings } from "./connection.js";
import { StorageError } from "./errors.js";
import { Identity } from "./identity.js";
import { Merger } from "./merge.js";
import { Messages, type ScrubQuote } from "./messages.js";
import { Search } from "./search.js";
import { Sends } from "./sends.js";
import type { BulkDeleteResult, Counts, MergeReport } from "./types.js";
import { Vectors } from "./vectors.js";

export { StorageError, type StorageErrorCode } from "./errors.js";
export { SCHEMA_VERSION } from "./schema.js";
export { SEQ_SPAN, idLowerBound, idUpperBound, secondOfId } from "./ids.js";
export { chatKindOf, isLidJid, normalizeJid, parseSid, sidOf } from "./identity.js";
export { mergeNotes } from "./merge.js";
export { foldText, DEFAULT_SCAN_CAP, DEFAULT_TRIGRAM_CAP } from "./search.js";
export { contentHash, hybridTokens, hybridWords, int8Similarity, quantizeVector, unitVector, RRF_K } from "./vectors.js";
export { isSqliteExperimentalWarning } from "./sqlite.js";
export type { ScrubQuote } from "./messages.js";
export type { NewDraft, SendRecord, SendState, Sends } from "./sends.js";
export type { CheckpointResult, ConnectionOptions, ConnectionSettings } from "./connection.js";
export type {
  BacklogItem,
  HybridHit,
  HybridResult,
  HybridSearchInput,
  VectorHit,
  VectorSearchInput,
} from "./vectors.js";
export type * from "./types.js";

/** Pages one incremental merge step writes; ~3 ms a step on a 100k-message index. */
const FTS_MERGE_PAGES = 100;

export interface AccountDbOptions extends ConnectionOptions {
  /** Strips a quoted message's embedded copy from a quoting message's protobuf; see ScrubQuote. */
  scrubQuote?: ScrubQuote;
}

export class AccountDb {
  readonly identity: Identity;
  readonly messages: Messages;
  readonly search: Search;
  readonly vectors: Vectors;
  readonly sends: Sends;
  private readonly merger: Merger;

  private constructor(private readonly connection: Connection, options: AccountDbOptions) {
    this.identity = new Identity(connection);
    this.messages = new Messages(connection, this.identity, options.scrubQuote ?? null);
    this.search = new Search(connection, this.identity, this.messages);
    this.vectors = new Vectors(connection, this.identity, this.messages, this.search);
    this.sends = new Sends(connection);
    this.merger = new Merger(connection, this.identity, this.messages);
  }

  /** Opens (creating and migrating when writable) the database at `path`. */
  static open(path: string, options: AccountDbOptions = {}): AccountDb {
    return new AccountDb(Connection.open(path, options), options);
  }

  get path(): string {
    return this.connection.path;
  }

  get readOnly(): boolean {
    return this.connection.readOnly;
  }

  get schemaVersion(): number {
    return this.connection.schemaVersion;
  }

  get isOpen(): boolean {
    return this.connection.isOpen;
  }

  settings(): ConnectionSettings {
    return this.connection.settings();
  }

  getMeta(key: string): string | null {
    return this.connection.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
  }

  setMeta(key: string, value: string | null): void {
    this.connection.write(() => {
      if (value === null) this.connection.run("DELETE FROM meta WHERE key = ?", key);
      else this.connection.run("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", key, value);
    });
  }

  /**
   * Ties the file to one WhatsApp account. The first call records the owner;
   * a later call naming someone else refuses, so one account's history never
   * lands in another's file.
   */
  bindOwner(ownerJid: string): void {
    this.connection.write(() => {
      const current = this.getMeta("owner");
      if (current === null) this.setMeta("owner", ownerJid);
      else if (current !== ownerJid) {
        throw new StorageError("OWNER_MISMATCH", `This database belongs to ${current}, not ${ownerJid}.`);
      }
    });
  }

  /**
   * Several writes as one transaction: all of them or none. The body must be
   * synchronous — a transaction never spans an await.
   */
  transaction<T>(body: () => T): T {
    return this.connection.write(body);
  }

  /**
   * Merges the full-text index's segments a hundred pages at a time, with the
   * event loop running between steps, then refreshes the planner statistics.
   * A merged index makes every later delete several times cheaper, and it
   * drops the entries of deleted rows for good. Run it after an import or in
   * an idle moment; it queues behind other large operations.
   */
  optimize(): Promise<{ steps: number }> {
    this.connection.assertWritable();
    return this.connection.bulk(async () => {
      let steps = 0;
      await this.connection.chunked(() => {
        const before = this.connection.get<{ n: number }>("SELECT total_changes() AS n")!.n;
        this.connection.run("INSERT INTO messages_fts(messages_fts, rank) VALUES ('merge', ?)", -FTS_MERGE_PAGES);
        steps++;
        // The command itself counts as one change; anything more means it wrote pages.
        return this.connection.get<{ n: number }>("SELECT total_changes() AS n")!.n - before > 1;
      });
      this.connection.db.exec("PRAGMA optimize");
      return { steps };
    });
  }

  /** Makes a lid and a phone number one person and one chat; chunked. */
  learnLidPhone(lid: string, phoneJid: string): Promise<MergeReport> {
    return this.merger.learnLidPhone(lid, phoneJid);
  }

  /** Finishes any fold a crash or a close interrupted. */
  resumeMerges(): Promise<MergeReport> {
    return this.merger.resumeMerges();
  }

  /**
   * Finishes what a crash or a close interrupted: folds first, then the
   * physical purge under every stored clear barrier. Call once after opening a
   * writable database; reads are already correct before it runs.
   */
  async resume(): Promise<{ merges: MergeReport; purged: BulkDeleteResult }> {
    const merges = await this.merger.resumeMerges();
    const purged = await this.messages.resumePurges();
    return { merges, purged };
  }

  /**
   * Files removed rows pointed at and no row references any more, oldest
   * first, whether claimed or not. A read-only view of the queue.
   */
  pendingUnlinks(limit = 1000): string[] {
    return this.connection
      .all<{ path: string }>("SELECT path FROM pending_unlinks ORDER BY queued_at, path LIMIT ?", Math.max(1, Math.floor(limit)))
      .map((row) => row.path);
  }

  /**
   * Hands paths to unlink to the caller and marks them claimed: unclaimed
   * ones, and claims older than `staleAfterMs` (a process that died between
   * claiming and acknowledging). Recording a claimed path again before the
   * acknowledgement cancels its claim.
   */
  claimUnlinks(limit = 1000, staleAfterMs = 10 * 60_000): string[] {
    return this.connection.write(() => {
      const now = this.connection.now();
      const paths = this.connection
        .all<{ path: string }>(
          `SELECT path FROM pending_unlinks WHERE claimed_at IS NULL OR claimed_at <= ?
           ORDER BY queued_at, path LIMIT ?`,
          now - Math.max(0, staleAfterMs),
          Math.max(1, Math.floor(limit))
        )
        .map((row) => row.path);
      if (paths.length > 0) {
        this.connection.run("UPDATE pending_unlinks SET claimed_at = ? WHERE path IN (SELECT value FROM json_each(?))", now, JSON.stringify(paths));
      }
      return paths;
    });
  }

  /**
   * Acknowledges claimed paths as unlinked and takes them off the queue.
   * `rerecorded` are the ones a message recorded again after the claim: their
   * claim was cancelled, they stay referenced, and the caller must not have
   * unlinked them — or must recreate the file if it already did.
   */
  ackUnlinks(paths: readonly string[]): { acked: string[]; rerecorded: string[] } {
    const result = { acked: [] as string[], rerecorded: [] as string[] };
    if (paths.length === 0) return result;
    this.connection.write(() => {
      for (const path of new Set(paths)) {
        const row = this.connection.get<{ claimed_at: number | null }>("SELECT claimed_at FROM pending_unlinks WHERE path = ?", path);
        if (row !== undefined && row.claimed_at !== null) {
          this.connection.run("DELETE FROM pending_unlinks WHERE path = ?", path);
          result.acked.push(path);
        } else if (row !== undefined || this.connection.get("SELECT 1 FROM media WHERE path = ?", path) !== undefined) {
          result.rerecorded.push(path);
        } else {
          result.acked.push(path);
        }
      }
    });
    return result;
  }

  /**
   * Whole-account counts for status, off indexes: rows a stored clear barrier
   * already hides are not messages any more, even before their purge ran.
   */
  counts(): Counts {
    const row = this.connection.get<Counts & { total: number; hidden: number }>(
      `SELECT (SELECT count(*) FROM messages) AS total,
              (SELECT count(*) FROM messages INDEXED BY messages_tombstones WHERE deleted_at IS NOT NULL) AS tombstones,
              (SELECT count(*) FROM chats c CROSS JOIN messages m ON m.chat_id = c.id
                 AND m.id < ((c.cleared_through_ts / 1000) + 1) * 1048576 AND m.ts <= c.cleared_through_ts
                 AND m.deleted_at IS NULL
               WHERE c.cleared_through_ts IS NOT NULL) AS hidden,
              (SELECT count(*) FROM chats WHERE merged_into IS NULL) AS chats,
              (SELECT count(*) FROM contacts WHERE merged_into IS NULL) AS contacts,
              (SELECT count(*) FROM embeddings) AS embeddings`
    )!;
    return {
      messages: row.total - row.tombstones - row.hidden,
      tombstones: row.tombstones,
      chats: row.chats,
      contacts: row.contacts,
      embeddings: row.embeddings,
    };
  }

  /**
   * SQLite's quick_check, plus — on a writable connection — the full-text
   * index compared against the messages it indexes. For doctor, and for tests
   * that must prove the triggers kept the index in step.
   */
  integrityCheck(): { ok: boolean; problems: string[] } {
    const problems = this.connection
      .all<{ quick_check: string }>("PRAGMA quick_check")
      .map((row) => row.quick_check)
      .filter((line) => line !== "ok");
    if (!this.connection.readOnly) {
      try {
        this.connection.run("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)");
      } catch (err) {
        problems.push(`full-text index: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const drifted = this.connection.get<{ n: number }>(
      `SELECT count(*) AS n FROM chats c WHERE c.visible != (
         SELECT count(*) FROM messages m WHERE m.chat_id = c.id AND m.deleted_at IS NULL AND m.ts > coalesce(c.cleared_through_ts, 0))`
    )!.n;
    if (drifted > 0) problems.push(`visible message counts: ${drifted} chats disagree with their rows`);
    return { ok: problems.length === 0, problems };
  }

  checkpoint(): CheckpointResult {
    return this.connection.checkpoint();
  }

  /** An online copy of the database, owner-only, taken while the account keeps working. */
  backup(destination: string): Promise<number> {
    return this.connection.backup(destination);
  }

  /** Settles once queued chunked operations (clears, expiry sweeps, merges) have finished. */
  idle(): Promise<void> {
    return this.connection.idle();
  }

  close(): void {
    this.connection.close();
  }
}
