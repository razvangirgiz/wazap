/**
 * What goes out as media: reading a file or a URL into a buffer, the size
 * cap, the mime guess, the GIF conversion, and the Baileys content for each
 * kind. Nothing here touches the socket or the store.
 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AnyMessageContent } from "baileys";
import { WazapError } from "./errors.js";
import { gifToMp4 } from "./gif.js";
import type { MediaSource } from "./wa-types.js";

const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const PROFILE_PICTURE_MAX_BYTES = 10 * 1024 * 1024;
const PROFILE_PICTURE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function mediaFilename(info: { mime: string; filename?: string }): string {
  const original = (info.filename ?? "").replace(/[^\w.-]/g, "_");
  const fromName = original.includes(".") ? original.slice(original.lastIndexOf(".")) : "";
  const subtype = info.mime.split("/")[1]?.split(";")[0] ?? "bin";
  return `${Date.now()}-${randomUUID().slice(0, 8)}${fromName || `.${subtype}`}`;
}

export interface LoadedMedia {
  buffer: Buffer;
  mimetype: string;
  filename: string;
}

export async function assertMediaSource(source: MediaSource, maxBytes = MAX_MEDIA_BYTES): Promise<void> {
  const hasPath = Boolean(source.file_path);
  const hasUrl = Boolean(source.url);
  if (hasPath === hasUrl) {
    throw new WazapError("FILE_NOT_FOUND", "Provide exactly one of file_path or url.");
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

export async function loadMedia(source: MediaSource, maxBytes = MAX_MEDIA_BYTES): Promise<LoadedMedia> {
  await assertMediaSource(source, maxBytes);
  if (source.file_path) {
    const path = source.file_path;
    return { buffer: await readFile(path), mimetype: guessMime(path), filename: basename(path) };
  }

  const url = source.url!;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new WazapError("URL_FETCH_FAILED", `Could not fetch ${url}: ${describe(err)}`);
  }
  if (!response.ok) {
    throw new WazapError("URL_FETCH_FAILED", `Fetching ${url} returned HTTP ${response.status}.`);
  }
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared)) assertMediaSize(declared, maxBytes);
  const buffer = Buffer.from(await response.arrayBuffer());
  assertMediaSize(buffer.length, maxBytes);
  return {
    buffer,
    mimetype: response.headers.get("content-type")?.split(";")[0] ?? guessMime(url),
    filename: basename(url.split("?")[0] ?? url),
  };
}

/** JPEG, PNG or WebP, capped at 10 MB before Baileys sees the buffer. */
export async function loadProfilePicture(source: MediaSource): Promise<LoadedMedia> {
  const media = await loadMedia(source, PROFILE_PICTURE_MAX_BYTES);
  if (!PROFILE_PICTURE_MIMES.has(media.mimetype)) {
    throw new WazapError(
      "INVALID_IMAGE",
      `A profile picture must be a JPEG, PNG or WebP, not ${media.mimetype}.`,
      "Pass a .jpg, .png or .webp via file_path or url",
    );
  }
  return media;
}

function assertMediaSize(size: number, maxBytes: number): void {
  if (size <= maxBytes) return;
  throw new WazapError(
    "FILE_TOO_LARGE",
    `The file is ${Math.round(size / 1_048_576)} MB; the limit is ${Math.round(maxBytes / 1_048_576)} MB.`,
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
    `as_gif needs a .gif or a video, not ${media.mimetype}.`,
    "Pass a .gif or an mp4, or drop as_gif",
  );
}

export function mediaContent(
  media: LoadedMedia,
  opts: { caption?: string; asDocument: boolean; asVoice: boolean; asGif: boolean },
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
};

function guessMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

