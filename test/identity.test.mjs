/**
 * The lid ↔ number table. One person goes by a phone jid and by a lid; these
 * pin how a pairing is learned, which id wins, the spellings a vote is tried
 * under, how the account knows itself, and that the table reads and writes
 * the snapshot's `lids` exactly as an older wazap did.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveChatId } from "../dist/ids.js";
import { LidRegistry, lidKey } from "../dist/identity.js";
import { Store } from "../dist/store.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ME_LID = "900000000000001@lid";
const PHONE = "40700000002@s.whatsapp.net";
const LID = "900000000000002@lid";
const UNPAIRED = "11112222@lid";

test("a pairing is learned with the device dropped on both sides, and says whether the written table changed", () => {
  const ids = new LidRegistry();
  assert.equal(lidKey("900000000000002:7@hosted.lid"), LID, "one key whatever lid server it came from");
  assert.equal(ids.learn("900000000000002:7@lid", "40700000002:3@s.whatsapp.net"), true, "a new pairing");
  assert.equal(ids.phoneOf(LID), PHONE);
  assert.equal(ids.lidOf(PHONE), LID);
  assert.equal(ids.learn(LID, PHONE), false, "the same pairing again");
  assert.equal(ids.learn(LID, "40700000009@s.whatsapp.net"), true, "another number for the lid");
  assert.equal(ids.learn("", PHONE), false, "half a pairing is none");
  assert.equal(ids.learn(LID, ""), false);
  assert.deepEqual([...ids], [[LID, "40700000009@s.whatsapp.net"]]);
});

test("a lid moved to another number stops answering for the old one, and every reading agrees", () => {
  const OLD = PHONE;
  const NEW = "40700000008@s.whatsapp.net";
  const ids = new LidRegistry();
  ids.learn(LID, OLD);
  assert.equal(ids.learn(LID, NEW), true);

  assert.equal(ids.phoneOf(LID), NEW);
  assert.equal(ids.aliasOf(LID), NEW);
  assert.equal(ids.canonical(LID), NEW);
  assert.equal(ids.lidOf(NEW), LID);
  assert.equal(ids.aliasOf(NEW), LID);
  assert.equal(ids.canonical(NEW), NEW);
  assert.equal(ids.lidOf(OLD), undefined, "the old number no longer reaches the lid");
  assert.equal(ids.aliasOf(OLD), undefined);
  assert.equal(ids.canonical(OLD), OLD);
  assert.deepEqual(ids.spellings([OLD]), [OLD]);
  assert.deepEqual(ids.spellings([NEW]), [NEW, LID]);
});

test("a number a lid moved away from is no longer named, or forgotten, through that lid", async () => {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-identity-", id: ME, name: "Răzvan" });
  const OLD = PHONE;
  const NEW = "40700000008@s.whatsapp.net";
  sock.ev.emit("lid-mapping.update", { lid: LID, pn: OLD });
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: NEW, fromMe: false, id: "N1" },
        message: { conversation: "am număr nou" },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: "Nou",
      },
    ],
  });
  sock.ev.emit("lid-mapping.update", { lid: LID, pn: NEW });

  assert.equal(svc.displayName(LID), "Nou");
  assert.equal(svc.displayName(NEW), "Nou");
  assert.equal(svc.displayName(OLD), "40700000002", "the old number is not named after whoever holds the lid now");

  sock.ev.emit("chats.delete", [OLD]);
  await svc.storageIdle();
  assert.notEqual(svc.db.identity.chat(OLD).clearedThroughTs, null, "the old number's chat is cleared");
  assert.equal(svc.db.identity.chat(NEW).clearedThroughTs, null, "and the chat the lid now answers for is not");
  assert.equal(svc.hasMessage(`false_${NEW}_N1`), true, "deleting the old number's chat leaves the lid's person alone");
});

test("a number that gains a new lid keeps the older lid's pairing, and moving the older lid leaves the number alone", () => {
  const NEWER_LID = "900000000000007@lid";
  const ELSEWHERE = "40700000009@s.whatsapp.net";
  const ids = new LidRegistry();
  ids.learn(LID, PHONE);
  ids.learn(NEWER_LID, PHONE);
  assert.equal(ids.lidOf(PHONE), NEWER_LID, "a number names the lid it was last learned with");
  assert.equal(ids.phoneOf(LID), PHONE, "the older lid still pairs with it");
  assert.equal(ids.canonical(LID), PHONE);

  ids.learn(LID, ELSEWHERE);
  assert.equal(ids.lidOf(PHONE), NEWER_LID, "the number pointed at the newer lid, so the move does not unlink it");
  assert.equal(ids.lidOf(ELSEWHERE), LID);
});

test("canonical: the number wins once it is known, by the same rules as resolveChatId", () => {
  const ids = new LidRegistry();
  ids.learn(LID, PHONE);
  const inputs = [
    "40700000002",
    "+40 700 000 002",
    "40700000002@c.us",
    "40700000002:12@s.whatsapp.net",
    "120363000000000001@g.us",
    LID,
    "900000000000002:4@lid",
    UNPAIRED,
  ];
  for (const input of inputs) {
    assert.equal(ids.canonical(input), resolveChatId(input, (lid) => ids.phoneOf(lid)), input);
  }
  assert.equal(ids.canonical(LID), PHONE);
  assert.equal(ids.canonical("11112222:3@lid"), UNPAIRED, "an unpaired lid stays the lid, device dropped");
  assert.equal(ids.canonical(""), "");
});

test("canonical hands back what it cannot read, where resolve refuses it", () => {
  const ids = new LidRegistry();
  for (const input of ["status@broadcast", "someone@newsletter", "0722123456"]) {
    assert.equal(ids.canonical(input), input);
    assert.throws(
      () => ids.resolve(input),
      (err) => ["INVALID_ID", "INVALID_PHONE"].includes(err.code)
    );
  }
});

test("aliasOf is the other id of the same person, either way round", () => {
  const ids = new LidRegistry();
  ids.learn(LID, PHONE);
  assert.equal(ids.aliasOf(LID), PHONE);
  assert.equal(ids.aliasOf(PHONE), LID);
  assert.equal(ids.aliasOf(UNPAIRED), undefined);
  assert.equal(ids.aliasOf("40700000009@s.whatsapp.net"), undefined);
});

test("spellings lists every form a vote may be bound to, people only, in a fixed order", () => {
  const ids = new LidRegistry();
  ids.learn(LID, PHONE);
  assert.deepEqual(ids.spellings(["900000000000002:5@lid"]), [LID, PHONE], "a lid, then its number");
  assert.deepEqual(ids.spellings(["40700000002@c.us"]), [PHONE, LID], "a number, then its lid");
  assert.deepEqual(
    ids.spellings([undefined, null, "", "120363000000000001@g.us", "status@broadcast", PHONE, "11112222:1@lid", LID]),
    [PHONE, LID, UNPAIRED],
    "groups, the status feed and blanks are skipped, and nothing is listed twice"
  );
});

test("isSelf knows the account by its number and by its own lid, paired or not", () => {
  const ids = new LidRegistry();
  assert.equal(ids.isSelf(ME, ME, ME_LID), true);
  assert.equal(ids.isSelf("40700000001:4@s.whatsapp.net", ME, ME_LID), true, "another device of the account");
  assert.equal(ids.isSelf("900000000000001:9@lid", ME, ME_LID), true, "the socket's own lid, before any pairing");
  assert.equal(ids.isSelf(ME_LID, ME, undefined), false, "without the socket's lid, an unpaired lid is nobody");
  ids.learn(ME_LID, ME);
  assert.equal(ids.isSelf(ME_LID, ME, undefined), true, "once paired, the lid is the number");
  assert.equal(ids.isSelf(PHONE, ME, ME_LID), false);
  assert.equal(ids.isSelf(ME, "", ME_LID), false, "no account, no self");
});

test("the table reads and writes the snapshot's lids shape unchanged", () => {
  const written = { [LID]: PHONE, "900000000000003@lid": "40700000003@s.whatsapp.net" };
  const ids = new LidRegistry();
  ids.hydrate(written);
  assert.deepEqual(ids.toJSON(), written, "written back exactly as read, in the same order");
  assert.equal(JSON.stringify(ids), JSON.stringify(written));
  assert.equal(ids.canonical(LID), PHONE, "ids follow a restored pairing");
  assert.equal(ids.lidOf(PHONE), undefined, "the way back is not restored, it is learned");
  assert.equal(ids.learn(LID, PHONE), false, "a pairing already written down is no change");
  assert.equal(ids.lidOf(PHONE), LID);

  const handEdited = new LidRegistry();
  handEdited.hydrate({ "900000000000004:2@lid": "40700000004:1@s.whatsapp.net", "900000000000005@lid": "" });
  assert.deepEqual(
    handEdited.toJSON(),
    { "900000000000004@lid": "40700000004@s.whatsapp.net" },
    "restored the way learn would have learned it, and what learn refuses is not restored"
  );

  const learned = new LidRegistry();
  learned.learn(LID, PHONE);
  const revived = new LidRegistry();
  revived.hydrate(JSON.parse(JSON.stringify(learned)));
  assert.deepEqual([...revived], [...learned], "a round trip keeps every pairing");
});

test("a store snapshot keeps its lids through a load and a save, and one from before the table reads as empty", () => {
  const older = {
    v: 1,
    chats: {},
    contacts: {},
    pushNames: {},
    messages: {},
    byChat: {},
    transcripts: {},
    lids: { [LID]: PHONE, "900000000000003@lid": "40700000003@s.whatsapp.net" },
    contactsResyncedAt: null,
  };
  const store = new Store();
  store.hydrate(older);
  assert.deepEqual(store.serialize().lids, older.lids);
  assert.equal(store.lids.canonical(LID), PHONE);

  const beforeTheTable = new Store();
  beforeTheTable.hydrate({ v: 1, chats: {}, contacts: {}, messages: {}, byChat: {} });
  assert.deepEqual(beforeTheTable.serialize().lids, {});
});
