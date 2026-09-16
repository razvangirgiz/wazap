/**
 * One person, one row — and never two people in one. A lid and a number
 * learned together fold into one contact and one chat, every sid spelling
 * keeps resolving, and the barriers hold across spellings. A lid that moves
 * to another number follows main's LidRegistry: it stops answering for the
 * old number, and nothing the old number holds moves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AccountDb, StorageError, mergeNotes } from "../dist/db/index.js";
import { ME, PEER, PEER_LID, T0, openTemp, sid, textMessage, wordsOf } from "./db-fixtures.mjs";

const OTHER = "40700000003@s.whatsapp.net";
const P2 = "40700000009@s.whatsapp.net";
const LID2 = "999999999999999@lid";
const GROUP_A = "120363000000000001@g.us";

const turn = () => new Promise((resolve) => setImmediate(resolve));

test("a lid and a phone number become one contact and one chat, and every message answers to both spellings", async () => {
  const { db } = openTemp({ chunkSize: 3 });
  const phoneContact = db.identity.upsertContact({ jid: PEER, name: "Ana Contabil" });
  db.identity.setNote(PEER, "contabila");
  db.identity.updateFields(PEER, { addTags: ["client"], set: { rol: "contabil" } });
  db.messages.upsert(textMessage(PEER, "P1", T0 + 1_000, "factura pe august"));
  db.messages.upsert(textMessage(PEER, "P2", T0 + 50_000, "mulțumesc", { fromMe: true }));
  db.messages.upsert(textMessage(PEER, "DUP", T0 + 60_000, "același mesaj"));
  db.messages.upsert(textMessage(PEER, "PC", T0 + 500, "sub barieră"));

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
  const notes = db.identity.notes(PEER_LID);
  assert.deepEqual([notes.note, notes.tags, notes.fields], ["contabila", ["client", "vip"], { oras: "Iași", rol: "contabil | ignored" }]);

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
  assert.equal(byPhone.sid, sid(false, PEER, "L3"));
  assert.equal(byPhone.senderJid, PEER);

  for (const chatJid of [PEER, PEER_LID]) {
    assert.equal(db.messages.get(sid(false, chatJid, "DUP")), null, `DUP under ${chatJid} stays deleted`);
    assert.equal(db.messages.upsert(textMessage(chatJid, "DUP", T0 + 60_000, "același mesaj")).outcome, "deleted");
  }
  assert.equal(db.search.text({ query: "același", limit: 5 }).items.length, 0);

  assert.deepEqual(db.messages.reactions(sid(false, PEER, "P1")).map((r) => [r.jid, r.emoji]), [[PEER, "🔥"]]);
  assert.deepEqual(
    db.messages.receipts(sid(true, PEER, "P2")).map((r) => [r.jid, r.deliveredAt, r.readAt]),
    [[PEER, T0 + 51_000, T0 + 55_000]],
    "the fold keeps the latest time of each kind"
  );

  const live = db.messages.upsert(textMessage(PEER_LID, "NEW", T0 + 90_000, "după unire"));
  assert.equal(live.sid, sid(false, PEER, "NEW"), "a new lid-addressed message is filed under the phone spelling");
  assert.equal(db.messages.get(sid(false, PEER_LID, "NEW")).id, live.id);
  assert.equal(db.identity.chat(PEER).lastMessageId, live.id);
  assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
  db.close();
});

test("finding 1: rows landing lid-addressed while a lid chat takes its number are the rows their phone spelling replays", async () => {
  const { db } = openTemp({ chunkSize: 2 });
  for (let i = 0; i < 10; i++) db.messages.upsert(textMessage(PEER_LID, `L${i}`, T0 + 60_000 + i * 1000, `live ${i}`));
  const learn = db.learnLidPhone(PEER_LID, PEER);
  for (let i = 0; i < 4; i++) await turn();
  db.messages.upsert(textMessage(PEER_LID, "OLD", T0 + 1000, "old history message"));
  db.messages.delete(sid(false, PEER_LID, "GONE"), { ts: T0 + 2000 });
  await learn;

  const old = db.messages.get(sid(false, PEER, "OLD"));
  assert.equal(old?.text, "old history message", "an older row that arrived mid-rename answers to the phone spelling");
  assert.equal(db.messages.upsert(textMessage(PEER, "OLD", T0 + 1000, "old history message")).outcome, "updated");
  assert.equal(db.messages.upsert(textMessage(PEER, "GONE", T0 + 1500, "the retracted text")).outcome, "deleted");
  const texts = db.messages.chatPage(PEER, { limit: 50 }).items.map((m) => m.text).filter((text) => !text.startsWith("live"));
  assert.deepEqual(texts, ["old history message"]);
  assert.deepEqual(db.messages.countInChat(PEER), { messages: 11, tombstones: 1 });
  db.close();
});

test("while a lid chat folds into its number, a page shows each message once, and never one deleted under the other spelling", async () => {
  const { db } = openTemp({ chunkSize: 2 });
  for (let i = 0; i < 20; i++) db.messages.upsert(textMessage(PEER_LID, `L${i}`, T0 + i * 1000, `mesaj ${i}`));
  // Before anyone knew the pairing: the sender revoked L19 from a device addressing the number, and L18 was synced under both spellings.
  db.messages.delete(sid(false, PEER, "L19"), { ts: T0 + 19_000 });
  db.messages.upsert(textMessage(PEER, "L18", T0 + 18_000, "mesaj 18"));
  const learn = db.learnLidPhone(PEER_LID, PEER);
  await turn();
  const midway = db.messages.chatPage(PEER, { limit: 5 }).items.map((m) => m.keyId);
  assert.equal(db.messages.get(sid(false, PEER, "L19")), null, "get already hides it");
  await learn;
  assert.deepEqual(midway, ["L18", "L17", "L16", "L15", "L14"], "the revoked one is not listed, the twin is listed once");
  assert.deepEqual(db.messages.chatPage(PEER, { limit: 5 }).items.map((m) => m.keyId), ["L18", "L17", "L16", "L15", "L14"]);
  db.close();
});

test("finding 3: a lid learned for a second number stops answering for the first and never merges the two people", async () => {
  const { db } = openTemp();
  await db.learnLidPhone(PEER_LID, PEER);
  db.messages.upsert(textMessage(PEER, "A", T0, "to/from P1 (person X)"));
  db.identity.setNote(PEER, "X: landlord, owes 300");
  db.identity.updateFields(PEER, { set: { iban: "RO-X" } });
  db.messages.upsert(textMessage(P2, "B", T0 + 1000, "to/from P2 (person Y)"));
  db.identity.setNote(P2, "Y: dentist");
  db.identity.updateFields(P2, { set: { iban: "RO-Y" } });

  const report = await db.learnLidPhone(PEER_LID, P2);
  assert.equal(report.movedMessages, 0);
  assert.notEqual(db.identity.chat(PEER).id, db.identity.chat(P2).id);
  assert.deepEqual(db.messages.chatPage(PEER, { limit: 10 }).items.map((m) => m.text), ["to/from P1 (person X)"]);
  assert.deepEqual(db.messages.chatPage(P2, { limit: 10 }).items.map((m) => m.text), ["to/from P2 (person Y)"]);
  assert.deepEqual([db.identity.notes(PEER).note, db.identity.notes(PEER).fields], ["X: landlord, owes 300", { iban: "RO-X" }]);
  assert.deepEqual([db.identity.notes(P2).note, db.identity.notes(P2).fields], ["Y: dentist", { iban: "RO-Y" }]);
  assert.notEqual(db.identity.contact(PEER).id, db.identity.contact(P2).id);
  assert.equal(db.identity.contact(PEER).lid, null, "the old number no longer answers to the lid");
  assert.equal(db.identity.contact(PEER_LID).id, db.identity.contact(P2).id);
  assert.equal(db.identity.chat(PEER_LID).jid, P2);
  assert.equal(db.messages.upsert(textMessage(PEER_LID, "C", T0 + 2000, "new lid message")).sid, sid(false, P2, "C"));
  db.close();
});

test("finding 3: a lid-first conversation stays with its first number when the lid moves to another", async () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER_LID, "A", T0, "X: my address is ..."));
  db.identity.setNote(PEER_LID, "X note");
  await db.learnLidPhone(PEER_LID, PEER);
  db.messages.upsert(textMessage(P2, "B", T0 + 1000, "Y: hello"));
  db.identity.setNote(P2, "Y note");
  await db.learnLidPhone(PEER_LID, P2);
  assert.deepEqual(
    db.messages.chatPage(PEER, { limit: 10 }).items.map((m) => [m.chatJid, m.senderJid, m.text]),
    [[PEER, PEER, "X: my address is ..."]]
  );
  assert.deepEqual(db.messages.chatPage(P2, { limit: 10 }).items.map((m) => [m.chatJid, m.text]), [[P2, "Y: hello"]]);
  assert.equal(db.identity.notes(PEER).note, "X note");
  assert.equal(db.identity.notes(P2).note, "Y note");
  db.close();
});

test("finding 3: re-pointing a lid while messages arrive creates no duplicate chat and leaves nothing pending", async () => {
  const { db } = openTemp({ chunkSize: 2 });
  for (let i = 0; i < 10; i++) db.messages.upsert(textMessage(PEER_LID, `L${i}`, T0 + i * 1000, `lid ${i}`));
  await db.learnLidPhone(PEER_LID, PEER);
  const learn = db.learnLidPhone(PEER_LID, P2);
  await turn();
  await turn();
  const up = db.messages.upsert(textMessage(P2, "NEW", T0 + 20_000, "arrives mid-merge"));
  assert.equal(up.outcome, "inserted");
  await learn;
  const conn = db["connection"];
  assert.equal(conn.get("SELECT count(*) AS n FROM chats WHERE merged_into IS NOT NULL").n, 0);
  assert.equal(conn.get("SELECT count(*) AS n FROM contacts WHERE merged_into IS NOT NULL").n, 0);
  assert.deepEqual(conn.all("SELECT jid FROM chats ORDER BY id").map((row) => row.jid), [PEER, P2]);
  assert.equal(db.messages.chatPage(PEER, { limit: 20 }).items.length, 10);
  assert.deepEqual(db.messages.chatPage(PEER_LID, { limit: 20 }).items.map((m) => m.keyId), ["NEW"]);
  db.close();
});

test("finding 5: a message filed under both spellings folds into one row and keeps its edit, transcript, reactions, receipts, embedding and file", async () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "V", T0, "original"));
  db.messages.upsert(textMessage(PEER_LID, "V", T0, "edited text", { editedAt: T0 + 30_000, type: "audio" }));
  db.messages.setTranscript(sid(false, PEER_LID, "V"), "transcriere vocala");
  db.messages.react(sid(false, PEER_LID, "V"), "40711111111@s.whatsapp.net", "❤️", T0 + 40_000);
  db.messages.receipt(sid(false, PEER_LID, "V"), PEER_LID, { readAt: T0 + 50_000 });
  db.vectors.put(sid(false, PEER_LID, "V"), "m", [1, 2, 3], wordsOf(db, sid(false, PEER_LID, "V")));
  db.messages.setMedia(sid(false, PEER_LID, "V"), "download", "/data/voice-V.ogg");

  const report = await db.learnLidPhone(PEER_LID, PEER);
  assert.deepEqual(report.mediaPaths, [], "a file the surviving row still references is not handed back to unlink");
  const survivor = db.messages.get(sid(false, PEER, "V"));
  assert.deepEqual(
    [survivor.text, survivor.editedAt, survivor.transcript, survivor.type],
    ["edited text", T0 + 30_000, "transcriere vocala", "audio"]
  );
  assert.deepEqual(db.messages.reactions(sid(false, PEER, "V")).map((r) => r.emoji), ["❤️"]);
  assert.deepEqual(db.messages.receipts(sid(false, PEER_LID, "V")).map((r) => [r.jid, r.readAt]), [[PEER, T0 + 50_000]]);
  assert.equal(db.vectors.get(sid(false, PEER, "V"))?.model, "m");
  assert.deepEqual(db.messages.media(sid(false, PEER, "V")).map((m) => m.path), ["/data/voice-V.ogg"]);
  assert.deepEqual(db.messages.countInChat(PEER), { messages: 1, tombstones: 0 });
  assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
  db.close();
});

test("n2: a lid that moves while its old chat is still folding starts the new number's chat, not the old person's", async () => {
  const { db } = openTemp({ chunkSize: 5 });
  for (let i = 0; i < 300; i++) db.messages.upsert(textMessage(GROUP_A, `G${i}`, T0 + i, "g", { senderJid: OTHER }));
  db.messages.upsert(textMessage(PEER, "X1", T0 + 1000, "X via phone"));
  db.messages.upsert(textMessage(PEER_LID, "X2", T0 + 2000, "X via lid"));
  const clear = db.messages.clearChat(GROUP_A, T0 + 500);
  const fold = db.learnLidPhone(PEER_LID, PEER);
  const move = db.learnLidPhone(PEER_LID, P2);
  const written = db.messages.upsert(textMessage(PEER_LID, "Y1", T0 + 3000, "Y (the lid's new number) writes"));
  assert.equal(written.sid, sid(false, P2, "Y1"));
  await clear;
  await fold;
  await move;
  assert.deepEqual(db.messages.chatPage(PEER, { limit: 10 }).items.map((m) => m.text), ["X via lid", "X via phone"]);
  assert.deepEqual(db.messages.chatPage(P2, { limit: 10 }).items.map((m) => m.text), ["Y (the lid's new number) writes"]);
  assert.equal(db.messages.get(sid(false, PEER_LID, "Y1"))?.sid, sid(false, P2, "Y1"));
  db.close();
});

test("n10: while a lid chat is still folding, the number's chat lists and waits with the folding chat's newest message", async () => {
  const { db } = openTemp({ chunkSize: 5 });
  for (let i = 0; i < 300; i++) db.messages.upsert(textMessage(GROUP_A, `G${i}`, T0 + i, "g", { senderJid: OTHER }));
  db.messages.upsert(textMessage(PEER, "OLD", T0 + 1000, "old reply", { fromMe: true }));
  db.messages.upsert(textMessage(PEER_LID, "ASK", T0 + 50_000, "are you coming tomorrow?"));
  const clear = db.messages.clearChat(GROUP_A, T0 + 400);
  const learn = db.learnLidPhone(PEER_LID, PEER);
  const window = { since: T0, until: T0 + 3_600_000, limit: 10, kinds: ["direct"] };
  assert.deepEqual(db.messages.waiting(window).items.map((w) => w.last.text), ["are you coming tomorrow?"]);
  assert.deepEqual(db.messages.listChats({ limit: 10 }).items.find((i) => i.chat.jid === PEER)?.last?.text, "are you coming tomorrow?");
  db.messages.delete(sid(false, PEER_LID, "ASK"));
  assert.equal(db.identity.chat(PEER).lastFromMe, true, "a tombstone in the folding chat updates the number's chat too");
  assert.deepEqual(db.messages.waiting(window).items, []);
  db.messages.upsert(textMessage(PEER, "NEW", T0 + 60_000, "still there?"));
  await clear;
  await learn;
  assert.deepEqual(db.messages.waiting(window).items.map((w) => w.last.text), ["still there?"]);
  db.close();
});

test("n8: an event or handled mark on the folded copy of a twin points at the surviving row afterwards", async () => {
  const { db } = openTemp();
  const conn = db["connection"];
  const history = db.messages.upsert(textMessage(PEER, "V", T0, "from history sync"));
  const live = db.messages.upsert(textMessage(PEER_LID, "V", T0, "live delivery"));
  conn.write(() =>
    conn.run("INSERT INTO events(kind, message_id, payload, created_at, ready_at, state) VALUES ('message', ?, '{}', 0, 0, 'pending')", live.id)
  );
  db.identity.markHandled(PEER_LID, sid(false, PEER_LID, "V"));
  await db.learnLidPhone(PEER_LID, PEER);
  assert.ok(db.messages.get(sid(false, PEER, "V")));
  assert.equal(conn.get("SELECT message_id FROM events").message_id, history.id);
  assert.deepEqual(
    [db.identity.handled(PEER).askMessageId, db.identity.handled(PEER).askSid],
    [history.id, sid(false, PEER, "V")]
  );
  db.close();
});

test("n1: every spelling main resolves reaches the same chat and message: device, hosted, c.us, case", async () => {
  const { db } = openTemp();
  await db.learnLidPhone(PEER_LID, PEER);
  const stored = db.messages.upsert(textMessage("40700000002@c.us", "D1", T0, "d1"));
  assert.equal(stored.sid, sid(false, PEER, "D1"));
  for (const spelling of [
    PEER,
    "40700000002@c.us",
    "40700000002@C.US",
    "40700000002:5@s.whatsapp.net",
    "40700000002@hosted",
    PEER_LID,
    "123456789012345@hosted.lid",
    "123456789012345:3@lid",
  ]) {
    assert.equal(db.messages.get(sid(false, spelling, "D1"))?.id, stored.id, spelling);
    assert.equal(db.identity.chat(spelling)?.jid, PEER, spelling);
  }
  assert.deepEqual(db.search.text({ query: "d1", limit: 5, from: "40700000002@c.us" }).items.map((m) => m.keyId), ["D1"]);
  db.close();
});

test("a number that gains a new lid keeps answering to its older lid too", async () => {
  const { db } = openTemp();
  await db.learnLidPhone(PEER_LID, PEER);
  await db.learnLidPhone(LID2, PEER);
  const contact = db.identity.contact(PEER);
  assert.equal(contact.lid, LID2);
  assert.equal(db.identity.contact(PEER_LID).id, contact.id);
  assert.equal(db.identity.contact(LID2).id, contact.id);
  db.messages.upsert(textMessage(PEER_LID, "OLD-LID", T0, "prin lidul vechi"));
  db.messages.upsert(textMessage(LID2, "NEW-LID", T0 + 1000, "prin lidul nou"));
  assert.deepEqual(db.messages.chatPage(PEER, { limit: 5 }).items.map((m) => m.keyId), ["NEW-LID", "OLD-LID"]);
  db.close();
});

test("finding 12b: a retraction spelled with the lid while the merge waits behind a long clear hits the number's message", async () => {
  const { db } = openTemp({ chunkSize: 5 });
  for (let i = 0; i < 400; i++) db.messages.upsert(textMessage(GROUP_A, `G${i}`, T0 + i, `g${i}`, { senderJid: OTHER }));
  db.messages.upsert(textMessage(PEER, "X", T0 + 2000, "secret"));
  const clear = db.messages.clearChat(GROUP_A, T0 + 1000);
  const learn = db.learnLidPhone(PEER_LID, PEER);
  const deleted = db.messages.delete(sid(false, PEER_LID, "X"), { ts: T0 + 2000 });
  assert.equal(deleted.outcome, "deleted");
  assert.equal(db.messages.get(sid(false, PEER, "X")), null);
  await clear;
  await learn;
  assert.equal(db.messages.get(sid(false, PEER, "X")), null);
  assert.deepEqual(db.messages.countInChat(PEER), { messages: 0, tombstones: 1 });
  db.close();
});

test("a fold interrupted by close is finished by resumeMerges, and learning the pair again changes nothing", async () => {
  const { db, path, clock } = openTemp({ chunkSize: 2 });
  for (let i = 0; i < 20; i++) db.messages.upsert(textMessage(PEER_LID, `L${i}`, T0 + i * 1000, `lid ${i}`));
  for (let i = 0; i < 20; i++) db.messages.upsert(textMessage(PEER, `P${i}`, T0 + i * 1000 + 500, `phone ${i}`));
  db.messages.upsert(textMessage(PEER, "L3", T0 + 3000, "twin"));
  const learn = db.learnLidPhone(PEER_LID, PEER);
  learn.catch(() => {});
  await turn();
  db.close();
  await learn.catch(() => {});

  const reopened = AccountDb.open(path, { now: () => clock.now, chunkSize: 2, checkpointDelayMs: 0 });
  assert.equal(reopened.identity.chat(PEER_LID).id, reopened.identity.chat(PEER).id, "the pairing itself was committed before close");
  await reopened.resumeMerges();
  const conn = reopened["connection"];
  assert.equal(conn.get("SELECT count(*) AS n FROM chats").n, 1);
  assert.equal(conn.get("SELECT count(*) AS n FROM contacts").n, 1);
  assert.equal(reopened.messages.chatPage(PEER, { limit: 100 }).items.length, 40);
  const counts = reopened.counts();
  const again = await reopened.learnLidPhone(PEER_LID, PEER);
  assert.equal(again.movedMessages, 0);
  assert.deepEqual(reopened.counts(), counts);
  assert.deepEqual(reopened.integrityCheck(), { ok: true, problems: [] });
  reopened.close();
});

test("a merge of one person keeps both notes and both values of a conflicting field", () => {
  const numberSide = { note: "contabila", tags: ["client"], fields: { rol: "contabil", oras: "Iași" }, updatedAt: 1 };
  const lidSide = { note: "vine marți", tags: ["vip", "client"], fields: { rol: "consultant", email: "a@b.ro" }, updatedAt: 2 };
  assert.deepEqual(mergeNotes(numberSide, lidSide), {
    note: "contabila\nvine marți",
    tags: ["client", "vip"],
    fields: { email: "a@b.ro", oras: "Iași", rol: "contabil | consultant" },
  });
  assert.deepEqual(mergeNotes(null, lidSide).note, "vine marți");
  assert.deepEqual(mergeNotes({ ...numberSide, note: "same" }, { ...lidSide, note: "same" }).note, "same");
});

test("learnLidPhone refuses arguments that are not a lid and a phone jid", async () => {
  const { db } = openTemp();
  await assert.rejects(db.learnLidPhone(PEER, PEER_LID), (err) => err instanceof StorageError && err.code === "INVALID_INPUT");
  await assert.rejects(db.learnLidPhone(PEER_LID, "120363@g.us"), (err) => err instanceof StorageError && err.code === "INVALID_INPUT");
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

test("while a fold is still moving rows, a message deleted under one spelling reads as deleted under both", async () => {
  const { db } = openTemp({ chunkSize: 1 });
  for (let i = 0; i < 5; i++) db.messages.upsert(textMessage(PEER, `P${i}`, T0 + i * 1000, `phone ${i}`));
  db.messages.upsert(textMessage(PEER, "TWIN", T0 + 10_000, "under the number"));
  for (let i = 0; i < 5; i++) db.messages.upsert(textMessage(PEER_LID, `L${i}`, T0 + 20_000 + i * 1000, `lid ${i}`));
  db.messages.delete(sid(false, PEER_LID, "TWIN"), { ts: T0 + 10_000 });
  const fold = db.learnLidPhone(PEER_LID, PEER);
  for (const spelling of [PEER, PEER_LID]) {
    assert.equal(db.messages.get(sid(false, spelling, "TWIN")), null, `under ${spelling}, before the fold lands`);
    assert.equal(db.messages.upsert(textMessage(spelling, "TWIN", T0 + 10_000, "replay")).outcome, "deleted");
  }
  await fold;
  assert.equal(db.messages.get(sid(false, PEER, "TWIN")), null, "and after it");
  db.close();
});

test("the address book's order costs the same for the ten-thousandth contact as for the first", () => {
  const { db } = openTemp();
  const phone = (i) => `4075${String(i).padStart(7, "0")}@s.whatsapp.net`;
  const batch = (from) => {
    const started = performance.now();
    db.transaction(() => {
      for (let i = from; i < from + 2_000; i++) db.identity.upsertContact({ jid: phone(i), name: `C${i}`, listed: true });
    });
    return performance.now() - started;
  };
  const first = batch(0);
  for (let from = 2_000; from < 8_000; from += 2_000) batch(from);
  const last = batch(8_000);
  assert.ok(last < Math.max(first, 5) * 3, `the last 2,000 took ${last.toFixed(0)} ms, the first ${first.toFixed(0)} ms`);
  assert.deepEqual(db.identity.listContacts().slice(-2).map(({ contact }) => contact.listed), [9_999, 10_000]);
  db.close();
});
