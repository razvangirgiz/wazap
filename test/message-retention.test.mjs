/**
 * Deleted stays deleted: a revoke, a delete for the account or for everyone, a
 * cleared chat and a lid that turns out to be a number all take the message's
 * words, protobuf, transcript, vector and preview off the disk, and no replay
 * — a late sync, a restart, an old snapshot — brings any of it back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "baileys";
import { WhatsAppService } from "../dist/whatsapp.js";
import { NO_MARKS, connectedService, databaseHolds, onlyTombstone } from "./helpers.mjs";

const CHAT = "40700000002@s.whatsapp.net";
const SECRET = "synthetic-retention-secret-27182";
const rawMessage = (id = "M1", message = { conversation: SECRET }) => ({
  key: { remoteJid: CHAT, fromMe: false, id },
  messageTimestamp: Math.floor(Date.now() / 1000) - 60,
  message,
});
const sidOf = (raw) => `${!!raw.key.fromMe}_${raw.key.remoteJid}_${raw.key.id}`;
const gate = () => { let release; const promise = new Promise((done) => { release = done; }); return { promise, release }; };
async function idle(svc) {
  await svc.storageIdle();
  await svc.recallIdle();
}
async function fixture(t, embedding, config = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wazap-retention-"));
  const services = [];
  const boot = async (config = {}) => {
    const before = Object.entries(process.env).filter(([key]) => key.startsWith("WAZAP_"));
    for (const [key] of before) delete process.env[key];
    process.env.WAZAP_RECALL = embedding ? "local" : "off";
    let result;
    try {
      result = connectedService(WhatsAppService, { prefix: "wazap-retention-", id: "40700000001@s.whatsapp.net", name: "Synthetic", config: { dataDir: dir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0, ...config } });
    } finally {
      for (const key of Object.keys(process.env)) if (key.startsWith("WAZAP_")) delete process.env[key];
      for (const [key, value] of before) process.env[key] = value;
    }
    result.sock.chatModify = async () => {};
    result.sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
    if (embedding) result.svc.recallEmbed = embedding;
    result.sock.sendMessage = async () => ({});
    services.push(result.svc);
    await result.svc.bootStorage();
    return result;
  };
  t.after(async () => { for (const svc of services) await svc.stop(); await rm(dir, { recursive: true, force: true }); });
  const result = await boot(config);
  return { ...result, boot };
}
async function seed(svc, raw = rawMessage()) {
  svc.ingestMessages([raw]);
  await idle(svc);
  return raw;
}
function remove(sock, raw) { sock.ev.emit("messages.delete", { keys: [raw.key] }); }
/** Neither the words nor the protobuf are anywhere in the database's files, and the row keeps nothing. */
async function assertNoPayload(svc, raw) {
  await svc.storageIdle();
  const bytes = Buffer.from(proto.WebMessageInfo.encode(raw).finish());
  assert.equal(databaseHolds(svc, SECRET), false, "the words are gone from the database files");
  assert.equal(databaseHolds(svc, bytes), false, "and so is the protobuf");
  const row = svc.db.messages.get(sidOf(raw), { includeHidden: true });
  if (row !== null) assert.deepEqual([row.text, row.transcript, row.raw], [null, null, null]);
}

test("phone deletion removes the message, its transcript and its cached preview before restart", async (t) => {
  const { svc, sock, boot } = await fixture(t);
  const raw = await seed(svc);
  const sid = sidOf(raw);
  svc.db.messages.setTranscript(sid, SECRET);
  await svc.writePreview(sid, Buffer.from(SECRET));
  await readFile(svc.previewPath(sid));
  remove(sock, raw);
  await idle(svc);
  await assertNoPayload(svc, raw);
  await assert.rejects(readFile(svc.previewPath(sid)), { code: "ENOENT" });
  await svc.stop();
  const restarted = await boot();
  assert.equal(restarted.svc.hasMessage(sid), false);
});

test("Baileys messages.update REVOKE removes the original even without an upsert", async (t) => {
  const { svc, sock } = await fixture(t);
  const raw = await seed(svc);
  sock.ev.emit("messages.update", [{ key: raw.key, update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE } }]);
  assert.equal(svc.hasMessage(sidOf(raw)), false);
  await idle(svc);
  await assertNoPayload(svc, raw);
});

test("a revoke observed before its target rejects a delayed sync across restart", async (t) => {
  const { svc, sock, boot } = await fixture(t);
  const raw = rawMessage();
  sock.ev.emit("messages.update", [{ key: raw.key, update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE } }]);
  await idle(svc);
  svc.ingestMessages([raw]);
  assert.equal(svc.hasMessage(sidOf(raw)), false);
  await svc.stop();
  const { svc: next } = await boot();
  await seed(next, raw);
  assert.equal(next.hasMessage(sidOf(raw)), false);
  await assertNoPayload(next, raw);
});

for (const everyone of [false, true]) test(`successful local deletion (${everyone ? "everyone" : "me"}) removes payload immediately`, async (t) => {
  const { svc } = await fixture(t);
  const raw = rawMessage();
  raw.key.fromMe = true;
  await seed(svc, raw);
  await svc.deleteMessage(sidOf(raw), everyone);
  assert.equal(svc.hasMessage(sidOf(raw)), false);
  await assertNoPayload(svc, raw);
});

test("a late preview and a later history sync cannot resurrect a deleted message", async (t) => {
  const { svc, sock } = await fixture(t);
  const raw = await seed(svc);
  remove(sock, raw);
  await svc.writePreview(sidOf(raw), Buffer.from(SECRET));
  svc.ingestMessages([raw]);
  await idle(svc);
  assert.equal(svc.hasMessage(sidOf(raw)), false);
  await assertNoPayload(svc, raw);
  await assert.rejects(readFile(svc.previewPath(sidOf(raw))), { code: "ENOENT" });
});

test("chat clear blocks unseen old history across a restart, but accepts newer messages", async (t) => {
  const { svc, sock, boot } = await fixture(t);
  const raw = await seed(svc);
  sock.ev.emit("messages.delete", { all: true, jid: CHAT });
  await idle(svc);
  assert.deepEqual(svc.db.messages.chatPage(CHAT, { limit: 10 }).items, []);
  await assertNoPayload(svc, raw);
  await svc.stop();
  const { svc: next } = await boot();
  const unseen = rawMessage("UNSEEN");
  await seed(next, unseen);
  assert.equal(next.hasMessage(sidOf(unseen)), false);
  const fresh = rawMessage("FRESH", { conversation: "kept" });
  fresh.messageTimestamp += 120;
  await seed(next, fresh);
  assert.equal(next.hasMessage(sidOf(fresh)), true);
});

test("a cached preview finishing after deletion returns no deleted image", async (t) => {
  const { svc, sock } = await fixture(t);
  const raw = await seed(svc, rawMessage("PHOTO", { imageMessage: { mimetype: "image/jpeg" } }));
  const started = gate(); const finish = gate();
  svc.readPreview = async () => { started.release(); return finish.promise; };
  const pending = svc.previews([sidOf(raw)]);
  await started.promise;
  remove(sock, raw);
  finish.release(Buffer.from(SECRET));
  assert.deepEqual(await pending, []);
});

test("a transcription finishing after deletion is neither cached nor returned", async (t) => {
  const { svc, sock } = await fixture(t);
  const raw = await seed(svc, rawMessage("VOICE", { audioMessage: { ptt: true, mimetype: "audio/ogg" } }));
  const started = gate(); const finish = gate();
  svc.mediaBuffer = async () => Buffer.from("synthetic audio");
  svc.transcriber = async () => { started.release(); return finish.promise; };
  const pending = svc.runTranscribe(sidOf(raw), raw, { mime: "audio/ogg" }, { provider: "local" });
  const rejected = assert.rejects(pending, { code: "MESSAGE_NOT_FOUND" });
  await started.promise;
  remove(sock, raw);
  finish.release({ text: SECRET });
  await rejected;
  await idle(svc);
  await assertNoPayload(svc, raw);
});

test("corrupt retention metadata fails closed without echoing its contents", async (t) => {
  const { svc, boot } = await fixture(t);
  await svc.stop();
  await writeFile(join(svc.paths.root, "retention.json"), `invalid-${SECRET}`);
  await assert.rejects(boot, (err) => !err.message.includes(SECRET) && /retention/i.test(err.message));
});

for (const own of [false, true]) test(`protocol revoke normalizes the sender's perspective (own target: ${own})`, async (t) => {
  const { svc } = await fixture(t);
  const raw = rawMessage();
  raw.key.fromMe = own;
  raw.key.remoteJid = "120000001@g.us";
  await seed(svc, raw);
  svc.ingestMessages([{
    ...rawMessage("REVOKE"),
    key: { remoteJid: raw.key.remoteJid, fromMe: false, participant: CHAT, id: "REVOKE" },
    message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE,
      key: { ...raw.key, fromMe: !own, participant: own ? "40700000001@s.whatsapp.net" : CHAT } } },
  }]);
  assert.equal(svc.hasMessage(sidOf(raw)), false);
});

test("a revoke's embedded remoteJid cannot delete a message in another chat", async (t) => {
  const { svc } = await fixture(t);
  const foreign = rawMessage(); foreign.key.remoteJid = "40700000003@s.whatsapp.net";
  await seed(svc, foreign);
  svc.ingestMessages([{ ...rawMessage("REVOKE"), message: { protocolMessage: {
    type: proto.Message.ProtocolMessage.Type.REVOKE, key: foreign.key,
  } } }]);
  assert.equal(svc.hasMessage(sidOf(foreign)), true);
  await idle(svc);
});

test("an admin's group revoke stub cannot confuse actor direction with the original author's", async (t) => {
  const { svc, sock } = await fixture(t);
  const raw = rawMessage(); raw.key.remoteJid = "120000001@g.us"; raw.key.fromMe = true;
  await seed(svc, raw);
  sock.ev.emit("messages.update", [{ key: { ...raw.key, fromMe: false }, update: {
    message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE,
  } }]);
  assert.equal(svc.hasMessage(sidOf(raw)), false);
});

test("history-sync chat metadata cannot retain a hidden second copy of a deleted message", async (t) => {
  const { svc, sock, boot } = await fixture(t);
  const raw = rawMessage();
  const chat = { id: CHAT, name: "kept chat metadata", messages: [{ message: raw }] };
  svc.ingestChat(chat);
  await seed(svc, raw);
  assert.equal(chat.messages.length, 1, "the socket's source object is not mutated");
  remove(sock, raw);
  await idle(svc);
  const stored = proto.Conversation.decode(svc.db.identity.chat(CHAT).proto);
  assert.deepEqual(stored.messages, [], "the chat's description keeps no message");
  assert.equal(stored.name, chat.name);
  await assertNoPayload(svc, raw);
  await svc.stop();
  // A legacy snapshot with the embedded copy, imported after the delete, cannot bring it in either.
  await writeFile(svc.paths.storeFile, JSON.stringify({
    v: 1,
    chats: { [CHAT]: Buffer.from(proto.Conversation.encode(chat).finish()).toString("base64") },
    contacts: {}, messages: {}, byChat: {},
  }));
  const { svc: next } = await boot();
  const imported = proto.Conversation.decode(next.db.identity.chat(CHAT).proto);
  assert.deepEqual(imported.messages, []);
  assert.equal(imported.name, chat.name);
  await assertNoPayload(next, raw);
});

const directions = (texts) => texts.map(() => [1, ...new Array(767).fill(0)]);

test("deletion wins over an in-flight embedding that has not reached the database", async (t) => {
  const started = gate(); const finish = gate();
  const { svc, sock } = await fixture(t, async (texts) => {
    started.release(); await finish.promise; return directions(texts);
  });
  const raw = rawMessage();
  svc.ingestMessages([raw]);
  await started.promise;
  try {
    remove(sock, raw);
    await svc.storageIdle();
  } finally { finish.release(); }
  await idle(svc);
  assert.equal(svc.db.vectors.count(), 0);
  await assertNoPayload(svc, raw);
});

test("recall stops answering with a deleted message before its file cleanup finishes", async (t) => {
  const { svc, sock } = await fixture(t, async (texts) => directions(texts));
  const raw = await seed(svc);
  const sid = sidOf(raw);
  assert.ok(svc.db.vectors.get(sid));
  const finish = gate();
  const unlink = svc.unlinkReleased.bind(svc);
  svc.unlinkReleased = async () => { await finish.promise; return unlink(); };
  remove(sock, raw);
  try {
    const answer = await svc.recall(SECRET, undefined, 10);
    assert.deepEqual(answer.data.hits, []);
  } finally { finish.release(); }
  await idle(svc);
  assert.deepEqual(onlyTombstone(svc, sid), NO_MARKS, "its vector row is gone from the file, not just hidden");
});

test("phone-number deletion also removes the LID-filed message and its vector", async (t) => {
  const { svc, sock, boot } = await fixture(t, async (texts) => directions(texts));
  const raw = rawMessage();
  raw.key.remoteJid = "900001@lid";
  await seed(svc, raw);
  const oldSid = sidOf(raw);
  assert.ok(svc.db.vectors.get(oldSid));
  svc.learnLid(raw.key.remoteJid, CHAT);
  remove(sock, { key: { ...raw.key, remoteJid: CHAT } });
  await idle(svc);
  assert.equal(svc.hasMessage(oldSid), false);
  assert.equal(svc.db.vectors.count(), 0);
  await assertNoPayload(svc, raw);
  await svc.stop();
  const { svc: next } = await boot();
  assert.equal(next.hasMessage(oldSid), false);
  assert.equal(next.hasMessage(`false_${CHAT}_M1`), false);
});

for (const underLid of [true, false]) test(`a newly learned alias applies an earlier deletion (stored under LID: ${underLid})`, async (t) => {
  const { svc, sock } = await fixture(t, async (texts) => directions(texts));
  const lid = "900002@lid";
  const raw = rawMessage(); raw.key.remoteJid = underLid ? lid : CHAT;
  await seed(svc, raw);
  remove(sock, { key: { ...raw.key, remoteJid: underLid ? CHAT : lid } });
  await idle(svc);
  assert.equal(svc.hasMessage(sidOf(raw)), true, "no pairing has been observed yet");
  svc.learnLid(lid, CHAT);
  assert.equal(svc.hasMessage(sidOf(raw)), false);
  await idle(svc);
  assert.equal(svc.db.vectors.count(), 0);
  await assertNoPayload(svc, raw);
});

test("deleting with history off keeps the barrier, and a restart forgets every message it kept", async (t) => {
  const { svc, boot } = await fixture(t, undefined, { retention: true });
  const raw = await seed(svc);
  await svc.stop();
  const { svc: off, sock } = await boot({ persistHistory: false, retention: true });
  assert.equal(off.hasMessage(sidOf(raw)), false, "history off forgets the messages a history-on run kept");
  off.ingestMessages([raw]);
  assert.equal(off.hasMessage(sidOf(raw)), true);
  remove(sock, raw);
  await idle(off);
  await assertNoPayload(off, raw);
  await off.stop();
  const { svc: next } = await boot({ persistHistory: false, retention: true });
  next.ingestMessages([raw]);
  assert.equal(next.hasMessage(sidOf(raw)), false);
});

test("without WAZAP_RETENTION, history off still forgets messages at a restart, and deletions still hold", async (t) => {
  const { svc, boot } = await fixture(t);
  const kept = await seed(svc, rawMessage("KEPT", { conversation: "synthetic kept words" }));
  const raw = await seed(svc);
  await svc.stop();
  const { svc: off, sock } = await boot({ persistHistory: false });
  assert.equal(off.hasMessage(sidOf(kept)), false);
  off.ingestMessages([raw]);
  remove(sock, raw);
  await idle(off);
  await off.stop();
  const { svc: next } = await boot({ persistHistory: false });
  assert.equal(databaseHolds(next, "synthetic kept words"), false, "a stop with history off leaves no words behind");
  next.ingestMessages([raw]);
  assert.equal(next.hasMessage(sidOf(raw)), false);
});

test("a failed automatic-cache cleanup is reported instead of acknowledging cleanup completion", async (t) => {
  const { svc } = await fixture(t);
  const raw = await seed(svc, rawMessage("PHOTO", { imageMessage: { mimetype: "image/jpeg" } }));
  const sid = sidOf(raw);
  await svc.writePreview(sid, Buffer.from("synthetic thumbnail"));
  // rm(path) cannot remove a directory: the unlink of the released preview fails.
  await rm(svc.previewPath(sid));
  await mkdir(svc.previewPath(sid), { recursive: true });
  await assert.rejects(svc.deleteMessage(sid, false), (err) =>
    err.code === "WHATSAPP_ERROR" && /cleanup failed/i.test(err.message) && !err.message.includes(SECRET));
  assert.equal(svc.hasMessage(sid), false);

  // The failure is reported once; a later cleanup that succeeds is not failed by it.
  await rm(svc.previewPath(sid), { recursive: true, force: true });
  const next = await seed(svc, rawMessage("M2"));
  assert.deepEqual(await svc.deleteMessage(sidOf(next), false), { message_id: sidOf(next), for_everyone: false });
});

test("deletion barriers hold against a replay after a restart, and against an older snapshot imported later", async (t) => {
  const { svc, sock, boot } = await fixture(t);
  const raw = await seed(svc);
  remove(sock, raw);
  await idle(svc);
  await svc.stop();
  await writeFile(svc.paths.storeFile, JSON.stringify({
    v: 1, chats: {}, contacts: {}, byChat: { [CHAT]: [sidOf(raw)] },
    messages: { [sidOf(raw)]: Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString("base64") },
  }));
  const { svc: next } = await boot();
  assert.equal(next.hasMessage(sidOf(raw)), false, "the snapshot's copy is not a way back");
  await seed(next, raw);
  assert.equal(next.hasMessage(sidOf(raw)), false);
  await assertNoPayload(next, raw);
  assert.equal(await readFile(next.paths.storeFile, "utf8").then(() => true), true, "the legacy file is only read");
});
