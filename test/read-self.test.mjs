/**
 * What the account's own devices read: a read receipt from the phone moves the
 * chat's read mark (`read_through_id`) forward, never back, under any spelling
 * of the chat; someone else's receipt never does. get_status counts what
 * arrives, so it can be checked live that the phone sends them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { proto } from "baileys";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ME_LID = "900000000000001@lid";
const ANA = "40700000002@s.whatsapp.net";
const ANA_LID = "800000000000002@lid";
const DAN = "40700000003@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const STATUS = proto.WebMessageInfo.Status;
const T0 = Math.floor(Date.now() / 1000) - 3600;

function setup() {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-read-self-", id: ME, name: "Răzvan" });
  let seq = 0;
  const arrive = (chat, text, { fromMe = false, participant, status, type = "notify", at } = {}) => {
    const id = `RS${++seq}`;
    sock.ev.emit("messages.upsert", {
      type,
      messages: [
        {
          key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) },
          message: { conversation: text },
          messageTimestamp: at ?? T0 + seq,
          ...(status === undefined ? {} : { status }),
        },
      ],
    });
    return id;
  };
  /** A one-to-one receipt, as Baileys' handleReceipt reports one from the account's own device: someone else's key, raised. */
  const phoneRead = (chat, id, status = STATUS.READ) =>
    sock.ev.emit("messages.update", [{ key: { remoteJid: chat, fromMe: false, id }, update: { status, messageTimestamp: T0 + 900 } }]);
  const groupReceipt = (id, user, fields) =>
    sock.ev.emit("message-receipt.update", [{ key: { remoteJid: GROUP, fromMe: true, id, participant: user }, receipt: { userJid: user, ...fields } }]);
  const idOf = (chat, id, fromMe = false) => svc.db.messages.get(`${fromMe}_${chat}_${id}`).id;
  const mark = (chat) => svc.db.identity.chat(chat).readThroughId;
  const counters = () => svc.getStatus().diagnostics.read_self;
  return { svc, sock, arrive, phoneRead, groupReceipt, idOf, mark, counters };
}

test("the phone reading a one-to-one chat moves its read mark forward, never back, and get_status counts it", () => {
  const { arrive, phoneRead, idOf, mark, counters } = setup();
  assert.deepEqual(counters(), { seen: 0, synced: 0, applied: 0, unmatched: 0, last_at: null });
  const a = arrive(ANA, "unu");
  const b = arrive(ANA, "doi");
  const c = arrive(ANA, "vocală");
  assert.equal(mark(ANA), null);

  phoneRead(ANA, b);
  assert.equal(mark(ANA), idOf(ANA, b));
  phoneRead(ANA, a);
  assert.equal(mark(ANA), idOf(ANA, b), "an older receipt arriving late does not take it back");
  phoneRead(ANA, c, STATUS.PLAYED);
  assert.equal(mark(ANA), idOf(ANA, c), "played counts as read");
  phoneRead(ANA, "NEVER-STORED");

  const seen = counters();
  assert.equal(seen.seen, 4);
  assert.equal(seen.applied, 2);
  assert.equal(seen.unmatched, 1);
  assert.equal(seen.synced, 0);
  assert.match(seen.last_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("someone else's receipts never move the read mark and are not counted as the phone's", () => {
  const { arrive, sock, phoneRead, groupReceipt, idOf, mark, counters } = setup();
  const theirs = arrive(ANA, "bună");
  const mine = arrive(ANA, "salut", { fromMe: true, status: STATUS.SERVER_ACK });
  // Ana reading the account's message: Baileys reports it on the account's own key.
  sock.ev.emit("messages.update", [{ key: { remoteJid: ANA, fromMe: true, id: mine }, update: { status: STATUS.READ } }]);
  // A delivery receipt, and a status that is not a read, on her message.
  phoneRead(ANA, theirs, STATUS.DELIVERY_ACK);
  assert.equal(mark(ANA), null);
  assert.equal(counters().seen, 0);

  const inGroup = arrive(GROUP, "cine vine?", { participant: DAN });
  const ownInGroup = arrive(GROUP, "eu", { fromMe: true });
  groupReceipt(ownInGroup, DAN, { readTimestamp: T0 + 100 });
  groupReceipt(inGroup, DAN, { readTimestamp: T0 + 100 });
  assert.equal(mark(GROUP), null, "a member reading is theirs, not the phone's");
  assert.equal(counters().seen, 0);

  // The account's own device confirming delivery only, or its own message, moves nothing either.
  groupReceipt(inGroup, ME, { receiptTimestamp: T0 + 100 });
  assert.equal(counters().seen, 0);
  groupReceipt(ownInGroup, ME, { readTimestamp: T0 + 100 });
  assert.equal(mark(GROUP), null, "a receipt on the account's own message is not a read of the chat");
  assert.equal(counters().seen, 1);
  assert.equal(counters().applied, 0);
  // The phone viewing a story reports a receipt on the status feed; that reads no chat.
  sock.ev.emit("message-receipt.update", [
    { key: { remoteJid: "status@broadcast", fromMe: false, id: "STORY", participant: ME }, receipt: { userJid: ME, readTimestamp: T0 + 100 } },
  ]);
  assert.equal(counters().seen, 1);
  assert.ok(idOf(GROUP, inGroup) > 0);
});

test("in a group, the account's own device reading a member's message moves the group's mark, by number or by lid", () => {
  const { sock, arrive, groupReceipt, idOf, mark, counters } = setup();
  const first = arrive(GROUP, "ședința e joi", { participant: DAN });
  const second = arrive(GROUP, "la 10", { participant: DAN });
  groupReceipt(first, ME, { readTimestamp: T0 + 200 });
  assert.equal(mark(GROUP), idOf(GROUP, first));

  sock.ev.emit("lid-mapping.update", { lid: ME_LID, pn: ME });
  groupReceipt(second, ME_LID, { readTimestamp: T0 + 300 });
  assert.equal(mark(GROUP), idOf(GROUP, second), "the account's lid is the account too");
  assert.deepEqual([counters().seen, counters().applied], [2, 2]);
});

test("a receipt under the lid of a chat stored under the number marks the number's chat", () => {
  const { sock, arrive, phoneRead, idOf, mark } = setup();
  sock.ev.emit("lid-mapping.update", { lid: ANA_LID, pn: ANA });
  const id = arrive(ANA, "pe număr");
  phoneRead(ANA_LID, id);
  assert.equal(mark(ANA), idOf(ANA, id));
  assert.equal(mark(ANA_LID), idOf(ANA, id));
});

test("a message that arrives already read — a history sync, a receipt Baileys folded into it — marks the chat as read through it", () => {
  const { arrive, idOf, mark, counters } = setup();
  const synced = arrive(ANA, "din istoric", { status: STATUS.READ, type: "append" });
  assert.equal(mark(ANA), idOf(ANA, synced));
  arrive(ANA, "nou, necitit", { status: STATUS.DELIVERY_ACK });
  assert.equal(mark(ANA), idOf(ANA, synced), "delivered is not read");
  // The account's own message carries its delivery status, never a read of the chat.
  arrive(ANA, "al meu", { fromMe: true, status: STATUS.READ });
  assert.equal(mark(ANA), idOf(ANA, synced));
  assert.deepEqual([counters().synced, counters().applied, counters().seen], [1, 1, 0]);
});

test("a receipt that arrives while a history batch is being stored lands once its message is stored", async () => {
  const { svc, sock, phoneRead, mark, counters } = setup();
  const messages = Array.from({ length: 3 }, (_, i) => ({
    key: { remoteJid: ANA, fromMe: false, id: `H${i}` },
    message: { conversation: `istoric ${i}` },
    messageTimestamp: T0 - 100 + i,
  }));
  sock.ev.emit("messaging-history.set", { chats: [], contacts: [], messages, isLatest: true, progress: 100 });
  phoneRead(ANA, "H2");
  assert.equal(counters().seen, 1, "counted when it arrives");
  await svc.historyIdle();
  assert.equal(mark(ANA), svc.db.messages.get(`false_${ANA}_H2`).id);
  assert.equal(counters().applied, 1);
});
