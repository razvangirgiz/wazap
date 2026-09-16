import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "baileys";
import { WhatsAppService } from "../dist/whatsapp.js";
import { RecallStore } from "../dist/recall/store.js";
import { RecallQueue } from "../dist/recall/queue.js";
import { embedModelSpec } from "../dist/recall/models.js";
import { connectedService } from "./helpers.mjs";

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
  await svc.retentionIdle?.();
  await svc.flushStore();
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
    await result.svc.loadPersisted();
    return result;
  };
  t.after(async () => { for (const svc of services) await svc.stop(); await rm(dir, { recursive: true, force: true }); });
  const result = await boot(config);
  return { ...result, boot };
}
async function seed(svc, raw = rawMessage()) {
  svc.ingestMessages([raw]);
  await svc.appendHistory([raw]);
  svc.markStoreDirty();
  await idle(svc);
  return raw;
}
function remove(sock, raw) { sock.ev.emit("messages.delete", { keys: [raw.key] }); }
const historyPath = (svc) => join(svc.paths.historyDir, `${CHAT}.jsonl`);
async function assertNoPayload(svc, raw) {
  const bytes = Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString("base64");
  for (const path of [historyPath(svc), svc.paths.storeFile]) {
    const text = await readFile(path, "utf8").catch((err) => { if (err.code === "ENOENT") return ""; throw err; });
    assert.ok(!text.includes(bytes), `retained encoded payload in ${path}`);
    assert.ok(!text.includes(SECRET), `retained transcript in ${path}`);
    if (text) {
      const snapshot = path === svc.paths.storeFile ? JSON.parse(text) : null;
      const payloads = snapshot
        ? [...Object.values(snapshot.messages ?? {}), ...Object.values(snapshot.chats ?? {})]
        : text.trim().split("\n").map((line) => JSON.parse(line).raw);
      for (const payload of payloads) assert.ok(!Buffer.from(payload, "base64").includes(Buffer.from(SECRET)), `retained nested payload in ${path}`);
    }
  }
}

test("phone deletion removes history, snapshot, transcript and cached preview bytes before restart", async (t) => {
  const { svc, sock, boot } = await fixture(t);
  const raw = await seed(svc);
  const sid = sidOf(raw);
  svc.store.setTranscript(sid, { text: SECRET, provider: "local", at: Date.now() });
  await svc.appendHistory([raw]);
  await svc.writePreview(sid, Buffer.from(SECRET));
  remove(sock, raw);
  await idle(svc);
  await assertNoPayload(svc, raw);
  await assert.rejects(readFile(svc.previewPath(sid)), { code: "ENOENT" });
  assert.equal(svc.store.transcripts.has(sid), false);
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

test("a stale append and later history sync cannot resurrect a deleted message", async (t) => {
  const { svc, sock } = await fixture(t);
  const raw = await seed(svc);
  remove(sock, raw);
  await svc.appendHistory([raw]);
  await svc.writePreview(sidOf(raw), Buffer.from(SECRET));
  svc.ingestMessages([raw]);
  await idle(svc);
  assert.equal(svc.hasMessage(sidOf(raw)), false);
  await assertNoPayload(svc, raw);
  await assert.rejects(readFile(svc.previewPath(sidOf(raw))), { code: "ENOENT" });
});

test("chat clear blocks old queued appends and unseen old history, but accepts newer messages", async (t) => {
  const { svc, sock, boot } = await fixture(t);
  const raw = await seed(svc);
  sock.ev.emit("messages.delete", { all: true, jid: CHAT });
  await svc.appendHistory([raw]);
  await idle(svc);
  await assert.rejects(readFile(historyPath(svc)), { code: "ENOENT" });
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

test("recall deletion physically rewrites text/vector rows below the old compaction threshold", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wazap-retention-index-"));
  const spec = embedModelSpec("embeddinggemma-300m");
  const store = await RecallStore.open(dir, spec, 100);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const items = Array.from({ length: 12 }, (_, i) => ({ sid: `s${i}`, jid: CHAT, ts: Date.now(), sender: CHAT, type: "text", text: i ? `kept-${i}` : SECRET }));
  await store.add(items, items.map((_, i) => Array.from({ length: spec.dims }, (_, col) => +(col === i))));
  await store.remove(["s0"]);
  assert.equal(store.count, 11);
  assert.ok(!(await readFile(join(dir, "meta.jsonl"), "utf8")).includes(SECRET));
  assert.equal((await readFile(join(dir, "vectors.bin"))).length, 11 * spec.dims);
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
  assert.equal(svc.store.chats.get(CHAT).messages, undefined);
  await assertNoPayload(svc, raw);
  await svc.stop();
  // Also sanitize a legacy snapshot with the embedded copy, independently of its live ring.
  const snapshot = JSON.parse(await readFile(svc.paths.storeFile, "utf8"));
  snapshot.chats[CHAT] = Buffer.from(proto.Conversation.encode(chat).finish()).toString("base64");
  await writeFile(svc.paths.storeFile, JSON.stringify(snapshot));
  const { svc: next } = await boot();
  assert.equal(next.store.chats.get(CHAT).messages, undefined);
  assert.equal(next.store.chats.get(CHAT).name, chat.name);
  await assertNoPayload(next, raw);
});

const directions = (texts) => texts.map(() => [1, ...new Array(767).fill(0)]);

test("deletion wins over an in-flight embedding that has not reached the index", async (t) => {
  const started = gate(); const finish = gate();
  const { svc, sock } = await fixture(t, async (texts) => {
    started.release(); await finish.promise; return directions(texts);
  });
  const raw = rawMessage();
  svc.ingestMessages([raw]);
  await started.promise;
  try {
    await svc.appendHistory([raw]);
    remove(sock, raw);
    await svc.retentionIdle();
  } finally { finish.release(); }
  await idle(svc);
  assert.equal(svc.recallStore.count, 0);
  const meta = await readFile(join(svc.paths.root, "recall", "meta.jsonl"), "utf8").catch((err) => {
    if (err.code === "ENOENT") return "";
    throw err;
  });
  assert.ok(!meta.includes(SECRET));
});

test("recall hides an index-only deleted message before asynchronous cleanup finishes", async (t) => {
  const { svc, sock } = await fixture(t, async (texts) => directions(texts));
  const raw = await seed(svc);
  const sid = sidOf(raw);
  assert.ok(svc.recallStore.record(sid));
  svc.store.dropMessage(sid);
  const finish = gate();
  void svc.serializeStorage(() => finish.promise);
  remove(sock, raw);
  try {
    const answer = await svc.recall(SECRET, undefined, 10);
    assert.deepEqual(answer.data.hits, []);
  } finally { finish.release(); }
  await idle(svc);
  assert.equal(svc.recallStore.record(sid), undefined);
});

test("phone-number deletion also removes LID-filed memory, history and index rows", async (t) => {
  const { svc, sock, boot } = await fixture(t, async (texts) => directions(texts));
  const raw = rawMessage();
  raw.key.remoteJid = "900001@lid";
  await seed(svc, raw);
  const oldSid = sidOf(raw);
  assert.ok(svc.recallStore.record(oldSid));
  svc.learnLid(raw.key.remoteJid, CHAT);
  remove(sock, { key: { ...raw.key, remoteJid: CHAT } });
  await idle(svc);
  assert.equal(svc.hasMessage(oldSid), false);
  assert.equal(svc.recallStore.record(oldSid), undefined);
  await svc.stop();
  const { svc: next } = await boot();
  assert.equal(next.hasMessage(oldSid), false);
  assert.equal(next.recallStore.record(oldSid), undefined);
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
  assert.equal(svc.recallStore.record(sidOf(raw)), undefined);
  const text = await readFile(join(svc.paths.historyDir, `${raw.key.remoteJid}.jsonl`), "utf8");
  assert.ok(!text.includes(Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString("base64")));
});

test("disabled recall and interrupted rewrite files are not exempt from cleanup", async (t) => {
  const { svc, sock } = await fixture(t, undefined, { retention: true });
  const raw = await seed(svc);
  const dir = join(svc.paths.root, "recall");
  await mkdir(dir, { recursive: true });
  const stages = [join(dir, "meta.jsonl"), join(dir, "vectors.bin"), join(dir, "meta.jsonl.tmp"), `${historyPath(svc)}.tmp`];
  for (const path of stages) await writeFile(path, SECRET);
  const untouched = join(dir, "user-note.txt");
  await writeFile(untouched, "not a managed cache file");
  remove(sock, raw);
  await idle(svc);
  for (const path of stages) await assert.rejects(readFile(path), { code: "ENOENT" });
  assert.equal(await readFile(untouched, "utf8"), "not a managed cache file");
});

test("deleting with history off invalidates inactive old caches and keeps deletion barriers", async (t) => {
  const { svc, boot } = await fixture(t, undefined, { retention: true });
  const raw = await seed(svc);
  await svc.stop();
  const { svc: off, sock } = await boot({ persistHistory: false, retention: true });
  off.ingestMessages([raw]);
  remove(sock, raw);
  await idle(off);
  await assert.rejects(readFile(historyPath(off)), { code: "ENOENT" });
  await assert.rejects(readFile(off.paths.storeFile), { code: "ENOENT" });
  await off.stop();
  const { svc: next } = await boot({ persistHistory: false, retention: true });
  next.ingestMessages([raw]);
  assert.equal(next.hasMessage(sidOf(raw)), false);
});

test("without WAZAP_RETENTION, history off and disabled recall keep earlier caches, and deletions still hold", async (t) => {
  const { svc, boot } = await fixture(t);
  const raw = await seed(svc);
  const dir = join(svc.paths.root, "recall");
  await mkdir(dir, { recursive: true });
  const index = [join(dir, "meta.jsonl"), join(dir, "vectors.bin")];
  for (const path of index) await writeFile(path, "earlier index");
  await svc.stop();
  const { svc: off, sock } = await boot({ persistHistory: false });
  off.ingestMessages([raw]);
  remove(sock, raw);
  await idle(off);
  for (const path of index) assert.equal(await readFile(path, "utf8"), "earlier index");
  await readFile(off.paths.storeFile);
  await off.stop();
  const { svc: next } = await boot({ persistHistory: false });
  next.ingestMessages([raw]);
  assert.equal(next.hasMessage(sidOf(raw)), false);
});

test("a failed automatic-cache cleanup is reported instead of acknowledging cleanup completion", async (t) => {
  const { svc } = await fixture(t);
  const raw = await seed(svc);
  await mkdir(svc.previewPath(sidOf(raw)), { recursive: true });
  await assert.rejects(svc.deleteMessage(sidOf(raw), false), (err) =>
    err.code === "WHATSAPP_ERROR" && /cleanup failed/i.test(err.message) && !err.message.includes(SECRET));
  assert.equal(svc.hasMessage(sidOf(raw)), false);

  // The failure is reported once; a later cleanup that succeeds is not failed by it.
  await rm(svc.previewPath(sidOf(raw)), { recursive: true, force: true });
  const next = await seed(svc, rawMessage("M2"));
  assert.deepEqual(await svc.deleteMessage(sidOf(next), false), { message_id: sidOf(next), for_everyone: false });
});

test("opening an incomplete recall index clears leftover payload and stale staging bytes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wazap-retention-partial-"));
  const files = ["meta.jsonl", "vectors.bin", "meta.jsonl.tmp", "vectors.bin.tmp"];
  for (const name of files) await writeFile(join(dir, name), SECRET);
  const store = await RecallStore.open(dir, embedModelSpec("embeddinggemma-300m"), 100);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(store.count, 0);
  for (const name of files) await assert.rejects(readFile(join(dir, name)), { code: "ENOENT" });
});

test("a deletion arriving during the last seal is drained without needing another feed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wazap-retention-seal-"));
  const store = await RecallStore.open(dir, embedModelSpec("embeddinggemma-300m"), 100);
  const queue = new RecallQueue(store, async () => assert.fail("tombstones need no embedding"));
  t.after(async () => { await queue.stop(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  await store.add([{ sid: "sealed", jid: CHAT, ts: Date.now(), sender: CHAT, type: "text", text: SECRET }], directions([SECRET]));
  const started = gate(); const finish = gate();
  const advance = store.advanceOffset.bind(store);
  store.advanceOffset = async (...args) => { started.release(); await finish.promise; return advance(...args); };
  queue.feed([], { file: "synthetic.jsonl", bytes: 1 });
  await started.promise;
  queue.enqueue({ sid: "sealed" });
  finish.release();
  let timeout;
  try {
    await Promise.race([queue.idle(), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("delete stranded behind the last seal")), 2000);
    })]);
  } finally { clearTimeout(timeout); }
  assert.equal(store.count, 0);
});

for (const method of ["removeMatching", "removeChats"]) test(`${method} evaluates the rows after earlier queued writes commit`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wazap-retention-queued-index-"));
  const store = await RecallStore.open(dir, embedModelSpec("embeddinggemma-300m"), 100);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const item = { sid: "queued", jid: CHAT, ts: Date.now(), sender: CHAT, type: "text", text: SECRET };
  const adding = store.add([item], directions([SECRET]));
  const deleting = method === "removeChats" ? store.removeChats([CHAT]) : store.removeMatching((row) => row.sid === item.sid);
  await Promise.all([adding, deleting]);
  assert.equal(store.count, 0);
  assert.ok(!(await readFile(join(dir, "meta.jsonl"), "utf8")).includes(SECRET));
});

test("deletion barriers reject an older snapshot even after bounded history loses the tombstone line", async (t) => {
  const { svc, sock, boot } = await fixture(t);
  const raw = await seed(svc);
  const oldSnapshot = await readFile(svc.paths.storeFile);
  remove(sock, raw);
  await idle(svc);
  await svc.stop();
  await rm(historyPath(svc), { force: true });
  await writeFile(svc.paths.storeFile, oldSnapshot);
  const { svc: next } = await boot();
  assert.equal(next.hasMessage(sidOf(raw)), false);
  await seed(next, raw);
  assert.equal(next.hasMessage(sidOf(raw)), false);
  await assertNoPayload(next, raw);
});
