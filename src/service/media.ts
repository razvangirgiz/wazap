/**
 * A message's media for the account's tools: get_media's download to a
 * directory, and the small JPEG previews a read shows, made once and kept as
 * files the database knows. Part of WhatsAppService (src/whatsapp.ts), which
 * keeps the download itself (mediaBuffer), where tests replace it, and lends
 * it through MediaHost.
 */

import type { WAMessage, WASocket } from "baileys";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { WazapError } from "../errors.js";
import { logError } from "../logger.js";
import { mediaFilename } from "../outgoing-media.js";
import { tinyThumbnail, videoFrame } from "../previews.js";
import { loadSharp, previewImage } from "../images.js";
import { mediaInfo, thumbnailOf } from "../messages.js";
import { DIR_MODE, FILE_MODE } from "./util.js";
import type { ConnectionStatus, MediaResult, Preview } from "../wa-types.js";
import type { AccountPaths } from "../config.js";
import type { AccountStorage } from "./storage.js";
import type { MessageViews } from "./views.js";

/** An image this small also comes back inline, as base64. */
const INLINE_IMAGE_MAX_BYTES = 1_000_000;

/**
 * A photo bigger than this is not downloaded for a preview: the keep limit's
 * default, since sharp shrinks a 16 MB photo in tens of milliseconds off the
 * event loop. Without sharp, jpeg-js decodes on the event loop, and only up to
 * the old 6 MB.
 */
const PREVIEW_SOURCE_MAX_BYTES = 16_000_000;
const PREVIEW_SOURCE_MAX_BYTES_JS = 6_000_000;

/** A video bigger than this is not downloaded for a frame. */
const PREVIEW_VIDEO_MAX_BYTES = 25_000_000;

/** How long one call may spend downloading and shrinking photos before it returns with what it has. */
const PREVIEW_BUDGET_MS = 20_000;

/** A file that is not there, as opposed to one that could not be read. */
function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** A message id as a file name: the characters no file system takes become underscores. */
function safeFilename(jid: string): string {
  return jid.replace(/[/\\:*?"<>|]/g, "_");
}

/** What the service lends media: the socket, the download, and whether a message is still there, read at each call. */
export interface MediaHost {
  status(): ConnectionStatus;
  sock(): WASocket | null;
  guarded<T>(work: () => Promise<T>): Promise<T>;
  ensureConnected(): WASocket;
  hasMessage(id: string): boolean;
  /** The bytes behind a message's media, from WhatsApp. */
  mediaBuffer(sock: WASocket, messageId: string, raw: WAMessage): Promise<Buffer>;
  /** The kept copy of a message's media, or null (src/service/keep.ts). */
  keptMedia(messageId: string, raw: WAMessage): Promise<Buffer | null>;
  /** WhatsApp's copy, just downloaded: kept too when the kept-media settings want it. */
  offerKept(messageId: string, raw: WAMessage, buffer: Buffer): Promise<void>;
}

export class AccountMedia {
  constructor(
    private readonly host: MediaHost,
    private readonly views: MessageViews,
    private readonly storage: AccountStorage,
    private readonly paths: AccountPaths
  ) {}

  /**
   * Small JPEGs of these messages' photos, in the order given, at most `max`.
   * A preview made earlier comes first. A tiny shipped thumbnail is upgraded
   * from the original (the kept copy first, even with the link down), once,
   * within a time budget so the call returns with what it has. A photo that
   * has expired, is too big, or that nothing here reads (without sharp: not a
   * JPEG) simply has no preview.
   */
  previews(messageIds: string[], max: number): Promise<Preview[]> {
    return this.host.guarded(async () => {
      const out: Preview[] = [];
      const started = Date.now();
      const sharp = (await loadSharp()) !== null;
      for (const sid of messageIds) {
        if (out.length >= max) break;
        const message = this.storage.readyDb()?.messages.get(sid) ?? null;
        const raw = message === null ? null : this.views.rawOf(message);
        if (!raw) continue;
        const shipped = thumbnailOf(raw);
        const cached = await this.readPreview(sid);
        if (!this.host.hasMessage(sid)) continue;
        if (cached) {
          out.push({ message_id: sid, mime: "image/jpeg", base64: cached.toString("base64") });
          continue;
        }
        if (shipped && !tinyThumbnail(Buffer.from(shipped.base64, "base64"))) {
          out.push({ message_id: sid, ...shipped });
          continue;
        }
        let chosen = shipped;
        const info = mediaInfo(raw);
        const photo =
          info !== undefined &&
          (sharp ? /^image\//i.test(info.mime) : /^image\/jpe?g\b/i.test(info.mime)) &&
          (info.size ?? 0) <= (sharp ? PREVIEW_SOURCE_MAX_BYTES : PREVIEW_SOURCE_MAX_BYTES_JS);
        const video = info !== undefined && /^video\//i.test(info.mime) && (info.size ?? 0) <= PREVIEW_VIDEO_MAX_BYTES;
        if ((photo || video) && Date.now() - started <= PREVIEW_BUDGET_MS) {
          try {
            // A kept copy answers with the link down; only without one is WhatsApp asked, and only while connected.
            const sock = this.host.sock();
            const buffer =
              (await this.host.keptMedia(sid, raw)) ??
              (sock && this.host.status() === "connected" ? await this.host.mediaBuffer(sock, sid, raw) : null);
            const made = buffer === null ? null : photo ? ((await previewImage(buffer, info.mime))?.data ?? null) : await videoFrame(buffer);
            if (made && this.host.hasMessage(sid)) {
              await this.writePreview(sid, made);
              chosen = { mime: "image/jpeg", base64: made.toString("base64") };
            }
          } catch {
            // Expired or unreadable original: keep the shipped thumbnail when available.
          }
        }
        if (chosen && this.host.hasMessage(sid)) out.push({ message_id: sid, ...chosen });
      }
      return out.filter((preview) => this.host.hasMessage(preview.message_id));
    });
  }

  /** Previews live as files, one JPEG per message, recorded against it in the database so a delete takes the file too. */
  private previewPath(sid: string): string {
    return join(this.paths.previewsDir, `${safeFilename(sid)}.jpg`);
  }

  private async readPreview(sid: string): Promise<Buffer | null> {
    const path = this.storage.readyDb()?.messages.media(sid).find((media) => media.kind === "preview")?.path;
    if (path === undefined) return null;
    try {
      return await readFile(path);
    } catch (err) {
      if (!isMissing(err)) logError("preview read", err);
      return null;
    }
  }

  /**
   * Writes the file, then records it against its message. A message deleted
   * meanwhile refuses the record, and the file goes at once; one deleted after
   * the record releases it through the database's unlink queue.
   */
  private async writePreview(sid: string, jpeg: Buffer): Promise<void> {
    if (!this.host.hasMessage(sid)) return;
    const path = this.previewPath(sid);
    await mkdir(this.paths.previewsDir, { recursive: true, mode: DIR_MODE });
    if (!this.host.hasMessage(sid)) return;
    await writeFile(path, jpeg, { mode: FILE_MODE });
    const db = this.storage.readyDb();
    const recorded = db?.messages.setMedia(sid, "preview", path) ?? { stored: false, replaced: null };
    if (!recorded.stored) await rm(path, { force: true });
    if (recorded.replaced !== null && recorded.replaced !== path) await rm(recorded.replaced, { force: true });
  }

  /**
   * The kept copy first: it answers with no link, and after WhatsApp let the
   * file go. Only without one is WhatsApp asked, and what it sends is kept
   * then when the settings want it.
   */
  downloadMedia(messageId: string, saveTo?: string): Promise<MediaResult> {
    return this.host.guarded(async () => {
      const raw = this.views.messageOrThrow(messageId);
      const info = mediaInfo(raw);
      if (!info) throw new WazapError("MEDIA_UNAVAILABLE", `Message ${messageId} carries no media.`);
      let buffer = await this.host.keptMedia(messageId, raw);
      const source: MediaResult["source"] = buffer === null ? "whatsapp" : "kept";
      if (buffer === null) {
        const sock = this.host.ensureConnected();
        buffer = await this.host.mediaBuffer(sock, messageId, raw);
        this.views.messageOrThrow(messageId);
        await this.host.offerKept(messageId, raw, buffer).catch((err: unknown) => logError("kept media", err));
      }
      this.views.messageOrThrow(messageId);

      const dir = saveTo ?? this.paths.mediaDir;
      if (!isAbsolute(dir)) {
        throw new WazapError("FILE_NOT_FOUND", `"${dir}" is not an absolute directory path.`);
      }
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
      this.views.messageOrThrow(messageId);
      const filename = mediaFilename(info);
      const path = join(dir, filename);
      await writeFile(path, buffer, { mode: FILE_MODE });
      // An export already written belongs to the user; never delete arbitrary
      // download paths. Do not return its bytes after expiry, however.
      this.views.messageOrThrow(messageId);

      const inline =
        info.mime.startsWith("image/") && buffer.length <= INLINE_IMAGE_MAX_BYTES ? buffer.toString("base64") : null;
      return { path, mime: info.mime, size: buffer.length, filename, inline_base64: inline, source };
    });
  }
}
