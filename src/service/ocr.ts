/**
 * Opt-in background OCR for one account (WAZAP_OCR=local). Scans kept image
 * originals (and images opened on demand via get_media) with local tesseract
 * and writes extracted text into `messages.ocr_text` so `search` and recall
 * find screenshots, receipts and product photos by their words and meaning.
 *
 * Off by default, and never downloads media from WhatsApp on its own.
 */
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AccountPaths, Config } from "../config.js";
import type { AccountDb } from "../db/index.js";
import { log, logError } from "../logger.js";
import { cleanOcrText, ocrAvailable, ocrBufferWith, type OcrRunner } from "../ocr.js";
import type { EmbedFeed } from "../recall/index.js";

const KEPT_NAME = /^\d+-[0-9a-f]{8}\.[a-z0-9]{1,16}$/i;
const OCR_PAGE = 50;
const OCR_MAX_TRIES = 2;
const STOP_WAIT_MS = 3_000;
const DEFAULT_PACE_MS = 50;

export interface OcrHost {
  readyDb(): AccountDb | null;
  stopped(): boolean;
  embedFeed(): EmbedFeed | null;
  runner(): OcrRunner;
  /** True when tests injected a custom runner instead of the system tesseract binary. */
  customRunner(): boolean;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isAborted(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR");
}

export class AccountOcr {
  private readonly queue: Array<{ sid: string; path: string }> = [];
  private readonly queued = new Set<string>();
  private readonly failures = new Map<string, number>();
  private worker: Promise<void> | null = null;
  private backlogPending = false;
  private stopping = false;
  private warnedMissing = false;
  private activeAbort: AbortController | null = null;
  /** Delay between backlog images so OCR stays polite on CPU; tests set 0. */
  paceMs = DEFAULT_PACE_MS;

  constructor(
    private readonly host: OcrHost,
    private readonly config: Config,
    private readonly paths: AccountPaths
  ) {}

  get enabled(): boolean {
    return this.config.ocr === "local" && this.config.command === "serve" && this.config.persistHistory;
  }

  private available(): boolean {
    if (!this.enabled || this.stopping || this.host.stopped()) return false;
    if (this.host.customRunner()) return true;
    if (ocrAvailable(this.config.dataDir)) return true;
    if (!this.warnedMissing) {
      this.warnedMissing = true;
      log("ocr: WAZAP_OCR=local is set but neither macOS Vision (swiftc) nor tesseract was found; install with `brew install tesseract tesseract-lang`");
    }
    return false;
  }

  private located(path: string): string | null {
    const name = basename(path);
    return KEPT_NAME.test(name) ? join(this.paths.keptDir, name) : null;
  }

  /** Called once after storage and kept-media boot: schedules backlog OCR over kept images, newest first. */
  boot(): void {
    if (!this.available()) return;
    this.backlogPending = true;
    this.kick();
  }

  /** A kept image original was just stored: enqueue it ahead of older backlog items. */
  noteKept(sid: string, path: string): void {
    if (!this.available() || this.queued.has(sid)) return;
    this.queued.add(sid);
    this.queue.unshift({ sid, path });
    this.kick();
  }

  /** An image was opened on demand (get_media): extract OCR in the background if not scanned yet. */
  noteOpened(sid: string, buffer: Buffer, mime: string): void {
    if (!this.available() || !/^image\//i.test(mime) || /^image\/svg/i.test(mime)) return;
    const db = this.host.readyDb();
    if (db === null) return;
    const msg = db.messages.get(sid);
    if (msg === null || msg.type !== "image" || msg.ocrText !== null) return;
    void (async () => {
      const abort = new AbortController();
      try {
        const text = await ocrBufferWith(buffer, mime, this.host.runner(), abort.signal);
        if (this.stopping || this.host.stopped()) return;
        const liveDb = this.host.readyDb();
        if (liveDb === null || !liveDb.isOpen) return;
        if (liveDb.messages.setOcrText(sid, text) && text !== "") {
          this.host.embedFeed()?.kick();
        }
      } catch (err) {
        if (!isAborted(err)) logError("ocr", err);
      }
    })();
  }

  private kick(): void {
    if (this.worker !== null || this.stopping || this.host.stopped()) return;
    this.worker = this.drain()
      .catch((err: unknown) => logError("ocr", err))
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
      const page = db.messages.keptImagesWithoutOcr(OCR_PAGE, cursor);
      if (page.length === 0) {
        this.backlogPending = false;
        return;
      }
      for (const item of page) {
        if (this.stopping || this.host.stopped()) return;
        if ((this.failures.get(item.sid) ?? 0) >= OCR_MAX_TRIES) continue;
        await this.scanKept(item.sid, item.path);
        if (this.paceMs > 0 && !this.stopping) await sleep(this.paceMs);
      }
      cursor = page[page.length - 1]!.id;
      if (page.length < OCR_PAGE) {
        this.backlogPending = false;
        return;
      }
    }
  }

  private async scanKept(sid: string, storedPath: string): Promise<void> {
    const db = this.host.readyDb();
    if (db === null || !db.isOpen || this.stopping || this.host.stopped()) return;
    const msg = db.messages.get(sid);
    if (msg === null || msg.type !== "image" || msg.ocrText !== null) return;
    const filePath = this.located(storedPath);
    if (filePath === null) return;

    const abort = new AbortController();
    this.activeAbort = abort;
    try {
      const raw = await this.host.runner()(filePath, abort.signal);
      if (this.stopping || this.host.stopped()) return;
      const text = cleanOcrText(raw);
      const liveDb = this.host.readyDb();
      if (liveDb === null || !liveDb.isOpen) return;
      if (liveDb.messages.setOcrText(sid, text) && text !== "") {
        this.host.embedFeed()?.kick();
      }
      this.failures.delete(sid);
    } catch (err) {
      if (this.stopping || this.host.stopped() || isAborted(err)) return;
      if (isMissing(err)) return;
      const tries = (this.failures.get(sid) ?? 0) + 1;
      this.failures.set(sid, tries);
      // After retries are spent on an unreadable/corrupt image, mark "" so we do not spin forever across restarts.
      if (tries >= OCR_MAX_TRIES) {
        const liveDb = this.host.readyDb();
        if (liveDb !== null && liveDb.isOpen) liveDb.messages.setOcrText(sid, "");
      } else {
        logError("ocr", err);
      }
    } finally {
      if (this.activeAbort === abort) this.activeAbort = null;
    }
  }

  /** Settles once the active OCR pass finishes (test helper). */
  async idle(): Promise<void> {
    while (this.worker !== null) await this.worker;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.backlogPending = false;
    this.queue.length = 0;
    this.queued.clear();
    this.activeAbort?.abort();
    if (this.worker === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((done) => {
      timer = setTimeout(done, STOP_WAIT_MS);
      timer.unref();
    });
    await Promise.race([this.worker.catch(() => {}), waited]);
    if (timer !== undefined) clearTimeout(timer);
  }
}
