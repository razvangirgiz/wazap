/**
 * The copy an upgrade leaves beside an account database before it migrates it.
 *
 * A migration is one transaction, so a file is never left half-migrated; what
 * it cannot undo is a migration that lands and then reads wrong. So the first
 * read-write open that finds an older schema writes
 * `wazap.<old version>.pre-migration.sqlite` next to the database, before the
 * first byte of the upgrade, and only then migrates. The copy is a whole,
 * openable database at the version it was taken from: the wazap that wrote it
 * can pick it up.
 *
 * Where it is taken from, and under which lock, is `Connection.open`'s business
 * (see connection.ts). This file owns the name, what counts as a usable copy,
 * the week they are kept and the reading `wazap status` and doctor do.
 *
 * The week is the legacy files' week, counted the same way: from the file's own
 * mtime (`src/legacy-files.ts`, `LEGACY_TTL_MS`). A copy is written, never
 * renamed, so its mtime is when it was taken and nothing has to stamp it. A
 * copy is deleted only once the database it was taken from is past its version:
 * an upgrade that never finished keeps its copy however old it is, and nothing
 * without exactly this name is ever deleted.
 *
 * It is a full copy of the account: every message the database held at that
 * moment, unencrypted, `0600` in the account's `0700` folder. Messages deleted
 * after it was taken are still in it until its week is up (or at once under
 * `WAZAP_RETENTION=1`, which treats it as the redundant copy it is).
 */
import { existsSync, lstatSync, readdirSync, rmSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { StorageError } from "./errors.js";
import { sqlite, type DatabaseSync } from "./sqlite.js";

/** How long a pre-migration copy is kept: the legacy files' own week. */
export const PRE_MIGRATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** `wazap.<old version>.pre-migration.sqlite`, and nothing else, is ever deleted. */
const PRE_MIGRATION = /^wazap\.(\d+)\.pre-migration\.sqlite$/;

/**
 * Free space a copy needs beyond the database's own size, so the filesystem is
 * not left at zero by a copy that only just fitted.
 */
const SPACE_MARGIN_BYTES = 8 * 1024 * 1024;

/** The setting that turns the copy off, for someone who knows they do not want it. */
export const PRE_MIGRATION_SETTING = "WAZAP_PRE_MIGRATION_BACKUP";

/** What to do about a copy that cannot be written. Also the doctor's line. */
export const PRE_MIGRATION_FIX = `Free disk space and check the account folder's permissions, then start wazap again; \`${PRE_MIGRATION_SETTING}=0\` upgrades without a copy`;

export function preMigrationName(fromVersion: number): string {
  return `wazap.${fromVersion}.pre-migration.sqlite`;
}

/** On unless the setting says otherwise; the same boolean words the other settings take. */
export function preMigrationBackupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[PRE_MIGRATION_SETTING];
  if (value === undefined) return true;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export interface PreMigrationBackup {
  /** Its file name, which is also the only thing a purge matches on. */
  file: string;
  path: string;
  /** The schema version the database was at when the copy was taken. */
  fromVersion: number;
  bytes: number;
  /** Epoch ms: the file's own mtime, which is when it was written. */
  takenAt: number;
  deleteAfter: number;
}

/** The pre-migration copies beside an account database, oldest first. Never a link, never a folder. */
export function preMigrationBackups(root: string): PreMigrationBackup[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const found: PreMigrationBackup[] = [];
  for (const name of names) {
    const match = PRE_MIGRATION.exec(name);
    if (match === null) continue;
    const path = join(root, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const takenAt = Math.floor(stat.mtimeMs);
    found.push({
      file: name,
      path,
      fromVersion: Number(match[1]),
      bytes: stat.size,
      takenAt,
      deleteAfter: takenAt + PRE_MIGRATION_TTL_MS,
    });
  }
  return found.sort((a, b) => a.takenAt - b.takenAt);
}

/**
 * Deletes the copies whose week is up, or at once under retention: the copy is
 * redundant, the database it was taken from holds everything it holds.
 *
 * `liveVersion` is the schema version of the open database beside them, read
 * after its migration. A copy is deleted only when that version is past it, so
 * an upgrade that failed — or one this build never ran — keeps its safety net
 * whatever the clock says. Returns how many went.
 */
export function purgePreMigrationBackups(root: string, now: number, liveVersion: number, retention = false): number {
  let deleted = 0;
  for (const backup of preMigrationBackups(root)) {
    if (backup.fromVersion >= liveVersion) continue;
    if (!retention && now < backup.deleteAfter) continue;
    rmSync(backup.path, { force: true });
    deleted++;
  }
  return deleted;
}

/**
 * Whether a copy already beside the database is one worth keeping: a database
 * SQLite finds nothing wrong with, at the version it claims in its name. A copy
 * a run that died after writing it left behind is therefore kept rather than
 * taken again; anything else is written over, atomically.
 *
 * Opened immutable, so reading it leaves no -wal or -shm beside it.
 */
export function preMigrationBackupHolds(path: string, fromVersion: number): boolean {
  if (!existsSync(path)) return false;
  let db: DatabaseSync;
  try {
    db = new (sqlite().DatabaseSync)(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
  } catch {
    return false;
  }
  try {
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)?.user_version;
    if (version !== fromVersion) return false;
    const problems = db
      .prepare("PRAGMA integrity_check")
      .all()
      .map((row) => (row as { integrity_check: string }).integrity_check);
    return problems.length === 1 && problems[0] === "ok";
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** The bytes a copy of the database would need: the file and the log that belongs to it. */
export function databaseBytes(path: string): number {
  return ["", "-wal"].reduce((sum, suffix) => {
    try {
      return sum + statSync(`${path}${suffix}`).size;
    } catch {
      return sum;
    }
  }, 0);
}

/** What the filesystem holding `dir` reports as free to this user. */
function freeSpace(dir: string): number {
  const stats = statfsSync(dir);
  return stats.bavail * stats.bsize;
}

/**
 * Refuses before the first byte when the disk cannot hold the copy, so a full
 * disk is one clean error instead of a half-written file. A filesystem that
 * will not answer is not an objection: the write itself then decides.
 */
export function assertRoomForBackup(dbPath: string, dir: string, freeBytes: (dir: string) => number = freeSpace): void {
  let free: number;
  try {
    free = freeBytes(dir);
  } catch {
    return;
  }
  const need = databaseBytes(dbPath) + SPACE_MARGIN_BYTES;
  if (free >= need) return;
  throw new StorageError(
    "BACKUP_FAILED",
    "The account database cannot be copied before its upgrade: the disk has less free space than the copy needs, so nothing was migrated.",
    PRE_MIGRATION_FIX
  );
}
