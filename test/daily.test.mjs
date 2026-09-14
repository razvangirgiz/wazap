/**
 * The everyday tools: a note on a person, "I handled that", a search with a
 * time or a sender, and the compact catch-up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { proto } from "baileys";
import { z } from "zod";

import { WhatsAppService } from "../dist/whatsapp.js";
import { registerTools } from "../dist/tools.js";
import { compactConversations } from "../dist/compact.js";
import { decodeMessage } from "../dist/store.js";
import { asToolSource, connectedService, offlineConfig, openService, waitFor } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const hour = 3_600_000;

function setup(config = {}) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-daily-", id: ME, name: "Răzvan", config });
  const tools = new Map();
  registerTools({ registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) }, asToolSource(svc), {
    allowWrite: false,
  });
  const call = (name, args = {}) => {
    const { meta, handler } = tools.get(name);
    return handler(z.object(meta.inputSchema).parse(args));
  };
  let seq = 0;
  const arrive = (chat, text, { fromMe = false, participant, at = Date.now() } = {}) => {
    const id = `M${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) },
          message: typeof text === "string" ? { conversation: text } : text,
          messageTimestamp: Math.floor(at / 1000),
        },
      ],
    });
    return id;
  };
  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Ana" },
    { id: DAN, name: "Dan" },
  ]);
  sock.fetchStatus = async () => [];
  sock.profilePictureUrl = async () => null;
  return { svc, sock, call, arrive, tools };
}

test("a note on a contact rides along wherever the person shows, and lives in notes.json", async () => {
  const { svc, call, arrive } = setup();
  arrive(DAN, "salut");
  const noted = await call("set_contact_note", { contact_id: "+40 700 000 003", note: "Hermi, my own agent" });
  assert.match(noted.content[0].text, /Noted for Dan: Hermi, my own agent/);
  assert.match(
    (await call("search_contacts", { query: "dan" })).content[0].text,
    /\*\*Dan\*\* \[saved\] · Hermi, my own agent/
  );
  assert.match((await call("list_chats", {})).content[0].text, /## Dan · Hermi, my own agent/);
  assert.match((await call("get_recent_messages", { hours: 1 })).content[0].text, /## Dan · Hermi, my own agent —/);
  assert.match((await call("get_contact", { contact_id: DAN })).content[0].text, /\*\*note\*\*: Hermi, my own agent/);
  assert.ok(existsSync(svc.paths.notesFile));
  assert.equal(JSON.parse(readFileSync(svc.paths.notesFile, "utf8")).contacts[DAN].note, "Hermi, my own agent");

  const again = openService(WhatsAppService, { ...offlineConfig("x"), dataDir: svc.config.dataDir });
  assert.equal(again.notes.noteFor(DAN), "Hermi, my own agent", "a restart reads it back");

  await call("set_contact_note", { contact_id: DAN, note: "" });
  assert.doesNotMatch((await call("search_contacts", { query: "dan" })).content[0].text, /Hermi/);
});

test("mark_handled takes a chat off the waiting list until the other side writes again", async () => {
  const { call, arrive } = setup();
  arrive(ANA, "poți să mă suni?", { at: Date.now() - 2 * hour });
  assert.deepEqual(
    (await call("get_unanswered", {})).structuredContent.chats.map((c) => c.name),
    ["Ana"]
  );

  const marked = await call("mark_handled", { chat_id: ANA });
  assert.match(marked.content[0].text, /Ana is off the waiting list until they write again/);
  assert.equal(marked.structuredContent.ask_text, "poți să mă suni?");
  assert.deepEqual((await call("get_unanswered", {})).structuredContent.chats, []);

  arrive(ANA, "și mâine?", { at: Date.now() - hour });
  assert.deepEqual(
    (await call("get_unanswered", {})).structuredContent.chats.map((c) => c.ask.text),
    ["și mâine?"],
    "a new ask reopens it"
  );

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
  assert.deepEqual(
    recent.structuredContent.messages.map((m) => m.text),
    ["am plătit RCA", "RCA e gata"]
  );
  const theirs = await call("search_messages", { query: "rca", from: ANA });
  assert.deepEqual(
    theirs.structuredContent.messages.map((m) => m.text),
    ["RCA e gata", "RCA expiră luni"]
  );
  const mine = await call("search_messages", { query: "rca", from: "me" });
  assert.deepEqual(
    mine.structuredContent.messages.map((m) => m.text),
    ["am plătit RCA"]
  );
  const until = await call("search_messages", { query: "rca", until: new Date(Date.now() - 5 * day).toISOString() });
  assert.deepEqual(
    until.structuredContent.messages.map((m) => m.text),
    ["RCA expiră luni"]
  );
  assert.match(recent.content[0].text, new RegExp(`since ${since}`));

  const bad = await call("search_messages", { query: "rca", since: "luni" });
  assert.equal(bad.structuredContent.error, "INVALID_ID");
});

test("search follows an edit and a late transcript, not the words it cached first", async () => {
  const { svc, sock, call, arrive } = setup();
  arrive(ANA, "RCA expiră luni");
  const before = await call("search_messages", { query: "zebra" });
  assert.deepEqual(before.structuredContent.messages, []);

  sock.ev.emit("messages.update", [
    {
      key: { remoteJid: ANA, fromMe: false, id: "M1" },
      update: { message: { editedMessage: { message: { conversation: "zebra e a mea" } } } },
    },
  ]);
  const after = await call("search_messages", { query: "zebra" });
  assert.deepEqual(
    after.structuredContent.messages.map((m) => m.text),
    ["zebra e a mea"],
    "the edit replaces what the search matches"
  );
  assert.deepEqual(
    (await call("search_messages", { query: "rca" })).structuredContent.messages,
    [],
    "and the words it replaced no longer match"
  );

  const vid = arrive(ANA, { audioMessage: { ptt: true, seconds: 4 } });
  const sid = `false_${ANA}_${vid}`;
  assert.deepEqual((await call("search_messages", { query: "umbrela" })).structuredContent.messages, []);
  svc.store.setTranscript(sid, { text: "am uitat umbrela", provider: "local", at: Date.now() });
  assert.deepEqual(
    (await call("search_messages", { query: "umbrela" })).structuredContent.messages.map((m) => m.message_id),
    [sid],
    "a transcript that lands after the first search is still found"
  );
});

test("a snapshot re-encodes the message an edit touched and keeps the rest", async () => {
  const { svc, sock, arrive } = setup();
  arrive(ANA, "prima versiune");
  arrive(DAN, "nemișcat");
  const sid = `false_${ANA}_M1`;
  const still = `false_${DAN}_M2`;

  const first = svc.store.serialize();
  const second = svc.store.serialize();
  assert.equal(second.messages[sid], first.messages[sid], "an untouched message keeps its encoding");

  sock.ev.emit("messages.update", [
    {
      key: { remoteJid: ANA, fromMe: false, id: "M1" },
      update: { message: { editedMessage: { message: { conversation: "a doua versiune" } } } },
    },
  ]);
  const third = svc.store.serialize();
  assert.notEqual(third.messages[sid], first.messages[sid], "the edit re-encodes");
  assert.equal(third.messages[still], first.messages[still], "the neighbour is not re-encoded");
  assert.equal(decodeMessage(third.messages[sid]).message.conversation, "a doua versiune");
});

test("compact keeps the words, folds a run into one line, and counts what it left out", async () => {
  const { call, arrive } = setup();
  const t = Date.now() - hour;
  arrive(GROUP, "ați pornit?", { participant: ANA, at: t });
  arrive(GROUP, "da, de la 8", { participant: DAN, at: t + 60_000 });
  arrive(GROUP, "mai avem 2 ore", { participant: DAN, at: t + 120_000 });
  arrive(GROUP, "😘😘", { participant: DAN, at: t + 130_000 });
  arrive(GROUP, { imageMessage: { mimetype: "image/jpeg" } }, { participant: DAN, at: t + 140_000 });
  arrive(
    GROUP,
    { imageMessage: { mimetype: "image/jpeg", caption: "autostrada" } },
    { participant: DAN, at: t + 150_000 }
  );
  arrive(GROUP, "?", { participant: ANA, at: t + 20 * 60_000 });
  arrive(GROUP, "am ajuns", { participant: DAN, at: t + 60 * 60_000 });

  const full = await call("get_recent_messages", { hours: 2 });
  const compact = await call("get_recent_messages", { hours: 2, compact: true });
  const [c] = compact.structuredContent.conversations;
  assert.deepEqual(
    c.lines.map((l) => [l.text, l.message_ids.length]),
    [
      ["ați pornit?", 1],
      ["da, de la 8 · mai avem 2 ore · [image] autostrada", 3],
      ["?", 1],
      ["am ajuns", 1],
    ]
  );
  assert.deepEqual(c.dropped, { media: 1, wordless: 1 });
  assert.match(compact.content[0].text, /left out: 1 media without a word, 1 wordless/);
  assert.match(compact.content[0].text, /Dan: da, de la 8 · mai avem 2 ore · \[image\] autostrada \(3 msgs\)/);
  assert.ok(compact.content[0].text.length < full.content[0].text.length * 0.7, "well under the full size");
  assert.equal(compactConversations([]).length, 0);
});

test("a revoked message leaves the store, the search, and the history file on reload", async () => {
  const { svc, sock, call, arrive } = setup({ persistHistory: true });
  const id = arrive(ANA, "parola e hunter2");
  const sid = `false_${ANA}_${id}`;
  assert.ok(svc.store.messages.has(sid));

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: ANA, fromMe: false, id: "R1" },
        message: {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.REVOKE,
            key: { remoteJid: ANA, fromMe: false, id },
          },
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  });

  assert.equal(svc.store.messages.has(sid), false, "the target is gone from the store");
  assert.deepEqual((await call("search_messages", { query: "hunter2" })).structuredContent.messages, []);
  const read = (await call("read_messages", { chat_id: ANA })).content[0].text;
  assert.doesNotMatch(read, /hunter2/);
  assert.match(read, /\[deleted\]/, "the placeholder stays, the way the phone shows it");

  // The file keeps the line until the next load compacts it away; the
  // tombstone must win over it there, or a restart resurrects the message.
  const file = join(svc.paths.historyDir, `${ANA}.jsonl`);
  const lines = () => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []);
  await waitFor(() => lines().length >= 2, 5_000, "the history lines to land");
  await svc.flushStore();
  const again = openService(WhatsAppService, { ...offlineConfig("x"), dataDir: svc.config.dataDir, persistHistory: true });
  await again.loadPersisted();
  assert.equal(again.store.messages.has(sid), false, "the reload honours the tombstone");
  assert.deepEqual(
    lines().map((line) => decodeMessage(JSON.parse(line).raw)?.message?.protocolMessage?.type ?? null),
    [proto.Message.ProtocolMessage.Type.REVOKE],
    "compaction drops the target's bytes and keeps only the tombstone"
  );

  const second = arrive(ANA, "al doilea secret");
  sock.ev.emit("messages.delete", { keys: [{ remoteJid: ANA, fromMe: false, id: second }] });
  assert.equal(svc.store.messages.has(`false_${ANA}_${second}`), false, "messages.delete drops it too");
});

test("a creds save that fails is logged, not left as an unhandled rejection", async () => {
  const { svc, sock } = setup();
  svc.saveCreds = () => Promise.reject(new Error("ENOSPC"));
  let unhandled = false;
  const spy = () => (unhandled = true);
  process.on("unhandledRejection", spy);
  try {
    sock.ev.emit("creds.update", {});
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(unhandled, false, "the rejection is caught and logged");
  } finally {
    process.off("unhandledRejection", spy);
  }
});

test("download_media refuses a file over the cap before touching the network", async () => {
  const { call, arrive } = setup();
  const id = arrive(ANA, {
    documentMessage: { mimetype: "video/mp4", fileLength: 250_000_000, fileName: "big.mp4" },
  });
  const res = await call("download_media", { message_id: `false_${ANA}_${id}` });
  assert.equal(res.structuredContent.error, "FILE_TOO_LARGE");
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
