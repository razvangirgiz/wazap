/**
 * One WhatsApp account's storage: a single SQLite file,
 * `accounts/<id>/wazap.sqlite`, opened synchronously on the calling thread.
 *
 *   const db = AccountDb.open(path);
 *   db.messages.upsert({...});           // barriers enforced in the write
 *   db.search.text({ query: "factur", limit: 20 });
 *   await db.messages.clearChat(jid, Date.now());  // chunked, yields between chunks
 *   db.close();
 *
 * Not wired into the service yet (F1-a); the service keeps its JSON stores
 * until the import slice switches reads over.
 */
import { Connection, type CheckpointResult, type ConnectionOptions, type ConnectionSettings } from "./connection.js";
import { StorageError } from "./errors.js";
import { Identity } from "./identity.js";
import { Merger } from "./merge.js";
import { Messages, type ScrubQuote } from "./messages.js";
import { Search } from "./search.js";
import type { Counts, MergeReport } from "./types.js";
import { Vectors } from "./vectors.js";

export { StorageError, type StorageErrorCode } from "./errors.js";
export { SCHEMA_VERSION } from "./schema.js";
export { SEQ_SPAN, idLowerBound, idUpperBound, secondOfId } from "./ids.js";
export { chatKindOf, isLidJid, normalizeJid, parseSid, sidOf } from "./identity.js";
export { mergeNotes } from "./merge.js";
export { foldText, DEFAULT_SCAN_CAP, DEFAULT_TRIGRAM_CAP } from "./search.js";
export { hybridTokens, int8Similarity, quantizeVector, unitVector, RRF_K } from "./vectors.js";
export { isSqliteExperimentalWarning } from "./sqlite.js";
export type { ScrubQuote } from "./messages.js";
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
  private readonly merger: Merger;

  private constructor(private readonly connection: Connection, options: AccountDbOptions) {
    this.identity = new Identity(connection);
    this.messages = new Messages(connection, this.identity, options.scrubQuote ?? null);
    this.search = new Search(connection, this.identity, this.messages);
    this.vectors = new Vectors(connection, this.identity, this.messages, this.search);
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

  /** Whole-account counts for status; each is an index count, never a table scan. */
  counts(): Counts {
    const row = this.connection.get<Counts & { total: number }>(
      `SELECT (SELECT count(*) FROM messages) AS total,
              (SELECT count(*) FROM messages INDEXED BY messages_tombstones WHERE deleted_at IS NOT NULL) AS tombstones,
              (SELECT count(*) FROM chats) AS chats,
              (SELECT count(*) FROM contacts) AS contacts,
              (SELECT count(*) FROM embeddings) AS embeddings`
    )!;
    return {
      messages: row.total - row.tombstones,
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
