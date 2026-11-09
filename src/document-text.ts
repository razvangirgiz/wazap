/**
 * The words of a document someone sent, for an agent that cannot open the
 * file: a PDF's text layer page by page (pdf.js, through unpdf), the XML of
 * Office and OpenDocument files, and plain text, CSV, JSON, Markdown, XML and
 * HTML decoded. Everything stops at a character budget and says whether it
 * did. These run in the document worker (src/document-worker.ts), off the
 * event loop and under its memory and time limits; src/documents.ts is the
 * side the service calls.
 */
import { ZipError, ZipReader } from "./zip.js";

export type DocumentFormat = "pdf" | "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp" | "text" | "html";

export interface TextJob {
  format: DocumentFormat;
  bytes: Uint8Array;
  /** 1-based, inclusive; `to` null runs until the budget is spent. Pages are a PDF's, or a presentation's slides. */
  pages: { from: number; to: number | null };
  budget: number;
}

export interface TextResult {
  text: string;
  truncated: boolean;
  pages_total?: number;
  pages?: { from: number; to: number };
  /** A PDF whose asked pages carry no text at all: a scan. */
  scanned?: boolean;
  note?: string;
}


export async function extractText(job: TextJob): Promise<TextResult> {
  switch (job.format) {
    case "pdf":
      return pdfText(job);
    case "docx":
    case "xlsx":
    case "pptx":
    case "odt":
    case "ods":
    case "odp":
      try {
        return await officeText(job);
      } catch (err) {
        if (err instanceof ZipError) return { text: "", truncated: false, note: `This ${job.format} could not be read: ${err.message}.` };
        throw err;
      }
    case "html":
      // The whole page up to the window, stripped before it is cut: a long <head> of styles or scripts must not use up the budget.
      return clip(htmlText(decodeText(job.bytes, FLOW_MAX_BYTES)), job.budget);
    case "text":
      return clip(decodeText(job.bytes, job.budget * 4), job.budget);
  }
}

/** How much of a text or HTML file is decoded: far more than one answer, so the words after a long head are reached. */
const FLOW_MAX_BYTES = 8_000_000;

/** `text` within `budget` characters, cut at a line where one is near. */
function clip(text: string, budget: number): TextResult {
  const tidy = tidyText(text);
  if (tidy.length <= budget) return { text: tidy, truncated: false };
  const cut = tidy.lastIndexOf("\n", budget);
  return { text: tidy.slice(0, cut > budget * 0.8 ? cut : budget), truncated: true };
}

/** Blank runs collapsed, trailing spaces dropped. */
function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Bytes as text: UTF-16 by its byte-order mark, otherwise UTF-8, with any
 * invalid sequence replaced. Only the first `limit` bytes are decoded: no
 * budget needs more.
 */
export function decodeText(bytes: Uint8Array, limit: number): string {
  const head = bytes.subarray(0, Math.min(bytes.length, limit));
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder("utf-16le").decode(head.subarray(2));
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder("utf-16be").decode(head.subarray(2));
  return new TextDecoder("utf-8").decode(head).replace(/^\ufeff/, "");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** XML and HTML character references, named (the few XML and HTML text needs) and numeric. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** Elements whose content is never shown: dropped up to their closing tag (an unclosed one, to the end, as a browser does). */
const HIDDEN_ELEMENTS = new Set(["script", "style", "noscript", "template", "svg", "title", "iframe", "object"]);
/** Closing tags that end a line of text. */
const BLOCK_ELEMENTS = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "section", "article", "blockquote", "pre", "ul", "ol"]);

/**
 * An HTML page's visible words: comments, scripts, styles and the like
 * dropped, blocks on lines of their own, cells apart by tabs. One pass from
 * left to right, with no pattern that can backtrack, so a hostile page of
 * megabytes takes as long as its length. A "<" that starts no tag is text.
 */
export function htmlText(html: string): string {
  const parts: string[] = [];
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open < 0) {
      parts.push(html.slice(at));
      break;
    }
    parts.push(html.slice(at, open));
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    const next = html.charCodeAt(open + 1);
    const startsTag = next === 0x2f || next === 0x21 || next === 0x3f || (next >= 0x41 && next <= 0x5a) || (next >= 0x61 && next <= 0x7a);
    if (!startsTag) {
      parts.push("<");
      at = open + 1;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    // No ">" anywhere after: no tag can follow, and the rest is text.
    if (close < 0) {
      parts.push(html.slice(open));
      break;
    }
    const name = /^\/?([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(open + 1, Math.min(close, open + 66)));
    const tag = name?.[1]?.toLowerCase() ?? "";
    const closing = html[open + 1] === "/";
    at = close + 1;
    if (!closing && HIDDEN_ELEMENTS.has(tag) && html[close - 1] !== "/") {
      const ending = new RegExp(`</${tag}\\s*>`, "gi");
      ending.lastIndex = at;
      const found = ending.exec(html);
      at = found === null ? html.length : found.index + found[0].length;
    } else if (tag === "br") {
      parts.push("\n");
    } else if (closing && BLOCK_ELEMENTS.has(tag)) {
      parts.push("\n");
    } else if (closing && (tag === "td" || tag === "th")) {
      parts.push("\t");
    }
  }
  return decodeEntities(parts.join(""));
}

/** XML with the given closing tags ended as lines (and cells as tabs), every tag dropped, entities decoded. */
function xmlText(xml: string, rules: { line: string[]; tab?: string[]; drop?: string[] }): string {
  let out = xml;
  for (const tag of rules.drop ?? []) out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g"), "");
  out = out
    .replace(/<w:tab\/>|<text:tab\/>/g, "\t")
    .replace(/<w:(br|cr)\b[^>]*\/>|<a:br\b[^>]*\/>|<text:line-break\/>/g, "\n")
    .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_whole, count: string | undefined) => " ".repeat(Math.min(Number(count ?? 1), 100)));
  for (const tag of rules.line) out = out.replace(new RegExp(`</${tag}>`, "g"), "\n");
  for (const tag of rules.tab ?? []) out = out.replace(new RegExp(`</${tag}>`, "g"), "\t");
  return decodeEntities(out.replace(/<[^>]*>/g, ""));
}

/** Entries named `prefix<n>.xml`, in the order of n. */
function numbered(zip: ZipReader, pattern: RegExp): string[] {
  return zip.entries
    .map((entry) => ({ name: entry.name, n: Number(pattern.exec(entry.name)?.[1]) }))
    .filter((entry) => Number.isFinite(entry.n))
    .sort((a, b) => a.n - b.n)
    .map((entry) => entry.name);
}

async function officeText(job: TextJob): Promise<TextResult> {
  const zip = new ZipReader(Buffer.from(job.bytes.buffer, job.bytes.byteOffset, job.bytes.byteLength));
  switch (job.format) {
    case "docx": {
      const xml = zip.text("word/document.xml");
      if (xml === null) return { text: "", truncated: false, note: "This docx has no document part." };
      return clip(xmlText(xml, { line: ["w:p"], drop: ["w:instrText", "w:delText"] }), job.budget);
    }
    case "xlsx":
      return clip(workbookText(zip), job.budget);
    case "pptx": {
      const slides = numbered(zip, /^ppt\/slides\/slide(\d+)\.xml$/);
      return pagedText(slides.map((name) => () => xmlText(zip.text(name) ?? "", { line: ["a:p"] })), job, "slide");
    }
    case "odp": {
      const xml = zip.text("content.xml") ?? "";
      const slides = xml.split(/<draw:page\b/).slice(1);
      return pagedText(slides.map((slide) => () => xmlText(`<x${slide}`, { line: ["text:p", "text:h"] })), job, "slide");
    }
    default: {
      const xml = zip.text("content.xml");
      if (xml === null) return { text: "", truncated: false, note: `This ${job.format} has no content part.` };
      return clip(xmlText(xml, { line: ["text:p", "text:h", "table:table-row"], tab: ["table:table-cell"] }), job.budget);
    }
  }
}

/** An xlsx as tab-separated rows under each sheet's name: shared strings resolved, columns kept in place. */
function workbookText(zip: ZipReader): string {
  const shared: string[] = [];
  const strings = zip.text("xl/sharedStrings.xml");
  if (strings !== null) {
    for (const item of strings.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(decodeEntities([...item[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
    }
  }
  const workbook = zip.text("xl/workbook.xml") ?? "";
  const rels = zip.text("xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"/g)].map((m) => ({
    name: decodeEntities(m[1]!),
    path: `xl/${(targets.get(m[2]!) ?? "").replace(/^\/?xl\//, "").replace(/^\//, "")}`,
  }));
  const listed = sheets.length > 0 ? sheets : numbered(zip, /^xl\/worksheets\/sheet(\d+)\.xml$/).map((path, i) => ({ name: `Sheet${i + 1}`, path }));
  const parts: string[] = [];
  for (const sheet of listed) {
    const xml = zip.text(sheet.path);
    if (xml === null) continue;
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1] ?? "";
        const body = cell[2] ?? "";
        const column = columnIndex(/\br="([A-Z]+)\d+"/.exec(attrs)?.[1]);
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let text = "";
        if (type === "s" && value !== undefined) text = shared[Number(value)] ?? "";
        else if (type === "inlineStr") text = decodeEntities([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
        else if (type === "b") text = value === "1" ? "TRUE" : "FALSE";
        else if (value !== undefined) text = decodeEntities(value);
        if (text === "") continue;
        // A column far to the right is placed after a single gap: a sheet's empty columns are not spelled out.
        if (column !== null && column > cells.length) cells.push(...Array<string>(Math.min(column - cells.length, 1)).fill(""));
        cells.push(text.replace(/[\t\n]/g, " "));
      }
      if (cells.length > 0) rows.push(cells.join("\t"));
    }
    parts.push(`--- sheet ${sheet.name} ---\n${rows.join("\n")}`);
  }
  return parts.join("\n\n");
}

/** "AB" as a 0-based column index; null without one. */
function columnIndex(letters: string | undefined): number | null {
  if (letters === undefined) return null;
  let n = 0;
  for (const letter of letters) n = n * 26 + (letter.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Pages (or slides) read one at a time from `from`, each under a marker,
 * until `to` or the budget: a page that does not fit is cut only when it is
 * the first, so an answer never ends mid-page otherwise.
 */
async function pagedTextAsync(pages: Array<() => Promise<string> | string>, job: TextJob, unit: string): Promise<TextResult & { chars: number[] }> {
  const total = pages.length;
  if (job.pages.from > total) {
    return { text: "", truncated: false, pages_total: total, chars: [], note: `It has ${total} ${unit}${total === 1 ? "" : "s"}; ${unit} ${job.pages.from} is past its end.` };
  }
  const last = Math.min(total, job.pages.to ?? total);
  const parts: string[] = [];
  const chars: number[] = [];
  let used = 0;
  let reached = job.pages.from - 1;
  let truncated = false;
  for (let page = job.pages.from; page <= last; page++) {
    const body = tidyText(await pages[page - 1]!());
    chars.push(body.length);
    const block = total > 1 ? `--- ${unit} ${page} ---\n${body}` : body;
    if (used + block.length + 2 > job.budget) {
      if (parts.length === 0) {
        parts.push(block.slice(0, job.budget));
        reached = page;
      }
      truncated = true;
      break;
    }
    parts.push(block);
    used += block.length + 2;
    reached = page;
  }
  if (job.pages.to === null && reached < total) truncated = true;
  return { text: parts.join("\n\n"), truncated, pages_total: total, pages: { from: job.pages.from, to: reached }, chars };
}

async function pagedText(pages: Array<() => string>, job: TextJob, unit: string): Promise<TextResult> {
  const { chars: _chars, ...result } = await pagedTextAsync(pages, job, unit);
  return result;
}

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

/** A PDF's text layer, page by page from the first asked, with the page count; a scan says so. */
async function pdfText(job: TextJob): Promise<TextResult> {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(job.bytes, {
    // No fonts loaded or installed, and no warnings printed (the worker's console would reach stdout).
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  const readers = Array.from({ length: doc.numPages }, (_, i) => async () => {
    const page = await doc.getPage(i + 1);
    const content = await page.getTextContent();
    page.cleanup();
    return (content.items as PdfTextItem[]).map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : "")).join("");
  });
  const { chars, ...result } = await pagedTextAsync(readers, job, "page");
  // No visible character on any page asked: a scan, whose words are only in its picture. A page with a
  // few words is text, however short, and is returned as such.
  const scanned = chars.length > 0 && chars.every((count) => count === 0);
  return scanned ? { ...result, text: "", truncated: false, scanned: true } : result;
}
