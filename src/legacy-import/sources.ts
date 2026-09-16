/**
 * The legacy files of one account, read and never written: the store
 * snapshot, the per-chat history logs, the retention barriers, the notes, the
 * recall index and the beta archive. Every reader opens its file read-only;
 * the beta archive is opened immutable, so not even a `-shm` file appears next
 * to it.
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AccountPaths } from "../config.js";
import { sqlite, type DatabaseSync } from "../db/sqlite.js";
import type { HistoryRecord, StoreSnapshot } from "../store.js";

export interface LegacyPaths {
  root: string;
  storeFile: string;
  historyDir: string;
  retentionFile: string;
  notesFile: string;
  recallDir: string;
  authDir: string;
}

export function legacyPaths(paths: AccountPaths): LegacyPaths {
  return {
    root: paths.root,
    storeFile: paths.storeFile,
    historyDir: paths.historyDir,
    retentionFile: join(paths.root, "retention.json"),
    notesFile: paths.notesFile,
    recallDir: join(paths.root, "recall"),
    authDir: paths.authDir,
  };
}

function missing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** The snapshot, null when absent. An unreadable one is null too, the way the service boots past it. */
export function readSnapshot(path: string): { snapshot: StoreSnapshot | null; unreadable: boolean } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (missing(err)) return { snapshot: null, unreadable: false };
    return { snapshot: null, unreadable: true };
  }
  try {
    const snapshot = JSON.parse(text) as StoreSnapshot;
    return snapshot?.v === 1 ? { snapshot, unreadable: false } : { snapshot: null, unreadable: true };
  } catch {
    return { snapshot: null, unreadable: true };
  }
}

export interface RetentionFile {
  deleted: Array<[sid: string, jid: string]>;
  cleared: Array<[jid: string, at: number]>;
  expires: Array<[sid: string, jid: string, at: number]>;
  mtimeMs: number | null;
}

/**
 * The barriers, with MessageRetention.load's validation. An unreadable file
 * throws: the service refuses to replay history without its barriers, and so
 * does the import.
 */
export function readRetention(path: string): RetentionFile {
  let text: string;
  let mtimeMs: number;
  try {
    text = readFileSync(path, "utf8");
    mtimeMs = statSync(path).mtimeMs;
  } catch (err) {
    if (missing(err)) return { deleted: [], cleared: [], expires: [], mtimeMs: null };
    throw new Error("retention.json could not be read; refusing to import history without its deletion barriers.", { cause: err });
  }
  const refuse = (): never => {
    throw new Error("retention.json is malformed; refusing to import history without its deletion barriers.");
  };
  let value: { version?: unknown; deleted?: unknown; cleared?: unknown; expires?: unknown };
  try {
    value = JSON.parse(text) as typeof value;
  } catch {
    return refuse();
  }
  if (value?.version !== 1 || !Array.isArray(value.deleted) || !Array.isArray(value.cleared)) refuse();
  const out: RetentionFile = { deleted: [], cleared: [], expires: [], mtimeMs };
  for (const entry of value.deleted as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") refuse();
    out.deleted.push([(entry as string[])[0]!, (entry as string[])[1]!]);
  }
  for (const entry of value.cleared as unknown[]) {
    const e = entry as [unknown, unknown];
    if (!Array.isArray(entry) || entry.length !== 2 || typeof e[0] !== "string" || typeof e[1] !== "number" || !Number.isFinite(e[1]) || e[1] < 0) {
      refuse();
    }
    out.cleared.push([e[0] as string, e[1] as number]);
  }
  if (value.expires !== undefined) {
    if (!Array.isArray(value.expires)) refuse();
    for (const entry of value.expires as unknown[]) {
      const e = entry as [unknown, unknown, unknown];
      if (!Array.isArray(entry) || entry.length !== 3 || typeof e[0] !== "string" || typeof e[1] !== "string" || !Number.isSafeInteger(e[2]) || (e[2] as number) < 0) {
        refuse();
      }
      out.expires.push([e[0] as string, e[1] as string, e[2] as number]);
    }
  }
  return out;
}

export interface NotesFileShape {
  contacts: Record<string, { note?: unknown; updated_at?: unknown }>;
  handled: Record<string, { ask_id?: unknown; at?: unknown }>;
  fields: Record<string, { tags?: unknown; fields?: unknown }>;
}

/** notes.json, or null when absent or unreadable (the service then starts with no notes). */
export function readNotes(path: string): { notes: NotesFileShape | null; unreadable: boolean } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { notes: null, unreadable: !missing(err) };
  }
  try {
    const parsed = JSON.parse(text) as { v?: unknown } & Partial<NotesFileShape>;
    if (parsed?.v !== 1) return { notes: null, unreadable: true };
    return {
      notes: { contacts: parsed.contacts ?? {}, handled: parsed.handled ?? {}, fields: parsed.fields ?? {} },
      unreadable: false,
    };
  } catch {
    return { notes: null, unreadable: true };
  }
}

/** The history files, in a stable order. */
export function historyFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
  } catch (err) {
    if (missing(err)) return [];
    throw err;
  }
}

export interface HistoryFileRead {
  name: string;
  size: number;
  /** Every parsed record with a sid, in file order. */
  records: HistoryRecord[];
  malformed: number;
  partialTail: boolean;
}

/** One history file, parsed the way historyRecords does, with what it skips counted. */
export function readHistoryFile(dir: string, name: string): HistoryFileRead | null {
  let text: string;
  try {
    text = readFileSync(join(dir, name), "utf8");
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
  const lines = text.split("\n");
  const tail = text.length > 0 && !text.endsWith("\n");
  const out: HistoryFileRead = { name, size: Buffer.byteLength(text), records: [], malformed: 0, partialTail: false };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as HistoryRecord;
      if (!record || typeof record.sid !== "string" || record.sid === "") throw new Error("no sid");
      out.records.push(record);
    } catch {
      out.malformed++;
      if (tail && i === lines.length - 1) out.partialTail = true;
    }
  }
  return out;
}

export interface RecallState {
  model: string;
  dims: number;
  quant: string;
}

export interface RecallLive {
  sid: string;
  /** The put line's byte span in meta.jsonl. */
  offset: number;
  length: number;
}

export interface RecallIndex {
  state: RecallState;
  meta: Buffer;
  /** The live put of each sid, in log order. */
  live: RecallLive[];
  malformed: number;
  vectorsPath: string;
  vectorRows: number;
}

export interface RecallLine {
  op: "put";
  sid: string;
  jid: string;
  ts: number;
  sender: string;
  type: string;
  text: string;
  expiresAt?: number;
  model: string;
  row: number;
}

/**
 * The recall index as its replay sees it: the last put of each sid, a del
 * taking it out. Lines that do not parse are counted and skipped rather than
 * failing the whole index, so a torn last line costs one row, not all of them.
 */
export function readRecallIndex(dir: string): { index: RecallIndex | null; reason: string | null } {
  let state: RecallState;
  let meta: Buffer;
  const vectorsPath = join(dir, "vectors.bin");
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as Partial<RecallState>;
    if (typeof parsed.model !== "string" || typeof parsed.dims !== "number" || parsed.quant !== "int8") {
      return { index: null, reason: "state" };
    }
    state = { model: parsed.model, dims: parsed.dims, quant: parsed.quant };
    meta = readFileSync(join(dir, "meta.jsonl"));
    if (!existsSync(vectorsPath)) return { index: null, reason: "vectors" };
  } catch (err) {
    return { index: null, reason: missing(err) ? "absent" : "unreadable" };
  }
  const vectorRows = Math.floor(statSync(vectorsPath).size / state.dims);
  const live = new Map<string, RecallLive>();
  let malformed = 0;
  let start = 0;
  while (start < meta.length) {
    let end = meta.indexOf(0x0a, start);
    if (end === -1) end = meta.length;
    if (end > start) {
      try {
        const entry = JSON.parse(meta.toString("utf8", start, end)) as { op?: unknown; sid?: unknown };
        if (typeof entry.sid !== "string") throw new Error("no sid");
        if (entry.op === "del") live.delete(entry.sid);
        else if (entry.op === "put") {
          live.delete(entry.sid);
          live.set(entry.sid, { sid: entry.sid, offset: start, length: end - start });
        } else throw new Error("unknown op");
      } catch {
        malformed++;
      }
    }
    start = end + 1;
  }
  return { index: { state, meta, live: [...live.values()], malformed, vectorsPath, vectorRows }, reason: null };
}

export function recallLine(index: RecallIndex, live: RecallLive): RecallLine {
  return JSON.parse(index.meta.toString("utf8", live.offset, live.offset + live.length)) as RecallLine;
}

/** Reads fixed-stride rows out of vectors.bin without loading the file. */
export class VectorFile {
  private readonly fd: number;
  readonly rows: number;
  constructor(path: string, private readonly dims: number) {
    this.fd = openSync(path, "r");
    this.rows = Math.floor(fstatSync(this.fd).size / this.dims);
  }

  row(index: number): Int8Array {
    const buffer = Buffer.alloc(this.dims);
    const read = readSync(this.fd, buffer, 0, this.dims, index * this.dims);
    if (read !== this.dims) throw new Error("short vector row");
    return new Int8Array(buffer.buffer, buffer.byteOffset, this.dims);
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** Where a beta archive may sit: the data dir (where 0.15-beta put it) or the account dir. */
export function findBetaArchive(dataDir: string, paths: AccountPaths): string | null {
  for (const candidate of [join(dataDir, "archive.sqlite"), join(paths.root, "archive.sqlite")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The beta archive, read-only. With no write-ahead log to replay it opens
 * immutable, which creates nothing beside the file; a non-empty `-wal` needs a
 * normal read-only open, or its committed rows would be missed.
 */
export function openBetaArchive(path: string): DatabaseSync {
  const { DatabaseSync } = sqlite();
  const wal = `${path}-wal`;
  const pending = existsSync(wal) && statSync(wal).size > 0;
  if (pending) return new DatabaseSync(path, { readOnly: true });
  return new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
}

export interface BetaRow {
  rowid: number;
  sid: string;
  jid: string;
  ts: number;
  sender: string;
  type: string;
  text: string;
  raw: string;
  extra: string;
  deleted: number;
  expires: number | null;
  edited: number;
  keyid: string;
  origin: string;
}

export function betaOwner(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'owner'").get() as { value?: unknown } | undefined;
  return typeof row?.value === "string" ? row.value : null;
}

/** Only what a timestamp lookup needs, without the protobufs. */
export function betaTimes(db: DatabaseSync, afterRowid: number, limit: number): Array<{ rowid: number; sid: string; ts: number }> {
  return db
    .prepare("SELECT rowid, sid, ts FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?")
    .all(afterRowid, limit) as unknown as Array<{ rowid: number; sid: string; ts: number }>;
}

export function betaRows(db: DatabaseSync, afterRowid: number, limit: number): BetaRow[] {
  return db
    .prepare(
      `SELECT rowid, sid, jid, ts, sender, type, text, raw, extra, deleted, expires, edited, keyid, origin
       FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?`
    )
    .all(afterRowid, limit) as unknown as BetaRow[];
}

/**
 * The beta expired disappearing messages whatever WAZAP_RETENTION said, and
 * its erasure keeps the deadline: a deleted row whose deadline had passed is
 * an expiry, not something the user deleted.
 */
export function isBetaExpiry(row: Pick<BetaRow, "deleted" | "expires">, now: number): boolean {
  return row.deleted === 1 && typeof row.expires === "number" && row.expires > 0 && row.expires <= now;
}
