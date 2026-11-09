/**
 * What goes out as media: reading a file or a URL into a buffer, the size
 * cap, the mime guess, the GIF conversion, and the Baileys content for each
 * kind. Nothing here touches the socket or the store.
 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { AnyMessageContent } from "baileys";
import { WazapError } from "./errors.js";
import { gifToMp4 } from "./gif.js";
import { publicMedia, type MediaNetwork } from "./safe-media.js";
import type { MediaSource } from "./wa-types.js";

const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const PROFILE_PICTURE_MAX_BYTES = 10 * 1024 * 1024;
const PROFILE_PICTURE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function mediaFilename(info: { mime: string; filename?: string }): string {
  const original = (info.filename ?? "").replace(/[^\w.-]/g, "_");
  const fromName = original.includes(".") ? original.slice(original.lastIndexOf(".") + 1) : "";
  const subtype = info.mime.split("/")[1]?.split(";")[0] ?? "bin";
  // Both filename and MIME came from a message, not from a trusted filesystem.
  // A MIME subtype containing backslashes is a path on Windows; cap it too.
  const extension = [fromName, subtype].find((value) => /^[a-z0-9]{1,16}$/i.test(value)) ?? "bin";
  return `${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
}

export interface LoadedMedia {
  buffer: Buffer;
  mimetype: string;
  filename: string;
}

export async function assertMediaSource(source: MediaSource, maxBytes = MAX_MEDIA_BYTES): Promise<void> {
  const given = [Boolean(source.file_path), Boolean(source.url), source.inline !== undefined].filter(Boolean).length;
  if (given !== 1) {
    throw new WazapError("FILE_NOT_FOUND", "Provide exactly one of file_path, url or data_base64.");
  }
  if (source.inline !== undefined) {
    assertMediaSize(source.inline.bytes.length, maxBytes);
    return;
  }
  if (!source.file_path) return;
  let size: number;
  try {
    size = (await stat(source.file_path)).size;
  } catch {
    throw new WazapError("FILE_NOT_FOUND", `No file at "${source.file_path}" on the machine running wazap.`);
  }
  assertMediaSize(size, maxBytes);
}

export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function loadMedia(
  source: MediaSource,
  maxBytes = MAX_MEDIA_BYTES,
  io: Partial<MediaNetwork> = {}
): Promise<LoadedMedia> {
  await assertMediaSource(source, maxBytes);
  if (source.file_path) {
    const path = source.file_path;
    return { buffer: await readFile(path), mimetype: guessMime(path), filename: basename(path) };
  }
  if (source.inline !== undefined) {
    const { bytes, filename, mime } = source.inline;
    const mimetype = sniffMime(bytes, mime ?? null, filename);
    return { buffer: bytes, mimetype, filename: safeFilename(filename, mimetype) };
  }

  const result = await publicMedia(source.url!, { maxBytes, ...io });
  const named = result.filename ?? urlFilename(result.url);
  const mimetype = sniffMime(result.buffer, result.mime, named);
  return { buffer: result.buffer, mimetype, filename: safeFilename(named, mimetype) };
}

/** The last segment of a URL's path, decoded: what a browser would save it as. */
function urlFilename(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last);
  } catch {
    return basename(url.split("?")[0] ?? url);
  }
}

/**
 * A name a recipient's phone can save: no path, no control characters, at
 * most 120 characters, and the extension the type has when the name has none.
 */
export function safeFilename(name: string, mime: string): string {
  // eslint-disable-next-line no-control-regex
  let clean = (name.split(/[/\\]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (clean === "" || clean === "." || clean === "..") clean = "file";
  const ext = EXTENSION_BY_MIME[mime];
  if (ext !== undefined && !/\.[a-z0-9]{1,8}$/i.test(clean)) clean = `${clean}.${ext}`;
  if (clean.length > 120) {
    const dot = clean.lastIndexOf(".");
    const tail = dot > 0 && clean.length - dot <= 9 ? clean.slice(dot) : "";
    clean = `${clean.slice(0, 120 - tail.length)}${tail}`;
  }
  return clean;
}

/**
 * What a file is, by its first bytes when they say it, else by the type it was
 * declared with (a server's Content-Type, an agent's mime), else by its name.
 * A ZIP is an Office or OpenDocument file when its name says so.
 */
export function sniffMime(buffer: Buffer, declared: string | null, filename: string): string {
  const byName = guessMime(filename);
  const magic = magicMime(buffer);
  if (magic === "application/zip" && byName !== "application/octet-stream") return byName;
  if (magic !== null) return magic;
  const stated = declared?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (/^[a-z]+\/[a-z0-9.+-]+$/.test(stated) && stated !== "application/octet-stream") return stated;
  return byName;
}

function magicMime(b: Buffer): string | null {
  const ascii = (from: number, to: number): string => b.subarray(from, to).toString("latin1");
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF") {
    const kind = ascii(8, 12);
    if (kind === "WEBP") return "image/webp";
    if (kind === "WAVE") return "audio/wav";
    if (kind === "AVI ") return "video/x-msvideo";
  }
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 3) === "ID3" || (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0)) return "audio/mpeg";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "qt  ") return "video/quicktime";
    if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
    if (["heic", "heix", "mif1", "msf1", "hevc"].includes(brand)) return "image/heic";
    return "video/mp4";
  }
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "application/zip";
  return null;
}

/** JPEG, PNG or WebP, capped at 10 MB before Baileys sees the buffer. */
export async function loadProfilePicture(source: MediaSource, io: Partial<MediaNetwork> = {}): Promise<LoadedMedia> {
  const media = await loadMedia(source, PROFILE_PICTURE_MAX_BYTES, io);
  if (!PROFILE_PICTURE_MIMES.has(media.mimetype)) {
    throw new WazapError(
      "INVALID_IMAGE",
      `A profile picture must be a JPEG, PNG or WebP, not ${media.mimetype}.`,
      "Pass a .jpg, .png or .webp via file_path or url"
    );
  }
  return media;
}

function assertMediaSize(size: number, maxBytes: number): void {
  if (size <= maxBytes) return;
  throw new WazapError(
    "FILE_TOO_LARGE",
    `The file is ${Math.round(size / 1_048_576)} MB; the limit is ${Math.round(maxBytes / 1_048_576)} MB.`
  );
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || "file";
}

/** With `asGif`, a .gif becomes the mp4 WhatsApp loops; an mp4 is already that. Anything else is refused. */
export async function asGifMedia(media: LoadedMedia, asGif: boolean): Promise<LoadedMedia> {
  if (!asGif) return media;
  if (media.mimetype === "image/gif") {
    const buffer = await gifToMp4(media.buffer);
    return { buffer, mimetype: "video/mp4", filename: media.filename.replace(/\.gif$/i, "") + ".mp4" };
  }
  if (media.mimetype.startsWith("video/")) return media;
  throw new WazapError(
    "MEDIA_UNAVAILABLE",
    `as: "gif" needs a .gif or a video, not ${media.mimetype}.`,
    'Pass a .gif or an mp4, or leave out as: "gif"'
  );
}

/** Whether WhatsApp shows a caption on media sent this way: never on a voice note, nor on a plain audio file. */
export function captionTravels(mime: string, opts: { asDocument: boolean; asVoice: boolean; asGif: boolean }): boolean {
  if (opts.asVoice) return false;
  return opts.asGif || opts.asDocument || !mime.startsWith("audio/");
}

/** The MIME a draft's file or URL names by its extension, before anything is read; a URL without one names none. */
export function mimeOfSource(source: MediaSource): string {
  if (source.file_path) return guessMime(source.file_path);
  if (source.inline !== undefined) return sniffMime(source.inline.bytes, source.inline.mime ?? null, source.inline.filename);
  if (!source.url) return "application/octet-stream";
  try {
    return guessMime(new URL(source.url).pathname);
  } catch {
    return "application/octet-stream";
  }
}

export function mediaContent(
  media: LoadedMedia,
  opts: { caption?: string; asDocument: boolean; asVoice: boolean; asGif: boolean }
): AnyMessageContent {
  const { buffer, mimetype, filename } = media;
  if (opts.asVoice) return { audio: buffer, mimetype: "audio/ogg; codecs=opus", ptt: true };
  if (opts.asGif) return { video: buffer, gifPlayback: true, caption: opts.caption };
  if (opts.asDocument) return { document: buffer, mimetype, fileName: filename, caption: opts.caption };
  if (mimetype.startsWith("image/")) return { image: buffer, caption: opts.caption };
  if (mimetype.startsWith("video/")) return { video: buffer, caption: opts.caption };
  if (mimetype.startsWith("audio/")) return { audio: buffer, mimetype };
  return { document: buffer, mimetype, fileName: filename, caption: opts.caption };
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
  webm: "video/webm",
  wav: "audio/wav",
  heic: "image/heic",
  json: "application/json",
  md: "text/markdown",
  html: "text/html",
  ics: "text/calendar",
  vcf: "text/vcard",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};

/** The extension a type is saved under, for a name that has none. */
const EXTENSION_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_BY_EXTENSION)
    .filter(([ext]) => !["jpeg", "opus"].includes(ext))
    .map(([ext, mime]) => [mime, ext])
);

function guessMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}
