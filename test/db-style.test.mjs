/**
 * The draft context's storage half: how the user writes in a chat
 * (db.messages.styleFor) and the last messages a draft is written after
 * (db.messages.recentExchange).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MESSAGE_FLAGS, styleOf } from "../dist/db/index.js";
import { GROUP, PEER, PEER_LID, T0, openTemp, sid, textMessage } from "./db-fixtures.mjs";

const DAY = 86_400_000;
const ANA = "40700000005@s.whatsapp.net";
const BOSS = "40700000006@s.whatsapp.net";
const JOHN = "40700000007@s.whatsapp.net";

function account() {
  const opened = openTemp();
  opened.clock.now = T0 + 200 * DAY;
  let key = 0;
  const now = opened.clock.now;
  const write = (chat, texts, { fromMe = true, daysAgo = 1, extra = {} } = {}) =>
    texts.map((text, i) =>
      opened.db.messages.upsert(textMessage(chat, `S${++key}`, now - daysAgo * DAY + key * 1000 + i, text, { fromMe, ...extra }))
    );
  return { ...opened, write };
}

test("Romanian without diacritics, on tu: what most people write", () => {
  const { db, write } = account();
  write(ANA, ["da, ajung la 6", "ok te sun dupa", "hai ca vin si eu", "poti sa-mi trimiti adresa?", "mersi mult", "nu stiu inca daca pot ajunge la timp"]);
  write(ANA, ["Bună, ce faci?", "Vii diseară?"], { fromMe: false });
  const style = db.messages.styleFor(ANA);
  assert.deepEqual(style.basis, { own_messages: 6, days: 90, scope: "chat" });
  assert.equal(style.language, "ro");
  assert.equal(style.diacritics, "none");
  assert.equal(style.address, "tu");
  assert.equal(style.starts_capital, 0);
  assert.equal(style.ends_punct, 0.17);
  assert.equal(style.emoji_rate, 0);
});

test("formal Romanian with diacritics, on dumneavoastră", () => {
  const { db, write } = account();
  write(BOSS, [
    "Bună ziua, vă mulțumesc pentru ofertă.",
    "Când sunteți disponibil pentru o discuție?",
    "Vă trimit documentele mâine dimineață.",
    "Aveți nevoie și de copia buletinului?",
    "Mulțumesc frumos, o zi bună!",
    "Dumneavoastră decideți, pentru mine e în regulă.",
  ]);
  const style = db.messages.styleFor(BOSS);
  assert.equal(style.language, "ro");
  assert.equal(style.diacritics, "most");
  assert.equal(style.address, "dumneavoastra");
  assert.equal(style.starts_capital, 1);
  assert.equal(style.ends_punct, 1);
});

test("English, with emoji and lengths", () => {
  const { db, write } = account();
  write(JOHN, ["hey are you coming tonight", "I'll be there at 8 😀", "thanks, see you!", "can you bring the charger", "just got home 🏠🙏", "ok"]);
  const style = db.messages.styleFor(JOHN);
  assert.equal(style.language, "en");
  assert.equal(style.diacritics, "none");
  assert.equal(style.address, "unknown");
  assert.equal(style.emoji_rate, 0.33);
  assert.deepEqual(style.length_chars, { p50: 20, p90: 26 });
  assert.equal(style.starts_capital, 0.17);
  assert.equal(style.ends_punct, 0.17, "an emoji after the words does not hide the punctuation, and none is there");
});

test("with fewer than five of the user's own messages in a chat, the style is the account's", () => {
  const { db, write } = account();
  write(ANA, ["da, ajung la 6", "ok te sun dupa", "hai ca vin si eu", "poti sa-mi trimiti adresa?", "mersi mult"]);
  write(GROUP, ["vin si eu", "unde ne vedem"]);
  write(PEER, ["ok", "da"]);
  const style = db.messages.styleFor(PEER);
  assert.equal(style.basis.scope, "account");
  assert.equal(style.basis.own_messages, 9);
  assert.equal(style.language, "ro");
  assert.equal(db.messages.styleFor(ANA).basis.scope, "chat");
  assert.equal(db.messages.styleFor("40799999999@s.whatsapp.net"), null, "a chat the account does not know");
});

test("what wazap sent, what is older than the window, deleted or someone else's, is not the user's style", () => {
  const { db, write } = account();
  const mine = write(ANA, ["da, ajung la 6", "ok te sun dupa", "hai ca vin si eu", "poti sa-mi trimiti adresa?", "mersi mult"]);
  write(ANA, ["Bună ziua! Vă mulțumesc.", "Cu stimă, asistentul."], { extra: { flags: MESSAGE_FLAGS.viaWazap } });
  write(ANA, ["Stimată doamnă, vă scriu în legătură cu factura."], { daysAgo: 120 });
  write(ANA, ["Bună ziua, cu respect."], { fromMe: false });
  const gone = write(ANA, ["Bună ziua, vă rog frumos."]);
  db.messages.delete(gone[0].sid);
  let style = db.messages.styleFor(ANA);
  assert.equal(style.basis.own_messages, 5);
  assert.equal(style.diacritics, "none");
  style = db.messages.styleFor(ANA, { excludeViaWazap: false });
  assert.equal(style.basis.own_messages, 7);
  assert.equal(db.messages.styleFor(ANA, { days: 365, excludeViaWazap: false }).basis.own_messages, 8);
  assert.equal(mine.length, 5);
});

test("before wazap recorded its sends (an upgrade, an import), an own message under a Baileys-shaped key is not taken as the user's style", () => {
  const { db, clock } = account();
  const now = clock.now;
  const stored = (key, daysAgo, text) => db.messages.upsert(textMessage(ANA, key, now - daysAgo * DAY, text, { fromMe: true }));
  // Written on the phone before the upgrade: kept.
  ["da, ajung la 6", "ok te sun dupa", "hai ca vin si eu"].forEach((text, i) => stored(`A1B2C3D4E5F6${i}`, 30 + i, text));
  // Sent by wazap (or Calfa) before the upgrade, their send rows long gone: unknowable, so left out.
  ["Bună ziua! Vă mulțumesc.", "Cu stimă, asistentul.", "Vă confirm programarea."].forEach((text, i) => stored(`3EB0ABCDEF${i}`, 20 + i, text));
  stored("BAE5OLDBAILEYS", 25, "Vă stă la dispoziție echipa.");
  db.setMeta("via_wazap_known_after", "migrated_v5");
  db.setMeta("migrated_v5", String(now - 10 * DAY));
  // After the upgrade every send is on record: a Baileys-shaped key the record does not name is the user's (WhatsApp Web).
  ["mersi mult", "nu stiu inca daca pot ajunge la timp"].forEach((text, i) => stored(`3EB0WEB${i}`, 2 + i, text));
  const style = db.messages.styleFor(ANA);
  assert.equal(style.basis.own_messages, 5);
  assert.equal(style.diacritics, "none");
  assert.equal(db.messages.styleFor(ANA, { excludeViaWazap: false }).basis.own_messages, 9, "asked for everything, everything");
});

test("styleOf is deterministic on its own and mixed languages read as other", () => {
  const basis = { own_messages: 4, days: 90, scope: "chat" };
  const mixed = styleOf(["ce faci azi", "see you tomorrow at the office", "hai ca vin", "thanks for the help"], basis);
  assert.equal(mixed.language, "other");
  assert.deepEqual(styleOf([], { own_messages: 0, days: 90, scope: "account" }), {
    basis: { own_messages: 0, days: 90, scope: "account" },
    language: "other",
    diacritics: "none",
    address: "unknown",
    length_chars: { p50: 0, p90: 0 },
    emoji_rate: 0,
    starts_capital: 0,
    ends_punct: 0,
  });
  const clitics = styleOf(["s-a terminat", "mi-a zis", "i-am dat", "l-am vazut"], basis);
  assert.equal(clitics.language, "ro");
  assert.deepEqual(styleOf(["Aveți timp?", "Puteți mâine?"], basis).address, "unknown", "two is the least, but plural verbs count only one-to-one");
  assert.deepEqual(styleOf(["Aveți timp?", "Puteți mâine?"], basis, { oneToOne: true }).address, "dumneavoastra");
});

// ---------------------------------------------------------------- recentExchange

test("the recent exchange: the last messages both ways, oldest first, cut short, voice notes as their words", async () => {
  const { db, clock } = openTemp();
  const at = (s) => T0 + s * 1000;
  db.messages.upsert(textMessage(PEER, "E1", at(1), "prea vechi"));
  db.messages.upsert(textMessage(PEER, "E2", at(2), "ajung la 6", { fromMe: true }));
  db.messages.upsert(textMessage(PEER, "E3", at(3), "[image] uite locul", { type: "image" }));
  db.messages.upsert(textMessage(PEER, "E4", at(4), "[voice message · 0:12]", { type: "voice", transcript: "vin și eu, dar întârzii puțin" }));
  db.messages.upsert(textMessage(PEER, "E5", at(5), "[voice message · 0:03]", { type: "voice" }));
  db.messages.upsert(textMessage(PEER, "E6", at(6), "[system message]", { type: "system" }));
  db.messages.upsert(textMessage(PEER, "E7", at(7), "x".repeat(250), { fromMe: true }));
  db.messages.upsert(textMessage(PEER, "E8", at(8), "șters"));
  db.messages.delete(sid(false, PEER, "E8"));
  db.messages.upsert(textMessage(PEER_LID, "E9", at(9), "de pe lid"));
  const fold = db.learnLidPhone(PEER_LID, PEER);
  const recent = db.messages.recentExchange(PEER, { limit: 5 });
  assert.deepEqual(
    recent.map((item) => [item.type, item.fromMe, item.text.length > 40 ? `${item.text.slice(0, 3)}…(${[...item.text].length})` : item.text, item.transcribed, item.truncated]),
    [
      ["image", false, "[image] uite locul", false, false],
      ["voice", false, "vin și eu, dar întârzii puțin", true, false],
      ["voice", false, "[voice message · 0:03]", false, false],
      ["text", true, "xxx…(200)", false, true],
      ["text", false, "de pe lid", false, false],
    ]
  );
  assert.ok(recent.at(-1).text.endsWith("lid"));
  assert.equal(recent[3].text.at(-1), "…");
  assert.equal(recent[0].senderJid, PEER);
  await fold;
  assert.deepEqual(db.messages.recentExchange(PEER, { limit: 8 }).map((item) => item.sid.split("_").at(-1)), ["E1", "E2", "E3", "E4", "E5", "E7", "E9"]);
  assert.deepEqual(db.messages.recentExchange("40799999999@s.whatsapp.net"), []);
  assert.equal(db.messages.recentExchange(PEER).length, 7, "8 by default");
  clock.now += 1;
});
