/**
 * A GIF on WhatsApp is an mp4 that loops. These pin the two halves: the flag
 * on the outgoing message, and the conversion a real .gif needs first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { mediaContent } from "../dist/whatsapp.js";
import { gifToMp4 } from "../dist/gif.js";
import { which } from "../dist/transcribe/local.js";
import { DraftStore } from "../dist/drafts.js";

const run = promisify(execFile);
const ffmpeg = which("ffmpeg");

test("as_gif sends a video with gifPlayback, and nothing else changes", () => {
  const mp4 = { buffer: Buffer.from("mp4"), mimetype: "video/mp4", filename: "dance.mp4" };
  assert.deepEqual(mediaContent(mp4, { asDocument: false, asVoice: false, asGif: true, caption: "haha" }), {
    video: mp4.buffer,
    gifPlayback: true,
    caption: "haha",
  });
  assert.deepEqual(mediaContent(mp4, { asDocument: false, asVoice: false, asGif: false }), {
    video: mp4.buffer,
    caption: undefined,
  });
});

test("the draft preview says gif", () => {
  const store = new DraftStore();
  const to = { chat_id: "40722123456@s.whatsapp.net", name: "Ana", number: "40722123456" };
  const view = store.view(
    store.put(to, { kind: "media", chatId: to.chat_id, source: { file_path: "/tmp/dance.gif" }, asDocument: false, asVoice: false, asGif: true }),
  );
  assert.match(view.preview, /\[gif\] dance\.gif/);
});

test("a .gif becomes an mp4 WhatsApp can loop", { skip: ffmpeg === null && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-gif-test-"));
  const gifPath = join(dir, "in.gif");
  // Five frames of a colour bar, 33x17 so the odd size has to be made even.
  await run(ffmpeg, ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=33x17:rate=5", "-t", "1", gifPath]);
  const mp4 = await gifToMp4(readFileSync(gifPath));
  assert.equal(mp4.subarray(4, 8).toString(), "ftyp", "an mp4 container");
  assert.ok(mp4.length > 200, `has frames: ${mp4.length} bytes`);
});
