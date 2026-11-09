/**
 * The images wazap makes from a message's media: the 320 px previews a read
 * attaches, the larger "view" get_media sends instead of the original, and
 * the tiles of a video's contact sheet. sharp (libvips) does the work on its
 * own thread pool, so a 12 MP photo no longer holds the event loop that
 * every MCP session, the WhatsApp socket and the webhooks share; it decodes
 * PNG, WebP, GIF and SVG as well as JPEG, and turns a photo the way its EXIF
 * says. sharp is a native module: when it does not load (a platform without
 * its prebuilt binary), previews fall back to the pure-JavaScript JPEG path in
 * src/previews.ts and the larger views are simply not made.
 *
 * Every view is a JPEG flattened onto white (a transparent sticker reads on
 * any background) and sized to a byte budget, so its base64 fits the tool
 * results of hosted clients (claude.ai keeps about 150,000 characters).
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sharp, SharpOptions } from "sharp";
import { log } from "./logger.js";
import { makePreview, PREVIEW_MAX_EDGE } from "./previews.js";
import { HELPER_RSS_BYTES, helperSlots, runNative } from "./native-run.js";
import { which } from "./transcribe/local.js";

type SharpFactory = (input?: Buffer | SharpOptions, options?: SharpOptions) => Sharp;

/**
 * A decompression bomb is a small file that decodes to gigabytes. libvips
 * refuses an input over this many pixels before decoding it; 100 MP is above
 * any phone camera's photo (a 108 MP sensor bins to 12 MP) and far below the
 * 16k x 16k sharp allows by default.
 */
export const INPUT_PIXELS_MAX = 100_000_000;

/** What sharp is told about every untrusted input: the pixel cap, one pass, the first frame only, and no refusal over a warning. */
const INPUT: SharpOptions = { limitInputPixels: INPUT_PIXELS_MAX, sequentialRead: true, animated: false, failOn: "none" };

const PREVIEW_QUALITY = 60;

/**
 * The views get_media sends. standard: the long edge at 1,024 px (about 1,000
 * of Claude's visual tokens) in at most ~110 KB, so the base64 stays under
 * ~150,000 characters; high: 2,048 px for small print, in at most ~1.5 MB.
 */
export const VIEW_DETAILS = {
  standard: { edge: 1024, maxBytes: 110_000 },
  high: { edge: 2048, maxBytes: 1_500_000 },
} as const;
export type ViewDetail = keyof typeof VIEW_DETAILS;

/** The qualities a view tries, best first, before it shrinks. */
const QUALITIES = [82, 72, 62, 52, 42];
/** Each shrink when the lowest quality is still over the budget. */
const SHRINK = 0.8;

export interface Jpeg {
  data: Buffer;
  width: number;
  height: number;
}

export interface ImageView extends Jpeg {
  /** The source's size, turned the way its EXIF says. */
  original_width: number;
  original_height: number;
  /** What libvips read it as: jpeg, png, webp, gif, svg, heif. */
  format: string;
  /** Frames of an animation; only the first is shown. */
  frames?: number;
}

let engine: Promise<SharpFactory | null> | undefined;

/** sharp, loaded the first time an image is made; null when it cannot load here, said once. */
export function loadSharp(): Promise<SharpFactory | null> {
  engine ??= import("sharp").then(
    (module) => {
      const sharp = module.default;
      // A long-running server makes each image once: libvips' operation cache would only hold memory.
      sharp.cache(false);
      return sharp as unknown as SharpFactory;
    },
    (err: unknown) => {
      log(`sharp did not load (${err instanceof Error ? err.message.split("\n")[0] : "unknown error"}): photo previews fall back to pure JavaScript, and larger views are off.`);
      return null;
    }
  );
  return engine;
}

/** Test seam: run as if sharp were (or were not) installed. `undefined` loads it again. */
export function setImageEngine(sharp: SharpFactory | null | undefined): void {
  engine = sharp === undefined ? undefined : Promise.resolve(sharp);
}

/**
 * The 320 px JPEG a read attaches: made by sharp from any image libvips reads,
 * or, without sharp, by jpeg-js from a JPEG (on the event loop, the cost the
 * fallback pays). Null for an input neither can read.
 */
export async function previewImage(input: Buffer, mime: string): Promise<Jpeg | null> {
  const sharp = await loadSharp();
  if (sharp !== null) {
    try {
      const { data, info } = await sharp(input, INPUT)
        .rotate()
        .resize(PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: PREVIEW_QUALITY })
        .toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height };
    } catch {
      return null;
    }
  }
  if (!/^image\/jpe?g\b/i.test(mime)) return null;
  try {
    const made = makePreview(input);
    return { data: Buffer.from(made.base64, "base64"), width: made.width, height: made.height };
  } catch {
    return null;
  }
}

/**
 * A JPEG view of an image at `detail`: the first frame of an animation,
 * turned upright, flattened onto white, never enlarged, and within the
 * detail's byte budget (or `budget`, when the answer carries text beside it). A HEIC photo libvips cannot decode goes through
 * macOS's sips first. Null without sharp, or for an input nothing here reads.
 */
export async function imageView(input: Buffer, detail: ViewDetail, mime = "", budget?: number): Promise<ImageView | null> {
  const sharp = await loadSharp();
  if (sharp === null) return null;
  const { edge, maxBytes } = VIEW_DETAILS[detail];
  const view = async (source: Buffer): Promise<ImageView | null> => {
    try {
      const meta = await sharp(source, INPUT).metadata();
      if (!meta.width || !meta.height) return null;
      const fitted = await fitJpeg(sharp, sharp(source, INPUT).rotate(), edge, budget ?? maxBytes);
      return {
        ...fitted,
        original_width: meta.autoOrient?.width ?? meta.width,
        original_height: meta.autoOrient?.height ?? meta.height,
        format: meta.format ?? "unknown",
        ...(meta.pages !== undefined && meta.pages > 1 ? { frames: meta.pages } : {}),
      };
    } catch {
      return null;
    }
  };
  const made = await view(input);
  if (made !== null || !/^image\/hei[cf]/i.test(mime)) return made;
  // libvips reads a HEIC's header but cannot decode its HEVC pixels: sips can, on macOS.
  const converted = await heicToJpeg(input);
  return converted === null ? null : view(converted);
}

/**
 * The pixels of `pipeline`, fitted inside `edge` and encoded at the best
 * quality under `maxBytes`, shrinking when even the lowest quality is over.
 * The resize is done once; each try only re-encodes.
 */
async function fitJpeg(sharp: SharpFactory, pipeline: Sharp, edge: number, maxBytes: number): Promise<Jpeg> {
  let { data, info } = await pipeline
    .resize(edge, edge, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let shrinks = 0; ; shrinks++) {
    const raw = { width: info.width, height: info.height, channels: info.channels };
    for (const quality of QUALITIES) {
      const out = await sharp(data, { raw }).jpeg({ quality }).toBuffer();
      // Six shrinks leave a quarter of the edge: what is left is returned rather than nothing.
      if (out.length <= maxBytes || shrinks >= 6) return { data: out, width: info.width, height: info.height };
    }
    const width = Math.max(1, Math.floor(info.width * SHRINK));
    ({ data, info } = await sharp(data, { raw }).resize(width).raw().toBuffer({ resolveWithObject: true }));
  }
}

/** A contact sheet's layout: how many columns, and each tile's size, inside a square of `edge`. */
export function sheetLayout(count: number, frameWidth: number, frameHeight: number, edge: number): { columns: number; rows: number; tileWidth: number; tileHeight: number } {
  let best = { columns: 1, rows: count, tileWidth: 1, tileHeight: 1 };
  let bestArea = -1;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const scale = Math.min(edge / (columns * frameWidth), edge / (rows * frameHeight));
    const tileWidth = Math.max(1, Math.floor(frameWidth * scale));
    const tileHeight = Math.max(1, Math.floor(frameHeight * scale));
    const area = tileWidth * tileHeight;
    if (area > bestArea) {
      bestArea = area;
      best = { columns, rows, tileWidth, tileHeight };
    }
  }
  return best;
}

/** Gap between tiles, in a dark grey that separates frames of any content. */
const SHEET_GAP = 4;

/**
 * Frames (JPEG or PNG, in order) tiled left to right and top to bottom into
 * one JPEG within the standard view's size and budget. Null without sharp or
 * with no frame it can read.
 */
export async function contactSheet(frames: Buffer[], detail: ViewDetail = "standard"): Promise<Jpeg | null> {
  const sharp = await loadSharp();
  if (sharp === null || frames.length === 0) return null;
  const first = await sharp(frames[0], INPUT).metadata().catch(() => null);
  if (first === null || !first.width || !first.height) return null;
  const { edge, maxBytes } = VIEW_DETAILS[detail];
  const { columns, rows, tileWidth, tileHeight } = sheetLayout(frames.length, first.width, first.height, edge - SHEET_GAP * 2);
  const tiles = await Promise.all(
    frames.map((frame) =>
      sharp(frame, INPUT)
        .resize(tileWidth, tileHeight, { fit: "contain", background: "#202020" })
        .flatten({ background: "#202020" })
        .jpeg({ quality: 90 })
        .toBuffer()
        .catch(() => null)
    )
  );
  const width = columns * tileWidth + (columns + 1) * SHEET_GAP;
  const height = rows * tileHeight + (rows + 1) * SHEET_GAP;
  const composite = tiles.flatMap((tile, index) =>
    tile === null
      ? []
      : [{ input: tile, left: SHEET_GAP + (index % columns) * (tileWidth + SHEET_GAP), top: SHEET_GAP + Math.floor(index / columns) * (tileHeight + SHEET_GAP) }]
  );
  if (composite.length === 0) return null;
  const canvas = sharp({ create: { width, height, channels: 3, background: "#202020" } }).composite(composite).png();
  // Composite first, then fit: the sheet is already inside `edge`, so only the budget can shrink it.
  const flat = await canvas.toBuffer();
  return fitJpeg(sharp, sharp(flat), edge, maxBytes);
}

const SIPS_TIMEOUT_MS = 30_000;

/**
 * A HEIC photo as a JPEG, by macOS's sips: libvips' prebuilt HEIF loader reads
 * AVIF only, and a photo sent as a document from an iPhone is HEVC. Null
 * elsewhere, or when sips fails.
 */
async function heicToJpeg(input: Buffer): Promise<Buffer | null> {
  if (process.platform !== "darwin") return null;
  const sips = which("sips");
  if (sips === null) return null;
  return helperSlots.run(async () => {
    const dir = await mkdtemp(join(tmpdir(), "wazap-heic-"));
    try {
      const source = join(dir, "in.heic");
      const output = join(dir, "out.jpg");
      await writeFile(source, input, { mode: 0o600 });
      await runNative(sips, ["-s", "format", "jpeg", source, "--out", output], { timeoutMs: SIPS_TIMEOUT_MS, maxRssBytes: HELPER_RSS_BYTES });
      return await readFile(output);
    } catch {
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
