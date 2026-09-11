/**
 * set_profile_picture: the linked account's own photo, mocked at the socket.
 * No live WhatsApp call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerTools } from "../dist/tools.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService } from "./helpers.mjs";

const ME = "40700000000@s.whatsapp.net";
const PIC_URL = "https://pps.whatsapp.net/v/t61.24694-24/pic.jpg";

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, meta, handler) {
      tools.set(name, { meta, handler });
    },
  };
}

function writableService() {
  return connectedService(WhatsAppService, {
    prefix: "wazap-pic-",
    id: ME,
    name: "Răzvan",
    config: { readOnly: false },
  });
}

function jpegPath() {
  const dir = mkdtempSync(join(tmpdir(), "wazap-pic-file-"));
  const path = join(dir, "me.jpg");
  writeFileSync(path, Buffer.from("fake-jpeg-bytes"));
  return path;
}

test("updateProfilePicture is called with ownJid and a buffer", async () => {
  const { svc, sock } = writableService();
  const calls = [];
  sock.updateProfilePicture = async (jid, content) => {
    calls.push({ jid, content });
  };
  sock.profilePictureUrl = async () => PIC_URL;

  const result = await svc.setOwnProfilePicture({ file_path: jpegPath() });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].jid, ME);
  assert.ok(Buffer.isBuffer(calls[0].content));
  assert.deepEqual(result, { profile_pic_url: PIC_URL });
  await svc.stop();
});

test("READ_ONLY when writes are off", async () => {
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-pic-ro-",
    id: ME,
    name: "Răzvan",
    config: { readOnly: true },
  });
  await assert.rejects(
    () => svc.setOwnProfilePicture({ file_path: jpegPath() }),
    (err) => err.code === "READ_ONLY",
  );
  await svc.stop();
});

test("FILE_NOT_FOUND for a missing path and for not exactly one of path or url", async () => {
  const { svc } = writableService();
  await assert.rejects(
    () => svc.setOwnProfilePicture({ file_path: "/no/such/wazap-pic.jpg" }),
    (err) => err.code === "FILE_NOT_FOUND",
  );
  await assert.rejects(
    () => svc.setOwnProfilePicture({}),
    (err) => err.code === "FILE_NOT_FOUND" && /exactly one/i.test(err.message),
  );
  await assert.rejects(
    () => svc.setOwnProfilePicture({ file_path: jpegPath(), url: "https://example.com/pic.jpg" }),
    (err) => err.code === "FILE_NOT_FOUND" && /exactly one/i.test(err.message),
  );
  await svc.stop();
});

test("INVALID_IMAGE for a non-image", async () => {
  const { svc } = writableService();
  const dir = mkdtempSync(join(tmpdir(), "wazap-pic-bad-"));
  const path = join(dir, "note.txt");
  writeFileSync(path, "not an image");
  await assert.rejects(
    () => svc.setOwnProfilePicture({ file_path: path }),
    (err) => err.code === "INVALID_IMAGE",
  );
  await svc.stop();
});

test("FILE_TOO_LARGE for a photo over 10 MB, before the socket is touched", async () => {
  const { svc, sock } = writableService();
  let called = false;
  sock.updateProfilePicture = async () => {
    called = true;
  };
  const dir = mkdtempSync(join(tmpdir(), "wazap-pic-big-"));
  const path = join(dir, "huge.jpg");
  writeFileSync(path, Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(
    () => svc.setOwnProfilePicture({ file_path: path }),
    (err) => err.code === "FILE_TOO_LARGE" && /10 MB/.test(err.message),
  );
  assert.equal(called, false);
  await svc.stop();
});

test("a url is fetched and passed to updateProfilePicture", async () => {
  const { svc, sock } = writableService();
  const calls = [];
  sock.updateProfilePicture = async (jid, content) => {
    calls.push({ jid, content });
  };
  sock.profilePictureUrl = async () => PIC_URL;
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(Buffer.from("fake-jpeg-bytes"), { headers: { "content-type": "image/jpeg" } });
  try {
    const result = await svc.setOwnProfilePicture({ url: "https://example.com/me.jpg" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].jid, ME);
    assert.ok(Buffer.isBuffer(calls[0].content));
    assert.deepEqual(result, { profile_pic_url: PIC_URL });
  } finally {
    globalThis.fetch = original;
  }
  await svc.stop();
});

test("the write tool is absent when allowWrite is false", () => {
  const hidden = fakeServer();
  registerTools(hidden, {}, { allowWrite: false });
  assert.equal(hidden.tools.has("set_profile_picture"), false);

  const shown = fakeServer();
  registerTools(shown, {}, { allowWrite: true });
  assert.ok(shown.tools.has("set_profile_picture"));
  assert.equal(shown.tools.get("set_profile_picture").meta.annotations.destructiveHint, true);
});

test("the tool hits the service and learn names it", async () => {
  const { svc, sock } = writableService();
  sock.updateProfilePicture = async () => {};
  sock.profilePictureUrl = async () => PIC_URL;
  const server = fakeServer();
  registerTools(server, svc, { allowWrite: true });

  const result = await server.tools.get("set_profile_picture").handler({ file_path: jpegPath() });
  assert.equal(result.structuredContent.profile_pic_url, PIC_URL);
  assert.match(result.content[0].text, /Updated the linked account's profile picture/);

  const guide = (await server.tools.get("learn").handler({})).structuredContent.guide;
  assert.match(guide, /set_profile_picture/);
  assert.match(guide, /INVALID_IMAGE/);
  assert.match(guide, /profile picture may be 10 MB/);
  await svc.stop();
});
