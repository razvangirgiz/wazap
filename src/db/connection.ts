/**
 * One open account database: the file and its modes, the pragmas, the schema
 * migrations, a statement cache, write transactions, and the chunked loop the
 * large operations run through so the event loop keeps breathing.
 *
 * Everything is synchronous on the calling thread (node:sqlite's
 * DatabaseSync). A write transaction must therefore never span an `await`:
 * `write()` takes a synchronous function, and a long operation is a sequence
 * of short transactions with `setImmediate` between them.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { StorageError } from "./errors.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";
import { sqlite, type DatabaseSync, type SQLInputValue, type StatementSync } from "./sqlite.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_CHUNK_SIZE = 200;
/**
 * A chunk also stops once it has run this long. Deleting indexed text costs
 * far more than reading it — the full-text index rewrites its pages at once
 * so deleted words do not linger — and the cost per row grows with the index,
 * so a row count alone cannot bound the pause.
 */
const DEFAULT_CHUNK_BUDGET_MS = 15;
const DEFAULT_CHECKPOINT_DELAY_MS = 2_000;

export interface ConnectionOptions {
  /** status and doctor: never migrates, never writes, refuses a schema it would have to change. */
  readOnly?: boolean;
  /** How long a statement waits on a lock held by another connection (busy_timeout). */
  timeoutMs?: number;
  /** The clock expiry and bookkeeping read; tests move it. Epoch ms. */
  now?: () => number;
  /** Rows per transaction in the chunked operations. */
  chunkSize?: number;
  /** Milliseconds a delete chunk may run before it commits and yields. */
  chunkBudgetMs?: number;
  /**
   * After a single delete, a WAL checkpoint runs this long later, so the
   * deleted bytes leave the write-ahead log soon without a checkpoint per
   * message. 0 turns the delayed checkpoint off; bulk deletes always
   * checkpoint when they finish.
   */
  checkpointDelayMs?: number;
}

export interface ConnectionSettings {
  journalMode: string;
  synchronous: "off" | "normal" | "full" | "extra" | "unknown";
  foreignKeys: boolean;
  secureDelete: boolean;
  ftsSecureDelete: boolean;
  busyTimeoutMs: number;
}

export interface CheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
}

/** Owner-only, whatever the umask: the file holds every message of the account. */
function enforceMode(path: string, mode: number): void {
  if (process.platform === "win32") return;
  const current = statSync(path).mode & 0o777;
  if ((current & ~mode) !== 0) chmodSync(path, mode);
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

function tooNew(path: string, version: number): StorageError {
  return new StorageError(
    "SCHEMA_TOO_NEW",
    `${path} has schema version ${version}; this wazap knows up to ${SCHEMA_VERSION}.`,
    "Update wazap to the version that wrote this file (npm i -g wazap-mcp@latest)"
  );
}

export class Connection {
  readonly readOnly: boolean;
  readonly now: () => number;
  readonly chunkSize: number;
  readonly chunkBudgetMs: number;
  private readonly checkpointDelayMs: number;
  private readonly statements = new Map<string, StatementSync>();
  private bulkTail: Promise<unknown> = Promise.resolve();
  private checkpointTimer: NodeJS.Timeout | null = null;
  private closed = false;

  private constructor(
    readonly path: string,
    readonly db: DatabaseSync,
    options: ConnectionOptions
  ) {
    this.readOnly = options.readOnly === true;
    this.now = options.now ?? Date.now;
    this.chunkSize = Math.max(1, Math.floor(options.chunkSize ?? DEFAULT_CHUNK_SIZE));
    this.chunkBudgetMs = Math.max(1, options.chunkBudgetMs ?? DEFAULT_CHUNK_BUDGET_MS);
    this.checkpointDelayMs = Math.max(0, options.checkpointDelayMs ?? DEFAULT_CHECKPOINT_DELAY_MS);
  }

  static open(path: string, options: ConnectionOptions = {}): Connection {
    const { DatabaseSync } = sqlite();
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (options.readOnly === true) {
      if (!existsSync(path)) {
        throw new StorageError("NOT_FOUND", `${path} does not exist.`, "Start the wazap server once to create it");
      }
      const db = new DatabaseSync(path, { readOnly: true, timeout });
      try {
        const version = userVersion(db);
        if (version > SCHEMA_VERSION) throw tooNew(path, version);
        if (version < SCHEMA_VERSION) {
          throw new StorageError(
            "SCHEMA_OUTDATED",
            `${path} has schema version ${version}; this wazap migrates it to ${SCHEMA_VERSION} when the server starts.`,
            "Restart the wazap server so it migrates the database"
          );
        }
        db.exec("PRAGMA query_only = ON");
      } catch (err) {
        db.close();
        throw err;
      }
      return new Connection(path, db, options);
    }

    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    enforceMode(dir, DIR_MODE);
    // Created here, not by SQLite, so the file is never briefly world-readable;
    // SQLite gives the -wal and -shm files the database file's mode.
    closeSync(openSync(path, "a", FILE_MODE));
    enforceMode(path, FILE_MODE);
    for (const side of [`${path}-wal`, `${path}-shm`]) if (existsSync(side)) enforceMode(side, FILE_MODE);

    const db = new DatabaseSync(path, { timeout, enableForeignKeyConstraints: true });
    try {
      // Before anything that writes: a newer file is left exactly as it was.
      const version = userVersion(db);
      if (version > SCHEMA_VERSION) throw tooNew(path, version);
      const mode = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string } | undefined;
      if (mode?.journal_mode !== "wal") {
        throw new StorageError("INVALID_INPUT", `${path} could not switch to WAL journaling.`);
      }
      db.exec("PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;");
      const connection = new Connection(path, db, options);
      connection.migrate(version);
      return connection;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  /** Each pending migration and its version bump commit together, or not at all. */
  private migrate(from: number): void {
    for (const migration of MIGRATIONS) {
      if (migration.version <= from) continue;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(migration.sql);
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
        this.db
          .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
          .run(`migrated_v${migration.version}`, String(this.now()));
        this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('created_at', ?)").run(String(this.now()));
        this.db.exec("COMMIT");
      } catch (err) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  get schemaVersion(): number {
    return userVersion(this.db);
  }

  /** The settings that make the promises hold, read back from SQLite: what doctor can show. */
  settings(): ConnectionSettings {
    this.assertOpen();
    const pragma = <T>(name: string): T => (this.db.prepare(`PRAGMA ${name}`).get() as Record<string, T>)[name] as T;
    const ftsSecureDelete = this.db
      .prepare("SELECT v FROM messages_fts_config WHERE k = 'secure-delete'")
      .get() as { v: number } | undefined;
    return {
      journalMode: pragma<string>("journal_mode"),
      synchronous: (["off", "normal", "full", "extra"] as const)[pragma<number>("synchronous")] ?? "unknown",
      foreignKeys: pragma<number>("foreign_keys") === 1,
      secureDelete: pragma<number>("secure_delete") === 1,
      ftsSecureDelete: ftsSecureDelete?.v === 1,
      busyTimeoutMs: (this.db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
    };
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  assertOpen(): void {
    if (this.closed) throw new StorageError("CLOSED", "The account database is closed.");
  }

  assertWritable(): void {
    this.assertOpen();
    if (this.readOnly) throw new StorageError("READ_ONLY", "This account database was opened read-only.");
  }

  stmt(sql: string): StatementSync {
    this.assertOpen();
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** A statement whose rows come back as arrays: the vector scan's loop builds no objects it would throw away. */
  arrayStmt(sql: string): StatementSync {
    this.assertOpen();
    const key = `arrays:${sql}`;
    let statement = this.statements.get(key);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      statement.setReturnArrays(true);
      this.statements.set(key, statement);
    }
    return statement;
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.stmt(sql).run(...params).changes);
  }

  /**
   * A write transaction around a synchronous body. Nested calls join the
   * outer transaction, so helpers can require one without caring who opened it.
   */
  write<T>(body: () => T): T {
    this.assertWritable();
    if (this.db.isTransaction) return body();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * A large operation as many small transactions: `step` does at most one
   * chunk and says whether more is left. Between chunks the event loop runs,
   * so live messages keep flowing while a chat of 50,000 rows is cleared.
   */
  async chunked(step: () => boolean): Promise<void> {
    for (;;) {
      if (!this.write(step)) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** Large operations run one at a time; two chunked loops over one chat would race each other's cursors. */
  bulk<T>(work: () => Promise<T>): Promise<T> {
    const run = this.bulkTail.then(work, work);
    this.bulkTail = run.catch(() => undefined);
    return run;
  }

  /** Settles once every queued large operation has finished. */
  async idle(): Promise<void> {
    for (;;) {
      const tail = this.bulkTail;
      await tail;
      if (tail === this.bulkTail) return;
    }
  }

  /** Moves the WAL into the main file and truncates it, so deleted bytes leave the log. */
  checkpoint(): CheckpointResult {
    this.assertWritable();
    const row = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as CheckpointResult | undefined;
    return row ?? { busy: 0, log: 0, checkpointed: 0 };
  }

  /** The delayed checkpoint after a single delete; several deletes in a row share one. */
  scheduleCheckpoint(): void {
    if (this.readOnly || this.closed || this.checkpointDelayMs === 0 || this.checkpointTimer !== null) return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = null;
      if (this.closed) return;
      try {
        this.checkpoint();
      } catch {
        // A busy reader only postpones it; the next delete or bulk operation tries again.
      }
    }, this.checkpointDelayMs);
    this.checkpointTimer.unref();
  }

  /**
   * An online copy of the whole database to `destination`, taken while the
   * account keeps working. The copy is owner-only like the original.
   */
  async backup(destination: string): Promise<number> {
    this.assertOpen();
    mkdirSync(dirname(destination), { recursive: true, mode: DIR_MODE });
    closeSync(openSync(destination, "w", FILE_MODE));
    enforceMode(destination, FILE_MODE);
    return sqlite().backup(this.db, destination);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.checkpointTimer !== null) {
      clearTimeout(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }
}
