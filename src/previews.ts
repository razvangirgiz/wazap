/**
 * A small JPEG of a photo, made here. WhatsApp used to ship a preview inside
 * every image message; in 2026 almost none carries one (1 in 500 in a real
 * account), so the preview an agent needs to tell a receipt from a baby has
 * to be computed from the photo itself, and the photo never leaves the
 * machine. sharp makes it (src/images.ts); makePreview here is the fallback
 * for an install where sharp does not load: jpeg-js is pure JavaScript and
 * needs no native build, but it decodes on the event loop.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import jpeg from "jpeg-js";
import { which } from "./transcribe/local.js";
import { LOCAL_MEDIA_INPUT_ARGS } from "./media-process.js";

const run = promisify(execFile);
const FRAME_TIMEOUT_MS = 30_000;

/** Longest edge of a preview. 320 px reads a receipt's total and a face. */
export const PREVIEW_MAX_EDGE = 320;
const PREVIEW_QUALITY = 60;

export interface PreviewImage {
  mime: string;
  base64: string;
  width: number;
  height: number;
}

/** Tiny WhatsApp thumbnails identify a photo but cannot show a document's words. */
export function tinyThumbnail(input: Buffer): boolean {
  try {
    const image = jpeg.decode(input, { useTArray: true, maxResolutionInMP: 1, maxMemoryUsageInMB: 16 });
    return Math.max(image.width, image.height) < 160;
  } catch {
    // Leave unrecognized previews alone; do not trigger a download on malformed metadata.
    return false;
  }
}

/** Decode a JPEG, shrink it with a box filter, encode it small. Throws on a file that is not a JPEG. */
export function makePreview(
  input: Buffer,
  maxEdge = PREVIEW_MAX_EDGE,
  limits = { maxResolutionInMP: 50, maxMemoryUsageInMB: 512 }
): PreviewImage {
  const source = jpeg.decode(input, {
    useTArray: true,
    formatAsRGBA: true,
    ...limits,
  });
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const out = Buffer.alloc(width * height * 4);
  const src = source.data;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * source.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * source.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * source.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * source.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let at = (sy * source.width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, at += 4) {
          r += src[at]!;
          g += src[at + 1]!;
          b += src[at + 2]!;
          n++;
        }
      }
      const to = (y * width + x) * 4;
      out[to] = Math.round(r / n);
      out[to + 1] = Math.round(g / n);
      out[to + 2] = Math.round(b / n);
      out[to + 3] = 255;
    }
  }
  const encoded = jpeg.encode({ data: out, width, height }, PREVIEW_QUALITY);
  return { mime: "image/jpeg", base64: Buffer.from(encoded.data).toString("base64"), width, height };
}

/**
 * One frame of a video as a small JPEG, made by ffmpeg when it is installed;
 * null when it is not, or when the clip yields no frame. The frame is taken
 * a second in, where a clip has usually settled, and at the start for one
 * shorter than that.
 */
export async function videoFrame(video: Buffer, maxEdge = PREVIEW_MAX_EDGE): Promise<Buffer | null> {
  const ffmpeg = which("ffmpeg");
  if (ffmpeg === null) return null;
  const dir = await mkdtemp(join(tmpdir(), "wazap-frame-"));
  try {
    const input = join(dir, "in.bin");
    const output = join(dir, "out.jpg");
    await writeFile(input, video);
    for (const at of ["1", "0"]) {
      const args = [
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        at,
        ...LOCAL_MEDIA_INPUT_ARGS,
        "-i",
        input,
        "-frames:v",
        "1",
        "-vf",
        `scale='min(${maxEdge},iw)':-2`,
        "-q:v",
        "6",
        output,
      ];
      try {
        await run(ffmpeg, args, { timeout: FRAME_TIMEOUT_MS, windowsHide: true });
        const frame = await readFile(output);
        if (frame.length > 0) return frame;
      } catch {
        // No frame at that offset; try the start.
      }
    }
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** How many frames a contact sheet shows: enough to follow a clip, few enough to read at 1,024 px. */
export const SHEET_FRAMES = 6;
/** Each frame's longest edge as ffmpeg extracts it, before it is tiled. */
const SHEET_FRAME_EDGE = 512;

export interface VideoFrames {
  /** JPEGs, in the order of `at`. */
  frames: Buffer[];
  /** The second each frame was taken at. */
  at: number[];
  /** How long the clip runs: as WhatsApp stated it, or as ffmpeg read it. */
  duration_seconds?: number;
}

/** "Duration: 00:01:02.50" in ffmpeg's report on its input, as seconds. */
export function parseDuration(report: string): number | undefined {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(report);
  if (!match) return undefined;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** When `count` frames are taken across `duration` seconds: the middle of each equal slice, to a tenth of a second. */
export function frameTimes(duration: number, count = SHEET_FRAMES): number[] {
  const n = duration < 1 ? 1 : count;
  return Array.from({ length: n }, (_, i) => Math.round(((duration * (i + 0.5)) / n) * 10) / 10);
}

/**
 * Frames spread evenly across a clip, for a contact sheet: one ffmpeg run that
 * seeks to each time (a fast seek, so only the frames around each point are
 * decoded), every input under the same protocol and format whitelists as any
 * other ffmpeg call here. The length comes from the envelope, or from
 * ffmpeg's own report on the file. Null without ffmpeg, or when the clip
 * yields no frame.
 */
export async function videoFrames(video: Buffer, seconds?: number): Promise<VideoFrames | null> {
  const ffmpeg = which("ffmpeg");
  if (ffmpeg === null) return null;
  const dir = await mkdtemp(join(tmpdir(), "wazap-sheet-"));
  try {
    const input = join(dir, "in.bin");
    await writeFile(input, video, { mode: 0o600 });
    const duration = seconds ?? (await probeDuration(ffmpeg, input));
    if (duration === undefined) return null;
    const at = frameTimes(duration);
    const outputs = at.map((_, i) => join(dir, `f${i}.jpg`));
    const scale = `scale='min(${SHEET_FRAME_EDGE},iw)':'min(${SHEET_FRAME_EDGE},ih)':force_original_aspect_ratio=decrease`;
    const args = ["-nostdin", "-loglevel", "error", "-y"];
    for (const time of at) args.push("-ss", String(time), ...LOCAL_MEDIA_INPUT_ARGS, "-i", input);
    at.forEach((_, i) => args.push("-map", `${i}:v:0`, "-frames:v", "1", "-an", "-sn", "-dn", "-vf", scale, "-q:v", "3", outputs[i]!));
    try {
      await run(ffmpeg, args, { timeout: FRAME_TIMEOUT_MS, windowsHide: true });
    } catch {
      // A seek past a short clip's last frame fails the run: what it did write is used below.
    }
    const frames: Buffer[] = [];
    const taken: number[] = [];
    for (const [i, output] of outputs.entries()) {
      const frame = await readFile(output).catch(() => null);
      if (frame !== null && frame.length > 0) {
        frames.push(frame);
        taken.push(at[i]!);
      }
    }
    if (frames.length === 0) return null;
    return { frames, at: taken, ...(duration > 0 ? { duration_seconds: Math.round(duration * 10) / 10 } : {}) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The clip's length from ffmpeg's report on its input; it exits with an error for want of an output, which is expected. */
async function probeDuration(ffmpeg: string, input: string): Promise<number | undefined> {
  try {
    const { stderr } = await run(ffmpeg, ["-nostdin", "-hide_banner", ...LOCAL_MEDIA_INPUT_ARGS, "-i", input], { timeout: FRAME_TIMEOUT_MS, windowsHide: true });
    return parseDuration(stderr);
  } catch (err) {
    return parseDuration(String((err as { stderr?: unknown }).stderr ?? ""));
  }
}

/** A JPEG's width and height from its frame header, without decoding it; null when there is none. */
export function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 < jpeg.length) {
    if (jpeg[at] !== 0xff) return null;
    const marker = jpeg[at + 1]!;
    const length = jpeg.readUInt16BE(at + 2);
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(at + 5), width: jpeg.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return null;
}
