/**
 * What get_media shows of a message's media: given the original's bytes, the
 * one picture or the text an agent can take in, whatever client it runs in.
 * Hosted clients take image blocks and text, not audio, video or files, so
 * every image becomes a JPEG view, a video a sheet of frames, a document its
 * text. Pure apart from the helpers it calls: nothing here touches the
 * database, the socket or the data dir.
 */
import type { WAMessage } from "baileys";
import { contactSheet, imageView, loadSharp, previewImage } from "./images.js";
import { isLottieSticker, mediaSeconds, stickerThumbnail, thumbnailOf } from "./messages.js";
import { jpegSize, makePreview, videoFrame, videoFrames } from "./previews.js";
import type { MediaDetail, MediaPicture, MediaRendition, PageRange } from "./wa-types.js";

export interface RenderInput {
  raw: WAMessage;
  mime: string;
  filename?: string;
  buffer: Buffer;
  detail: MediaDetail;
  pages?: PageRange;
}

/** Without sharp, a JPEG this big is still shrunk by jpeg-js, on the event loop. */
const JS_VIEW_MAX_BYTES = 6_000_000;

export async function renderMedia(input: RenderInput): Promise<MediaRendition> {
  if (isLottieSticker(input.raw)) return lottieRendition(input.raw);
  const mime = sniffedMime(input.mime, input.buffer);
  if (mime.startsWith("image/")) return imageRendition({ ...input, mime });
  if (mime.startsWith("video/")) return videoRendition(input);
  if (mime.startsWith("audio/")) {
    return { kind: "none", note: "A recording: only its transcript can reach you; there is nothing to look at." };
  }
  return { kind: "none", note: `No view or text is made of ${mime}: only its facts.` };
}

/** A mime the sender left generic, told by the file's first bytes when they say an image. */
function sniffedMime(mime: string, buffer: Buffer): string {
  const lower = mime.toLowerCase();
  if (lower !== "application/octet-stream" && lower !== "") return lower;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buffer.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  return lower;
}

/**
 * Any image as a JPEG view at the asked detail. Without sharp, a JPEG is
 * shrunk by jpeg-js, and anything else falls back to the thumbnail WhatsApp
 * shipped, if any.
 */
async function imageRendition(input: RenderInput): Promise<MediaRendition> {
  const view = await imageView(input.buffer, input.detail, input.mime);
  if (view !== null) {
    return {
      kind: "image",
      jpeg: view.data,
      width: view.width,
      height: view.height,
      detail: input.detail,
      original_width: view.original_width,
      original_height: view.original_height,
      ...(view.frames === undefined ? {} : { frames: view.frames }),
    };
  }
  if ((await loadSharp()) === null && /^image\/jpe?g\b/.test(input.mime) && input.buffer.length <= JS_VIEW_MAX_BYTES) {
    try {
      const made = makePreview(input.buffer, input.detail === "high" ? 2048 : 1024);
      return { kind: "frame", jpeg: Buffer.from(made.base64, "base64"), width: made.width, height: made.height };
    } catch {
      // Not a JPEG after all: the shipped thumbnail, below.
    }
  }
  const shipped = await shippedPicture(input.raw);
  if (shipped !== null) return { kind: "frame", ...shipped };
  return { kind: "none", note: `This ${input.mime} image could not be read here, so it cannot be shown.` };
}

/**
 * A video, GIF or round video as a contact sheet: frames spread across its
 * length, tiled into one JPEG, with the second of each. Without ffmpeg (or
 * sharp to tile them) it falls back to one frame, then to the thumbnail
 * WhatsApp shipped. The sound is not heard here.
 */
async function videoRendition(input: RenderInput): Promise<MediaRendition> {
  const seconds = mediaSeconds(input.raw);
  const duration = seconds === undefined ? {} : { duration_seconds: seconds };
  const taken = await videoFrames(input.buffer, seconds).catch(() => null);
  if (taken !== null) {
    const sheet = await contactSheet(taken.frames, input.detail);
    if (sheet !== null) {
      return {
        kind: "sheet",
        jpeg: sheet.data,
        width: sheet.width,
        height: sheet.height,
        frames_at: taken.at,
        ...(taken.duration_seconds === undefined ? {} : { duration_seconds: taken.duration_seconds }),
      };
    }
  }
  const frame = await videoFrame(input.buffer, 1024).catch(() => null);
  const size = frame === null ? null : jpegSize(frame);
  if (frame !== null && size !== null) return { kind: "frame", jpeg: frame, ...size, ...duration };
  const shipped = await shippedPicture(input.raw);
  if (shipped !== null) return { kind: "frame", ...shipped, ...duration };
  return { kind: "none", note: "No frame of this video could be taken here (ffmpeg is not installed), and it shipped no thumbnail." };
}

/** A Lottie sticker is an animation in vector form: its thumbnail, when it shipped one, is all there is to see. */
async function lottieRendition(raw: WAMessage): Promise<MediaRendition> {
  const shipped = await shippedPicture(raw);
  if (shipped !== null) return { kind: "frame", ...shipped };
  return { kind: "none", note: "An animated (Lottie) sticker that shipped no thumbnail: it cannot be drawn here." };
}

/** The thumbnail WhatsApp shipped with the message (a JPEG, or a sticker's PNG), as a JPEG; null when none came or none reads. */
async function shippedPicture(raw: WAMessage): Promise<MediaPicture | null> {
  const jpeg = thumbnailOf(raw);
  const bytes = jpeg ? Buffer.from(jpeg.base64, "base64") : stickerThumbnail(raw);
  if (bytes === undefined) return null;
  const made = await previewImage(bytes, jpeg ? "image/jpeg" : "image/png");
  return made === null ? null : { jpeg: made.data, width: made.width, height: made.height };
}
