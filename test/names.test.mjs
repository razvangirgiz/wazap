/**
 * Name resolution. A group sender used to render as a bare LID — fifteen digits
 * that read as a phone number and are not one — and a stranger with a pushName
 * rendered as their phone number. These pin the ladder that fixed it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";

const makeService = () => connectedService(WhatsAppService, { prefix: "wazap-names-", id: ME, name: "Răzvan" });

const message = (chat, { participant, pushName, text = "hi", id = "M1", fromMe = false } = {}) => ({
  key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) },
  message: { conversation: text },
  messageTimestamp: Math.floor(Date.now() / 1000),
  ...(pushName ? { pushName } : {}),
});

test("displayName resolves a jid through one ladder", () => {
  const { svc, sock } = makeService();
  sock.ev.emit("contacts.upsert", [
    { id: "40700000002@s.whatsapp.net", name: "Ana", notify: "ana-on-wa" },
    { id: "40700000003@s.whatsapp.net", notify: "Bogdan" },
    { id: "40700000005@s.whatsapp.net", name: "Dana", lid: "111222333444555@lid" },
    { id: "40700000006@s.whatsapp.net", verifiedName: "Pizza SRL" },
  ]);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [message("40700000004@s.whatsapp.net", { pushName: "Carmen" })],
  });

  const cases = [
    ["saved name wins over the sender's own", "40700000002@s.whatsapp.net", "Ana"],
    ["notify when nothing is saved", "40700000003@s.whatsapp.net", "Bogdan"],
    ["a business name counts as saved", "40700000006@s.whatsapp.net", "Pizza SRL"],
    ["pushName seen on a message", "40700000004@s.whatsapp.net", "Carmen"],
    ["a lid resolves through its phone jid", "111222333444555@lid", "Dana"],
    ["an unresolved lid never poses as a phone number", "4226298167515@lid", "unknown (lid …7515)"],
    ["a phone number with no name at all", "40700000009@s.whatsapp.net", "40700000009"],
    ["the linked account is you", ME, "Răzvan"],
  ];
  for (const [label, jid, expected] of cases) {
    assert.equal(svc.displayName(jid), expected, label);
  }
});

test("a group learns its participants' names and numbers from its metadata", () => {
  const { svc, sock } = makeService();
  const group = "120363000000000001@g.us";
  sock.ev.emit("contacts.upsert", [{ id: "40700000007@s.whatsapp.net", name: "Elena" }]);
  sock.ev.emit("groups.upsert", [
    {
      id: group,
      subject: "Familia",
      participants: [
        { id: "999888777666555@lid", phoneNumber: "40700000007@s.whatsapp.net" },
        { id: "555666777888999@lid", phoneNumber: "40700000008@s.whatsapp.net", username: "Florin" },
      ],
    },
  ]);

  assert.equal(svc.displayName(group), "Familia");
  assert.equal(svc.displayName("999888777666555@lid"), "Elena", "the saved contact behind the lid");
  assert.equal(svc.displayName("555666777888999@lid"), "Florin", "the name the metadata carried");
  assert.equal(svc.lidPhones.get("999888777666555@lid"), "40700000007@s.whatsapp.net");
  assert.equal(svc.lidToPn.has("999888777666555@lid"), false, "naming a participant must not rename their chat");
});

test("a group message renders its sender as a name, not as a LID", async () => {
  const { svc, sock } = makeService();
  const group = "120363000000000002@g.us";
  sock.ev.emit("groups.upsert", [
    {
      id: group,
      subject: "Drum",
      participants: [{ id: "123123123123123@lid", phoneNumber: "40700000010@s.whatsapp.net" }],
    },
  ]);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [message(group, { participant: "123123123123123@lid", pushName: "Gigi", text: "am ajuns" })],
  });

  const { data } = await svc.readMessages(group, 10);
  assert.equal(data.length, 1);
  assert.equal(data[0].sender.name, "Gigi");
  assert.equal(data[0].sender.id, "123123123123123@lid", "the id stays the one the chat's history is filed under");
});

test("pushNames survive a store round trip, so a restart does not forget who wrote", () => {
  const { svc, sock } = makeService();
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [message("40700000011@s.whatsapp.net", { pushName: "Horia" })],
  });

  const { svc: revived } = makeService();
  revived.store.hydrate(JSON.parse(JSON.stringify(svc.store.serialize())));
  assert.equal(revived.store.pushNames.get("40700000011@s.whatsapp.net"), "Horia");
});

test("search_contacts finds someone by the name the chat list shows them under", async () => {
  const { svc, sock } = makeService();
  sock.ev.emit("contacts.upsert", [{ id: "40700000012@s.whatsapp.net" }]);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [message("40700000012@s.whatsapp.net", { pushName: "Ioana" })],
  });

  assert.equal(svc.displayName("40700000012@s.whatsapp.net"), "Ioana");
  const found = await svc.searchContacts("ioana", 10);
  assert.deepEqual(found.map((c) => c.name), ["Ioana"]);
});

test("a lid WhatsApp never paired on a chat is still named from Baileys' own table", async () => {
  const { svc, sock } = makeService();
  const lid = "273520764416235@lid";
  sock.ev.emit("contacts.upsert", [{ id: "447535707769@s.whatsapp.net", name: "Vlad" }]);
  sock.ev.emit("messages.upsert", { type: "notify", messages: [message(lid, { text: "salut" })] });
  assert.equal(svc.displayName(lid), "unknown (lid …6235)", "nothing to go on before the lookup");

  const asked = [];
  svc.sockClient.signalRepository = {
    lidMapping: {
      getPNsForLIDs: async (lids) => {
        asked.push(...lids);
        return [{ lid, pn: "447535707769:0@s.whatsapp.net" }];
      },
    },
  };

  const chats = (await svc.listChats("all", 10)).data;
  assert.deepEqual(asked, [lid]);
  assert.equal(chats[0].name, "Vlad");
  assert.equal(chats[0].chat_id, lid, "the chat keeps the id its history is filed under");
});

test("a sender's own name is used even when only this message carries it", () => {
  const { svc } = makeService();
  const jid = "40700000013@s.whatsapp.net";
  assert.equal(svc.displayName(jid), "40700000013", "nothing is known about them");
  assert.equal(svc.displayName(jid, "Radu"), "Radu", "the name riding on the message being rendered");
});

test("reading a group fetches its metadata once and then stops asking", async () => {
  const { svc, sock } = makeService();
  const group = "120363000000000009@g.us";
  let fetches = 0;
  svc.sockClient.groupMetadata = async (id) => {
    fetches++;
    return { id, subject: "Munte", participants: [{ id: "321321321321321@lid", phoneNumber: "40700000014@s.whatsapp.net" }] };
  };
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [message(group, { participant: "321321321321321@lid", text: "gata" })],
  });

  await svc.readMessages(group, 10);
  await svc.readMessages(group, 10);
  assert.equal(fetches, 1, "the second read must come out of the cache");
  assert.equal(svc.displayName("321321321321321@lid"), "40700000014");
});

test("a group we cannot read is not re-fetched on every message page", async () => {
  const { svc } = makeService();
  const group = "120363000000000010@g.us";
  let fetches = 0;
  svc.sockClient.groupMetadata = async () => {
    fetches++;
    throw new Error("not a participant");
  };
  await svc.readMessages(group, 10);
  await svc.readMessages(group, 10);
  assert.equal(fetches, 1);
});

test("a name learned before the lid pairing is still found after it", () => {
  const { svc, sock } = makeService();
  const group = "120363000000000011@g.us";
  const lid = "444555666777888@lid";
  const phone = "40700000015@s.whatsapp.net";
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [message(group, { participant: lid, pushName: "Sanda", text: "aici" })],
  });
  assert.equal(svc.displayName(lid), "Sanda");
  assert.equal(svc.displayName(phone), "40700000015", "nothing links them yet");

  sock.ev.emit("groups.upsert", [{ id: group, subject: "Tura", participants: [{ id: lid, phoneNumber: phone }] }]);
  assert.equal(svc.displayName(phone), "Sanda", "get_group_info asks by number and must get the same answer");
  assert.equal(svc.displayName(lid), "Sanda");
});

/**
 * WhatsApp names a contact it will not identify with the masked number
 * "+40∙∙∙∙∙∙∙98". Treating that as a name once hid the plain number behind
 * dots, and made a session with no address book at all look like it had one.
 */
test("a masked number is not a name, at any rung of the ladder", () => {
  const { svc, sock } = makeService();
  sock.ev.emit("contacts.upsert", [
    { id: "40700000021@s.whatsapp.net", name: "+40∙∙∙∙∙∙∙21" },
    { id: "40700000022@s.whatsapp.net", name: "+40∙∙∙∙∙∙∙22", notify: "Vlad" },
    { id: "40700000023@s.whatsapp.net", name: "0721 234 567" },
  ]);
  assert.equal(svc.displayName("40700000021@s.whatsapp.net"), "40700000021", "the plain number beats dots");
  assert.equal(svc.displayName("40700000022@s.whatsapp.net"), "Vlad", "a real name below it still wins");
  assert.equal(svc.displayName("40700000023@s.whatsapp.net"), "40700000023", "a number saved as a name is a number");
});

test("namedContacts counts the address book, not the store", () => {
  const { svc, sock } = makeService();
  sock.ev.emit("contacts.upsert", [
    { id: "40700000031@s.whatsapp.net", name: "Ionut" },
    { id: "40700000032@s.whatsapp.net", notify: "seen in a group" },
    { id: "40700000033@s.whatsapp.net", name: "+40∙∙∙∙∙∙∙33" },
    { id: "120363000000000031@g.us", name: "Familia" },
  ]);
  assert.equal(svc.storeCounts().contacts, 1);
  assert.equal(svc.namedContacts(), 1);
  assert.equal(svc.getStatus().contacts_named, 1);
});

test("search_contacts still finds a masked contact by number, and never by dots", async () => {
  const { svc, sock } = makeService();
  sock.ev.emit("contacts.upsert", [{ id: "40700000041@s.whatsapp.net", name: "+40∙∙∙∙∙∙∙41" }]);
  assert.equal((await svc.searchContacts("∙∙", 10)).length, 0);
  const byNumber = await svc.searchContacts("40700000041", 10);
  assert.deepEqual(
    byNumber.map((c) => [c.name, c.is_my_contact]),
    [["40700000041", false]],
  );
});

test("a contact filed under both a lid chat and a phone chat is listed once", async () => {
  const { svc, sock } = makeService();
  const phone = "40700000020@s.whatsapp.net";
  const lid = "555444333222111@lid";
  // The chats and their history land before WhatsApp says which number the
  // lid belongs to, so the store keeps a row under each id.
  sock.ev.emit("chats.upsert", [
    { id: phone, conversationTimestamp: 1_700_000_000, unreadCount: 0 },
    { id: lid, conversationTimestamp: 1_700_000_100, unreadCount: 2 },
  ]);
  sock.ev.emit("messages.upsert", { type: "notify", messages: [message(lid, { text: "salut", id: "L1" })] });
  assert.equal(svc.store.chats.size, 2, "two rows before the pairing is known");
  sock.ev.emit("contacts.upsert", [{ id: phone, name: "Mama", lid, phoneNumber: phone }]);

  const chats = (await svc.listChats("all", 10)).data;
  assert.deepEqual(chats.map((chat) => chat.chat_id), [phone], "one row for the person, not one per alias");
  assert.equal(chats[0].name, "Mama");
  assert.equal(chats[0].unread_count, 2, "the unread count survives the merge");
});
