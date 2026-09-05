/**
 * The everyday tools: a note on a person, "I handled that", a search with a
 * time or a sender, and the compact catch-up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

import { WhatsAppService } from "../dist/whatsapp.js";
import { registerTools } from "../dist/tools.js";
import { compactConversations } from "../dist/compact.js";
import { connectedService, offlineConfig } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const hour = 3_600_000;

function setup(config = {}) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-daily-", id: ME, name: "Răzvan", config });
  const tools = new Map();
  registerTools({ registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) }, svc, { allowWrite: false });
  const call = (name, args = {}) => {
    const { meta, handler } = tools.get(name);
    return handler(z.object(meta.inputSchema).parse(args));
  };
  let seq = 0;
  const arrive = (chat, text, { fromMe = false, participant, at = Date.now() } = {}) => {
    const id = `M${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{ key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) }, message: typeof text === "string" ? { conversation: text } : text, messageTimestamp: Math.floor(at / 1000) }],
    });
    return id;
  };
  sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana" }, { id: DAN, name: "Dan" }]);
  sock.fetchStatus = async () => [];
  sock.profilePictureUrl = async () => null;
  return { svc, sock, call, arrive, tools };
}

test("a note on a contact rides along wherever the person shows, and lives in notes.json", async () => {
  const { svc, call, arrive } = setup();
  arrive(DAN, "salut");
  const noted = await call("set_contact_note", { contact_id: "+40 700 000 003", note: "Hermi, my own agent" });
  assert.match(noted.content[0].text, /Noted for Dan: Hermi, my own agent/);
  assert.match((await call("search_contacts", { query: "dan" })).content[0].text, /\*\*Dan\*\* \[saved\] · Hermi, my own agent/);
  assert.match((await call("list_chats", {})).content[0].text, /## Dan · Hermi, my own agent/);
  assert.match((await call("get_recent_messages", { hours: 1 })).content[0].text, /## Dan · Hermi, my own agent —/);
  assert.match((await call("get_contact", { contact_id: DAN })).content[0].text, /\*\*note\*\*: Hermi, my own agent/);
  assert.ok(existsSync(svc.paths.notesFile));
  assert.equal(JSON.parse(readFileSync(svc.paths.notesFile, "utf8")).contacts[DAN].note, "Hermi, my own agent");

  const again = new WhatsAppService({ ...offlineConfig("x"), dataDir: svc.config.dataDir });
  assert.equal(again.notes.noteFor(DAN), "Hermi, my own agent", "a restart reads it back");

  await call("set_contact_note", { contact_id: DAN, note: "" });
  assert.doesNotMatch((await call("search_contacts", { query: "dan" })).content[0].text, /Hermi/);
});

test("mark_handled takes a chat off the waiting list until the other side writes again", async () => {
  const { call, arrive } = setup();
  arrive(ANA, "poți să mă suni?", { at: Date.now() - 2 * hour });
  assert.deepEqual((await call("get_unanswered", {})).structuredContent.chats.map((c) => c.name), ["Ana"]);

  const marked = await call("mark_handled", { chat_id: ANA });
  assert.match(marked.content[0].text, /Ana is off the waiting list until they write again/);
  assert.equal(marked.structuredContent.ask_text, "poți să mă suni?");
  assert.deepEqual((await call("get_unanswered", {})).structuredContent.chats, []);

  arrive(ANA, "și mâine?", { at: Date.now() - hour });
  assert.deepEqual((await call("get_unanswered", {})).structuredContent.chats.map((c) => c.ask.text), ["și mâine?"], "a new ask reopens it");

  const nothing = await call("mark_handled", { chat_id: DAN });
  assert.match(nothing.content[0].text, /had nothing open/);
});

test("search_messages narrows by time and by sender", async () => {
  const { call, arrive } = setup();
  const day = 24 * hour;
  arrive(ANA, "RCA expiră luni", { at: Date.now() - 10 * day });
  arrive(ANA, "RCA e gata", { at: Date.now() - 2 * day });
  arrive(ANA, "am plătit RCA", { fromMe: true, at: Date.now() - day });
  const since = new Date(Date.now() - 3 * day).toISOString().slice(0, 10);

  const recent = await call("search_messages", { query: "rca", since });
  assert.deepEqual(recent.structuredContent.messages.map((m) => m.text), ["am plătit RCA", "RCA e gata"]);
  const theirs = await call("search_messages", { query: "rca", from: ANA });
  assert.deepEqual(theirs.structuredContent.messages.map((m) => m.text), ["RCA e gata", "RCA expiră luni"]);
  const mine = await call("search_messages", { query: "rca", from: "me" });
  assert.deepEqual(mine.structuredContent.messages.map((m) => m.text), ["am plătit RCA"]);
  const until = await call("search_messages", { query: "rca", until: new Date(Date.now() - 5 * day).toISOString() });
  assert.deepEqual(until.structuredContent.messages.map((m) => m.text), ["RCA expiră luni"]);
  assert.match(recent.content[0].text, new RegExp(`since ${since}`));

  const bad = await call("search_messages", { query: "rca", since: "luni" });
  assert.equal(bad.structuredContent.error, "INVALID_ID");
});

test("compact keeps the words, folds a run into one line, and counts what it left out", async () => {
  const { call, arrive } = setup();
  const t = Date.now() - hour;
  arrive(GROUP, "ați pornit?", { participant: ANA, at: t });
  arrive(GROUP, "da, de la 8", { participant: DAN, at: t + 60_000 });
  arrive(GROUP, "mai avem 2 ore", { participant: DAN, at: t + 120_000 });
  arrive(GROUP, "😘😘", { participant: DAN, at: t + 130_000 });
  arrive(GROUP, { imageMessage: { mimetype: "image/jpeg" } }, { participant: DAN, at: t + 140_000 });
  arrive(GROUP, { imageMessage: { mimetype: "image/jpeg", caption: "autostrada" } }, { participant: DAN, at: t + 150_000 });
  arrive(GROUP, "?", { participant: ANA, at: t + 20 * 60_000 });
  arrive(GROUP, "am ajuns", { participant: DAN, at: t + 60 * 60_000 });

  const full = await call("get_recent_messages", { hours: 2 });
  const compact = await call("get_recent_messages", { hours: 2, compact: true });
  const [c] = compact.structuredContent.conversations;
  assert.deepEqual(
    c.lines.map((l) => [l.text, l.message_ids.length]),
    [["ați pornit?", 1], ["da, de la 8 · mai avem 2 ore · [image] autostrada", 3], ["?", 1], ["am ajuns", 1]],
  );
  assert.deepEqual(c.dropped, { media: 1, wordless: 1 });
  assert.match(compact.content[0].text, /left out: 1 media without a word, 1 wordless/);
  assert.match(compact.content[0].text, /Dan: da, de la 8 · mai avem 2 ore · \[image\] autostrada \(3 msgs\)/);
  assert.ok(compact.content[0].text.split("\nCoverage:")[0].length < full.content[0].text.split("\nCoverage:")[0].length * 0.7, "well under the full size");
  assert.equal(compactConversations([]).length, 0);
});

test("in a group the note introduces the sender once, then the name alone", async () => {
  const { call, arrive } = setup();
  await call("set_contact_note", { contact_id: DAN, note: "Hermi" });
  const t = Date.now() - hour;
  arrive(GROUP, "sunt aici", { participant: DAN, at: t });
  arrive(GROUP, "și tu?", { participant: ANA, at: t + 10 * 60_000 });
  arrive(GROUP, "tot aici", { participant: DAN, at: t + 20 * 60_000 });
  const full = (await call("get_recent_messages", { hours: 2 })).content[0].text;
  assert.equal((full.match(/Dan · Hermi:/g) || []).length, 1, "introduced once");
  assert.match(full, /\] Dan: tot aici/);
  const read = (await call("read_messages", { chat_id: GROUP })).content[0].text;
  assert.equal((read.match(/\*\*Dan · Hermi\*\*/g) || []).length, 1);
  const compact = (await call("get_recent_messages", { hours: 2, compact: true })).content[0].text;
  assert.equal((compact.match(/Dan · Hermi:/g) || []).length, 1);
  assert.match(compact, /\] Dan: tot aici/);
});
