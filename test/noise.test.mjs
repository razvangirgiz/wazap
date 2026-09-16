/**
 * What must never show up. A `0@s.whatsapp.net` pseudo-chat WhatsApp files its
 * own template notices under sat at the top of list_chats, and four
 * "[system message]" rows from linking a device were counted as conversation in
 * the 24h digest. Both were noise the store should never have kept.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";

import { WhatsAppService } from "../dist/whatsapp.js";
import { isNoiseJid } from "../dist/ids.js";
import { mkdirSync, writeFileSync } from "node:fs";

import { connectedService, storedIds } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const REAL = "40700000002@s.whatsapp.net";

const makeService = () => connectedService(WhatsAppService, { prefix: "wazap-noise-", id: ME, name: "Răzvan" });

const at = (secondsAgo) => Math.floor(Date.now() / 1000) - secondsAgo;

const message = (chat, message, { id = "M", fromMe = false, seconds = at(60) } = {}) => ({
  key: { remoteJid: chat, fromMe, id },
  message,
  messageTimestamp: seconds,
});

test("noise jids are named exactly, so nothing else gets swallowed", () => {
  const real = [
    "40700000002@s.whatsapp.net",
    "273520764416235@lid",
    "447851830860-1443638182@g.us",
    "1234567890@broadcast",
    "1234@newsletter",
  ];
  const noise = ["0@s.whatsapp.net", "00@s.whatsapp.net", "status@broadcast", "@s.whatsapp.net", "40700000002", ""];
  for (const jid of real) assert.equal(isNoiseJid(jid), false, jid);
  for (const jid of noise) assert.equal(isNoiseJid(jid), true, jid);
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
    [REAL]
  );

  const digest = (await svc.getRecentMessages(24, "all")).data;
  assert.deepEqual(
    digest.map((c) => c.chat_id),
    [REAL]
  );
  assert.equal(svc.db.identity.chat("0@s.whatsapp.net"), null, "nothing is stored for a noise jid");
});

test("linking machinery is dropped, not shown as a message", async () => {
  const { svc, sock } = makeService();
  const types = proto.Message.ProtocolMessage.Type;
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      message(
        ME,
        { protocolMessage: { type: types.HISTORY_SYNC_NOTIFICATION }, messageContextInfo: {} },
        { id: "S1", fromMe: true }
      ),
      message(
        ME,
        { protocolMessage: { type: types.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE } },
        { id: "S2", fromMe: true }
      ),
      message(ME, { conversation: "note to self" }, { id: "S3", fromMe: true }),
    ],
  });

  const messages = (await svc.readMessages(ME, 20)).data;
  assert.deepEqual(
    messages.map((m) => m.text),
    ["note to self"]
  );

  const digest = (await svc.getRecentMessages(24, "all")).data;
  assert.equal(digest.length, 1);
  assert.equal(digest[0].messages.length, 1, "machinery must not be counted as conversation");
});

test("a snapshot an older wazap wrote is cleaned on the way in", async () => {
  const { svc } = connectedService(WhatsAppService, { prefix: "wazap-noise-", id: ME, name: "Răzvan", config: { persistHistory: true } });
  const b64 = (raw) => Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString("base64");
  const chat = Buffer.from(proto.Conversation.encode({ id: REAL }).finish()).toString("base64");
  const snapshot = {
    v: 1,
    chats: { [REAL]: chat, "0@s.whatsapp.net": chat },
    contacts: {},
    messages: {
      [`false_${REAL}_K1`]: b64({ key: { remoteJid: REAL, fromMe: false, id: "K1" }, message: { conversation: "keep me" }, messageTimestamp: at(60) }),
      "false_0@s.whatsapp.net_N1": b64({ key: { remoteJid: "0@s.whatsapp.net", fromMe: false, id: "N1" }, message: { templateMessage: {} }, messageTimestamp: at(10) }),
      [`true_${REAL}_N2`]: b64({
        key: { remoteJid: REAL, fromMe: true, id: "N2" },
        message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION } },
        messageTimestamp: at(10),
      }),
    },
    byChat: { [REAL]: [`false_${REAL}_K1`, `true_${REAL}_N2`], "0@s.whatsapp.net": ["false_0@s.whatsapp.net_N1"] },
  };
  mkdirSync(svc.paths.root, { recursive: true });
  writeFileSync(svc.paths.storeFile, JSON.stringify(snapshot));

  await svc.bootStorage();
  assert.equal(svc.db.identity.chat("0@s.whatsapp.net"), null);
  assert.deepEqual(
    svc.db.identity.listChats().map((c) => c.jid),
    [REAL]
  );
  assert.deepEqual(storedIds(svc, REAL), [`false_${REAL}_K1`], "the control payload is left behind too");
});

test("system notices are typed, excluded from the digest, and returned on request", async () => {
  const { svc, sock } = makeService();
  const group = "120363000000000003@g.us";
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        ...message(group, undefined, { id: "G1" }),
        messageStubType: proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD,
      },
      message(group, { conversation: "salut" }, { id: "G2" }),
    ],
  });

  const read = (await svc.readMessages(group, 20)).data;
  assert.deepEqual(
    read.map((m) => m.type),
    ["system", "text"],
    "read_messages shows the whole chat"
  );

  const quiet = (await svc.getRecentMessages(24, "all")).data;
  assert.deepEqual(
    quiet[0].messages.map((m) => m.text),
    ["salut"]
  );

  const loud = (await svc.getRecentMessages(24, "all", true)).data;
  assert.deepEqual(
    loud[0].messages.map((m) => m.type),
    ["system", "text"]
  );
});

test("a chat with nothing but system notices drops out of the digest entirely", async () => {
  const { svc, sock } = makeService();
  const group = "120363000000000004@g.us";
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      { ...message(group, undefined, { id: "H1" }), messageStubType: proto.WebMessageInfo.StubType.E2E_ENCRYPTED },
    ],
  });

  assert.deepEqual((await svc.getRecentMessages(24, "all")).data, []);
  assert.equal((await svc.getRecentMessages(24, "all", true)).data.length, 1);
});

test("a payload wazap does not model yet stays visible instead of hiding as system", async () => {
  const { svc, sock } = makeService();
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [message(REAL, { someFutureMessage: {}, messageContextInfo: {} }, { id: "E1" })],
  });

  const digest = (await svc.getRecentMessages(24, "all")).data;
  assert.equal(digest.length, 1, "an unmodelled payload must not drop out of the catch-up tool");
  assert.deepEqual(
    digest[0].messages.map((m) => [m.type, m.text]),
    [["unknown", "[unsupported: someFutureMessage]"]]
  );
});
