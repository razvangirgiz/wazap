/**
 * What a restart puts back together. An account upgraded from the legacy
 * files imports them once, at boot, into its database: a message that arrived
 * under a lid and was written to the history file with the phone chat's id
 * lands in that one chat, not in a second one under the lid. From then on the
 * database is what a restart reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { proto } from "baileys";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, openService, offlineConfig } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const PHONE = "40723321578@s.whatsapp.net";
const LID = "117261398495351@lid";

/** The chats the database lists messages under, by jid. */
function chatsWithMessages(svc) {
  return svc.db.identity
    .listChats()
    .filter((chat) => chat.lastMessageId !== null)
    .map((chat) => chat.jid);
}

test("a history line filed under the phone imports into one chat even though it arrived under the lid", async () => {
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-persisted-",
    id: ME,
    name: "Răzvan",
    config: { persistHistory: true },
  });
  const raw = proto.WebMessageInfo.fromObject({
    key: { remoteJid: LID, fromMe: false, id: "3AC5", participant: "" },
    message: { conversation: "Da" },
    messageTimestamp: Math.floor(Date.now() / 1000) - 60,
    pushName: "Sorin",
  });
  const sid = `false_${PHONE}_3AC5`;
  const record = {
    sid,
    ts: Number(raw.messageTimestamp),
    raw: Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString("base64"),
  };
  mkdirSync(svc.paths.historyDir, { recursive: true });
  writeFileSync(join(svc.paths.historyDir, `${PHONE}.jsonl`), `${JSON.stringify(record)}\n`);
  mkdirSync(svc.paths.root, { recursive: true });
  writeFileSync(
    svc.paths.storeFile,
    JSON.stringify({
      v: 1,
      chats: {},
      contacts: { [PHONE]: { id: PHONE, name: "Sorin Cobzaru", lid: LID, phoneNumber: PHONE } },
      pushNames: {},
      messages: {},
      byChat: {},
      transcripts: {},
      contactsResyncedAt: null,
    })
  );

  await svc.bootStorage();

  assert.deepEqual(chatsWithMessages(svc), [PHONE], "one chat, under the phone");
  const recent = (await svc.getRecentMessages(24, "all")).data;
  assert.deepEqual(
    recent.map((c) => c.chat_id),
    [PHONE],
    "the catch-up shows the conversation once"
  );
  assert.equal(recent[0].messages[0].sender.name, "Sorin Cobzaru", "and knows who wrote it");
  assert.equal(recent[0].messages[0].from_me, false);

  const status = svc.getStatus();
  assert.ok(status.last_message_received_at, "status must not say never after a restart that already has messages");
  assert.equal(Date.parse(status.last_message_received_at), Number(raw.messageTimestamp) * 1000);
});

test("a snapshot that still holds a ring under the lid folds it into the phone chat on import", async () => {
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-persisted-",
    id: ME,
    name: "Răzvan",
    config: { persistHistory: true },
  });
  const raw = proto.WebMessageInfo.fromObject({
    key: { remoteJid: LID, fromMe: false, id: "3AC5", participant: "" },
    message: { conversation: "Da" },
    messageTimestamp: Math.floor(Date.now() / 1000) - 60,
    pushName: "Sorin",
  });
  const sid = `false_${PHONE}_3AC5`;
  const b64 = Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString("base64");
  mkdirSync(svc.paths.root, { recursive: true });
  writeFileSync(
    svc.paths.storeFile,
    JSON.stringify({
      v: 1,
      chats: {},
      contacts: { [PHONE]: { id: PHONE, name: "Sorin Cobzaru", lid: LID, phoneNumber: PHONE } },
      pushNames: {},
      messages: { [sid]: b64 },
      byChat: { [PHONE]: [sid], [LID]: [sid] },
      transcripts: {},
      contactsResyncedAt: null,
    })
  );

  await svc.bootStorage();

  assert.deepEqual(chatsWithMessages(svc), [PHONE]);
  assert.deepEqual(
    svc.db.messages.chatPage(PHONE, { limit: 10 }).items.map((m) => m.sid),
    [sid],
    "the message is filed once"
  );
  const recent = (await svc.getRecentMessages(24, "all")).data;
  assert.deepEqual(
    recent.map((c) => c.chat_id),
    [PHONE]
  );
});

test("a lid chat learned before its number folds in the moment the pairing arrives", async () => {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-persisted-", id: ME, name: "Răzvan" });
  sock.ev.emit("chats.upsert", [
    { id: PHONE, conversationTimestamp: 1_700_000_000, unreadCount: 0 },
    { id: LID, conversationTimestamp: 1_700_000_100, unreadCount: 2 },
  ]);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: LID, fromMe: false, id: "L1" },
        message: { conversation: "salut" },
        messageTimestamp: 1_700_000_100,
      },
    ],
  });
  assert.deepEqual(chatsWithMessages(svc), [LID], "filed under the lid while nothing better is known");

  sock.ev.emit("lid-mapping.update", { lid: LID, pn: PHONE });

  assert.equal(svc.db.identity.chat(LID).jid, PHONE, "the lid answers as the phone chat at once");
  await svc.storageIdle();
  assert.deepEqual(
    svc.db.identity.listChats().map((chat) => chat.jid),
    [PHONE],
    "and once the fold lands, one chat is left"
  );
  assert.equal(svc.db.identity.chat(PHONE).unread, 2);
  const messages = (await svc.readMessages(PHONE, 10)).data;
  assert.deepEqual(
    messages.map((m) => m.text),
    ["salut"],
    "history reads from the phone chat"
  );
});

test("reactions come back after an import, and a reaction an older snapshot filed as a message moves onto its target", async () => {
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-persisted-",
    id: ME,
    name: "Răzvan",
    config: { persistHistory: true },
  });
  const b64 = (raw) =>
    Buffer.from(proto.WebMessageInfo.encode(proto.WebMessageInfo.fromObject(raw)).finish()).toString("base64");
  const target = `false_${PHONE}_T1`;
  const loose = `false_${PHONE}_R1`;
  mkdirSync(svc.paths.root, { recursive: true });
  writeFileSync(
    svc.paths.storeFile,
    JSON.stringify({
      v: 1,
      chats: {},
      contacts: {},
      pushNames: {},
      messages: {
        [target]: b64({
          key: { remoteJid: PHONE, fromMe: false, id: "T1" },
          message: { conversation: "gata" },
          messageTimestamp: 1_700_000_000,
        }),
        [loose]: b64({
          key: { remoteJid: PHONE, fromMe: false, id: "R1" },
          message: { reactionMessage: { key: { remoteJid: PHONE, fromMe: false, id: "T1" }, text: "🔥" } },
          messageTimestamp: 1_700_000_010,
        }),
      },
      byChat: { [PHONE]: [target, loose] },
      transcripts: {},
      reactions: { [target]: { [ME]: "👍" } },
      contactsResyncedAt: null,
    })
  );

  await svc.bootStorage();

  assert.deepEqual(
    svc.db.messages.chatPage(PHONE, { limit: 10 }).items.map((m) => m.sid),
    [target],
    "the loose reaction line is gone"
  );
  const [view] = (await svc.readMessages(PHONE, 10)).data;
  assert.deepEqual(
    view.reactions.map((r) => [r.emoji, r.sender]).sort(),
    [
      ["🔥", PHONE],
      ["👍", ME],
    ].sort(),
    "the persisted one and the folded one both sit on the target"
  );
});

test("a pairing WhatsApp's table taught is kept, so after a restart a lid-filed message still has its sender", async () => {
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-persisted-",
    id: ME,
    name: "Răzvan",
    config: { persistHistory: true },
  });
  const raw = proto.WebMessageInfo.fromObject({
    key: { remoteJid: LID, fromMe: false, id: "3AC5" },
    message: { conversation: "In fine" },
    messageTimestamp: Math.floor(Date.now() / 1000) - 60,
  });
  const sid = `false_${PHONE}_3AC5`;
  mkdirSync(svc.paths.root, { recursive: true });
  writeFileSync(
    svc.paths.storeFile,
    JSON.stringify({
      v: 1,
      chats: {},
      contacts: { [PHONE]: { id: PHONE } },
      pushNames: {},
      messages: { [sid]: Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString("base64") },
      byChat: { [PHONE]: [sid] },
      transcripts: {},
      lids: { [LID]: PHONE },
      contactsResyncedAt: null,
    })
  );
  await svc.bootStorage();
  const [view] = (await svc.readMessages(PHONE, 10)).data;
  assert.equal(view.sender.id, PHONE);
  assert.equal(view.sender.name, "40723321578", "the number, not unknown (lid …)");
  await svc.stop();

  const again = openService(WhatsAppService, offlineConfig("x", { dataDir: svc.config.dataDir, persistHistory: true }));
  assert.deepEqual(again.db.identity.lidPairs(), [[LID, PHONE]], "the database keeps it");
  assert.equal(again.lidToPn.get(LID), PHONE, "and a restart reads it back");
  await again.stop();
});

test("an import runs once: the next boot serves the database and never reads the legacy files again", async () => {
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-persisted-",
    id: ME,
    name: "Răzvan",
    config: { persistHistory: true },
  });
  const raw = proto.WebMessageInfo.fromObject({
    key: { remoteJid: PHONE, fromMe: false, id: "ONCE" },
    message: { conversation: "o singură dată" },
    messageTimestamp: Math.floor(Date.now() / 1000) - 60,
  });
  mkdirSync(svc.paths.historyDir, { recursive: true });
  writeFileSync(
    join(svc.paths.historyDir, `${PHONE}.jsonl`),
    `${JSON.stringify({ sid: `false_${PHONE}_ONCE`, ts: Number(raw.messageTimestamp), raw: Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString("base64") })}\n`
  );
  await svc.bootStorage();
  assert.equal(svc.db.getMeta("import_state"), "done");
  await svc.stop();

  // A line appended to the old file after the import is not the database's business.
  const later = proto.WebMessageInfo.fromObject({
    key: { remoteJid: PHONE, fromMe: false, id: "LATER" },
    message: { conversation: "scris după import" },
    messageTimestamp: Math.floor(Date.now() / 1000) - 30,
  });
  writeFileSync(
    join(svc.paths.historyDir, `${PHONE}.jsonl`),
    `${JSON.stringify({ sid: `false_${PHONE}_LATER`, ts: Number(later.messageTimestamp), raw: Buffer.from(proto.WebMessageInfo.encode(later).finish()).toString("base64") })}\n`,
    { flag: "a" }
  );
  const { svc: next } = connectedService(WhatsAppService, {
    prefix: "wazap-persisted-",
    id: ME,
    name: "Răzvan",
    config: { persistHistory: true, dataDir: svc.config.dataDir },
  });
  await next.bootStorage();
  assert.deepEqual(
    (await next.readMessages(PHONE, 10)).data.map((m) => m.text),
    ["o singură dată"]
  );
  await next.stop();
});
