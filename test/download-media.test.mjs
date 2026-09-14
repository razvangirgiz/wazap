/**
 * The download_media contract: the bytes on disk are the decrypted file, and
 * the structured result says what arrived with it — mime, the caption the
 * sender wrote, the name their file had — so an agent never has to decrypt or
 * guess.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { WhatsAppService } from "../dist/whatsapp.js";
import { registerTools } from "../dist/tools.js";
import { asToolSource, connectedService } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, meta, handler) {
      tools.set(name, { meta, handler });
    },
  };
}

function setup() {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-dlmedia-", id: ME, name: "Răzvan" });
  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: false });
  const call = (name, args = {}) => {
    const { meta, handler } = server.tools.get(name);
    return handler(z.object(meta.inputSchema).parse(args));
  };
  let seq = 0;
  const arrive = (chat, content, { fromMe = false, participant, at = Date.now() } = {}) => {
    const id = `M${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) },
          message: content,
          messageTimestamp: Math.floor(at / 1000),
        },
      ],
    });
    return `false_${chat}_${id}`;
  };
  return { svc, sock, call, arrive, saveTo: mkdtempSync(join(tmpdir(), "wazap-dl-")) };
}

test("a group photo lands on disk as usable bytes, with its caption and mime", async () => {
  const { svc, call, arrive, saveTo } = setup();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  svc.mediaBuffer = async () => jpeg;
  const sid = arrive(
    GROUP,
    { imageMessage: { mimetype: "image/jpeg", fileLength: jpeg.length, caption: "meniul de azi" } },
    { participant: ANA }
  );

  const result = await call("download_media", { message_id: sid, save_to: saveTo });
  const out = result.structuredContent;
  assert.equal(out.mime, "image/jpeg");
  assert.equal(out.size, jpeg.length);
  assert.equal(out.caption, "meniul de azi");
  assert.equal(out.original_filename, null, "a photo's envelope carries no filename");
  assert.equal(out.message_id, sid);
  assert.ok(out.path.startsWith(saveTo), "saved under the requested directory");
  assert.ok(out.filename.endsWith(".jpeg"), "the saved name keeps the extension");
  assert.deepEqual(readFileSync(out.path), jpeg, "the decrypted bytes round-trip");
  assert.equal("inline_base64" in out, false, "the inline copy is a content block, not a field");
  assert.deepEqual(
    result.content[1],
    { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
    "a small image also comes back inline"
  );
});

test("a document reports its caption and the sender's own filename", async () => {
  const { svc, call, arrive, saveTo } = setup();
  const pdf = Buffer.from("%PDF-1.4 fake");
  svc.mediaBuffer = async () => pdf;
  const sid = arrive(ANA, {
    documentMessage: { mimetype: "application/pdf", fileName: "factura.pdf", fileLength: pdf.length, caption: "plata" },
  });

  const result = await call("download_media", { message_id: sid, save_to: saveTo });
  const out = result.structuredContent;
  assert.equal(out.mime, "application/pdf");
  assert.equal(out.caption, "plata");
  assert.equal(out.original_filename, "factura.pdf");
  assert.ok(out.filename.endsWith(".pdf"), "the saved name keeps the sender's extension");
  assert.deepEqual(readFileSync(out.path), pdf);
  assert.equal(result.content.length, 1, "a document is never inlined");
});

test("a document with no caption reports null, and so does audio", async () => {
  const { svc, call, arrive, saveTo } = setup();
  const pdf = Buffer.from("%PDF-1.4 fake");
  const ogg = Buffer.from("OggS fake audio");
  svc.mediaBuffer = async () => pdf;
  const docSid = arrive(ANA, {
    documentMessage: { mimetype: "application/pdf", fileName: "orar.pdf", fileLength: pdf.length },
  });

  const doc = (await call("download_media", { message_id: docSid, save_to: saveTo })).structuredContent;
  assert.equal(doc.caption, null, "the filename under the tag is not a caption");
  assert.equal(doc.original_filename, "orar.pdf");

  svc.mediaBuffer = async () => ogg;
  const audioSid = arrive(ANA, {
    audioMessage: { mimetype: "audio/ogg; codecs=opus", fileLength: ogg.length, seconds: 7 },
  });
  const audio = (await call("download_media", { message_id: audioSid, save_to: saveTo })).structuredContent;
  assert.equal(audio.caption, null, "audio cannot carry a caption");
  assert.equal(audio.original_filename, null);
  assert.deepEqual(readFileSync(audio.path), ogg);
});

test("a message without media is MEDIA_UNAVAILABLE, not a file of nothing", async () => {
  const { call, arrive, saveTo } = setup();
  const sid = arrive(ANA, { conversation: "doar text" });
  const result = await call("download_media", { message_id: sid, save_to: saveTo });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "MEDIA_UNAVAILABLE");
});

test("a voice note in an unmapped lid chat downloads by its raw id, sender honestly unresolved", async () => {
  const { svc, call, arrive, saveTo } = setup();
  const LID = "4226298167515@lid";
  const ogg = Buffer.from("OggS fake voice");
  svc.mediaBuffer = async () => ogg;
  const sid = arrive(LID, {
    audioMessage: { mimetype: "audio/ogg; codecs=opus", fileLength: ogg.length, seconds: 4, ptt: true },
  });

  const out = (await call("download_media", { message_id: sid, save_to: saveTo })).structuredContent;
  assert.equal(out.mime, "audio/ogg; codecs=opus");
  assert.deepEqual(readFileSync(out.path), ogg, "the attachment came down even with no identity behind it");
  assert.equal(out.sender.id, LID, "the sender stays the unpaired lid");
  assert.equal(out.sender.phone, null);
  assert.equal(out.sender.is_saved, false);
  assert.equal(out.sender.name_source, "none");
  assert.match(out.sender.name, /^unknown \(lid …7515\)$/);
});

test("a message filed under the paired number answers to its raw lid id", async () => {
  const { svc, sock, call, arrive, saveTo } = setup();
  const LID = "999888777666555@lid";
  const OWNER = "40700000007@s.whatsapp.net";
  sock.fetchStatus = async () => [];
  sock.profilePictureUrl = async () => null;
  // The pairing lands first, so the arrival files under the number.
  sock.ev.emit("lid-mapping.update", { lid: LID, pn: OWNER });
  const ogg = Buffer.from("OggS mapped");
  svc.mediaBuffer = async () => ogg;
  const lidSid = arrive(LID, { audioMessage: { mimetype: "audio/ogg", fileLength: ogg.length } });
  const stanza = lidSid.split("_").at(-1);
  assert.equal(svc.store.hasMessage(lidSid), false, "the store keys it by the number");
  assert.equal(svc.store.hasMessage(`false_${OWNER}_${stanza}`), true);

  const out = (await call("download_media", { message_id: lidSid, save_to: saveTo })).structuredContent;
  assert.equal(out.mime, "audio/ogg");
  assert.deepEqual(readFileSync(out.path), ogg);
  assert.equal(out.sender.id, OWNER, "the sender resolves through the same pairing");
});

test("get_message answers the id a view reports after the lid pairs with a number", async () => {
  const { svc, sock, call, arrive } = setup();
  const LID = "999888777666555@lid";
  const OWNER = "40700000007@s.whatsapp.net";
  const sid = arrive(LID, { conversation: "de pe lid" });
  sock.ev.emit("lid-mapping.update", { lid: LID, pn: OWNER });
  // The ring moved to the number but the store still keys the lid spelling, so
  // the id read_messages now reports is not the store key.
  const reported = `false_${OWNER}_${sid.split("_").at(-1)}`;
  assert.equal(svc.store.hasMessage(reported), false);

  const out = (await call("get_message", { message_id: reported })).structuredContent;
  assert.equal(out.text, "de pe lid");
  assert.equal(out.sender.id, OWNER);
});

test("the saved file lands in the media dir when save_to is omitted", async () => {
  const { svc, call, arrive } = setup();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  svc.mediaBuffer = async () => jpeg;
  const sid = arrive(ANA, { imageMessage: { mimetype: "image/jpeg", fileLength: jpeg.length } });
  const out = (await call("download_media", { message_id: sid })).structuredContent;
  assert.ok(out.path.startsWith(svc.paths.mediaDir));
  assert.ok(existsSync(out.path));
});
