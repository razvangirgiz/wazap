/**
 * One person, one row: learning that a lid and a phone number belong
 * together merges the contacts, the chats and their messages, and every sid
 * spelling keeps resolving — including the barriers, so nothing deleted or
 * cleared under one spelling comes back under the other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { StorageError } from "../dist/db/index.js";
import { ME, PEER, PEER_LID, T0, openTemp, sid, textMessage } from "./db-fixtures.mjs";

const OTHER = "40700000003@s.whatsapp.net";

test("a lid and a phone number become one contact and one chat, and every message answers to both spellings", async () => {
  const { db } = openTemp({ chunkSize: 3 });
  // What the phone spelling knew: a contact with a note, a chat with history.
  const phoneContact = db.identity.upsertContact({ jid: PEER, name: "Ana Contabil" });
  db.identity.setNote(PEER, "contabila");
  db.identity.updateFields(PEER, { addTags: ["client"], set: { rol: "contabil" } });
  db.messages.upsert(textMessage(PEER, "P1", T0 + 1_000, "factura pe august"));
  db.messages.upsert(textMessage(PEER, "P2", T0 + 50_000, "mulțumesc", { fromMe: true }));
  db.messages.upsert(textMessage(PEER, "DUP", T0 + 60_000, "același mesaj"));
  db.messages.upsert(textMessage(PEER, "PC", T0 + 500, "sub barieră"));

  // What the lid spelling knew: another contact row, another chat.
  const lidContact = db.identity.upsertContact({ jid: PEER_LID, pushName: "Ana" });
  assert.notEqual(lidContact.id, phoneContact.id);
  db.identity.updateFields(PEER_LID, { addTags: ["vip"], set: { oras: "Iași", rol: "ignored" } });
  for (let i = 0; i < 7; i++) db.messages.upsert(textMessage(PEER_LID, `L${i}`, T0 + 10_000 + i * 1000, `lid ${i}`));
  db.messages.upsert(textMessage(PEER_LID, "DUP", T0 + 60_000, "același mesaj"));
  db.messages.delete(sid(false, PEER_LID, "DUP"), { at: T0 + 70_000 });
  db.messages.react(sid(false, PEER, "P1"), PEER_LID, "🔥", T0 + 80_000);
  db.messages.react(sid(false, PEER, "P1"), PEER, "👍", T0 + 79_000);
  db.messages.receipt(sid(true, PEER, "P2"), PEER, { deliveredAt: T0 + 51_000, readAt: T0 + 55_000 });
  db.messages.receipt(sid(true, PEER, "P2"), PEER_LID, { readAt: T0 + 52_000 });
  await db.messages.clearChat(PEER_LID, T0 + 900);

  const report = await db.learnLidPhone(PEER_LID, PEER);
  assert.equal(report.contactId, Math.min(phoneContact.id, lidContact.id));
  assert.equal(report.movedMessages, 8);

  const contact = db.identity.contact(PEER_LID);
  assert.equal(contact.id, report.contactId);
  assert.deepEqual([contact.phoneJid, contact.lid, contact.name, contact.pushName], [PEER, PEER_LID, "Ana Contabil", "Ana"]);
  assert.equal(db.identity.contact(PEER).id, contact.id);
  assert.deepEqual(db.identity.notes(PEER_LID), {
    note: "contabila",
    tags: ["client", "vip"],
    fields: { oras: "Iași", rol: "contabil" },
    updatedAt: db.identity.notes(PEER).updatedAt,
  });

  const chat = db.identity.chat(PEER_LID);
  assert.equal(chat.jid, PEER);
  assert.equal(db.identity.chat(PEER).id, chat.id);
  assert.equal(chat.clearedThroughTs, T0 + 900, "the later barrier covers the merged chat");
  assert.equal(db.messages.listChats({ limit: 10 }).items.length, 1);

  const page = db.messages.chatPage(PEER, { limit: 50 }).items.map((m) => m.keyId);
  assert.deepEqual(page, ["P2", "L6", "L5", "L4", "L3", "L2", "L1", "L0", "P1"]);
  assert.equal(db.messages.get(sid(false, PEER, "PC")), null, "rows under the lid barrier left the phone chat too");
  assert.equal(db.messages.upsert(textMessage(PEER, "PC", T0 + 500, "sub barieră")).outcome, "cleared");

  const byLid = db.messages.get(sid(false, PEER_LID, "L3"));
  const byPhone = db.messages.get(sid(false, PEER, "L3"));
  assert.equal(byLid.id, byPhone.id);
  assert.equal(byPhone.senderJid, PEER);

  for (const spelling of [sid(false, PEER, "DUP"), sid(false, PEER_LID, "DUP")]) {
    assert.equal(db.messages.get(spelling), null, `${spelling} stays deleted`);
    assert.equal(db.messages.upsert(textMessage(spelling.split("_")[1], "DUP", T0 + 60_000, "același mesaj")).outcome, "deleted");
  }
  assert.equal(db.search.text({ query: "același", limit: 5 }).items.length, 0);

  assert.deepEqual(db.messages.reactions(sid(false, PEER, "P1")).map((r) => [r.jid, r.emoji]), [[PEER, "🔥"]]);
  assert.deepEqual(
    db.messages.receipts(sid(true, PEER, "P2")).map((r) => [r.jid, r.deliveredAt, r.readAt]),
    [[PEER, T0 + 51_000, T0 + 52_000]]
  );

  const live = db.messages.upsert(textMessage(PEER_LID, "NEW", T0 + 90_000, "după unire"));
  assert.equal(live.sid, sid(false, PEER, "NEW"), "a new lid-addressed message is filed under the phone spelling");
  assert.equal(db.messages.get(sid(false, PEER_LID, "NEW")).id, live.id);
  assert.equal(db.identity.chat(PEER).lastMessageId, live.id);
  db.close();
});

test("when only the lid chat exists it takes the phone jid, and its messages answer to both spellings", async () => {
  const { db } = openTemp({ chunkSize: 200 });
  for (let i = 0; i < 450; i++) db.messages.upsert(textMessage(PEER_LID, `K${i}`, T0 + i * 1000, `mesaj ${i}`));
  const before = db.identity.chat(PEER_LID);
  const report = await db.learnLidPhone(PEER_LID, PEER);
  assert.equal(report.chatId, before.id);
  assert.equal(report.aliasedMessages, 450);
  const after = db.identity.chat(PEER);
  assert.equal(after.id, before.id);
  assert.equal(after.jid, PEER);
  assert.equal(db.identity.chat(PEER_LID).id, before.id);
  for (const key of ["K0", "K199", "K200", "K449"]) {
    assert.equal(db.messages.get(sid(false, PEER, key)).sid, sid(false, PEER_LID, key), "the stored sid does not change");
  }
  assert.equal(db.messages.upsert(textMessage(PEER, "K5", T0 + 5_000, "replay")).outcome, "updated");
  assert.equal(db.counts().messages, 450);
  db.close();
});

test("when only the phone chat exists the lid becomes an alias, with no per-message rows", async () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "A", T0, "salut"));
  const report = await db.learnLidPhone(PEER_LID, PEER);
  assert.equal(report.aliasedMessages, 0);
  const viaLid = db.messages.get(sid(false, PEER_LID, "A"));
  assert.equal(viaLid.sid, sid(false, PEER, "A"));
  const replay = db.messages.upsert(textMessage(PEER_LID, "A", T0, "salut din nou"));
  assert.deepEqual([replay.outcome, replay.id], ["updated", viaLid.id]);
  db.messages.delete(sid(false, PEER_LID, "A"));
  assert.equal(db.messages.upsert(textMessage(PEER, "A", T0, "salut")).outcome, "deleted");
  db.close();
});

test("a pair learned before any chat files a lid-addressed message in the phone chat", async () => {
  const { db } = openTemp();
  await db.learnLidPhone(PEER_LID, PEER);
  const stored = db.messages.upsert(textMessage(PEER_LID, "X", T0, "primul"));
  assert.equal(stored.sid, sid(false, PEER, "X"));
  assert.equal(db.identity.chat(PEER_LID).jid, PEER);
  assert.equal(db.messages.get(sid(false, PEER_LID, "X")).id, stored.id);
  db.close();
});

test("a merge a crash interrupted is finished on resume, and learning the pair again changes nothing", async () => {
  const { db } = openTemp({ chunkSize: 2 });
  for (let i = 0; i < 5; i++) db.messages.upsert(textMessage(PEER_LID, `L${i}`, T0 + i * 1000, `l${i}`));
  db.messages.upsert(textMessage(PEER, "P", T0 + 9_000, "p"));
  db.setMeta(`merge_pending:${PEER_LID}`, PEER);
  const reports = await db.resumeMerges();
  assert.equal(reports.length, 1);
  assert.equal(db.getMeta(`merge_pending:${PEER_LID}`), null);
  assert.equal(db.identity.chat(PEER_LID).id, db.identity.chat(PEER).id);
  const counts = db.counts();
  const again = await db.learnLidPhone(PEER_LID, PEER);
  assert.equal(again.movedMessages, 0);
  assert.deepEqual(db.counts(), counts);
  assert.deepEqual(await db.resumeMerges(), []);
  db.close();
});

test("learnLidPhone refuses arguments that are not a lid and a phone jid", async () => {
  const { db } = openTemp();
  await assert.rejects(db.learnLidPhone(PEER, PEER_LID), (err) => err instanceof StorageError && err.code === "INVALID_INPUT");
  await assert.rejects(db.learnLidPhone(PEER_LID, "120363@g.us"), (err) => err instanceof StorageError && err.code === "INVALID_INPUT");
  db.close();
});

test("notes: an empty note clears it, tags and fields edit in place, a contact with nothing left loses the row", () => {
  const { db } = openTemp();
  assert.equal(db.identity.notes(OTHER), null);
  assert.equal(db.identity.setNote(OTHER, "  vecinul  ").note, "vecinul");
  const tagged = db.identity.updateFields(OTHER, { addTags: ["familie", "urgent"], set: { etaj: "3" } });
  assert.deepEqual([tagged.tags, tagged.fields], [["familie", "urgent"], { etaj: "3" }]);
  db.identity.updateFields(OTHER, { removeTags: ["urgent"], removeFields: ["etaj"] });
  assert.deepEqual(db.identity.notes(OTHER).tags, ["familie"]);
  assert.equal(db.identity.setNote(OTHER, "").note, null);
  assert.equal(db.identity.updateFields(OTHER, { removeTags: ["familie"] }), null);
  assert.equal(db.identity.notes(OTHER), null);
  db.close();
});

test("handled marks name the ask by sid, and an unknown ask is refused", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "ASK", T0, "vii?"));
  assert.equal(db.identity.handled(PEER), null);
  const mark = db.identity.markHandled(PEER, sid(false, PEER, "ASK"), T0 + 5);
  assert.deepEqual(mark, { askMessageId: db.messages.get(sid(false, PEER, "ASK")).id, askSid: sid(false, PEER, "ASK"), at: T0 + 5 });
  assert.deepEqual(db.identity.handled(PEER), mark);
  assert.throws(
    () => db.identity.markHandled(PEER, sid(false, PEER, "nope")),
    (err) => err instanceof StorageError && err.code === "INVALID_INPUT"
  );
  assert.equal(db.identity.markHandled(ME, null, T0).askMessageId, null);
  db.close();
});

test("a contact update keeps fields it does not name and clears the ones set to null", () => {
  const { db } = openTemp();
  db.identity.upsertContact({ jid: OTHER, name: "Mihai", pushName: "Mihu", isBusiness: true });
  const updated = db.identity.upsertContact({ jid: OTHER, pushName: null, verifiedName: "Mihai SRL" });
  assert.deepEqual(
    [updated.name, updated.pushName, updated.verifiedName, updated.isBusiness],
    ["Mihai", null, "Mihai SRL", true]
  );
  db.close();
});
