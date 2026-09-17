/**
 * set_profile_picture: the linked account's own photo, mocked at the socket.
 * No live WhatsApp call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Readable } from "node:stream";

import { loadProfilePicture } from "../dist/outgoing-media.js";
import { registerTools } from "../dist/tools.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { asToolSource, connectedService } from "./helpers.mjs";

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
    (err) => err.code === "READ_ONLY"
  );
  await svc.stop();
});

test("FILE_NOT_FOUND for a missing path and for not exactly one of path or url", async () => {
  const { svc } = writableService();
  await assert.rejects(
    () => svc.setOwnProfilePicture({ file_path: "/no/such/wazap-pic.jpg" }),
    (err) => err.code === "FILE_NOT_FOUND"
  );
  await assert.rejects(
    () => svc.setOwnProfilePicture({}),
    (err) => err.code === "FILE_NOT_FOUND" && /exactly one/i.test(err.message)
  );
  await assert.rejects(
    () => svc.setOwnProfilePicture({ file_path: jpegPath(), url: "https://example.com/pic.jpg" }),
    (err) => err.code === "FILE_NOT_FOUND" && /exactly one/i.test(err.message)
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
    (err) => err.code === "INVALID_IMAGE"
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
    (err) => err.code === "FILE_TOO_LARGE" && /10 MB/.test(err.message)
  );
  assert.equal(called, false);
  await svc.stop();
});

test("a public url is fetched into the buffer updateProfilePicture sends", async () => {
  // The socket handoff itself is covered by the file_path test; a fake network
  // stands in for the fetch, since a real loopback server is exactly what the
  // public-address check refuses.
  const request = (_url, _options, cb) => {
    const res = Readable.from([Buffer.from("fake-jpeg-bytes")]);
    res.statusCode = 200;
    res.headers = { "content-type": "image/jpeg" };
    res.socket = { remoteAddress: "93.184.216.34" };
    queueMicrotask(() => cb(res));
    return {
      on() {
        return this;
      },
      end() {},
    };
  };
  const media = await loadProfilePicture(
    { url: "https://example.com/me.jpg" },
    {
      request,
      requestTls: request,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    }
  );
  assert.equal(media.mimetype, "image/jpeg");
  assert.equal(media.buffer.toString(), "fake-jpeg-bytes");
});

test("the write tool is absent when allowWrite is false", () => {
  const hidden = fakeServer();
  registerTools(hidden, asToolSource({}), { allowWrite: false });
  assert.equal(hidden.tools.has("set_profile_picture"), false);

  const shown = fakeServer();
  registerTools(shown, asToolSource({}), { allowWrite: true });
  assert.ok(shown.tools.has("set_profile_picture"));
  assert.equal(shown.tools.get("set_profile_picture").meta.annotations.destructiveHint, true);
});

test("the tool hits the service and learn names it", async () => {
  const { svc, sock } = writableService();
  sock.updateProfilePicture = async () => {};
  sock.profilePictureUrl = async () => PIC_URL;
  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: true });

  const result = await server.tools.get("set_profile_picture").handler({ file_path: jpegPath() });
  assert.equal(result.structuredContent.profile_pic_url, PIC_URL);
  assert.match(result.content[0].text, /Updated the linked account's profile picture/);

  const guide = (await server.tools.get("learn").handler({})).structuredContent.guide;
  assert.match(guide, /set_profile_picture/);
  assert.match(guide, /INVALID_IMAGE/);
  assert.match(guide, /profile picture may be 10 MB/);
  await svc.stop();
});

const GROUP = "120363414132891692@g.us";

/** A group the linked account is in, as an admin or as a plain member. */
function inGroup(sock, admin) {
  sock.groupMetadata = async (id) => ({
    id,
    subject: "Râșnov 18-20 septembrie",
    participants: [{ id: ME, admin: admin ? "admin" : null }],
  });
}

test("manage_group set_picture sends the photo to the group's jid, and remove_picture takes it down", async () => {
  const { svc, sock } = writableService();
  inGroup(sock, true);
  const calls = [];
  sock.updateProfilePicture = async (jid, content) => {
    calls.push(["set", jid, Buffer.isBuffer(content)]);
  };
  sock.removeProfilePicture = async (jid) => {
    calls.push(["remove", jid]);
  };
  sock.profilePictureUrl = async () => PIC_URL;

  const set = await svc.manageGroup(GROUP, "set_picture", undefined, undefined, { file_path: jpegPath() });
  assert.deepEqual(set, {
    group_id: GROUP,
    action: "set_picture",
    applied: "group photo updated",
    profile_pic_url: PIC_URL,
  });
  const removed = await svc.manageGroup(GROUP, "remove_picture");
  assert.equal(removed.applied, "group photo removed");
  assert.deepEqual(calls, [
    ["set", GROUP, true],
    ["remove", GROUP],
  ]);
  await svc.stop();
});

test("set_picture where the account is not an admin is NOT_ADMIN with a fix, and nothing is uploaded", async () => {
  const { svc, sock } = writableService();
  inGroup(sock, false);
  let called = false;
  sock.updateProfilePicture = async () => {
    called = true;
  };
  await assert.rejects(
    () => svc.manageGroup(GROUP, "set_picture", undefined, undefined, { file_path: jpegPath() }),
    (err) => err.code === "NOT_ADMIN" && /make the linked account an admin/.test(err.fix ?? "")
  );
  assert.equal(called, false);
  await svc.stop();
});

test("set_picture refuses a bad file with set_profile_picture's errors, before anything is uploaded", async () => {
  const { svc, sock } = writableService();
  inGroup(sock, true);
  let called = false;
  sock.updateProfilePicture = async () => {
    called = true;
  };
  const dir = mkdtempSync(join(tmpdir(), "wazap-group-pic-"));
  const text = join(dir, "note.txt");
  writeFileSync(text, "not an image");
  const huge = join(dir, "huge.jpg");
  writeFileSync(huge, Buffer.alloc(10 * 1024 * 1024 + 1));
  const setPicture = (source) => svc.manageGroup(GROUP, "set_picture", undefined, undefined, source);

  await assert.rejects(
    () => setPicture({ file_path: text }),
    (err) => err.code === "INVALID_IMAGE"
  );
  await assert.rejects(
    () => setPicture({ file_path: huge }),
    (err) => err.code === "FILE_TOO_LARGE" && /10 MB/.test(err.message)
  );
  await assert.rejects(
    () => setPicture({}),
    (err) => err.code === "FILE_NOT_FOUND" && /exactly one/i.test(err.message)
  );
  assert.equal(called, false);
  await svc.stop();
});

test("the manage_group tool carries the photo through, and its description and learn say to ask first", async () => {
  const { svc, sock } = writableService();
  inGroup(sock, true);
  sock.updateProfilePicture = async () => {};
  sock.profilePictureUrl = async () => PIC_URL;
  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: true });
  const tool = server.tools.get("manage_group");
  assert.ok(tool.meta.inputSchema.action.options.includes("set_picture"));
  assert.match(tool.meta.description, /wait for a yes/);

  const result = await tool.handler({ group_id: GROUP, action: "set_picture", file_path: jpegPath() });
  assert.equal(result.structuredContent.profile_pic_url, PIC_URL);
  assert.match(result.content[0].text, /group photo updated/);

  const guide = (await server.tools.get("learn").handler({})).structuredContent.guide;
  assert.match(guide, /manage_group set_picture/);
  await svc.stop();
});
