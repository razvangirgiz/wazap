/**
 * The images wazap makes from media (src/images.ts): sharp's previews of
 * every image format libvips reads, the jpeg-js fallback when sharp does not
 * load, and the refusals an untrusted image meets before it is decoded.
 * Fixtures are generated here, with sharp itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";

import sharp from "sharp";

import { previewImage, setImageEngine } from "../dist/images.js";

/** A solid image of `format`, `width` x `height`, optionally transparent. */
async function solid(format, width, height, { alpha = false, color = { r: 200, g: 40, b: 40 } } = {}) {
  const background = alpha ? { ...color, alpha: 0 } : color;
  const image = sharp({ create: { width, height, channels: alpha ? 4 : 3, background } });
  return image.toFormat(format).toBuffer();
}

/** A PNG whose header claims `width` x `height`, with almost no pixel data: what a decompression bomb looks like to a decoder. */
function claimedPng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(16))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("a preview is a 320 px JPEG of any image libvips reads, not only of a JPEG", async () => {
  for (const format of ["jpeg", "png", "webp", "gif"]) {
    const preview = await previewImage(await solid(format, 1600, 1200), `image/${format}`);
    assert.ok(preview, format);
    assert.deepEqual([preview.width, preview.height], [320, 240], format);
    const meta = await sharp(preview.data).metadata();
    assert.equal(meta.format, "jpeg", `${format} comes back as a JPEG`);
  }
});

test("a transparent image is previewed on white, and a small one is never enlarged", async () => {
  const preview = await previewImage(await solid("png", 200, 100, { alpha: true }), "image/png");
  assert.deepEqual([preview.width, preview.height], [200, 100]);
  const { data } = await sharp(preview.data).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 240 && data[1] > 240 && data[2] > 240, `white, not black: ${[...data.subarray(0, 3)]}`);
});

test("a photo is turned the way its EXIF says before it is shrunk", async () => {
  const sideways = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#336699" } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const preview = await previewImage(sideways, "image/jpeg");
  assert.deepEqual([preview.width, preview.height], [240, 320]);
});

test("an image claiming more pixels than the cap is refused before it is decoded", async () => {
  const bomb = claimedPng(20_000, 20_000);
  assert.ok(bomb.length < 200, "a few bytes on the wire");
  assert.equal(await previewImage(bomb, "image/png"), null);
  assert.equal(await previewImage(Buffer.from("not an image"), "image/jpeg"), null);
});

test("without sharp, a JPEG is still previewed by jpeg-js, and other formats go without", async (t) => {
  setImageEngine(null);
  t.after(() => setImageEngine(undefined));
  const jpeg = await previewImage(await solid("jpeg", 1600, 1200), "image/jpeg");
  assert.deepEqual([jpeg.width, jpeg.height], [320, 240]);
  assert.equal(await previewImage(await solid("png", 1600, 1200), "image/png"), null);
});

test("read_messages previews a PNG photo too, and a kept copy answers with the link down", async (t) => {
  const { WhatsAppService } = await import("../dist/whatsapp.js");
  const { connectedService, schemaCheckedTools } = await import("./helpers.mjs");
  const { rmSync } = await import("node:fs");
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-png-preview-", id: "40700000001@s.whatsapp.net", name: "Me" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  const ANA = "40700000002@s.whatsapp.net";
  const png = await solid("png", 900, 600);
  let downloads = 0;
  svc.mediaBuffer = async () => {
    downloads++;
    return png;
  };
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: ANA, fromMe: false, id: "P1" }, message: { imageMessage: { mimetype: "image/png", fileLength: png.length } }, messageTimestamp: Math.floor(Date.now() / 1000) }],
  });
  const read = await call("read_messages", { chat_id: ANA, include_previews: true });
  assert.equal(read.structuredContent.preview_count, 1);
  const meta = await sharp(Buffer.from(read.content[1].data, "base64")).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ["jpeg", 320, 213]);
  assert.equal(downloads, 1);

  // A second photo, kept on arrival, while the link is down: the kept copy makes its preview.
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: ANA, fromMe: false, id: "P2" }, message: { imageMessage: { mimetype: "image/png", fileLength: png.length } }, messageTimestamp: Math.floor(Date.now() / 1000) + 1 }],
  });
  svc.status = "connecting";
  svc.keep.read = async (sid) => (sid.endsWith("_P2") ? png : null);
  const offline = await svc.previews([`false_${ANA}_P2`, `false_${ANA}_P1`], 12);
  assert.deepEqual(offline.map((p) => p.message_id), [`false_${ANA}_P2`, `false_${ANA}_P1`], "the kept copy is previewed without WhatsApp");
  assert.equal(downloads, 1, "nothing was downloaded with the link down");
});
