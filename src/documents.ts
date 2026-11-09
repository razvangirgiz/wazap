/**
 * Documents for an agent that cannot open a file: what kind a file is, its
 * text (read in a worker thread, src/document-worker.ts), and a picture of a
 * PDF page when this machine has a renderer: poppler's pdftoppm, or on macOS
 * Quick Look (qlmanage) for the first page. A PDF that is a scan has no text
 * layer, and the page picture is then what there is to read.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import type { DocumentFormat, TextResult } from "./document-text.js";
import { which } from "./transcribe/local.js";

const run = promisify(execFile);

/** Characters of a document's text one answer carries by default: about 3,000 tokens. */
export const TEXT_BUDGET = 12_000;
/** A document bigger than this is not parsed: the worker would need more memory than it is given. */
export const DOCUMENT_TEXT_MAX_BYTES = 50_000_000;
/** How long a document read may take before its thread is stopped. */
const TEXT_TIMEOUT_MS = 20_000;
/** What one document read may use. A file that needs more is reported unreadable. */
const WORKER_LIMITS = { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 48, stackSizeMb: 4 };
/** Document reads running at once, process-wide; the rest wait their turn. */
const MAX_WORKERS = 2;
const RENDER_TIMEOUT_MS = 20_000;

const MIME_FORMATS: Record<string, DocumentFormat> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "application/json": "text",
  "application/xml": "text",
  "application/x-ndjson": "text",
  "application/csv": "text",
  "application/x-yaml": "text",
  "application/yaml": "text",
};

const EXTENSION_FORMATS: Record<string, DocumentFormat> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".pptx": "pptx",
  ".odt": "odt",
  ".ods": "ods",
  ".odp": "odp",
  ".html": "html",
  ".htm": "html",
  ".txt": "text",
  ".csv": "text",
  ".tsv": "text",
  ".md": "text",
  ".json": "text",
  ".xml": "text",
  ".log": "text",
  ".yaml": "text",
  ".yml": "text",
  ".ics": "text",
  ".vcf": "text",
};

/** Which reader a file needs, by its mime, then its name, then its first bytes; null for a kind with none. */
export function documentFormat(mime: string, filename: string | undefined, bytes: Buffer): DocumentFormat | null {
  const base = mime.toLowerCase().split(";")[0]!.trim();
  const byMime = MIME_FORMATS[base];
  if (byMime !== undefined) return byMime;
  if (base.startsWith("text/")) return "text";
  const byName = filename === undefined ? undefined : EXTENSION_FORMATS[extname(filename).toLowerCase()];
  if (byName !== undefined) return byName;
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  return null;
}

let running = 0;
const waiting: Array<() => void> = [];

/** One of MAX_WORKERS slots; a slot given up passes straight to the next in line, so the count never overshoots. */
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_WORKERS) await new Promise<void>((resolve) => waiting.push(resolve));
  else running++;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next === undefined) running--;
    else next();
  }
}

/**
 * The document's text from page `from` (1-based) to `to`, or until the budget
 * is spent, read in a worker thread with a memory cap and a timeout. Throws
 * with a short reason when the file cannot be read.
 */
export function documentText(format: DocumentFormat, bytes: Buffer, pages: { from: number; to: number | null }, budget = TEXT_BUDGET): Promise<TextResult> {
  if (bytes.length > DOCUMENT_TEXT_MAX_BYTES) {
    return Promise.reject(new Error(`it is over ${DOCUMENT_TEXT_MAX_BYTES / 1_000_000} MB, more than is read here`));
  }
  return slot(
    () =>
      new Promise<TextResult>((resolve, reject) => {
        // A copy of its own, handed over: the download's buffer may share memory with others.
        const copy = new Uint8Array(bytes);
        const worker = new Worker(new URL("./document-worker.js", import.meta.url), {
          workerData: { format, bytes: copy, pages, budget },
          transferList: [copy.buffer],
          resourceLimits: WORKER_LIMITS,
          stdout: true,
          stderr: true,
        });
        worker.stdout.resume();
        worker.stderr.resume();
        let settled = false;
        const finish = (outcome: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          outcome();
          void worker.terminate();
        };
        const timer = setTimeout(() => finish(() => reject(new Error(`reading it took over ${TEXT_TIMEOUT_MS / 1000} s`))), TEXT_TIMEOUT_MS);
        worker.once("message", (message: { ok: boolean; result?: TextResult; message?: string }) =>
          finish(() => (message.ok ? resolve(message.result!) : reject(new Error(message.message ?? "unreadable"))))
        );
        worker.once("error", (err: Error & { code?: string }) =>
          finish(() => reject(new Error(err.code === "ERR_WORKER_OUT_OF_MEMORY" ? "it needs more memory than a document read is given" : "the reader failed")))
        );
        worker.once("exit", () => finish(() => reject(new Error("the reader stopped"))));
      })
  );
}

/**
 * Page `page` of a PDF as an image whose long edge is about `edge` px:
 * pdftoppm when poppler is installed (any page), else on macOS Quick Look,
 * which draws the first page only. Null when neither can, or the render fails.
 */
export async function pdfPageImage(pdf: Buffer, page: number, edge: number): Promise<Buffer | null> {
  const pdftoppm = which("pdftoppm");
  const qlmanage = process.platform === "darwin" && page === 1 ? which("qlmanage") : null;
  if (pdftoppm === null && qlmanage === null) return null;
  const dir = await mkdtemp(join(tmpdir(), "wazap-page-"));
  try {
    const input = join(dir, "in.pdf");
    await writeFile(input, pdf, { mode: 0o600 });
    if (pdftoppm !== null) {
      const prefix = join(dir, "page");
      // JPEG, not PNG: poppler's PNG encoder takes about a second for a 1,024 px page, its JPEG 50 ms.
      await run(pdftoppm, ["-q", "-f", String(page), "-l", String(page), "-singlefile", "-jpeg", "-jpegopt", "quality=90", "-scale-to", String(edge), input, prefix], {
        timeout: RENDER_TIMEOUT_MS,
        windowsHide: true,
      });
      return await readFile(`${prefix}.jpg`);
    }
    // Quick Look writes <name>.png into the output directory, and prints what it did on stdout (captured here).
    await run(qlmanage!, ["-t", "-s", String(edge), "-o", dir, input], { timeout: RENDER_TIMEOUT_MS, windowsHide: true });
    const made = (await readdir(dir)).find((name) => name.endsWith(".png"));
    return made === undefined ? null : await readFile(join(dir, made));
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
