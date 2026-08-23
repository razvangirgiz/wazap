/**
 * What must never show up. A `0@s.whatsapp.net` pseudo-chat WhatsApp files its
 * own template notices under sat at the top of list_chats, and four
 * "[system message]" rows from linking a device were counted as conversation in
 * the 24h digest. Both were noise the store should never have kept.
 *
 * Run: npm test  (requires npm run build first — these drive dist/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "baileys";

import { WhatsAppService } from "../dist/whatsapp.js";
import { isAddressableJid } from "../dist/ids.js";

const ME = "40700000001@s.whatsapp.net";
const REAL = "40700000002@s.whatsapp.net";

function config() {
  return {
    dataDir: mkdtempSync(join(tmpdir(), "wazap-noise-")),
    readOnly: true,
    syncFullHistory: false,
    persistHistory: false,
    transport: "stdio",
    httpHost: "127.0.0.1",
    httpPort: 8766,
    readToken: null,
    writeToken: null,
    rateLimitPerMinute: 20,
    command: "serve",
    loginCode: false,
  };
}

function makeFakeSocket() {
  const listeners = new Map();
  return {
    ev: {
      on(event, fn) {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      },
      removeAllListeners(event) {
        listeners.delete(event);
      },
      emit(event, arg) {
        for (const fn of listeners.get(event) ?? []) fn(arg);
      },
    },
    end() {},
  };
}

function makeService() {
  const svc = new WhatsAppService(config());
  const sock = makeFakeSocket();
  svc.sockClient = sock;
  svc.wireEvents(sock, ++svc.generation);
  svc.account = { id: ME, name: "Răzvan", number: "40700000001" };
  svc.status = "connected";
  svc.initialSyncDone = true;
  return { svc, sock };
}

const at = (secondsAgo) => Math.floor(Date.now() / 1000) - secondsAgo;

const message = (chat, message, { id = "M", fromMe = false, seconds = at(60) } = {}) => ({
  key: { remoteJid: chat, fromMe, id },
  message,
  messageTimestamp: seconds,
});

test("only user and group jids are addressable", () => {
  const addressable = ["40700000002@s.whatsapp.net", "273520764416235@lid", "447851830860-1443638182@g.us"];
  const noise = ["0@s.whatsapp.net", "status@broadcast", "1234@newsletter", "@s.whatsapp.net", "40700000002", ""];
  for (const jid of addressable) assert.equal(isAddressableJid(jid), true, jid);
  for (const jid of noise) assert.equal(isAddressableJid(jid), false, jid);
});

test("noise chats never reach the chat list, the digest or the store", async () => {
  const { svc, sock } = makeService();
  sock.ev.emit("chats.upsert", [
    { id: "0@s.whatsapp.net", conversationTimestamp: at(1) },
    { id: "status@broadcast", conversationTimestamp: at(1) },
    { id: REAL, conversationTimestamp: at(30) },
  ]);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      message("0@s.whatsapp.net", { templateMessage: {} }, { id: "T1" }),
      message("status@broadcast", { conversation: "a status" }, { id: "T2" }),
      message(REAL, { conversation: "a real one" }, { id: "T3" }),
    ],
  });

  const chats = (await svc.listChats("all", 20)).data;
  assert.deepEqual(
    chats.map((c) => c.chat_id),
    [REAL],
  );

  const digest = (await svc.getRecentMessages(24, "all")).data;
  assert.deepEqual(
    digest.map((c) => c.chat_id),
    [REAL],
  );
  assert.equal(svc.store.byChat.has("0@s.whatsapp.net"), false, "nothing is stored for a noise jid");
});

test("linking machinery is dropped, not shown as a message", async () => {
  const { svc, sock } = makeService();
  const types = proto.Message.ProtocolMessage.Type;
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      message(ME, { protocolMessage: { type: types.HISTORY_SYNC_NOTIFICATION }, messageContextInfo: {} }, { id: "S1", fromMe: true }),
      message(ME, { protocolMessage: { type: types.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE } }, { id: "S2", fromMe: true }),
      message(ME, { conversation: "note to self" }, { id: "S3", fromMe: true }),
    ],
  });

  const messages = (await svc.readMessages(ME, 20)).data;
  assert.deepEqual(
    messages.map((m) => m.text),
    ["note to self"],
  );

  const digest = (await svc.getRecentMessages(24, "all")).data;
  assert.equal(digest.length, 1);
  assert.equal(digest[0].messages.length, 1, "machinery must not be counted as conversation");
});

test("a snapshot an older wazap wrote is cleaned on the way in", () => {
  const { svc, sock } = makeService();
  sock.ev.emit("messages.upsert", { type: "notify", messages: [message(REAL, { conversation: "keep me" }, { id: "K1" })] });
  const snapshot = JSON.parse(JSON.stringify(svc.store.serialize()));

  const noisy = proto.WebMessageInfo.encode({
    key: { remoteJid: "0@s.whatsapp.net", fromMe: false, id: "N1" },
    message: { templateMessage: {} },
    messageTimestamp: at(10),
  }).finish();
  snapshot.messages["false_0@s.whatsapp.net_N1"] = Buffer.from(noisy).toString("base64");
  snapshot.byChat["0@s.whatsapp.net"] = ["false_0@s.whatsapp.net_N1"];

  const revived = new WhatsAppService(config());
  revived.store.hydrate(snapshot);
  assert.equal(revived.store.byChat.has("0@s.whatsapp.net"), false);
  assert.deepEqual([...revived.store.byChat.keys()], [REAL]);
});

test("system notices are typed, excluded from the digest, and returned on request", async () => {
  const { svc, sock } = makeService();
  const group = "120363000000000003@g.us";
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      { ...message(group, {}, { id: "G1" }), messageStubType: proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD },
      message(group, { conversation: "salut" }, { id: "G2" }),
    ],
  });

  const read = (await svc.readMessages(group, 20)).data;
  assert.deepEqual(read.map((m) => m.type), ["system", "text"], "read_messages shows the whole chat");

  const quiet = (await svc.getRecentMessages(24, "all")).data;
  assert.deepEqual(quiet[0].messages.map((m) => m.text), ["salut"]);

  const loud = (await svc.getRecentMessages(24, "all", true)).data;
  assert.deepEqual(loud[0].messages.map((m) => m.type), ["system", "text"]);
});

test("a chat with nothing but system notices drops out of the digest entirely", async () => {
  const { svc, sock } = makeService();
  const group = "120363000000000004@g.us";
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ ...message(group, {}, { id: "H1" }), messageStubType: proto.WebMessageInfo.StubType.E2E_ENCRYPTED }],
  });

  assert.deepEqual((await svc.getRecentMessages(24, "all")).data, []);
  assert.equal((await svc.getRecentMessages(24, "all", true)).data.length, 1);
});
