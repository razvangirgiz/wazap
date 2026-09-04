/**
 * What a restart puts back together. A message that arrived under a lid was
 * written to the history file with the phone chat's id, and on reload it must
 * land in that one chat, not in a second ring under the lid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { proto } from "baileys";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const PHONE = "40723321578@s.whatsapp.net";
const LID = "117261398495351@lid";

test("a history line filed under the phone reloads into one ring even though it arrived under the lid", async () => {
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-persisted-",
    id: ME,
    name: "Răzvan",
    config: { persistHistory: true },
  });
  const { dataDir } = svc.config;

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
  mkdirSync(join(dataDir, "history"), { recursive: true });
  writeFileSync(join(dataDir, "history", `${PHONE}.jsonl`), `${JSON.stringify(record)}\n`);
  writeFileSync(
    join(dataDir, "store.json"),
    JSON.stringify({
      v: 1,
      chats: {},
      contacts: { [PHONE]: { id: PHONE, name: "Sorin Cobzaru", lid: LID, phoneNumber: PHONE } },
      pushNames: {},
      messages: {},
      byChat: {},
      transcripts: {},
      contactsResyncedAt: null,
    }),
  );

  await svc.loadPersisted();

  assert.deepEqual([...svc.store.byChat.keys()], [PHONE], "one ring, under the phone");
  const recent = (await svc.getRecentMessages(24, "all")).data;
  assert.deepEqual(
    recent.map((c) => c.chat_id),
    [PHONE],
    "the catch-up shows the conversation once",
  );
  assert.equal(recent[0].messages[0].sender.name, "Sorin Cobzaru", "and knows who wrote it");
  assert.equal(recent[0].messages[0].from_me, false);
});

test("a snapshot that still holds a ring under the lid folds it into the phone chat on load", async () => {
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-persisted-",
    id: ME,
    name: "Răzvan",
    config: { persistHistory: true },
  });
  const { dataDir } = svc.config;
  const raw = proto.WebMessageInfo.fromObject({
    key: { remoteJid: LID, fromMe: false, id: "3AC5", participant: "" },
    message: { conversation: "Da" },
    messageTimestamp: Math.floor(Date.now() / 1000) - 60,
    pushName: "Sorin",
  });
  const sid = `false_${PHONE}_3AC5`;
  const b64 = Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString("base64");
  writeFileSync(
    join(dataDir, "store.json"),
    JSON.stringify({
      v: 1,
      chats: {},
      contacts: { [PHONE]: { id: PHONE, name: "Sorin Cobzaru", lid: LID, phoneNumber: PHONE } },
      pushNames: {},
      messages: { [sid]: b64 },
      byChat: { [PHONE]: [sid], [LID]: [sid] },
      transcripts: {},
      contactsResyncedAt: null,
    }),
  );

  await svc.loadPersisted();

  assert.deepEqual([...svc.store.byChat.keys()], [PHONE]);
  assert.deepEqual(svc.store.byChat.get(PHONE), [sid], "the message is filed once");
  const recent = (await svc.getRecentMessages(24, "all")).data;
  assert.deepEqual(recent.map((c) => c.chat_id), [PHONE]);
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
      { key: { remoteJid: LID, fromMe: false, id: "L1" }, message: { conversation: "salut" }, messageTimestamp: 1_700_000_100 },
    ],
  });
  assert.equal(svc.store.byChat.has(LID), true, "filed under the lid while nothing better is known");

  sock.ev.emit("lid-mapping.update", { lid: LID, pn: PHONE });

  assert.equal(svc.store.byChat.has(LID), false);
  assert.equal(svc.store.chats.has(LID), false);
  assert.equal(svc.store.chats.get(PHONE).unreadCount, 2);
  const messages = (await svc.readMessages(PHONE, 10)).data;
  assert.deepEqual(messages.map((m) => m.text), ["salut"], "history reads from the phone chat");
});
