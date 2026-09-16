/**
 * The files an earlier wazap wrote, once the account database holds what they
 * held: moved aside, then deleted a week later.
 *
 * - Per account, once the import is `done` (or `imported`, or `skipped` for a
 *   database a different number's link set aside), `store.json`, `history/`,
 *   `retention.json`, `notes.json`, `recall/` and their `.tmp` leftovers are
 *   renamed into `accounts/<id>/legacy/` (0700), and `legacy_moved_at` is
 *   recorded once every one of them has moved. A crash between two renames
 *   leaves the record unwritten, so the next boot moves the rest; once it is
 *   written the service never looks at those paths again. `auth/`, `media/`,
 *   `previews/` and `webhook.json` are the running service's own and stay.
 * - `legacy/` is deleted a week after the move, at once with
 *   WAZAP_RETENTION=1. An import whose verification found differences it could
 *   not explain (`imported`) records `legacy_keep=unverified`: its files stay
 *   until the user deletes them. So does a `legacy/` this database did not
 *   move (`inherited`: a different number linked, and the set-aside database
 *   holds the schedule); a crash after the last rename is told apart from it
 *   by `legacy_moving`, written before the first.
 * - The 0.15-beta `<data dir>/archive.sqlite` moves to `<data dir>/legacy/`
 *   once every enabled account linked to its number has imported it (`done`).
 *   Its mtime is set to the move first, so the week counts from there. An
 *   archive no enabled account is linked to stays where it is: nothing proves
 *   whose it is.
 * - A database set aside when a different number linked
 *   (`wazap.<ms>.previous-owner.sqlite`, with its -wal and -shm) is deleted a
 *   week after the later of its name's time and its files' mtime.
 *
 * The service runs these at boot and daily (`WhatsAppService.retireLegacy`);
 * doctor reads the same state without changing anything (`storage-status.ts`).
 * Nothing here reads a legacy file's contents except the archive's owner.
 */
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { AccountRegistry } from "./accounts.js";
import { readLinkedAccount } from "./auth-state.js";
import { accountPaths } from "./config.js";
import { AccountDb } from "./db/index.js";
import { IMPORT_META } from "./legacy-import/index.js";
import { betaOwner, openBetaArchive } from "./legacy-import/sources.js";

/** The folder legacy files move into, in an account dir and in the data dir. */
export const LEGACY_DIR = "legacy";
/** How long moved legacy files, the moved beta archive and a set-aside database are kept. */
export const LEGACY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LEGACY_META = {
  /** Epoch ms the last legacy entry left its place; absent until every one has. */
  movedAt: "legacy_moved_at",
  /**
   * Why nothing deletes `legacy/`: "unverified", the import could not explain
   * every difference; "inherited", the folder was there before this database
   * moved anything (a database set aside by a different number's link recorded
   * its schedule, not this one).
   */
  keep: "legacy_keep",
  /** Epoch ms a move started; tells a move of ours a crash cut short from a folder we inherited. */
  moving: "legacy_moving",
  /** Epoch ms `legacy/` was deleted, so later passes look no further. */
  deletedAt: "legacy_deleted_at",
} as const;

/** What an account dir holds that only the legacy service wrote and the import read. */
export const ACCOUNT_LEGACY_ENTRIES = [
  "store.json",
  "store.json.tmp",
  "history",
  "retention.json",
  "retention.json.tmp",
  "notes.json",
  "notes.json.tmp",
  "recall",
] as const;

export const BETA_ARCHIVE = "archive.sqlite";
const SIDE_FILES = ["-wal", "-shm"] as const;
const PREVIOUS_OWNER = /^wazap\.(\d+)\.previous-owner\.sqlite(-wal|-shm)?$/;
const DB_FILE = "wazap.sqlite";
const DIR_MODE = 0o700;
/** Import states after which the legacy files are no longer read. */
const RETIRED_STATES = new Set(["done", "imported", "skipped"]);

type MetaDb = Pick<AccountDb, "getMeta" | "setMeta" | "transaction">;

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Makes a rename durable; a filesystem that cannot sync a directory keeps the rename anyway. */
function syncDir(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // not supported here (Windows)
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  if (process.platform !== "win32") chmodSync(path, DIR_MODE);
}

/** `name` in `dir`, or a name beside it that is still free: nothing already moved is overwritten. */
function freeName(dir: string, name: string, now: number): string {
  let candidate = join(dir, name);
  for (let n = 0; present(candidate); n++) candidate = join(dir, n === 0 ? `${name}.${now}` : `${name}.${now}.${n}`);
  return candidate;
}

/** The legacy entries still at their old place in an account dir. */
export function legacyEntriesInPlace(root: string): string[] {
  return ACCOUNT_LEGACY_ENTRIES.filter((name) => present(join(root, name)));
}

/**
 * Moves an account's legacy entries into `legacy/` once its import no longer
 * reads them, and records the move when none is left. Idempotent: with the
 * move recorded it touches nothing.
 */
export function moveAccountLegacy(root: string, db: MetaDb, now: number): { moved: number; recorded: boolean } {
  const state = db.getMeta(IMPORT_META.state);
  if (state === null || !RETIRED_STATES.has(state) || db.getMeta(LEGACY_META.movedAt) !== null) {
    return { moved: 0, recorded: false };
  }
  const dir = join(root, LEGACY_DIR);
  const entries = legacyEntriesInPlace(root);
  if (entries.length > 0 && db.getMeta(LEGACY_META.moving) === null) db.setMeta(LEGACY_META.moving, String(now));
  let moved = 0;
  for (const name of entries) {
    if (moved === 0) ensureDir(dir);
    renameSync(join(root, name), freeName(dir, name, now));
    moved++;
  }
  if (moved > 0) {
    syncDir(dir);
    syncDir(root);
  }
  const ours = db.getMeta(LEGACY_META.moving) !== null;
  const folder = present(dir);
  const keep = !folder ? null : state === "imported" ? "unverified" : ours ? null : "inherited";
  db.transaction(() => {
    db.setMeta(LEGACY_META.movedAt, String(now));
    db.setMeta(LEGACY_META.keep, keep);
    db.setMeta(LEGACY_META.moving, null);
    // With no legacy/ at all there is nothing to delete either.
    if (!folder) db.setMeta(LEGACY_META.deletedAt, String(now));
  });
  return { moved, recorded: true };
}

export interface LegacySchedule {
  movedAt: number;
  /** When `legacy/` may go; null while it is kept. */
  deleteAfter: number | null;
  /** Why it is kept: see LEGACY_META.keep. */
  kept: "unverified" | "inherited" | null;
  deletedAt: number | null;
}

function metaTime(db: Pick<AccountDb, "getMeta">, key: string): number | null {
  const value = Number(db.getMeta(key));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** What the database recorded about the account's `legacy/`, or null when nothing moved. */
export function legacySchedule(db: Pick<AccountDb, "getMeta">): LegacySchedule | null {
  const movedAt = metaTime(db, LEGACY_META.movedAt);
  if (movedAt === null) return null;
  const keep = db.getMeta(LEGACY_META.keep);
  const kept = keep === null ? null : keep === "unverified" ? "unverified" : "inherited";
  return { movedAt, deleteAfter: kept === null ? movedAt + LEGACY_TTL_MS : null, kept, deletedAt: metaTime(db, LEGACY_META.deletedAt) };
}

/** Deletes the account's `legacy/` when its week is up, or at once under retention. Returns the entries it held. */
export function purgeAccountLegacy(root: string, db: MetaDb, now: number, retention: boolean): number | null {
  const schedule = legacySchedule(db);
  if (schedule === null || schedule.deleteAfter === null || schedule.deletedAt !== null) return null;
  if (!retention && now < schedule.deleteAfter) return null;
  const dir = join(root, LEGACY_DIR);
  let entries = 0;
  try {
    entries = readdirSync(dir).length;
  } catch {
    // already gone: a pass the process did not live to record
  }
  rmSync(dir, { recursive: true, force: true });
  db.setMeta(LEGACY_META.deletedAt, String(now));
  return entries;
}

export interface PreviousOwnerDb {
  /** The database's file name, `wazap.<ms>.previous-owner.sqlite`; its -wal and -shm go with it. */
  file: string;
  bytes: number;
  setAsideAt: number;
  deleteAfter: number;
}

/** The databases a different number's link set aside in an account dir. */
export function previousOwnerDbs(root: string): PreviousOwnerDb[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const groups = new Map<string, PreviousOwnerDb>();
  for (const name of names) {
    const match = PREVIOUS_OWNER.exec(name);
    if (match === null) continue;
    let stat;
    try {
      stat = statSync(join(root, name));
    } catch {
      continue;
    }
    const file = name.slice(0, name.length - (match[2]?.length ?? 0));
    const group = groups.get(file) ?? { file, bytes: 0, setAsideAt: Number(match[1]), deleteAfter: 0 };
    group.bytes += stat.size;
    group.setAsideAt = Math.max(group.setAsideAt, Math.floor(stat.mtimeMs));
    group.deleteAfter = group.setAsideAt + LEGACY_TTL_MS;
    groups.set(file, group);
  }
  return [...groups.values()].sort((a, b) => a.setAsideAt - b.setAsideAt);
}

/** Deletes the set-aside databases whose week is up (all of them under retention). Returns how many. */
export function purgePreviousOwners(root: string, now: number, retention: boolean): number {
  let deleted = 0;
  for (const db of previousOwnerDbs(root)) {
    if (!retention && now < db.deleteAfter) continue;
    // The database file last: a pass cut short still finds the group by it.
    for (const suffix of [...SIDE_FILES, ""]) rmSync(join(root, `${db.file}${suffix}`), { force: true });
    deleted++;
  }
  return deleted;
}

export interface ArchiveOwnerAccount {
  id: string;
  /** Its database's import_state, null when it has none or cannot be read. */
  importState: string | null;
}

export interface BetaArchiveStatus {
  /** `in-place`: still at `<data dir>/archive.sqlite`; `moved`: in `<data dir>/legacy/`. */
  place: "in-place" | "moved";
  path: string;
  bytes: number;
  /** The enabled accounts linked to its number; empty when none is, or its owner cannot be read. */
  accounts: ArchiveOwnerAccount[];
  ownerReadable: boolean;
  /** For a moved archive: when it moved (its mtime) and when it may be deleted. */
  movedAt: number | null;
  deleteAfter: number | null;
}

function archiveOwner(path: string): string | null {
  try {
    const archive = openBetaArchive(path);
    try {
      return betaOwner(archive);
    } finally {
      archive.close();
    }
  } catch {
    return null;
  }
}

/** An account database's import_state through a read-only connection; null when it has none. */
export function importStateAt(dbPath: string): string | null {
  try {
    const db = AccountDb.open(dbPath, { readOnly: true });
    try {
      return db.getMeta(IMPORT_META.state);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * The enabled accounts whose linked number (the credentials, or the owner the
 * registry recorded when they are unreadable) is `owner`. `stateOf` answers
 * for an account whose database the caller already holds.
 */
function ownerAccounts(dataDir: string, owner: string, stateOf?: (id: string) => string | null | undefined): ArchiveOwnerAccount[] {
  let records;
  try {
    records = AccountRegistry.load(dataDir).all();
  } catch {
    return [];
  }
  return records.flatMap((record) => {
    if (!record.enabled) return [];
    const paths = accountPaths(dataDir, record.id);
    let linked: string | null;
    try {
      linked = readLinkedAccount(paths.authDir)?.id ?? record.owner;
    } catch {
      linked = record.owner;
    }
    if (linked !== owner) return [];
    const known = stateOf?.(record.id);
    return [{ id: record.id, importState: known === undefined ? importStateAt(join(paths.root, DB_FILE)) : known }];
  });
}

function mtimeOf(path: string): number | null {
  try {
    return Math.floor(statSync(path).mtimeMs);
  } catch {
    return null;
  }
}

function bytesOf(path: string): number {
  return ["", ...SIDE_FILES].reduce((sum, suffix) => {
    try {
      return sum + statSync(`${path}${suffix}`).size;
    } catch {
      return sum;
    }
  }, 0);
}

/** Where the beta archive is and who it waits for, without changing anything. Null when there is none. */
export function betaArchiveStatus(dataDir: string, stateOf?: (id: string) => string | null | undefined): BetaArchiveStatus | null {
  const inPlace = join(dataDir, BETA_ARCHIVE);
  if (present(inPlace)) {
    const owner = archiveOwner(inPlace);
    return {
      place: "in-place",
      path: inPlace,
      bytes: bytesOf(inPlace),
      accounts: owner === null ? [] : ownerAccounts(dataDir, owner, stateOf),
      ownerReadable: owner !== null,
      movedAt: null,
      deleteAfter: null,
    };
  }
  const moved = join(dataDir, LEGACY_DIR, BETA_ARCHIVE);
  const movedAt = mtimeOf(moved);
  if (movedAt === null) return null;
  return { place: "moved", path: moved, bytes: bytesOf(moved), accounts: [], ownerReadable: true, movedAt, deleteAfter: movedAt + LEGACY_TTL_MS };
}

/**
 * Moves the beta archive aside once every enabled account linked to its
 * number has imported it, and deletes it a week after the move (at once under
 * retention). Idempotent and safe to run from every account's service.
 */
export function settleBetaArchive(
  dataDir: string,
  now: number,
  retention: boolean,
  stateOf?: (id: string) => string | null | undefined
): { moved: boolean; deleted: boolean } {
  const from = join(dataDir, BETA_ARCHIVE);
  const dir = join(dataDir, LEGACY_DIR);
  const to = join(dir, BETA_ARCHIVE);
  let moved = false;
  if (present(from)) {
    const status = betaArchiveStatus(dataDir, stateOf);
    const ready = status !== null && status.accounts.length > 0 && status.accounts.every((account) => account.importState === "done");
    if (ready && !present(to)) {
      ensureDir(dir);
      const seconds = now / 1000;
      utimesSync(from, seconds, seconds);
      renameSync(from, to);
      moved = true;
    }
  }
  if (present(from) || !present(to)) return { moved, deleted: false };
  // The database file moves first; its -wal and -shm follow, also after a crash between the renames.
  for (const suffix of SIDE_FILES) if (present(`${from}${suffix}`)) renameSync(`${from}${suffix}`, `${to}${suffix}`);
  if (moved) {
    syncDir(dir);
    syncDir(dataDir);
  }
  const movedAt = mtimeOf(to);
  if (movedAt === null || (!retention && now < movedAt + LEGACY_TTL_MS)) return { moved, deleted: false };
  for (const suffix of [...SIDE_FILES, ""]) rmSync(`${to}${suffix}`, { force: true });
  try {
    rmdirSync(dir);
  } catch {
    // holds something else
  }
  return { moved, deleted: true };
}
