/**
 * The files an earlier wazap wrote, once the account database holds what they
 * held: moved aside, then deleted a week later. Only what wazap moved is ever
 * deleted, and only through the record the database keeps of it.
 *
 * - Per account, once the import is `done` or `imported`, `store.json`,
 *   `history/`, `retention.json`, `notes.json`, `recall/` and their `.tmp`
 *   leftovers are renamed into `accounts/<id>/legacy/` (0700; `legacy-<n>/`
 *   when `legacy` is taken by something that is not a directory). The plan,
 *   with every destination, is written before the first rename, so a crash
 *   leaves the rest to the next pass and every moved entry recorded; the move
 *   is recorded as done (`legacy_moved_at`, `legacy_entries`) when none is
 *   left, and then the service never looks at those paths again. A link is
 *   never moved or deleted. `auth/`, `media/`, `previews/` and `webhook.json`
 *   stay. A `skipped` database moves nothing: the files are another number's,
 *   never imported here, and wait for that number to link again.
 * - The recorded entries are deleted a week after `legacy_moved_at` (the later
 *   of the move and the entries' own mtimes), at once with WAZAP_RETENTION=1;
 *   the folder goes only if nothing else is in it. An import whose
 *   verification found differences it could not explain (`imported`) records
 *   `legacy_keep=unverified`, and nothing deletes its files.
 * - A beta archive is retired only once imported: `<data dir>/archive.sqlite`
 *   when every enabled account linked to its number carries `beta_imported`
 *   for it and a `done` import, `accounts/<id>/archive.sqlite` when its own
 *   account does. It moves into the legacy folder beside it, with its mtime
 *   set to the move, and is deleted a week later (at once under retention).
 *   An archive nobody linked imported stays where it is.
 * - A database set aside when a different number linked
 *   (`wazap.<ms>.previous-owner.sqlite`, with its -wal and -shm) is deleted a
 *   week after the later of its name's time and its files' mtime, whatever
 *   WAZAP_RETENTION says, and never while its number is linked to an enabled
 *   account (which takes it back, see `WhatsAppService.claimDatabase`).
 *
 * The service runs these at boot and daily (`WhatsAppService.retireLegacy`);
 * `wazap status` reads the same state without changing anything
 * (`storage-status.ts`). Nothing here reads a legacy file's contents except a
 * beta archive's identity.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  utimesSync,
  type Stats,
} from "node:fs";
import { basename, join } from "node:path";
import { AccountRegistry } from "./accounts.js";
import { readLinkedAccount } from "./auth-state.js";
import { accountPaths, type AccountPaths } from "./config.js";
import { AccountDb } from "./db/index.js";
import { IMPORT_META, readBetaIdentity, sameBetaImport, type BetaIdentity } from "./legacy-import/index.js";

/** The folder legacy files move into, in an account dir and in the data dir. */
export const LEGACY_DIR = "legacy";
/** How long moved legacy files, a moved beta archive and a set-aside database are kept. */
export const LEGACY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LEGACY_META = {
  /** `{ dir, moves: [[from, to]] }`, written before the first rename and cleared when the move is recorded. */
  plan: "legacy_plan",
  /** Epoch ms the week counts from: the later of the move and the newest mtime among the moved entries. */
  movedAt: "legacy_moved_at",
  /** `{ dir, names }`: what the move put in `dir`, the only things ever deleted from it. */
  entries: "legacy_entries",
  /** "unverified": the import could not explain every difference, so nothing deletes the entries. */
  keep: "legacy_keep",
  /** Epoch ms the entries were deleted (or found to be none), so later passes look no further. */
  deletedAt: "legacy_deleted_at",
  /** `[{ name, movedAt }]`: an account-dir beta archive moved into the legacy folder, deleted on its own week. */
  archives: "legacy_archives",
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
const WAL_FILE = "-wal";
const SIDE_FILES = [WAL_FILE, "-shm"] as const;
const PREVIOUS_OWNER = /^wazap\.(\d+)\.previous-owner\.sqlite(-wal|-shm)?$/;
const MOVED_ARCHIVE = /^archive(?:\.\d+(?:\.\d+)?)?\.sqlite$/;
const LEGACY_DIR_NAME = /^legacy(?:-\d+)?$/;
const DB_FILE = "wazap.sqlite";
const DIR_MODE = 0o700;
/** Import states after which the account's own legacy files are no longer read. */
const RETIRED_STATES = new Set(["done", "imported"]);
/** Every legacy record a database keeps; carried whole from a database set aside to the one that follows it. */
const CARRIED_META = [LEGACY_META.plan, LEGACY_META.movedAt, LEGACY_META.entries, LEGACY_META.keep, LEGACY_META.deletedAt, LEGACY_META.archives];

type MetaDb = Pick<AccountDb, "getMeta" | "setMeta" | "transaction">;

function lstatOf(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function present(path: string): boolean {
  return lstatOf(path) !== null;
}

/** A file or a directory, not a link: the only kind wazap moves or deletes. */
function isReal(path: string): boolean {
  const stat = lstatOf(path);
  return stat !== null && (stat.isFile() || stat.isDirectory());
}

function isRealFile(path: string): boolean {
  return lstatOf(path)?.isFile() === true;
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

function tryRmdir(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // holds something wazap did not put there, or is gone
  }
}

function readJson<T>(db: Pick<AccountDb, "getMeta">, key: string): T | null {
  const value = db.getMeta(key);
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function metaTime(db: Pick<AccountDb, "getMeta">, key: string): number | null {
  const value = Number(db.getMeta(key));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** A plain name inside a folder, as the database recorded it: never a path that leaves the folder. */
function plainName(name: unknown): name is string {
  return typeof name === "string" && name !== "" && name !== "." && name !== ".." && basename(name) === name;
}

/** The legacy folder under `base`: `legacy`, or `legacy-<n>` when that name is taken by a file or a link. */
export function legacyDirName(base: string): string {
  for (let n = 0; ; n++) {
    const name = n === 0 ? LEGACY_DIR : `${LEGACY_DIR}-${n}`;
    const stat = lstatOf(join(base, name));
    if (stat === null || stat.isDirectory()) return name;
  }
}

/** `name` in `base/dir`, or a free name beside it: nothing already there is overwritten. */
function freeName(base: string, dir: string, name: string, now: number, taken: ReadonlySet<string> = new Set()): string {
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : n === 1 ? `${name}.${now}` : `${name}.${now}.${n - 1}`;
    if (!taken.has(candidate) && !present(join(base, dir, candidate))) return candidate;
  }
}

/** The newest mtime of an entry and, for a folder, of what it holds directly. */
function newestMtime(path: string): number {
  const stat = lstatOf(path);
  if (stat === null) return 0;
  let newest = Math.floor(stat.mtimeMs);
  if (stat.isDirectory()) {
    try {
      for (const name of readdirSync(path)) newest = Math.max(newest, Math.floor(lstatOf(join(path, name))?.mtimeMs ?? 0));
    } catch {
      // unreadable: the folder's own time stands
    }
  }
  return newest;
}

/** The legacy entries still at their old place in an account dir: files and folders, never links. */
export function legacyEntriesInPlace(root: string): string[] {
  return ACCOUNT_LEGACY_ENTRIES.filter((name) => isReal(join(root, name)));
}

/** Legacy entries that are symbolic links: never moved or deleted, only reported. */
export function legacyLinksInPlace(root: string): string[] {
  return ACCOUNT_LEGACY_ENTRIES.filter((name) => lstatOf(join(root, name))?.isSymbolicLink() === true);
}

interface MovePlan {
  dir: string;
  moves: Array<[from: string, to: string]>;
  /** The newest mtime among the entries, read before any rename: moving a folder can touch its own. */
  newest: number;
}

interface MovedEntries {
  dir: string;
  names: string[];
}

/**
 * Moves an account's legacy entries into its legacy folder once its import no
 * longer reads them, and records the move when none is left. Idempotent: with
 * the move recorded it touches nothing.
 */
export function moveAccountLegacy(root: string, db: MetaDb, now: number): { moved: number; recorded: boolean } {
  const state = db.getMeta(IMPORT_META.state);
  if (state === null || !RETIRED_STATES.has(state)) return { moved: 0, recorded: false };
  let plan = readJson<MovePlan>(db, LEGACY_META.plan);
  if (plan === null && db.getMeta(LEGACY_META.movedAt) !== null) return { moved: 0, recorded: false };
  if (plan === null || !plainName(plan.dir) || !LEGACY_DIR_NAME.test(plan.dir) || !Array.isArray(plan.moves)) {
    const dir = legacyDirName(root);
    const taken = new Set<string>();
    const entries = legacyEntriesInPlace(root);
    const moves: MovePlan["moves"] = entries.map((name) => {
      const to = freeName(root, dir, name, now, taken);
      taken.add(to);
      return [name, to];
    });
    plan = { dir, moves, newest: entries.reduce((at, name) => Math.max(at, newestMtime(join(root, name))), 0) };
    db.setMeta(LEGACY_META.plan, JSON.stringify(plan));
  }
  const dir = join(root, plan.dir);
  let moved = 0;
  for (let i = 0; i < plan.moves.length; i++) {
    const [from, planned] = plan.moves[i]!;
    if (!plainName(from) || !plainName(planned) || !(ACCOUNT_LEGACY_ENTRIES as readonly string[]).includes(from)) continue;
    if (!isReal(join(root, from))) continue;
    if (moved === 0) ensureDir(dir);
    let to = planned;
    if (present(join(dir, to))) {
      to = freeName(root, plan.dir, from, now, new Set(plan.moves.map(([, name]) => name)));
      plan.moves[i] = [from, to];
      db.setMeta(LEGACY_META.plan, JSON.stringify(plan));
    }
    renameSync(join(root, from), join(dir, to));
    moved++;
  }
  if (moved > 0) {
    syncDir(dir);
    syncDir(root);
  }
  const names = plan.moves.map(([, to]) => to).filter((to) => plainName(to) && present(join(dir, to)));
  const movedAt = Math.max(now, Number.isSafeInteger(plan.newest) ? plan.newest : 0);
  db.transaction(() => {
    db.setMeta(LEGACY_META.movedAt, String(movedAt));
    db.setMeta(LEGACY_META.entries, names.length === 0 ? null : JSON.stringify({ dir: plan.dir, names } satisfies MovedEntries));
    db.setMeta(LEGACY_META.keep, state === "imported" && names.length > 0 ? "unverified" : null);
    // With nothing moved there is nothing to delete either.
    db.setMeta(LEGACY_META.deletedAt, names.length === 0 ? String(now) : null);
    db.setMeta(LEGACY_META.plan, null);
  });
  return { moved, recorded: true };
}

export interface LegacySchedule {
  movedAt: number;
  /** When the moved entries may go; null while they are kept. */
  deleteAfter: number | null;
  kept: "unverified" | null;
  deletedAt: number | null;
  /** The folder the entries went into, and the entries. */
  dir: string | null;
  names: string[];
}

/** What the database recorded about the account's moved legacy entries, or null when nothing moved. */
export function legacySchedule(db: Pick<AccountDb, "getMeta">): LegacySchedule | null {
  const movedAt = metaTime(db, LEGACY_META.movedAt);
  if (movedAt === null) return null;
  const kept = db.getMeta(LEGACY_META.keep) === "unverified" ? "unverified" : null;
  const entries = readJson<MovedEntries>(db, LEGACY_META.entries);
  const valid = entries !== null && plainName(entries.dir) && LEGACY_DIR_NAME.test(entries.dir) && Array.isArray(entries.names);
  return {
    movedAt,
    deleteAfter: kept === null ? movedAt + LEGACY_TTL_MS : null,
    kept,
    deletedAt: metaTime(db, LEGACY_META.deletedAt),
    dir: valid ? entries.dir : null,
    names: valid ? entries.names.filter(plainName) : [],
  };
}

/**
 * Deletes what the move recorded when its week is up, or at once under
 * retention, then the folder if nothing else is in it. Returns how many
 * entries it deleted, or null when nothing was due.
 */
export function purgeAccountLegacy(root: string, db: MetaDb, now: number, retention: boolean): number | null {
  const schedule = legacySchedule(db);
  if (schedule === null || schedule.deleteAfter === null || schedule.deletedAt !== null) return null;
  if (!retention && now < schedule.deleteAfter) return null;
  let deleted = 0;
  if (schedule.dir !== null) {
    const dir = join(root, schedule.dir);
    for (const name of schedule.names) {
      if (!isReal(join(dir, name))) continue;
      rmSync(join(dir, name), { recursive: true, force: true });
      deleted++;
    }
    tryRmdir(dir);
  }
  db.setMeta(LEGACY_META.deletedAt, String(now));
  return deleted;
}

/** Copies every legacy record of the database being set aside onto the one that serves next. */
export function carryLegacyRecord(from: Record<string, string | null>, to: MetaDb): void {
  if (CARRIED_META.every((key) => from[key] === null || from[key] === undefined)) return;
  to.transaction(() => {
    for (const key of CARRIED_META) to.setMeta(key, from[key] ?? null);
  });
}

/** The legacy records of a database, read before it is closed and set aside. */
export function legacyRecordOf(db: Pick<AccountDb, "getMeta">): Record<string, string | null> {
  return Object.fromEntries(CARRIED_META.map((key) => [key, db.getMeta(key)]));
}

/**
 * An account database opened for reading, which changes neither the file nor
 * its write-ahead log: what every process that is not the server reads through.
 *
 * The write-ahead log is the only place a commit can be that the database file
 * does not hold yet, so whether one lies beside the file decides how it opens.
 * With a log — a server has the database, or a crash left one behind — it opens
 * read-only and reads the log too, so the answer includes what the server
 * committed a moment ago; that takes a read lock in the -shm, SQLite's index of
 * the log, which is shared memory the server rebuilds at will and holds nothing
 * of its own. Without a log there is nothing to read past the file, so it opens
 * immutable and not even a -shm appears beside a closed database.
 *
 * Deciding on the -shm instead would read a crashed account stale: its log is
 * there and holds messages, and an -shm the system cleaned away is no reason to
 * report the counts of the last checkpoint as if they were current.
 */
export function openForReading(path: string): AccountDb {
  const log = existsSync(`${path}${WAL_FILE}`);
  return AccountDb.open(path, { readOnly: true, immutable: !log });
}

export interface PreviousOwnerDb {
  /** The database's file name, `wazap.<ms>.previous-owner.sqlite`; its -wal and -shm go with it. */
  file: string;
  bytes: number;
  setAsideAt: number;
  deleteAfter: number;
}

/** The databases a different number's link set aside in an account dir, oldest first. */
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
    const stat = lstatOf(join(root, name));
    if (stat === null || !stat.isFile()) continue;
    const file = name.slice(0, name.length - (match[2]?.length ?? 0));
    const group = groups.get(file) ?? { file, bytes: 0, setAsideAt: Number(match[1]), deleteAfter: 0 };
    group.bytes += stat.size;
    group.setAsideAt = Math.max(group.setAsideAt, Math.floor(stat.mtimeMs));
    group.deleteAfter = group.setAsideAt + LEGACY_TTL_MS;
    groups.set(file, group);
  }
  return [...groups.values()].sort((a, b) => a.setAsideAt - b.setAsideAt);
}

/** The number a set-aside database belongs to, or null when it has none or cannot be read. */
export function previousOwnerOf(root: string, file: string): string | null {
  try {
    const db = openForReading(join(root, file));
    try {
      return db.getMeta("owner");
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** The newest database set aside for `owner`, by file name; null when there is none. */
export function setAsideFor(root: string, owner: string): string | null {
  const own = previousOwnerDbs(root).filter((db) => isRealFile(join(root, db.file)) && previousOwnerOf(root, db.file) === owner);
  return own.length === 0 ? null : own[own.length - 1]!.file;
}

/** The numbers linked to the data dir's enabled accounts: the credentials, or the owner the registry recorded. */
export function linkedOwners(dataDir: string): Set<string> {
  const owners = new Set<string>();
  let records;
  try {
    records = AccountRegistry.load(dataDir).all();
  } catch {
    return owners;
  }
  for (const record of records) {
    if (!record.enabled) continue;
    let linked: string | null;
    try {
      linked = readLinkedAccount(accountPaths(dataDir, record.id).authDir)?.id ?? record.owner;
    } catch {
      linked = record.owner;
    }
    if (linked !== null) owners.add(linked);
  }
  return owners;
}

/**
 * Deletes the set-aside databases whose week is up, keeping any whose number
 * is linked to an enabled account or cannot be read. WAZAP_RETENTION does not
 * shorten the week: a set-aside database is a whole history, not a copy.
 */
export function purgePreviousOwners(root: string, now: number, linked: ReadonlySet<string>): number {
  let deleted = 0;
  for (const db of previousOwnerDbs(root)) {
    if (now < db.deleteAfter) continue;
    const owner = previousOwnerOf(root, db.file);
    if (owner === null || linked.has(owner)) continue;
    // The database file last: a pass cut short still finds the group by it.
    for (const suffix of [...SIDE_FILES, ""]) rmSync(join(root, `${db.file}${suffix}`), { force: true });
    deleted++;
  }
  return deleted;
}

// Beta archives ------------------------------------------------------------------

/** What an account database says about the beta archive: its import's state, and the archive it imported. */
export interface AccountBetaState {
  importState: string | null;
  betaImported: string | null;
}

export function accountBetaState(db: Pick<AccountDb, "getMeta">): AccountBetaState {
  return { importState: db.getMeta(IMPORT_META.state), betaImported: db.getMeta(IMPORT_META.betaImported) };
}

function readAccountBetaState(dbPath: string): AccountBetaState {
  try {
    const db = openForReading(dbPath);
    try {
      return accountBetaState(db);
    } finally {
      db.close();
    }
  } catch {
    return { importState: null, betaImported: null };
  }
}

/** Whether a database's import is done and took this very archive. */
export function importedArchive(state: AccountBetaState, identity: BetaIdentity): boolean {
  return state.importState === "done" && sameBetaImport(state.betaImported, identity);
}

export interface ArchiveOwnerAccount {
  id: string;
  importState: string | null;
  /** Its import is done and recorded this archive. */
  imported: boolean;
}

export interface BetaArchiveStatus {
  /** `in-place`: still at `<data dir>/archive.sqlite`; `moved`: in the data dir's legacy folder. */
  place: "in-place" | "moved";
  path: string;
  bytes: number;
  /** In place: the enabled accounts linked to its number; empty when none is, or it cannot be read. */
  accounts: ArchiveOwnerAccount[];
  ownerReadable: boolean;
  /** Moved: when (its mtime) and when it may be deleted. */
  movedAt: number | null;
  deleteAfter: number | null;
}

type StateOf = (id: string) => AccountBetaState | undefined;

function ownerAccounts(dataDir: string, identity: BetaIdentity, stateOf?: StateOf): ArchiveOwnerAccount[] {
  if (identity.owner === null) return [];
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
    if (linked !== identity.owner) return [];
    const state = stateOf?.(record.id) ?? readAccountBetaState(join(paths.root, DB_FILE));
    return [{ id: record.id, importState: state.importState, imported: importedArchive(state, identity) }];
  });
}

function mtimeOf(path: string): number | null {
  const stat = lstatOf(path);
  return stat === null ? null : Math.floor(stat.mtimeMs);
}

function bytesOf(path: string): number {
  return ["", ...SIDE_FILES].reduce((sum, suffix) => sum + (lstatOf(`${path}${suffix}`)?.size ?? 0), 0);
}

/** The legacy folders directly under `base` that are real directories. */
function legacyDirs(base: string): string[] {
  try {
    return readdirSync(base)
      .filter((name) => LEGACY_DIR_NAME.test(name) && lstatOf(join(base, name))?.isDirectory() === true)
      .sort();
  } catch {
    return [];
  }
}

/** Beta archives a pass moved into the data dir's legacy folders, oldest first. */
function movedArchives(base: string): Array<{ path: string; movedAt: number }> {
  const found: Array<{ path: string; movedAt: number }> = [];
  for (const dir of legacyDirs(base)) {
    let names: string[];
    try {
      names = readdirSync(join(base, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(base, dir, name);
      if (!MOVED_ARCHIVE.test(name) || !isRealFile(path)) continue;
      found.push({ path, movedAt: mtimeOf(path)! });
    }
  }
  return found.sort((a, b) => a.movedAt - b.movedAt);
}

/** Where the data dir's beta archive is and who it waits for, without changing anything. Null when there is none. */
export function betaArchiveStatus(dataDir: string, stateOf?: StateOf): BetaArchiveStatus | null {
  const inPlace = join(dataDir, BETA_ARCHIVE);
  if (isRealFile(inPlace)) {
    const identity = readBetaIdentity(inPlace);
    return {
      place: "in-place",
      path: inPlace,
      bytes: bytesOf(inPlace),
      accounts: identity === null ? [] : ownerAccounts(dataDir, identity, stateOf),
      ownerReadable: identity !== null && identity.owner !== null,
      movedAt: null,
      deleteAfter: null,
    };
  }
  const moved = movedArchives(dataDir).at(-1);
  if (moved === undefined) return null;
  return {
    place: "moved",
    path: moved.path,
    bytes: bytesOf(moved.path),
    accounts: [],
    ownerReadable: true,
    movedAt: moved.movedAt,
    deleteAfter: moved.movedAt + LEGACY_TTL_MS,
  };
}

/**
 * Renames an archive, then its -wal and -shm, into the legacy folder under
 * `base`, under a free name, its mtime first set to the later of now and its
 * files' own. Returns the new path.
 */
function moveArchive(from: string, base: string, now: number): string {
  const dirName = legacyDirName(base);
  const dir = join(base, dirName);
  ensureDir(dir);
  const at = ["", ...SIDE_FILES].reduce((latest, suffix) => Math.max(latest, mtimeOf(`${from}${suffix}`) ?? 0), now);
  let name = BETA_ARCHIVE;
  for (let n = 0; ["", ...SIDE_FILES].some((suffix) => present(join(dir, `${name}${suffix}`))); n++) {
    name = n === 0 ? `archive.${now}.sqlite` : `archive.${now}.${n}.sqlite`;
  }
  const to = join(dir, name);
  utimesSync(from, at / 1000, at / 1000);
  renameSync(from, to);
  for (const suffix of SIDE_FILES) if (present(`${from}${suffix}`)) renameSync(`${from}${suffix}`, `${to}${suffix}`);
  syncDir(dir);
  syncDir(base);
  return to;
}

/** A -wal or -shm left behind by a crash after its archive moved: it follows the newest moved archive lacking it. */
function followSideFiles(from: string, targets: readonly string[]): boolean {
  if (present(from)) return false;
  let left = false;
  for (const suffix of SIDE_FILES) {
    if (!isRealFile(`${from}${suffix}`)) continue;
    const target = [...targets].reverse().find((path) => !present(`${path}${suffix}`));
    if (target === undefined) left = true;
    else renameSync(`${from}${suffix}`, `${target}${suffix}`);
  }
  return left;
}

function deleteArchive(path: string): void {
  for (const suffix of [...SIDE_FILES, ""]) rmSync(`${path}${suffix}`, { force: true });
}

/**
 * Moves the data dir's beta archive aside once every enabled account linked to
 * its number imported it, and deletes moved archives a week after their move
 * (at once under retention). Idempotent and safe to run from every account's service.
 */
export function settleBetaArchive(dataDir: string, now: number, retention: boolean, stateOf?: StateOf): { moved: boolean; deleted: number } {
  const from = join(dataDir, BETA_ARCHIVE);
  let moved = false;
  const status = isRealFile(from) ? betaArchiveStatus(dataDir, stateOf) : null;
  if (status !== null && status.accounts.length > 0 && status.accounts.every((account) => account.imported)) {
    moveArchive(from, dataDir, now);
    moved = true;
  }
  const archives = movedArchives(dataDir);
  if (followSideFiles(from, archives.map((archive) => archive.path))) return { moved, deleted: 0 };
  let deleted = 0;
  for (const archive of archives) {
    if (!retention && now < archive.movedAt + LEGACY_TTL_MS) continue;
    deleteArchive(archive.path);
    deleted++;
  }
  if (deleted > 0) for (const dir of legacyDirs(dataDir)) tryRmdir(join(dataDir, dir));
  return { moved, deleted };
}

/**
 * A beta archive the account's linked number owns and its database has not
 * imported: in place in the data dir or the account dir, or moved aside by
 * another account's pass and not deleted yet. Null when there is none, the
 * account is not linked, or its own import has not finished.
 */
export function lateBetaArchive(dataDir: string, paths: AccountPaths, db: Pick<AccountDb, "getMeta">): string | null {
  const state = db.getMeta(IMPORT_META.state);
  if (state !== "done" && state !== "imported") return null;
  let owner: string | null;
  try {
    owner = readLinkedAccount(paths.authDir)?.id ?? null;
  } catch {
    owner = null;
  }
  if (owner === null) return null;
  const candidates = [join(dataDir, BETA_ARCHIVE), join(paths.root, BETA_ARCHIVE), ...movedArchives(dataDir).map((archive) => archive.path).reverse()];
  for (const path of candidates) {
    if (!isRealFile(path)) continue;
    const identity = readBetaIdentity(path);
    if (identity === null || identity.owner !== owner || sameBetaImport(db.getMeta(IMPORT_META.betaImported), identity)) continue;
    return path;
  }
  return null;
}

interface MovedArchive {
  name: string;
  dir: string;
  movedAt: number;
}

/**
 * The same for an archive in the account dir, which only its own account can
 * have imported: moved once this database recorded it, and tracked in the
 * database, so a pass never lists the legacy folder to find it.
 */
export function settleAccountArchive(root: string, db: MetaDb, now: number, retention: boolean): { moved: boolean; deleted: number } {
  const from = join(root, BETA_ARCHIVE);
  const recorded = (readJson<MovedArchive[]>(db, LEGACY_META.archives) ?? []).filter(
    (entry) => plainName(entry?.name) && plainName(entry?.dir) && LEGACY_DIR_NAME.test(entry.dir) && Number.isSafeInteger(entry.movedAt)
  );
  let changed = false;
  let moved = false;
  if (isRealFile(from)) {
    const identity = readBetaIdentity(from);
    if (identity !== null && importedArchive(accountBetaState(db), identity)) {
      const to = moveArchive(from, root, now);
      recorded.push({ name: basename(to), dir: basename(join(to, "..")), movedAt: mtimeOf(to) ?? now });
      changed = moved = true;
    }
  }
  const paths = recorded.map((entry) => join(root, entry.dir, entry.name));
  let deleted = 0;
  if (!followSideFiles(from, paths)) {
    for (let i = recorded.length - 1; i >= 0; i--) {
      const entry = recorded[i]!;
      if (!retention && now < entry.movedAt + LEGACY_TTL_MS) continue;
      deleteArchive(join(root, entry.dir, entry.name));
      tryRmdir(join(root, entry.dir));
      recorded.splice(i, 1);
      changed = true;
      deleted++;
    }
  }
  if (changed) db.setMeta(LEGACY_META.archives, recorded.length === 0 ? null : JSON.stringify(recorded));
  return { moved, deleted };
}
