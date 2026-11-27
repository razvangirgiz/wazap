/**
 * Opt-in background document text indexing for one account
 * (WAZAP_INDEX_DOCUMENTS=local). Scans kept document originals (and documents
 * opened on demand via get_media) using the isolated worker reader
 * (src/documents.ts: PDF, DOCX, XLSX, PPTX, ODT, ODS, ODP, HTML, TXT/CSV) and
 * stores extracted text into `messages.doc_text` so `search` and semantic
 * recall find contracts, invoices, certificates and spreadsheets by content.
 *
 * Off by default, and never downloads media from WhatsApp on its own.
 */
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AccountPaths, Config } from "../config.js";
import type { AccountDb, StoredMessage } from "../db/index.js";
import { documentFormat, documentText } from "../documents.js";
import { logError } from "../logger.js";
import { mediaInfo } from "../messages.js";
import type { EmbedFeed } from "../recall/index.js";
import type { MessageViews } from "./views.js";

/** Maximum extracted document characters indexed per message. */
export const DOC_TEXT_MAX = 4_000;
const KEPT_NAME = /^\d+-[0-9a-f]{8}\.[a-z0-9]{1,16}$/i;
const DOC_PAGE = 50;
const DOC_MAX_TRIES = 2;
const STOP_WAIT_MS = 3_000;
const DEFAULT_PACE_MS = 50;
const MIN_ALNUM_CHARS = 5;

export type DocExtractor = (buffer: Buffer, mime: string, filename?: string, signal?: AbortSignal) => Promise<string>;

export interface DocIndexHost {
  readyDb(): AccountDb | null;
  stopped(): boolean;
  embedFeed(): EmbedFeed | null;
  extractor(): DocExtractor;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isAborted(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR");
}

/** Cleans extracted document text: strips control chars, collapses spacing, caps length. */
export function cleanDocText(raw: string): string {
  const lines = raw
    .replace(/(?![\r\n\t])\p{Cc}/gu, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length >= 2 && /[\p{L}\p{N}]/u.test(line));
  const cleaned = lines.join("\n").trim();
  const alnum = (cleaned.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (alnum < MIN_ALNUM_CHARS) return "";
  return cleaned.length <= DOC_TEXT_MAX ? cleaned : cleaned.slice(0, DOC_TEXT_MAX);
}

/** Extracts text from a document buffer via the worker thread, returning "" for unsupported or textless files. */
export async function extractDocumentForIndex(
  buffer: Buffer,
  mime: string,
  filename?: string,
  signal?: AbortSignal
): Promise<string> {
  const format = documentFormat(mime, filename, buffer);
  if (format === null) return "";
  const result = await documentText(format, buffer, { from: 1, to: null }, DOC_TEXT_MAX, signal);
  if (result.unreadable === true || result.scanned === true) return "";
  return cleanDocText(result.text);
}

export class AccountDocIndex {
  private readonly queue: Array<{ sid: string; path: string }> = [];
  private readonly queued = new Set<string>();
  private readonly failures = new Map<string, number>();
  private worker: Promise<void> | null = null;
  private backlogPending = false;
  private stopping = false;
  private activeAbort: AbortController | null = null;
  /** Delay between backlog documents so extraction stays polite on CPU; tests set 0. */
  paceMs = DEFAULT_PACE_MS;

  constructor(
    private readonly host: DocIndexHost,
    private readonly views: MessageViews,
    private readonly config: Config,
    private readonly paths: AccountPaths
  ) {}

  get enabled(): boolean {
    return this.config.indexDocuments === "local" && this.config.command === "serve" && this.config.persistHistory;
  }

  private available(): boolean {
    return this.enabled && !this.stopping && !this.host.stopped();
  }

  private located(path: string): string | null {
    const name = basename(path);
    return KEPT_NAME.test(name) ? join(this.paths.keptDir, name) : null;
  }

  private docMeta(message: StoredMessage, filePath: string): { mime: string; filename?: string } {
    const raw = this.views.rawOf(message);
    const info = raw === null ? undefined : mediaInfo(raw);
    if (info !== undefined) {
      return { mime: info.mime, ...(info.filename === undefined ? {} : { filename: info.filename }) };
    }
    return { mime: "application/octet-stream", filename: basename(filePath) };
  }

  /** Called once after storage boot: schedules backlog extraction over kept documents, newest first. */
  boot(): void {
    if (!this.available()) return;
    this.backlogPending = true;
    this.kick();
  }

  /** A kept document original was just stored: enqueue it ahead of older backlog items. */
  noteKept(sid: string, path: string): void {
    if (!this.available() || this.queued.has(sid)) return;
    this.queued.add(sid);
    this.queue.unshift({ sid, path });
    this.kick();
  }

  /** A document was opened on demand (get_media): index its text in the background if not indexed yet. */
  noteOpened(sid: string, buffer: Buffer, mime: string, filename?: string): void {
    if (!this.available()) return;
    const db = this.host.readyDb();
    if (db === null) return;
    const msg = db.messages.get(sid);
    if (msg === null || msg.type !== "document" || msg.docText !== null) return;
    void (async () => {
      const abort = new AbortController();
      try {
        const text = cleanDocText(await this.host.extractor()(buffer, mime, filename, abort.signal));
        if (this.stopping || this.host.stopped()) return;
        const liveDb = this.host.readyDb();
        if (liveDb === null || !liveDb.isOpen) return;
        if (liveDb.messages.setDocText(sid, text) && text !== "") {
          this.host.embedFeed()?.kick();
        }
      } catch (err) {
        if (!isAborted(err)) logError("doc-index", err);
      }
    })();
  }

  private kick(): void {
    if (this.worker !== null || this.stopping || this.host.stopped()) return;
    this.worker = this.drain()
      .catch((err: unknown) => logError("doc-index", err))
      .finally(() => {
        this.worker = null;
        if (!this.stopping && !this.host.stopped() && (this.queue.length > 0 || this.backlogPending)) {
          this.kick();
        }
      });
  }

  private async drain(): Promise<void> {
    let cursor: number | undefined;
    for (;;) {
      if (this.stopping || this.host.stopped()) return;
      if (this.queue.length > 0) {
        const next = this.queue.shift()!;
        this.queued.delete(next.sid);
        await this.scanKept(next.sid, next.path);
        if (this.paceMs > 0 && !this.stopping) await sleep(this.paceMs);
        continue;
      }
      if (!this.backlogPending) return;
      const db = this.host.readyDb();
      if (db === null || !db.isOpen) {
        this.backlogPending = false;
        return;
      }
      const page = db.messages.keptDocumentsWithoutDocText(DOC_PAGE, cursor);
      if (page.length === 0) {
        this.backlogPending = false;
        return;
      }
      for (const item of page) {
        if (this.stopping || this.host.stopped()) return;
        if ((this.failures.get(item.sid) ?? 0) >= DOC_MAX_TRIES) continue;
        await this.scanKept(item.sid, item.path);
        if (this.paceMs > 0 && !this.stopping) await sleep(this.paceMs);
      }
      cursor = page[page.length - 1]!.id;
      if (page.length < DOC_PAGE) {
        this.backlogPending = false;
        return;
      }
    }
  }

  private async scanKept(sid: string, storedPath: string): Promise<void> {
    const db = this.host.readyDb();
    if (db === null || !db.isOpen || this.stopping || this.host.stopped()) return;
    const msg = db.messages.get(sid);
    if (msg === null || msg.type !== "document" || msg.docText !== null) return;
    const filePath = this.located(storedPath);
    if (filePath === null) return;

    const abort = new AbortController();
    this.activeAbort = abort;
    try {
      const buffer = await readFile(filePath);
      if (this.stopping || this.host.stopped()) return;
      const meta = this.docMeta(msg, filePath);
      const raw = await this.host.extractor()(buffer, meta.mime, meta.filename, abort.signal);
      if (this.stopping || this.host.stopped()) return;
      const text = cleanDocText(raw);
      const liveDb = this.host.readyDb();
      if (liveDb === null || !liveDb.isOpen) return;
      if (liveDb.messages.setDocText(sid, text) && text !== "") {
        this.host.embedFeed()?.kick();
      }
      this.failures.delete(sid);
    } catch (err) {
      if (this.stopping || this.host.stopped() || isAborted(err)) return;
      if (isMissing(err)) return;
      const tries = (this.failures.get(sid) ?? 0) + 1;
      this.failures.set(sid, tries);
      if (tries >= DOC_MAX_TRIES) {
        const liveDb = this.host.readyDb();
        if (liveDb !== null && liveDb.isOpen) liveDb.messages.setDocText(sid, "");
      } else {
        logError("doc-index", err);
      }
    } finally {
      if (this.activeAbort === abort) this.activeAbort = null;
    }
  }

  /** Waits for queued and backlog document indexing to finish; for tests. */
  async idle(): Promise<void> {
    while (this.worker !== null) {
      await this.worker;
    }
  }

  /** Stops background document indexing promptly on shutdown, aborting any active worker. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.backlogPending = false;
    this.queue.length = 0;
    this.queued.clear();
    this.activeAbort?.abort();
    const active = this.worker;
    if (active !== null) {
      await Promise.race([active.catch(() => {}), sleep(STOP_WAIT_MS)]);
    }
  }
}
