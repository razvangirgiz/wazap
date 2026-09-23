import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "baileys";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, databaseHolds, storageRows } from "./helpers.mjs";
import { WebhookSink } from "../dist/webhook.js";

const CHAT = "40700000002@s.whatsapp.net";
const SECRET = "synthetic-ephemeral-secret-314159";
const START = 1_700_000_000_000;
const sid = (raw) => `${!!raw.key.fromMe}_${raw.key.remoteJid}_${raw.key.id}`;
const gate = () => { let release; const promise = new Promise((done) => { release = done; }); return { promise, release }; };
const vectors = (texts) => texts.map(() => [1, ...new Array(767).fill(0)]);
function message(id = "E1", duration = 10, content = { conversation: SECRET }) {
  return { key: { remoteJid: CHAT, fromMe: false, id }, messageTimestamp: START / 1000,
    ephemeralStartTimestamp: START / 1000, ephemeralDuration: duration, message: content };
}
async function fixture(t, { embed, timers = false, retention = true } = {}) {
  let now = START;
  if (timers) t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  else t.mock.method(Date, "now", () => now);
  const dir = await mkdtemp(join(tmpdir(), "wazap-expiry-"));
  const services = [];
  t.after(async () => { for (const svc of services) await svc.stop(); await rm(dir, { recursive: true, force: true }); });
  const boot = async (config = {}) => {
    const saved = Object.entries(process.env).filter(([key]) => key.startsWith("WAZAP_"));
    for (const [key] of saved) delete process.env[key];
    process.env.WAZAP_RECALL = embed ? "local" : "off";
    let result;
    try {
      result = connectedService(WhatsAppService, { prefix: "wazap-expiry-", id: "40700000001@s.whatsapp.net", name: "Synthetic",
        config: { dataDir: dir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0, retention, ...config } });
    } finally {
      for (const key of Object.keys(process.env)) if (key.startsWith("WAZAP_")) delete process.env[key];
      for (const [key, value] of saved) process.env[key] = value;
    }
    if (embed) result.svc.recallIndex.recallEmbed = embed;
    services.push(result.svc);
    await result.svc.bootStorage();
    return result;
  };
  return { ...await boot(), boot, advance(ms) { now += ms; if (timers) t.mock.timers.tick(ms); } };
}
async function seed(svc, raw = message()) {
  svc.ingest.ingestMessages([raw]);
  await svc.recallIdle();
  return raw;
}
/** The words are nowhere in the database files, and no row keeps them. */
async function noPayload(svc) {
  await svc.storageIdle();
  assert.equal(databaseHolds(svc, SECRET), false, "the words are gone from the database files");
}
/** A legacy history line, the shape main wrote. */
const historyLine = (item) =>
  JSON.stringify({ sid: sid(item), ts: item.messageTimestamp, raw: Buffer.from(proto.WebMessageInfo.encode(item).finish()).toString("base64") });

test("already-expired messages never enter the database, the search or the embeddings", async (t) => {
  const { svc, advance } = await fixture(t, { embed: async (texts) => vectors(texts) });
  advance(10_000);
  const raw = await seed(svc);
  await svc.storageIdle();
  assert.equal(svc.hasMessage(sid(raw)), false);
  assert.equal(svc.db.vectors.count(), 0);
  await noPayload(svc);
});

test("without WAZAP_RETENTION a disappearing message stays readable past its deadline", async (t) => {
  const { svc, advance } = await fixture(t, { retention: false });
  const raw = await seed(svc);
  advance(60_000);
  await svc.storageIdle();
  assert.equal((await svc.getMessage(sid(raw))).text, SECRET);
  assert.equal(svc.hasMessage(sid(raw)), true);
  assert.equal(svc.db.messages.get(sid(raw)).expiresAt, null, "no deadline is recorded");
});

test("reads enforce the exact expiry instant even if a scheduled timer has not run", async (t) => {
  const { svc, advance } = await fixture(t);
  const raw = await seed(svc);
  advance(9_999);
  assert.equal((await svc.getMessage(sid(raw))).text, SECRET);
  advance(1);
  await assert.rejects(svc.getMessage(sid(raw)), { code: "MESSAGE_NOT_FOUND" });
  assert.equal(svc.hasMessage(sid(raw)), false);
});

test("an idle account expires payloads and automatic previews without another tool call", async (t) => {
  const { svc, advance } = await fixture(t, { timers: true });
  const raw = await seed(svc);
  await svc.writePreview(sid(raw), Buffer.from("synthetic thumbnail"));
  assert.ok(svc.storage.expiryTimer, "a timer is armed for the deadline");
  advance(10_000);
  // Only what the timer started is awaited: no read, and no storageIdle, which would sweep on its own.
  await svc.storage.expirySweep;
  const [row] = storageRows(svc, "SELECT deleted_at, text, raw FROM messages WHERE key_id = ?", raw.key.id);
  assert.notEqual(row.deleted_at, null, "the timer's sweep tombstoned it");
  assert.deepEqual([row.text, row.raw], [null, null]);
  assert.deepEqual(storageRows(svc, "SELECT path FROM pending_unlinks"), [], "its preview was unlinked and acknowledged");
  await assert.rejects(readFile(svc.previewPath(sid(raw))), { code: "ENOENT" });
  assert.equal(svc.hasMessage(sid(raw)), false);
  await noPayload(svc);
});

test("contextInfo expiration uses the message time, not the old chat-setting time", async (t) => {
  const { svc, advance } = await fixture(t);
  const raw = message();
  delete raw.ephemeralDuration; delete raw.ephemeralStartTimestamp;
  raw.message = { ephemeralMessage: { message: { extendedTextMessage: { text: SECRET,
    contextInfo: { expiration: 10, ephemeralSettingTimestamp: 1 } } } } };
  await seed(svc, raw);
  assert.equal(svc.hasMessage(sid(raw)), true);
  advance(10_000);
  await assert.rejects(svc.getMessage(sid(raw)), { code: "MESSAGE_NOT_FOUND" });
});

test("an ephemeral wrapper with an uncomputable deadline is not retained indefinitely", async (t) => {
  const { svc } = await fixture(t);
  const raw = message(); delete raw.ephemeralDuration; delete raw.ephemeralStartTimestamp;
  raw.message = { ephemeralMessage: { message: { conversation: SECRET } } };
  await seed(svc, raw);
  assert.equal(svc.hasMessage(sid(raw)), false);
});

test("ordinary messages and a chat timer setting do not inherit a disappearing deadline", async (t) => {
  const { svc, advance } = await fixture(t);
  const raw = message(); delete raw.ephemeralDuration; delete raw.ephemeralStartTimestamp;
  await seed(svc, raw);
  svc.ingest.ingestChat({ id: CHAT, ephemeralExpiration: 1 });
  advance(100_000);
  assert.equal((await svc.getMessage(sid(raw))).text, SECRET);
});

test("an edit or replay without expiry metadata cannot extend the first observed deadline", async (t) => {
  const { svc, sock, advance, boot } = await fixture(t);
  const raw = message(); delete raw.ephemeralDuration; delete raw.ephemeralStartTimestamp;
  raw.message = { extendedTextMessage: { text: SECRET, contextInfo: { expiration: 10 } } };
  await seed(svc, raw);
  sock.ev.emit("messages.update", [{ key: raw.key, update: { message: { editedMessage: { message: { conversation: SECRET } } } } }]);
  svc.ingest.ingestMessages([{ key: raw.key, messageTimestamp: raw.messageTimestamp, message: { conversation: SECRET } }]);
  assert.equal(svc.db.messages.get(sid(raw)).expiresAt, START + 10_000);
  await svc.stop();
  const { svc: next } = await boot();
  advance(10_000);
  await assert.rejects(next.getMessage(sid(raw)), { code: "MESSAGE_NOT_FOUND" });
  await noPayload(next);
});

test("restart while a message is live preserves its deadline; expired replay stays absent", async (t) => {
  const { svc, advance, boot } = await fixture(t);
  const raw = await seed(svc);
  await svc.stop();
  advance(9_000);
  const { svc: next } = await boot();
  assert.equal((await next.getMessage(sid(raw))).text, SECRET);
  advance(1_000);
  await next.storageIdle();
  next.ingest.ingestMessages([raw]);
  assert.equal(next.hasMessage(sid(raw)), false);
  await noPayload(next);
});

test("an expired message leaves the semantic side too, before the sweep", async (t) => {
  const { svc, advance } = await fixture(t, { embed: async (texts) => vectors(texts) });
  await seed(svc);
  assert.equal((await svc.recall(SECRET, undefined, 10)).data.hits.length, 1);
  advance(10_000);
  assert.deepEqual(svc.db.vectors.vectorSearch({ model: "embeddinggemma-300m", vector: vectors([SECRET])[0], limit: 10 }), []);
  assert.deepEqual((await svc.recall(SECRET, undefined, 10)).data.hits, []);
  await svc.storageIdle();
  assert.equal(svc.db.vectors.count(), 0);
  await noPayload(svc);
});

test("a cached preview completing after expiry is not returned", async (t) => {
  const { svc, advance } = await fixture(t);
  const raw = await seed(svc, message("PHOTO", 10, { imageMessage: { mimetype: "image/jpeg" } }));
  const started = gate(); const finish = gate();
  svc.readPreview = async () => { started.release(); return finish.promise; };
  const pending = svc.previews([sid(raw)], 1);
  await started.promise; advance(10_000); finish.release(Buffer.from(SECRET));
  assert.deepEqual(await pending, []);
});

test("a transcription completing after expiry is neither returned nor re-cached", async (t) => {
  const { svc, advance } = await fixture(t);
  const raw = await seed(svc, message("VOICE", 10, { audioMessage: { ptt: true, mimetype: "audio/ogg" } }));
  const started = gate(); const finish = gate();
  svc.mediaBuffer = async () => Buffer.from("synthetic audio");
  svc.transcriber = async () => { started.release(); return finish.promise; };
  const pending = svc.voice.runTranscribe(sid(raw), raw, { mime: "audio/ogg" }, { provider: "local" });
  const rejected = assert.rejects(pending, { code: "MESSAGE_NOT_FOUND" });
  await started.promise; advance(10_000); finish.release({ text: SECRET });
  await rejected;
  await svc.storageIdle();
  await noPayload(svc);
});

const HOOK_ENV = { WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_URL: "http://127.0.0.1:9/hook",
  WAZAP_WEBHOOK_SECRET: "synthetic-secret", WAZAP_WEBHOOK_EVENTS: "all" };
const events = (svc) => storageRows(svc, "SELECT kind, state, attempts, last_error FROM events ORDER BY seq");

for (const reason of ["expiry", "delete"]) test(`a queued service webhook is not sent after ${reason}`, async (t) => {
  const { svc, sock, advance } = await fixture(t);
  const raw = message();
  const started = gate(); const finish = gate(); const seen = [];
  svc.webhook = new WebhookSink(HOOK_ENV, { post: async (_url, opts) => {
    seen.push(JSON.parse(opts.body)); started.release(); await finish.promise; return new Response(null, { status: 204 });
  } });
  // A connection event goes first and holds the line while the message's event waits behind it.
  svc.setStatus("disconnected");
  await started.promise;
  sock.ev.emit("messages.upsert", { type: "notify", messages: [raw] });
  if (reason === "expiry") advance(10_000);
  else sock.ev.emit("messages.delete", { keys: [raw.key] });
  finish.release();
  await svc.outbox.idle();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].event, "connection");
  assert.deepEqual(events(svc).map((row) => [row.kind, row.state]), [["connection", "delivered"], ["message_received", "cancelled"]]);
});

test("a webhook retry checks retention again instead of re-sending an expired payload", async (t) => {
  const { svc, sock, advance } = await fixture(t);
  let calls = 0;
  svc.webhook = new WebhookSink(HOOK_ENV, { post: async () => { calls++; advance(10_000); return new Response(null, { status: 503 }); } });
  sock.ev.emit("messages.upsert", { type: "notify", messages: [message()] });
  await svc.outbox.idle();
  assert.equal(calls, 1);
  advance(1_000);
  svc.outbox.kick();
  await svc.outbox.idle();
  assert.equal(calls, 1, "the retry found the message expired");
  assert.deepEqual(events(svc).map((row) => [row.state, row.attempts]), [["cancelled", 1]]);
});

test("a webhook whose body cannot be built is not posted, and the exception is exposed nowhere", async (t) => {
  const { svc, sock } = await fixture(t);
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  svc.webhook = new WebhookSink(HOOK_ENV, { post: async () => assert.fail("must not POST") });
  svc.webhookPayload = () => { throw new Error(SECRET); };
  sock.ev.emit("messages.upsert", { type: "notify", messages: [message()] });
  await svc.outbox.idle();
  assert.deepEqual(events(svc).map((row) => [row.state, row.last_error]), [["failed", "Webhook delivery failed."]]);
  assert.ok(!JSON.stringify(svc.getStatus().webhook).includes(SECRET));
  assert.ok(!logs.join("\n").includes(SECRET));
});

test("an in-flight embedding cannot publish a message after expiry", async (t) => {
  const started = gate(); const finish = gate();
  const { svc, advance } = await fixture(t, { embed: async (texts) => { started.release(); await finish.promise; return vectors(texts); } });
  const raw = message(); svc.ingest.ingestMessages([raw]);
  await started.promise;
  try { advance(10_000); await svc.storageIdle(); }
  finally { finish.release(); }
  await svc.recallIdle();
  assert.equal(svc.db.vectors.count(), 0);
  await noPayload(svc);
});

test("a forward waiting on recipient preparation rechecks source expiry", async (t) => {
  const { svc, sock, advance } = await fixture(t);
  const raw = await seed(svc);
  const started = gate(); const finish = gate(); let sent = 0;
  svc.sends.prepareSend = async () => { started.release(); await finish.promise; return { sock, jid: CHAT }; };
  sock.sendMessage = async () => { sent++; };
  const pending = svc.forwardMessage(sid(raw), CHAT);
  const rejected = assert.rejects(pending, { code: "MESSAGE_NOT_FOUND" });
  await started.promise; advance(10_000); finish.release();
  await rejected; assert.equal(sent, 0);
});

test("a reply waiting on recipient preparation does not quote an expired message", async (t) => {
  const { svc, sock, advance } = await fixture(t);
  const raw = await seed(svc);
  const started = gate(); const finish = gate(); let sent = 0;
  svc.sends.prepareSend = async () => { started.release(); await finish.promise; return { sock, jid: CHAT }; };
  sock.sendMessage = async () => { sent++; };
  const pending = svc.sendMessage(CHAT, "synthetic reply", sid(raw));
  const rejected = assert.rejects(pending, { code: "MESSAGE_NOT_FOUND" });
  await started.promise; advance(10_000); finish.release();
  await rejected; assert.equal(sent, 0);
});

test("media finishing download after expiry is not newly exported or returned", async (t) => {
  const { svc, advance } = await fixture(t);
  const raw = await seed(svc, message("PHOTO", 10, { imageMessage: { mimetype: "image/jpeg" } }));
  const started = gate(); const finish = gate();
  svc.mediaBuffer = async () => { started.release(); await finish.promise; return Buffer.from(SECRET); };
  const pending = svc.downloadMedia(sid(raw));
  const rejected = assert.rejects(pending, { code: "MESSAGE_NOT_FOUND" });
  await started.promise; advance(10_000); finish.release();
  await rejected;
  await assert.rejects(readFile(svc.paths.mediaDir), { code: "ENOENT" });
});

test("an import discovers deadlines in every alias file before anything is embedded", async (t) => {
  const seen = [];
  const { svc, advance, boot } = await fixture(t, { embed: async (texts) => { seen.push(...texts); return vectors(texts); } });
  const lid = "900001@lid";
  await svc.stop();
  const raw = message(); raw.key.remoteJid = lid;
  const stripped = { key: { ...raw.key, remoteJid: CHAT }, messageTimestamp: raw.messageTimestamp, message: { conversation: SECRET } };
  await mkdir(svc.paths.historyDir, { recursive: true });
  for (const item of [stripped, raw]) await writeFile(join(svc.paths.historyDir, `${item.key.remoteJid}.jsonl`), historyLine(item) + "\n");
  await writeFile(svc.paths.storeFile, JSON.stringify({ v: 1, chats: {}, contacts: {}, messages: {}, byChat: {}, lids: { [lid]: CHAT } }));
  advance(10_000);
  const { svc: next } = await boot();
  await next.recallIdle();
  assert.deepEqual(seen, []);
  assert.equal(next.hasMessage(sid(stripped)), false);
  await noPayload(next);
});

for (const surviving of ["snapshot", "history"]) test(`a stripped edit keeps the deadline its ${surviving} recorded through an import`, async (t) => {
  const { svc, advance, boot } = await fixture(t);
  await svc.stop();
  const stripped = { key: { remoteJid: CHAT, fromMe: false, id: "E1" }, messageTimestamp: START / 1000, message: { conversation: SECRET } };
  const b64 = Buffer.from(proto.WebMessageInfo.encode(stripped).finish()).toString("base64");
  if (surviving === "snapshot") {
    await writeFile(svc.paths.storeFile, JSON.stringify({
      v: 1, chats: {}, contacts: {}, messages: { [sid(stripped)]: b64 }, byChat: { [CHAT]: [sid(stripped)] },
      expires: { [sid(stripped)]: START + 10_000 },
    }));
  } else {
    await mkdir(svc.paths.historyDir, { recursive: true });
    await writeFile(join(svc.paths.historyDir, `${CHAT}.jsonl`), `${JSON.stringify({ sid: sid(stripped), ts: START / 1000, raw: b64, expiresAt: START + 10_000 })}\n`);
  }
  advance(10_000);
  const { svc: next } = await boot();
  assert.equal(next.hasMessage(sid(stripped)), false);
  await noPayload(next);
});

test("an observed expiry stays deleted if the wall clock later moves backwards", async (t) => {
  const { svc, advance } = await fixture(t);
  const raw = await seed(svc);
  advance(10_000);
  assert.equal(svc.hasMessage(sid(raw)), false);
  advance(-10_000);
  svc.ingest.ingestMessages([raw]);
  assert.equal(svc.hasMessage(sid(raw)), false);
});

test("long disappearing timers do not overflow Node's timer range", async (t) => {
  const { svc, advance } = await fixture(t, { timers: true });
  const duration = 90 * 24 * 60 * 60;
  const raw = await seed(svc, message("LONG", duration));
  advance(2_147_483_647);
  assert.equal(svc.hasMessage(sid(raw)), true);
  advance(duration * 1000 - 2_147_483_647);
  assert.equal(svc.hasMessage(sid(raw)), false);
  await svc.storageIdle();
});

test("stop clears expiry scheduling and is idempotent, without a stale second cleanup", async (t) => {
  const { svc, advance } = await fixture(t);
  await seed(svc);
  assert.ok(svc.storage.expiryTimer);
  assert.equal(svc.storage.expiryTimer.hasRef(), false);
  const stopping = svc.stop();
  assert.equal(svc.stop(), stopping);
  await stopping;
  assert.equal(svc.storage.expiryTimer, null);
  const before = await readFile(svc.databasePath);
  advance(20_000);
  await svc.stop();
  assert.deepEqual(await readFile(svc.databasePath), before, "nothing writes the database after the stop");
});

test("a marked outbound acknowledgement expires even without a later socket upsert", async (t) => {
  const { svc, advance } = await fixture(t, { timers: true });
  const raw = message("ACK"); raw.key.fromMe = true; delete raw.key.remoteJid;
  const result = svc.sends.sentResult(raw, CHAT, SECRET);
  assert.equal(svc.hasMessage(result.message_id), true);
  advance(10_000);
  await svc.storage.expirySweep;
  const [row] = storageRows(svc, "SELECT deleted_at, text FROM messages WHERE key_id = ?", "ACK");
  assert.notEqual(row.deleted_at, null, "the timer's sweep tombstoned it, with nothing reading it");
  assert.equal(row.text, null);
  assert.equal(svc.hasMessage(result.message_id), false);
  await noPayload(svc);
});

test("an outbound acknowledgement after shutdown is not stored", async (t) => {
  const { svc, boot } = await fixture(t);
  await svc.stop();
  svc.sends.sentResult(message("LATE_ACK"), CHAT, SECRET);
  assert.equal(svc.storage.expiryTimer, null);
  const { svc: next } = await boot();
  assert.equal(next.hasMessage(sid(message("LATE_ACK"))), false);
  assert.equal(databaseHolds(next, SECRET), false);
});

test("shutdown during a remote delete cannot acknowledge local cleanup, and writes nothing a later service reads", async (t) => {
  const { svc, sock, boot } = await fixture(t);
  const raw = await seed(svc);
  const started = gate(); const finish = gate();
  sock.chatModify = async () => { started.release(); await finish.promise; };
  const pending = svc.deleteMessage(sid(raw), false);
  const rejected = assert.rejects(pending, { code: "NOT_CONNECTED" });
  await started.promise;
  await svc.stop();
  const { svc: next } = await boot();
  finish.release(); await rejected;
  assert.equal(next.hasMessage(sid(raw)), true, "the stopped service did not delete behind the new one");
});

test("an import takes the earliest deadline any version of a history line carried", async (t) => {
  const { svc, advance, boot } = await fixture(t);
  await svc.stop();
  const raw = message();
  const later = { key: raw.key, messageTimestamp: raw.messageTimestamp, message: { conversation: SECRET } };
  // A pre-upgrade history with an expiry-bearing original and a stripped edit.
  await mkdir(svc.paths.historyDir, { recursive: true });
  await writeFile(join(svc.paths.historyDir, `${CHAT}.jsonl`), [raw, later].map(historyLine).join("\n") + "\n");
  advance(10_000);
  const { svc: next } = await boot();
  assert.equal(next.hasMessage(sid(raw)), false);
  await noPayload(next);
});
