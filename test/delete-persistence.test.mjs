/**
 * What a delete leaves behind across a restart. A chat cleared or deleted, by
 * manage_chat or by the phone, and a message deleted for the linked account
 * alone must stay gone once the service boots again on the same data dir: in
 * the database, in list_chats and read_messages, and in the stored vectors
 * recall searches. Mocked at the socket, with a stub embedding server; no live
 * WhatsApp call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, storedIds } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const CLEARED = "40700000011@s.whatsapp.net";
const DELETED = "40700000012@s.whatsapp.net";
const KEPT = "40700000013@s.whatsapp.net";
const DIMS = 768;

const RECALL_ENV = [
  "WAZAP_RECALL",
  "WAZAP_EMBED_MODEL",
  "WAZAP_EMBED_BIN",
  "WAZAP_EMBED_URL",
  "WAZAP_RECALL_MAX",
  "WAZAP_RECALL_MIN_SIMILARITY",
];

/** One slot per word: enough for a vector, and nothing here ranks on meaning. */
function vectorFor(text) {
  const vector = new Array(DIMS).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word === "") continue;
    let hash = 0;
    for (const ch of word) hash = (hash * 31 + ch.codePointAt(0)) % 9973;
    vector[hash % DIMS] += 1;
  }
  return vector;
}

/** A stand-in llama-server: POST /embedding → [{index, embedding: [[dims]]}]. */
function stubEmbedServer() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const texts = [JSON.parse(body).content].flat();
      const reply = texts.map((text, index) => ({ index, embedding: [vectorFor(text)] }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/**
 * A writable service on `dataDir`, after what start() runs before the socket:
 * the database's boot. The recall environment is read in the constructor, so
 * it is set around it.
 */
async function boot(dataDir, embedUrl) {
  const saved = RECALL_ENV.map((key) => [key, process.env[key]]);
  for (const key of RECALL_ENV) delete process.env[key];
  Object.assign(process.env, {
    WAZAP_RECALL: "local",
    WAZAP_EMBED_URL: embedUrl,
    WAZAP_RECALL_MIN_SIMILARITY: "0",
  });
  try {
    const connected = connectedService(WhatsAppService, {
      prefix: "wazap-delete-restart-",
      id: ME,
      name: "Răzvan",
      config: { dataDir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0 },
    });
    connected.sock.chatModify = async () => {};
    await connected.svc.bootStorage();
    return connected;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

let seq = 0;

function say(sock, chat, body, ageSeconds = 60) {
  const id = `P${++seq}`;
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: chat, fromMe: false, id },
        messageTimestamp: Math.floor(Date.now() / 1000) - ageSeconds,
        message: { conversation: body },
      },
    ],
  });
  return `false_${chat}_${id}`;
}

async function recallHits(svc) {
  return (await svc.recall("factura", undefined, 50)).data.hits.map((hit) => hit.message);
}

/**
 * What must hold both before and after the restart: the cleared chats listed
 * and empty, the deleted ones not listed, their messages and vectors gone, and
 * the kept chat exactly as it was.
 */
async function assertDeletes(svc, { cleared = [], deleted = [], gone, kept }) {
  const listed = (await svc.listChats("all", 50)).data;
  for (const chat of cleared) {
    const entry = listed.find((c) => c.chat_id === chat);
    assert.ok(entry, `the cleared chat ${chat} is still listed`);
    assert.equal(entry.last_message, null);
  }
  for (const chat of deleted) {
    assert.equal(
      listed.some((c) => c.chat_id === chat),
      false,
      `the deleted chat ${chat} is not listed`
    );
  }
  for (const chat of [...cleared, ...deleted]) {
    assert.deepEqual((await svc.readMessages(chat, 50)).data, [], `read_messages on ${chat}`);
    assert.deepEqual(storedIds(svc, chat), [], `nothing stored for ${chat}`);
  }
  for (const sid of gone) {
    assert.equal(svc.hasMessage(sid), false, `${sid} is out of the database`);
    assert.equal(svc.db.vectors.get(sid), null, `${sid} has no vector`);
  }
  const hits = await recallHits(svc);
  assert.deepEqual(
    hits.filter((m) => [...cleared, ...deleted].includes(m.chat_id)),
    [],
    "recall answers nothing from a cleared or deleted chat"
  );

  assert.deepEqual(
    (await svc.readMessages(KEPT, 50)).data.map((m) => m.message_id),
    kept
  );
  for (const sid of kept) {
    assert.equal(svc.hasMessage(sid), true, sid);
    assert.ok(svc.db.vectors.get(sid), `${sid} still has its vector`);
    assert.ok(
      hits.some((m) => m.message_id === sid),
      `recall still finds ${sid}`
    );
  }
  assert.deepEqual(storedIds(svc, KEPT).sort(), [...kept].sort());
  assert.ok(
    listed.some((c) => c.chat_id === KEPT && c.last_message !== null),
    "the kept chat is listed with its last message"
  );
}

/** Two chats with an older and a newer message each, and a chat nothing touches. */
async function seed(svc, sock) {
  sock.ev.emit("chats.upsert", [{ id: CLEARED }, { id: DELETED }, { id: KEPT }]);
  const old = [say(sock, CLEARED, "factura veche din iulie", 7200), say(sock, DELETED, "factura veche de gaz", 7200)];
  const recent = [say(sock, CLEARED, "factura lunii august"), say(sock, DELETED, "factura de la gaz")];
  const kept = [say(sock, KEPT, "factura de la curent", 120), say(sock, KEPT, "factura platita la notar")];
  await svc.recallIdle();
  for (const sid of [...old, ...recent, ...kept]) assert.ok(svc.db.vectors.get(sid), `${sid} is embedded before the deletes`);
  return { gone: [...old, ...recent], kept };
}

test("manage_chat clear and delete stay done after a restart: store, list_chats, read_messages and recall agree", async () => {
  const stub = await stubEmbedServer();
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-delete-restart-"));
  try {
    const first = await boot(dataDir, stub.url);
    const { gone, kept } = await seed(first.svc, first.sock);

    await first.svc.manageChat(CLEARED, "clear");
    await first.svc.manageChat(DELETED, "delete");
    await first.svc.recallIdle();
    const expected = { cleared: [CLEARED], deleted: [DELETED], gone, kept };
    await assertDeletes(first.svc, expected);
    await first.svc.stop();

    const second = await boot(dataDir, stub.url);
    await second.svc.recallIdle();
    await assertDeletes(second.svc, expected);
    await second.svc.stop();
  } finally {
    stub.server.close();
  }
});

test("the phone's messages.delete (all) and chats.delete stay done after a restart", async () => {
  const stub = await stubEmbedServer();
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-delete-restart-"));
  try {
    const first = await boot(dataDir, stub.url);
    const { gone, kept } = await seed(first.svc, first.sock);

    first.sock.ev.emit("messages.delete", { jid: CLEARED, all: true });
    first.sock.ev.emit("chats.delete", [DELETED]);
    await first.svc.storageIdle();
    await first.svc.recallIdle();
    const expected = { cleared: [CLEARED], deleted: [DELETED], gone, kept };
    await assertDeletes(first.svc, expected);
    await first.svc.stop();

    const second = await boot(dataDir, stub.url);
    await second.svc.recallIdle();
    await assertDeletes(second.svc, expected);
    await second.svc.stop();
  } finally {
    stub.server.close();
  }
});

test("a message deleted for the linked account alone stays gone after a restart, and shows no placeholder", async () => {
  const stub = await stubEmbedServer();
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-delete-restart-"));
  try {
    const first = await boot(dataDir, stub.url);
    const { svc, sock } = first;
    sock.ev.emit("chats.upsert", [{ id: KEPT }, { id: CLEARED }]);
    const gone = say(sock, KEPT, "factura pe care o sterg doar la mine", 180);
    const stays = say(sock, KEPT, "factura care ramane");
    const elsewhere = say(sock, CLEARED, "factura altui chat");
    await svc.recallIdle();

    assert.deepEqual(await svc.deleteMessage(gone, false), { message_id: gone, for_everyone: false });
    await svc.recallIdle();
    const tombstone = svc.db.messages.get(gone, { includeHidden: true });
    assert.notEqual(tombstone.deletedAt, null, "the chat keeps a tombstone");
    assert.deepEqual([tombstone.text, tombstone.raw], [null, null], "and nothing of the message");
    await svc.stop();

    const second = await boot(dataDir, stub.url);
    await second.svc.recallIdle();
    assert.equal(second.svc.hasMessage(gone), false);
    assert.equal(second.svc.db.vectors.get(gone), null);
    assert.deepEqual(
      (await second.svc.readMessages(KEPT, 50)).data.map((m) => [m.message_id, m.type]),
      [[stays, "text"]],
      "no [deleted] placeholder takes its place"
    );
    for (const sid of [stays, elsewhere]) {
      assert.equal(second.svc.hasMessage(sid), true, sid);
      assert.ok(second.svc.db.vectors.get(sid), sid);
    }
    const hits = await recallHits(second.svc);
    assert.equal(
      hits.some((m) => m.message_id === gone),
      false
    );
    assert.ok(hits.some((m) => m.message_id === stays));
    assert.deepEqual(storedIds(second.svc, KEPT), [stays]);
    assert.notEqual(second.svc.db.messages.get(gone, { includeHidden: true })?.deletedAt ?? null, null);
    assert.deepEqual(storedIds(second.svc, CLEARED), [elsewhere]);
    // A replay of the deleted message is refused.
    second.sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [{ key: { remoteJid: KEPT, fromMe: false, id: gone.split("_").at(-1) }, messageTimestamp: Math.floor(Date.now() / 1000) - 180, message: { conversation: "factura pe care o sterg doar la mine" } }],
    });
    assert.equal(second.svc.hasMessage(gone), false);
    await second.svc.stop();

    // A third boot finds the database as the second left it, and the message still gone.
    const third = await boot(dataDir, stub.url);
    await third.svc.recallIdle();
    assert.equal(third.svc.hasMessage(gone), false);
    assert.equal(third.svc.hasMessage(stays), true);
    await third.svc.stop();
  } finally {
    stub.server.close();
  }
});
