/**
 * read_messages over a time window (since, until), read the way search reads
 * them: one call for "what did Ana send yesterday", the window's own paging
 * with before, and an answer that says when the stored history starts inside
 * the window instead of reading as the chat's start.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { WhatsAppService } from "../dist/whatsapp.js";
import { clockAtHour, connectedService, schemaCheckedTools, textError } from "./helpers.mjs";

clockAtHour(12);

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAY = 86_400_000;

/** A local day's date, YYYY-MM-DD, `days` from today. */
function dayOf(days) {
  const at = new Date(Date.now() + days * DAY);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

function setup(t) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-window-", id: ME, name: "Răzvan" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana" }]);
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  let seq = 0;
  const arrive = (text, at, content) => {
    const id = `M${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{ key: { remoteJid: ANA, fromMe: false, id }, message: content ?? { conversation: text }, messageTimestamp: Math.floor(at / 1000) }],
    });
    return `false_${ANA}_${id}`;
  };
  return { svc, sock, call, arrive };
}

test("since and until read one window, oldest to newest, a bare date meaning its whole day", async (t) => {
  const { call, arrive } = setup(t);
  const today = new Date(`${dayOf(0)}T12:00:00`).getTime();
  arrive("acum trei zile", today - 3 * DAY);
  arrive("ieri dimineață", today - DAY - 3 * 3_600_000);
  arrive("ieri seară", today - DAY + 9 * 3_600_000);
  arrive("azi", today - 3_600_000);
  const yesterday = dayOf(-1);
  const result = await call("read_messages", { chat_id: ANA, since: yesterday, until: yesterday });
  const out = result.structuredContent;
  assert.deepEqual(out.messages.map((m) => m.text), ["ieri dimineață", "ieri seară"]);
  assert.equal(Date.parse(out.since), new Date(`${yesterday}T00:00:00`).getTime());
  assert.equal(Date.parse(out.until), new Date(`${yesterday}T23:59:59`).getTime(), "the whole day, to the second");
  assert.equal(out.more_in_window, undefined);
  assert.match(result.content[0].text, new RegExp(`\\(since ${yesterday}, until ${yesterday}\\)`));

  const fromYesterday = await call("read_messages", { chat_id: ANA, since: `${yesterday}T12:00` });
  assert.deepEqual(fromYesterday.structuredContent.messages.map((m) => m.text), ["ieri seară", "azi"]);
  const untilYesterday = await call("read_messages", { chat_id: ANA, until: yesterday, limit: 5 });
  assert.deepEqual(untilYesterday.structuredContent.messages.map((m) => m.text), ["acum trei zile", "ieri dimineață", "ieri seară"]);
  assert.equal(untilYesterday.structuredContent.unconfirmed_sends, undefined);
});

test("a window holding more than limit says so, and before pages on inside it without asking the phone", async (t) => {
  const { call, arrive, sock } = setup(t);
  let asked = 0;
  sock.fetchMessageHistory = async () => {
    asked++;
    return "history";
  };
  const start = Date.now() - 2 * DAY;
  arrive("înainte de fereastră", start - DAY);
  for (let i = 0; i < 5; i++) arrive(`în fereastră ${i}`, start + i * 60_000);
  const since = new Date(start - 1000).toISOString();
  const first = await call("read_messages", { chat_id: ANA, since, limit: 3 });
  assert.deepEqual(first.structuredContent.messages.map((m) => m.text), ["în fereastră 2", "în fereastră 3", "în fereastră 4"]);
  assert.equal(first.structuredContent.more_in_window, true);
  assert.ok(first.structuredContent.notes.some((note) => /holds older messages than these: read_messages again with before/.test(note)));

  const second = await call("read_messages", { chat_id: ANA, since, limit: 3, before: first.structuredContent.messages[0].message_id });
  assert.deepEqual(second.structuredContent.messages.map((m) => m.text), ["în fereastră 0", "în fereastră 1"]);
  assert.equal(second.structuredContent.more_in_window, undefined);
  const past = await call("read_messages", { chat_id: ANA, since, before: second.structuredContent.messages[0].message_id });
  assert.equal(past.structuredContent.count, 0);
  assert.equal(past.structuredContent.older, undefined, "the window's start is stored: nothing to ask the phone");
  assert.equal(asked, 0);
});

test("a window that reaches before the stored history says where it starts, and before then asks the phone", async (t) => {
  const { call, arrive, sock } = setup(t);
  const asked = [];
  sock.fetchMessageHistory = async (count, key) => {
    asked.push(key.id);
    setImmediate(() => sock.ev.emit("messaging-history.set", { chats: [], contacts: [], messages: [], isLatest: false }));
    return "history";
  };
  const first = arrive("primul mesaj stocat", Date.now() - DAY);
  arrive("al doilea", Date.now() - DAY + 60_000);
  const result = await call("read_messages", { chat_id: ANA, since: dayOf(-10) });
  assert.equal(result.structuredContent.count, 2);
  assert.ok(result.structuredContent.notes.some((note) => /stored history of this chat starts at .* inside the window: read_messages with before/.test(note)));
  const older = await call("read_messages", { chat_id: ANA, since: dayOf(-10), before: first });
  assert.deepEqual(asked, ["M1"], "nothing older is stored, so the phone is asked");
  assert.deepEqual(older.structuredContent.older, { asked_phone: true, received: 0 });
});

test("a window is refused where it cannot apply, and read the way search reads it", async (t) => {
  const { call } = setup(t);
  for (const [args, code, pattern] of [
    [{ chat_id: ANA, since: dayOf(0), until: dayOf(-1) }, "INVALID_ID", /is after until/],
    [{ chat_id: ANA, since: "yesterday" }, "INVALID_ID", /since is not a date/],
    [{ chat_id: "status", since: dayOf(-1) }, "INVALID_ID", /Stories are read by hours/],
  ]) {
    const refused = textError(await call("read_messages", args));
    assert.equal(refused.error, code);
    assert.match(refused.message, pattern);
  }
});

test("a window and types together: what Ana sent as photos and documents yesterday, in one call", async (t) => {
  const { call, arrive } = setup(t);
  const yesterday = new Date(`${dayOf(-1)}T10:00:00`).getTime();
  arrive("text de ieri", yesterday);
  const photo = arrive("", yesterday + 60_000, { imageMessage: { mimetype: "image/jpeg", caption: "bonul" } });
  const pdf = arrive("", yesterday + 120_000, { documentMessage: { mimetype: "application/pdf", fileName: "extras.pdf" } });
  arrive("", Date.now() - 60_000, { imageMessage: { mimetype: "image/jpeg", caption: "de azi" } });
  const result = await call("read_messages", { chat_id: ANA, since: dayOf(-1), until: dayOf(-1), types: ["image", "document"] });
  assert.deepEqual(result.structuredContent.messages.map((m) => m.message_id), [photo, pdf]);
});
