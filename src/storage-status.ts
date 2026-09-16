/**
 * What `wazap status` reports about each account's storage, read without
 * changing anything: the account database through a read-only connection,
 * which a running server's writes do not block, and the legacy files by their
 * place on disk. The same answer whether a server holds the data dir or not.
 * Counts and paths only, never contents.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { AccountRegistry } from "./accounts.js";
import { accountPaths } from "./config.js";
import { AccountDb, type Counts } from "./db/index.js";
import {
  LEGACY_DIR,
  betaArchiveStatus,
  legacyEntriesInPlace,
  legacySchedule,
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
  /** A `legacy/` this database did not move (it was replaced, or set aside for another number): never deleted by wazap. */
  | { state: "unrecorded"; path: string };

export interface AccountStorage {
  account: string;
  state: AccountStorageState;
  /** While preparing: the phase the import has reached, once it started. */
  progress: ImportProgress | null;
  /** While imported-unverified: the difference categories and their counts. */
  unverified: { at: string | null; unexpected: Record<string, number> } | null;
  error: { message: string; fix: string | null } | null;
  /** The database file and its write-ahead log. */
  db_bytes: number | null;
  counts: Counts | null;
  /** Messages queued for a vector; null when recall is off. */
  embedding_queue: number | null;
  legacy: LegacyFiles;
  /** Databases set aside when a different number linked. */
  previous_owner: Array<{ file: string; bytes: number; delete_after: string }>;
}

export interface BetaArchiveReport {
  /** `in-place` at `<data dir>/archive.sqlite`, or `moved` into `<data dir>/legacy/`. */
  state: "in-place" | "moved";
  path: string;
  bytes: number;
  /** In place: the enabled accounts linked to its number. */
  accounts: string[];
  /** In place: those of them whose import is not done; the archive moves once none is. */
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

function legacyFiles(root: string, inPlace: number, schedule: LegacySchedule | null): LegacyFiles {
  if (inPlace > 0) return { state: "in-place", entries: inPlace };
  const path = join(root, LEGACY_DIR);
  if (!existsSync(path)) return { state: "none" };
  if (schedule === null || schedule.deletedAt !== null || schedule.kept === "inherited") return { state: "unrecorded", path };
  const movedAt = isoWithOffset(schedule.movedAt);
  return schedule.deleteAfter === null
    ? { state: "kept-unverified", path, moved_at: movedAt }
    : { state: "moved", path, moved_at: movedAt, delete_after: isoWithOffset(schedule.deleteAfter) };
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
    legacy: legacyFiles(root, inPlace, null),
    previous_owner: previousOwnerDbs(root).map((db) => ({ file: db.file, bytes: db.bytes, delete_after: isoWithOffset(db.deleteAfter) })),
  };
  if (!existsSync(dbPath)) {
    if (inPlace > 0) report.state = "preparing";
    return report;
  }
  report.db_bytes = fileBytes(dbPath);
  let db: AccountDb;
  try {
    db = AccountDb.open(dbPath, { readOnly: true });
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
            waiting_for: archive.accounts.filter((account) => account.importState !== "done").map((account) => account.id),
            owner_readable: archive.ownerReadable,
            delete_after: archive.deleteAfter === null ? null : isoWithOffset(archive.deleteAfter),
          },
  };
}
