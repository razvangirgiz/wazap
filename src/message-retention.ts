import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WazapError } from "./errors.js";
import { logError } from "./logger.js";
import type { HistoryRecord } from "./store.js";

/** Content-free deletion barriers, independent of bounded message/history rings. */
export class MessageRetention {
  readonly deleted = new Map<string, string>();
  readonly cleared = new Map<string, number>();
  readonly expires = new Map<string, { jid: string; at: number }>();
  private saveQueued = false;
  private work: Promise<void> = Promise.resolve();
  private error: WazapError | null = null;
  private cleanupQueued = false;

  /** Without `WAZAP_RETENTION`, deadlines are neither recorded nor enforced; deletions always are. */
  constructor(private readonly enforceExpiry = true) {}

  allows(sid: string, jid: string, timestamp: number): boolean {
    return !this.deleted.has(sid) && timestamp > (this.cleared.get(jid) ?? -Infinity) &&
      Date.now() < (this.expires.get(sid)?.at ?? Infinity);
  }

  /** The first/earliest observed deadline wins, including over stripped edits. */
  noteExpiry(sid: string, jid: string, at: number): boolean {
    if (!this.enforceExpiry) return false;
    if (!Number.isSafeInteger(at) || at < 0) at = 0;
    if (this.deleted.has(sid) || (this.expires.get(sid)?.at ?? Infinity) <= at) return false;
    this.expires.set(sid, { jid, at });
    return true;
  }

  expire(now = Date.now()): string[] {
    const due: string[] = [];
    for (const [sid, value] of this.expires) if (value.at <= now) {
      this.expires.delete(sid);
      this.deleted.set(sid, value.jid);
      due.push(sid);
    }
    return due;
  }

  nextExpiry(): number | undefined {
    let next = Infinity;
    for (const value of this.expires.values()) next = Math.min(next, value.at);
    return next === Infinity ? undefined : next;
  }

  saveSoon(file: string): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    void this.serialize(async () => { this.saveQueued = false; await this.save(file); });
  }

  /** Keep canonical barriers when a previously unknown LID becomes a phone number. */
  alias(from: string, to: string): void {
    if (from === to) return;
    const convert = (sid: string): string => sid.replace(/^(true|false)_([^_]+)_/, (all, direction, jid) =>
      jid === from ? `${direction}_${to}_` : all);
    for (const [sid, jid] of this.deleted) {
      const canonical = convert(sid);
      if (canonical !== sid) this.deleted.set(canonical, jid === from ? to : jid);
    }
    for (const [sid, value] of this.expires) {
      const canonical = convert(sid);
      if (canonical !== sid) this.noteExpiry(canonical, value.jid === from ? to : value.jid, value.at);
    }
    const cleared = this.cleared.get(from);
    if (cleared !== undefined) this.cleared.set(to, Math.max(cleared, this.cleared.get(to) ?? 0));
  }

  /** Appends, compaction, preview writes and snapshots must use the same queue. */
  serialize(work: () => Promise<void>): Promise<void> {
    this.work = this.work.then(work).catch(() => {
      if (this.error) return;
      this.error = new WazapError(
        "WHATSAPP_ERROR",
        "Local message persistence or cleanup failed.",
        "Check the account directory permissions and disk space before restarting"
      );
      logError("message storage", this.error.message);
    });
    return this.work;
  }

  async idle(): Promise<void> {
    for (;;) {
      const pending = this.work;
      await pending;
      if (pending === this.work) break;
    }
    // Report a failure to whoever waits for it, then let later work start clean:
    // one full disk must not fail every delete until the process restarts.
    const error = this.error;
    this.error = null;
    if (error) throw error;
  }

  /** Coalesce queued deletes, but not ones arriving while a rewrite is running. */
  cleanup(work: () => Promise<void>): void {
    if (this.cleanupQueued) return;
    this.cleanupQueued = true;
    void this.serialize(async () => {
      this.cleanupQueued = false;
      await work();
    });
  }

  async load(file: string): Promise<void> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw this.unavailable();
    }
    try {
      const value = JSON.parse(text) as { version?: unknown; deleted?: unknown; cleared?: unknown; expires?: unknown };
      if (value?.version !== 1 || !Array.isArray(value.deleted) || !Array.isArray(value.cleared)) throw Error();
      const deleted = new Map<string, string>();
      const cleared = new Map<string, number>();
      for (const entry of value.deleted) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
          throw Error();
        }
        deleted.set(entry[0], entry[1]);
      }
      for (const entry of value.cleared) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" ||
            typeof entry[1] !== "number" || !Number.isFinite(entry[1]) || entry[1] < 0) {
          throw Error();
        }
        cleared.set(entry[0], entry[1]);
      }
      const expires = new Map<string, { jid: string; at: number }>();
      if (value.expires !== undefined) {
        if (!Array.isArray(value.expires)) throw Error();
        for (const entry of value.expires) {
          if (!Array.isArray(entry) || entry.length !== 3 || typeof entry[0] !== "string" ||
              typeof entry[1] !== "string" || !Number.isSafeInteger(entry[2]) || entry[2] < 0) throw Error();
          expires.set(entry[0], { jid: entry[1], at: entry[2] });
        }
      }
      for (const [sid, jid] of deleted) this.deleted.set(sid, jid);
      for (const [sid, entry] of expires) this.noteExpiry(sid, entry.jid, entry.at);
      for (const [jid, at] of cleared) this.cleared.set(jid, Math.max(at, this.cleared.get(jid) ?? 0));
    } catch {
      throw this.unavailable();
    }
  }

  /** Caller owns the serialized write slot. */
  async save(file: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, deleted: [...this.deleted], cleared: [...this.cleared],
      ...(this.expires.size ? { expires: [...this.expires].map(([sid, entry]) => [sid, entry.jid, entry.at]) } : {}),
    }), { mode: 0o600 });
    await rename(tmp, file);
  }

  /** Rewrite owned history files without deleted payloads, including old transcript versions. */
  async purgeHistory(dir: string, historyFile: (jid: string) => string, keep: (record: HistoryRecord) => boolean): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const deletedByFile = new Map<string, string[]>();
    for (const [sid, jid] of this.deleted) {
      const path = historyFile(jid);
      const ids = deletedByFile.get(path) ?? [];
      ids.push(sid);
      deletedByFile.set(path, ids);
    }
    const clearedFiles = new Set([...this.cleared.keys()].map(historyFile));
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      if (name.endsWith(".jsonl.tmp")) {
        await rm(path, { force: true });
        continue;
      }
      if (!name.endsWith(".jsonl")) continue;
      const text = await readFile(path, "utf8");
      const kept = new Map<string, HistoryRecord>();
      for (const line of text.split("\n")) {
        try {
          const record = JSON.parse(line) as HistoryRecord;
          if (record.deleted) {
            kept.set(record.sid, { sid: record.sid, ts: record.ts, raw: "", deleted: true });
          } else if (keep(record)) kept.set(record.sid, record);
        } catch { /* Malformed records cannot retain payload bytes in a rewrite. */ }
      }
      for (const sid of deletedByFile.get(path) ?? []) {
        if (!kept.get(sid)?.deleted) kept.set(sid, { sid, ts: Math.floor(Date.now() / 1000), raw: "", deleted: true });
      }
      const cleared = clearedFiles.has(path);
      if (cleared && ![...kept.values()].some((record) => !record.deleted)) {
        await rm(path, { force: true });
      } else {
        const written = [...kept.values()].map((record) => JSON.stringify(record)).join("\n") + (kept.size ? "\n" : "");
        if (written !== text) {
          await writeFile(`${path}.tmp`, written, { mode: 0o600 });
          await rename(`${path}.tmp`, path);
        }
      }
    }
  }

  private unavailable(): WazapError {
    return new WazapError(
      "WHATSAPP_ERROR",
      "Message retention state could not be loaded; refusing to replay message history.",
      "Restore the account's retention.json from a trusted backup, or move it aside knowingly: messages deleted earlier can then reappear from local history"
    );
  }
}
