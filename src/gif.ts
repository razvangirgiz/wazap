/**
 * WhatsApp has no GIF format: a GIF is an mp4 with `gifPlayback` set, and the
 * phone loops it. A real .gif file therefore has to become an mp4 first, which
 * ffmpeg does in well under a second for the sizes people send.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WazapError } from "./errors.js";
import { which } from "./transcribe/local.js";

const run = promisify(execFile);
const CONVERT_TIMEOUT_MS = 60_000;

const FFMPEG_FIX =
  process.platform === "darwin" ? "Run `brew install ffmpeg`" : "Install ffmpeg from your package manager";

/** Turn a GIF into an mp4 WhatsApp can loop. Even dimensions and yuv420p are what the phones decode. */
export async function gifToMp4(gif: Buffer): Promise<Buffer> {
  const ffmpeg = which("ffmpeg");
  if (ffmpeg === null) {
    throw new WazapError("MEDIA_UNAVAILABLE", "Sending a .gif needs ffmpeg to turn it into the mp4 WhatsApp plays.", FFMPEG_FIX);
  }
  const dir = await mkdtemp(join(tmpdir(), "wazap-gif-"));
  try {
    const input = join(dir, "in.gif");
    const output = join(dir, "out.mp4");
    await writeFile(input, gif);
    const args = [
      "-nostdin", "-loglevel", "error", "-y",
      "-i", input,
      "-movflags", "faststart",
      "-pix_fmt", "yuv420p",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-an",
      output,
    ];
    try {
      await run(ffmpeg, args, { timeout: CONVERT_TIMEOUT_MS, windowsHide: true });
    } catch (err) {
      const detail = (err as { stderr?: string; message?: string }).stderr?.trim() || (err as Error).message;
      throw new WazapError("MEDIA_UNAVAILABLE", `ffmpeg could not convert the GIF: ${detail.slice(-300)}`);
    }
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
