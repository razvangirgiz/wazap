/**
 * What `wazap status` reports about each account's storage, read without
 * changing anything: the account database through a read-only connection,
 * which a running server's writes do not block, and the legacy files by their
 * place on disk. The same answer whether a server holds the data dir or not.
 * Counts and paths only, never contents.
 */
import { existsSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { AccountRegistry } from "./accounts.js";
import { accountPaths } from "./config.js";
import { preMigrationBackups, type AccountDb, type Counts } from "./db/index.js";
import {
  LEGACY_DIR,
  betaArchiveStatus,
  legacyEntriesInPlace,
  legacyLinksInPlace,
  legacySchedule,
  openForReading,
  previousOwnerDbs,
  type LegacySchedule,
} from "./legacy-files.js";
import { IMPORT_META, IMPORT_PHASES, type ImportPhase } from "./legacy-import/index.js";
import { isoWithOffset } from "./messages.js";

/** Set in meta when an import's verification found differences it could not explain: `{ at, unexpected }`. */
export const IMPORT_UNVERIFIED_META = "import_unverified";

const DB_FILE = "wazap.sqlite";

export interface ImportProgress {
  phase: ImportPhase;
  /** 1-based: the phase running, of `steps`. */
  step: number;
  steps: number;
}

/** The phase an import is in, from the progress it commits with every chunk; null before it starts. */
export function importProgress(db: Pick<AccountDb, "getMeta">): ImportProgress | null {
  const stored = db.getMeta(IMPORT_META.progress);
  if (stored === null) return null;
  try {
    const phase = (JSON.parse(stored) as { phase?: unknown }).phase;
    if (typeof phase !== "number" || !Number.isInteger(phase) || phase < 0) return null;
    const index = Math.min(phase, IMPORT_PHASES.length - 1);
    return { phase: IMPORT_PHASES[index]!, step: index + 1, steps: IMPORT_PHASES.length };
  } catch {
    return null;
  }
}

/**
 * - `absent`: no database yet; the server creates it at its next start.
 * - `preparing`: the earlier message files are being imported, or wait for the
 *   next start to be (a stopped import resumes).
 * - `ready`: served from the database.
 * - `imported-unverified`: served from the database, but the import found
 *   differences it could not explain; its legacy files are kept.
 * - `error`: the database could not be opened.
 */
export type AccountStorageState = "absent" | "preparing" | "ready" | "imported-unverified" | "error";

export type LegacyFiles =
  /** No legacy file here. */
  | { state: "none" }
  /** At their old place: imported at the next start, or moved aside at it. */
  | { state: "in-place"; entries: number }
  /** In `legacy/`, deleted after `delete_after`. */
  | { state: "moved"; path: string; moved_at: string; delete_after: string }
  /** In `legacy/`, kept because the import is unverified: only the user deletes them. */
  | { state: "kept-unverified"; path: string; moved_at: string }
  /** A legacy folder holding nothing this database moved (it was replaced, or someone else made it): never deleted by wazap. */
  | { state: "unrecorded"; path: string };

export interface AccountStorage {
  account: string;
  state: AccountStorageState;
  /** While preparing: the phase the import has reached, once it started. */
  progress: ImportProgress | null;
  /** While imported-unverified: the difference categories and their counts. */
  unverified: { at: string | null; unexpected: Record<string, number> } | null;
  error: { message: string; fix: string | null } | null;
  /** import_state as recorded; `skipped` means legacy files in place are another number's. */
  import_state: string | null;
  /** Legacy entries that are symbolic links: never moved or deleted by wazap. */
  links: string[];
  /** The database file and its write-ahead log. */
  db_bytes: number | null;
  counts: Counts | null;
  /** Messages queued for a vector; null when recall is off. */
  embedding_queue: number | null;
  legacy: LegacyFiles;
  /** Databases set aside when a different number linked. */
  previous_owner: Array<{ file: string; bytes: number; delete_after: string }>;
  /**
   * Copies taken beside the database before an upgrade migrated it: the schema
   * they were taken from, when, and when they go. Read off the file names and
   * their mtimes, without opening them.
   */
  pre_migration: Array<{ file: string; from_version: number; bytes: number; taken_at: string; delete_after: string }>;
}

export interface BetaArchiveReport {
  /** `in-place` at `<data dir>/archive.sqlite`, or `moved` into `<data dir>/legacy/`. */
  state: "in-place" | "moved";
  path: string;
  bytes: number;
  /** In place: the enabled accounts linked to its number. */
  accounts: string[];
  /** In place: those of them that have not imported this archive yet (they do at their next start); it moves once none is left. */
  waiting_for: string[];
  /** False when its owner could not be read: it stays where it is. */
  owner_readable: boolean;
  delete_after: string | null;
}

export interface StorageReport {
  accounts: AccountStorage[];
  beta_archive: BetaArchiveReport | null;
}

function fileBytes(path: string): number {
  return ["", "-wal"].reduce((sum, suffix) => {
    try {
      return sum + statSync(`${path}${suffix}`).size;
    } catch {
      return sum;
    }
  }, 0);
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function legacyFiles(root: string, inPlace: number, schedule: LegacySchedule | null): LegacyFiles {
  if (inPlace > 0) return { state: "in-place", entries: inPlace };
  if (schedule !== null && schedule.deletedAt === null && schedule.dir !== null) {
    const path = join(root, schedule.dir);
    if (schedule.names.some((name) => existsSync(join(path, name)))) {
      const movedAt = isoWithOffset(schedule.movedAt);
      return schedule.deleteAfter === null
        ? { state: "kept-unverified", path, moved_at: movedAt }
        : { state: "moved", path, moved_at: movedAt, delete_after: isoWithOffset(schedule.deleteAfter) };
    }
  }
  const path = join(root, LEGACY_DIR);
  return isDir(path) ? { state: "unrecorded", path } : { state: "none" };
}

function unverifiedOf(db: AccountDb): AccountStorage["unverified"] {
  const stored = db.getMeta(IMPORT_UNVERIFIED_META);
  try {
    const parsed = (stored === null ? {} : JSON.parse(stored)) as { at?: unknown; unexpected?: unknown };
    const unexpected: Record<string, number> = {};
    if (parsed.unexpected !== null && typeof parsed.unexpected === "object") {
      for (const [kind, n] of Object.entries(parsed.unexpected)) if (typeof n === "number") unexpected[kind] = n;
    }
    return { at: typeof parsed.at === "number" ? isoWithOffset(parsed.at) : null, unexpected };
  } catch {
    return { at: null, unexpected: {} };
  }
}

/** One account's storage, read-only. `recall` says whether to count the embedding queue. */
export function accountStorage(dataDir: string, accountId: string, recall: boolean): AccountStorage {
  const root = accountPaths(dataDir, accountId).root;
  const dbPath = join(root, DB_FILE);
  const inPlace = legacyEntriesInPlace(root).length;
  const report: AccountStorage = {
    account: accountId,
    state: "absent",
    progress: null,
    unverified: null,
    error: null,
    db_bytes: null,
    counts: null,
    embedding_queue: null,
    import_state: null,
    links: legacyLinksInPlace(root),
    legacy: legacyFiles(root, inPlace, null),
    previous_owner: previousOwnerDbs(root).map((db) => ({ file: db.file, bytes: db.bytes, delete_after: isoWithOffset(db.deleteAfter) })),
    pre_migration: preMigrationBackups(root).map((copy) => ({
      file: copy.file,
      from_version: copy.fromVersion,
      bytes: copy.bytes,
      taken_at: isoWithOffset(copy.takenAt),
      delete_after: isoWithOffset(copy.deleteAfter),
    })),
  };
  if (!existsSync(dbPath)) {
    if (inPlace > 0) report.state = "preparing";
    return report;
  }
  report.db_bytes = fileBytes(dbPath);
  let db: AccountDb;
  try {
    db = openForReading(dbPath);
  } catch (err) {
    report.state = "error";
    report.error = {
      message: err instanceof Error ? err.message : String(err),
      fix: (err as { fix?: unknown }).fix === undefined ? null : String((err as { fix?: unknown }).fix),
    };
    return report;
  }
  try {
    const importState = db.getMeta(IMPORT_META.state);
    report.import_state = importState;
    if (importState === "running" || (importState === null && inPlace > 0)) {
      report.state = "preparing";
      report.progress = importProgress(db);
    } else if (importState === "imported" || db.getMeta(IMPORT_UNVERIFIED_META) !== null) {
      report.state = "imported-unverified";
      report.unverified = unverifiedOf(db);
    } else {
      report.state = "ready";
    }
    report.counts = db.counts();
    if (recall) report.embedding_queue = db.vectors.queueSize();
    report.legacy = legacyFiles(root, inPlace, legacySchedule(db));
  } catch (err) {
    report.state = "error";
    report.error = { message: err instanceof Error ? err.message : String(err), fix: null };
  } finally {
    db.close();
  }
  return report;
}

/** Every account in the registry, and the beta archive. A registry that will not load reads as no accounts. */
export function storageReport(dataDir: string, recall: boolean): StorageReport {
  let ids: string[];
  try {
    ids = AccountRegistry.load(dataDir)
      .all()
      .map((record) => record.id);
  } catch {
    ids = [];
  }
  const archive = betaArchiveStatus(dataDir);
  return {
    accounts: ids.map((id) => accountStorage(dataDir, id, recall)),
    beta_archive:
      archive === null
        ? null
        : {
            state: archive.place,
            path: archive.path,
            bytes: archive.bytes,
            accounts: archive.accounts.map((account) => account.id),
            waiting_for: archive.accounts.filter((account) => !account.imported).map((account) => account.id),
            owner_readable: archive.ownerReadable,
            delete_after: archive.deleteAfter === null ? null : isoWithOffset(archive.deleteAfter),
          },
  };
}
