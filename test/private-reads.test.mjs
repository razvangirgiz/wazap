/**
 * `#private` in the broad reads (src/private-contacts.ts): someone the user
 * tagged so has their words reach the assistant only when a call names them —
 * their chat, a message of theirs, them as the author — and a group named by
 * chat_id reads whole. Driven through the registered tools, each answer
 * checked against its output schema the way an SDK client checks it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const ELA = "40700000004@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const MINUTE = 60_000;

function account({ id = ME, name = "Răzvan", record } = {}) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-private-", id, name, ...(record ? { account: record } : {}) });
  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Ana" },
    { id: DAN, name: "Dan" },
    { id: ELA, name: "Ela" },
  ]);
  sock.ev.emit("chats.upsert", [{ id: GROUP, name: "Echipa" }]);
  let seq = 0;
  const arrive = (chat, content, { fromMe = false, participant, at } = {}) => {
    const key = `M${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: chat, fromMe, id: key, ...(participant ? { participant } : {}) },
          message: typeof content === "string" ? { conversation: content } : content,
          messageTimestamp: Math.floor(at / 1000),
        },
      ],
    });
    return `${fromMe}_${chat}_${key}`;
  };
  return { svc, sock, arrive };
}

const everything = (result) => `${result.content.map((block) => block.text ?? "").join("\n")}\n${JSON.stringify(result.structuredContent)}`;
const keyOf = (id) => id.split("_").pop();

test("search without a chat leaves out a #private person's chat and what they write in groups before its limit, counts them, and names them on request", async () => {
  const { svc, arrive } = account();
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  const at = Date.now() - 60 * MINUTE;
  // Newest first: private, public, private, public, public, private, public, public, then two older public ones.
  const theirs = arrive(ANA, "factura pentru terapie", { at: at + 10 * MINUTE });
  arrive(DAN, "factura de la service", { at: at + 9 * MINUTE });
  arrive(ANA, "factura ți-o trimit mâine", { fromMe: true, at: at + 8 * MINUTE });
  arrive(GROUP, "factura comună e plătită", { participant: DAN, at: at + 7 * MINUTE });
  const reply = arrive(
    GROUP,
    { extendedTextMessage: { text: "am văzut factura", contextInfo: { stanzaId: "Q1", participant: ANA, quotedMessage: { conversation: "diagnosticul meu, pe scurt" } } } },
    { participant: ELA, at: at + 6 * MINUTE }
  );
  const inGroup = arrive(GROUP, "factura de la clinică o plătesc eu", { participant: ANA, at: at + 5 * MINUTE });
  arrive(ELA, "factura la curent", { at: at + 4 * MINUTE });
  arrive(DAN, "factura veche", { at: at + 3 * MINUTE });
  arrive(ELA, "factura din august", { at: at + 2 * MINUTE });
  arrive(DAN, "factura din iulie", { at: at + MINUTE });
  svc.db.identity.updateFields(ANA, { addTags: ["private"] });

  const broad = await call("search", { query: "factura", match: "words", limit: 5 });
  assert.equal(broad.structuredContent.count, 5, "the limit counts what is shown");
  assert.equal(broad.structuredContent.private_omitted, 3);
  assert.ok(broad.structuredContent.messages.every((m) => m.chat_id !== ANA && m.sender.id !== ANA), "no entry of hers, not even without words");
  for (const words of ["terapie", "mâine", "clinică", "diagnosticul"]) assert.ok(!everything(broad).includes(words), words);
  const quoted = broad.structuredContent.messages.find((m) => m.message_id === reply);
  assert.deepEqual([quoted.text, quoted.quoted.text, quoted.quoted.sender], ["am văzut factura", "[private]", ANA], "a quote of hers keeps who, not what");
  assert.match(broad.content[0].text, /3 matches from people tagged #private left out: name the chat \(chat_id\) or the person \(from\) to search them\./);
  const fallback = await call("search", { query: "factura", limit: 5 });
  assert.equal(fallback.structuredContent.mode, "keyword_fallback", "meaning search is off here");
  assert.deepEqual([fallback.structuredContent.count, fallback.structuredContent.private_omitted], [5, 3], "the fallback holds the same rule");

  const chat = await call("search", { query: "factura", match: "words", chat_id: ANA });
  assert.deepEqual(chat.structuredContent.messages.map((m) => m.text).sort(), ["factura pentru terapie", "factura ți-o trimit mâine"]);
  assert.equal(chat.structuredContent.private_omitted, undefined);
  const author = await call("search", { query: "factura", match: "words", from: ANA });
  assert.deepEqual(author.structuredContent.messages.map((m) => m.message_id).sort(), [inGroup, theirs].sort());
  assert.equal(author.structuredContent.private_omitted, undefined);
  const group = await call("search", { query: "factura", match: "words", chat_id: GROUP });
  assert.ok(group.structuredContent.messages.some((m) => m.message_id === inGroup), "a group named by chat_id reads whole");
  assert.equal(group.structuredContent.messages.find((m) => m.message_id === reply).quoted.text, "diagnosticul meu, pe scurt");

  svc.db.identity.updateFields(ANA, { removeTags: ["private"] });
  const untagged = await call("search", { query: "factura", match: "words", limit: 5 });
  assert.deepEqual(untagged.structuredContent.messages.map((m) => keyOf(m.message_id)), ["M1", "M2", "M3", "M4", "M5"]);
  assert.equal(untagged.structuredContent.private_omitted, undefined);
});

test("wait_for_messages keeps what arrived from someone #private without their words, in their chat and in a group, unless it waits on their chat", async () => {
  const { svc, arrive } = account();
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  svc.db.identity.updateFields(ANA, { addTags: ["private"] });
  const { cursor } = (await call("wait_for_messages", { timeout_seconds: 1 })).structuredContent;
  const at = Date.now();
  const direct = arrive(ANA, "rezultatele de la analize au ieșit prost", { at: at - 4000 });
  const photo = arrive(ANA, { imageMessage: { mimetype: "image/jpeg", caption: "radiografia mea", fileLength: 2048 } }, { at: at - 3000 });
  const inGroup = arrive(GROUP, "nu spuneți nimănui de divorț", { participant: ANA, at: at - 2000 });
  const reply = arrive(
    GROUP,
    { extendedTextMessage: { text: "te sun diseară", contextInfo: { stanzaId: keyOf(inGroup), participant: ANA, quotedMessage: { conversation: "nu spuneți nimănui de divorț" } } } },
    { participant: DAN, at: at - 1000 }
  );

  const broad = await call("wait_for_messages", { timeout_seconds: 1, cursor });
  const all = everything(broad);
  for (const words of ["analize", "radiografia", "divorț"]) assert.ok(!all.includes(words), words);
  const byId = new Map(broad.structuredContent.messages.map((m) => [m.message_id, m]));
  assert.deepEqual([...byId.keys()], [direct, photo, inGroup, reply], "every arrival stays: something came from her");
  assert.deepEqual(
    [direct, photo, inGroup].map((id) => [byId.get(id).text, byId.get(id).private, byId.get(id).sender.name]),
    [
      ["[private]", true, "Ana"],
      ["[private]", true, "Ana"],
      ["[private]", true, "Ana"],
    ]
  );
  assert.deepEqual([byId.get(photo).type, byId.get(photo).media], ["image", { mime: "image/jpeg", size: 2048 }], "what kind stays");
  assert.deepEqual([byId.get(reply).text, byId.get(reply).private, byId.get(reply).quoted.text], ["te sun diseară", undefined, "[private]"]);
  assert.match(broad.content[0].text, /Ana: \[private\]/);

  const group = await call("wait_for_messages", { timeout_seconds: 1, cursor, chat_id: GROUP });
  assert.deepEqual(group.structuredContent.messages.map((m) => [m.message_id, m.private]), [[inGroup, true], [reply, undefined]], "a group waited on is not her chat");
  const theirs = await call("wait_for_messages", { timeout_seconds: 1, cursor, chat_id: ANA });
  assert.deepEqual(
    theirs.structuredContent.messages.map((m) => [m.text, m.private]),
    [
      ["rezultatele de la analize au ieșit prost", undefined],
      ["[image] radiografia mea", undefined],
    ],
    "waiting on her chat asks for her by name"
  );
});

test("list_chats shows the last message of a #private person's chat, and theirs in a group, without its words; reading the chat by name shows them", async () => {
  const { svc, sock, arrive } = account();
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  sock.ev.emit("chats.upsert", [{ id: "120363000000000002@g.us", name: "Vecini" }]);
  const at = Date.now() - 10 * MINUTE;
  arrive(ANA, "ai găsit avocat?", { at });
  arrive(ANA, "îți trimit banii pentru avocat mâine", { fromMe: true, at: at + MINUTE });
  arrive(GROUP, "ok, vin", { participant: DAN, at: at + 2 * MINUTE });
  arrive(GROUP, "am pierdut sarcina, nu mai vin", { participant: ANA, at: at + 3 * MINUTE });
  arrive("120363000000000002@g.us", "cine a lăsat ușa deschisă?", { participant: ANA, at: at + 4 * MINUTE });
  arrive("120363000000000002@g.us", "eu, scuze", { participant: ELA, at: at + 5 * MINUTE });
  arrive(DAN, "factura e plătită", { at: at + 6 * MINUTE });
  svc.db.identity.updateFields(ANA, { addTags: ["private"] });

  const listed = await call("list_chats", {});
  const all = everything(listed);
  for (const words of ["avocat", "sarcina"]) assert.ok(!all.includes(words), words);
  const last = new Map(listed.structuredContent.chats.map((chat) => [chat.chat_id, chat.last_message]));
  assert.deepEqual(last.get(ANA), { text: "[private]", timestamp: last.get(ANA).timestamp, from_me: true, private: true }, "her chat, the user's own words in it too");
  assert.deepEqual([last.get(GROUP).text, last.get(GROUP).private], ["[private]", true], "what she wrote last in a group");
  assert.deepEqual([last.get("120363000000000002@g.us").text, last.get("120363000000000002@g.us").private], ["eu, scuze", undefined]);
  assert.deepEqual([last.get(DAN).text, last.get(DAN).private], ["factura e plătită", undefined]);
  assert.match(listed.content[0].text, /## Ana\n- \*\*chat_id\*\*: `40700000002@s\.whatsapp\.net`\n- \*\*last\*\*: me: \[private\] \(/);

  const read = await call("read_messages", { chat_id: ANA });
  assert.deepEqual(read.structuredContent.messages.map((m) => m.text), ["ai găsit avocat?", "îți trimit banii pentru avocat mâine"], "named, her chat reads whole");
  const group = await call("read_messages", { chat_id: GROUP });
  assert.ok(group.structuredContent.messages.some((m) => m.text === "am pierdut sarcina, nu mai vin"), "a group named reads whole");
});
