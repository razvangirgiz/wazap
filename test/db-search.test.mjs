/**
 * Substring search the way search_messages promises it — case-insensitive,
 * now also diacritic-insensitive — newest first, filtered, paged without
 * loss, blind to deleted and replaced words, and honest when a bounded scan
 * stopped before it could prove absence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { foldText } from "../dist/db/index.js";
import { GROUP, PEER, PEER_LID, T0, openTemp, sid, textMessage } from "./db-fixtures.mjs";

const OTHER = "40700000003@s.whatsapp.net";

test("substrings match across case and diacritics, in text and in transcripts", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "F", T0, "Trimit factură mâine"));
  db.messages.upsert(textMessage(PEER, "S", T0 + 1000, "Ședința e la 17:30"));
  db.messages.upsert({ ...textMessage(PEER, "V", T0 + 2000, "[voice message]"), type: "audio", transcript: "Șoferul întârzie la depozit" });
  db.messages.upsert(textMessage(PEER, "N", T0 + 3000, "nimic relevant"));
  const find = (query) => db.search.text({ query, limit: 10 }).items.map((m) => m.keyId);
  assert.deepEqual(find("ctur"), ["F"]);
  assert.deepEqual(find("SEDINT"), ["S"]);
  assert.deepEqual(find("ședință"), ["S"]);
  assert.deepEqual(find("intarzie"), ["V"]);
  assert.deepEqual(find("17:30"), ["S"]);
  assert.deepEqual(find("mâine"), ["F"]);
  assert.equal(db.search.text({ query: "ctur", limit: 10 }).mode, "trigram");
  assert.equal(foldText("Ședință ȚARĂ"), "sedinta tara");
  db.close();
});

test("hits come newest first and page with a cursor, losing and repeating nothing", () => {
  const { db } = openTemp();
  const expected = [];
  for (let i = 0; i < 40; i++) {
    const match = i % 3 !== 1;
    db.messages.upsert(textMessage(i % 2 ? PEER : OTHER, `M${i}`, T0 + (i % 4 === 0 ? i - 1 : i) * 1000, match ? `plată ${i}` : `altceva ${i}`));
    if (match) expected.push(`M${i}`);
  }
  const seen = [];
  let before;
  for (;;) {
    const page = db.search.text({ query: "plata", limit: 7, ...(before === undefined ? {} : { before }) });
    seen.push(...page.items.map((m) => m.keyId));
    assert.equal(page.scanCapped, false);
    if (!page.hasMore) break;
    before = page.nextBefore;
  }
  const byTime = [...expected].sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  assert.deepEqual(seen, byTime);
  db.close();
});

test("filters: chat in any spelling, from me, from a sender in any spelling, since and until inclusive", async () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "A", T0, "comanda nouă"));
  db.messages.upsert(textMessage(PEER, "B", T0 + 1000, "comanda trimisă", { fromMe: true }));
  db.messages.upsert(textMessage(GROUP, "C", T0 + 2000, "comanda de grup", { senderJid: PEER }));
  db.messages.upsert(textMessage(GROUP, "D", T0 + 3000, "comanda altcuiva", { senderJid: OTHER }));
  await db.learnLidPhone(PEER_LID, PEER);
  const keys = (filter) => db.search.text({ query: "comanda", limit: 10, ...filter }).items.map((m) => m.keyId);
  assert.deepEqual(keys({}), ["D", "C", "B", "A"]);
  assert.deepEqual(keys({ chat: PEER_LID }), ["B", "A"]);
  assert.deepEqual(keys({ from: "me" }), ["B"]);
  assert.deepEqual(keys({ from: PEER_LID }), ["C", "A"]);
  assert.deepEqual(keys({ since: T0 + 1000, until: T0 + 2000 }), ["C", "B"]);
  assert.deepEqual(keys({ since: T0 + 1001 }), ["D", "C"]);
  assert.deepEqual(keys({ until: T0 + 999 }), ["A"]);
  assert.deepEqual(keys({ chat: "40799999999@s.whatsapp.net" }), []);
  assert.deepEqual(keys({ from: "40799999999@s.whatsapp.net" }), []);
  db.close();
});

test("deleted, edited-away and expired words leave the index, new words and transcripts join it", () => {
  const { db, clock } = openTemp();
  db.messages.upsert(textMessage(PEER, "DEL", T0, "parola wifi este secretă"));
  db.messages.upsert(textMessage(PEER, "EDIT", T0 + 1000, "întâlnire luni"));
  db.messages.upsert(textMessage(PEER, "EXP", T0 + 2000, "mesaj efemer", { expiresAt: clock.now + 1000 }));
  db.messages.upsert({ ...textMessage(PEER, "VOICE", T0 + 3000, "[voice]"), type: "audio" });
  const find = (query) => db.search.text({ query, limit: 10 }).items.map((m) => m.keyId);

  db.messages.delete(sid(false, PEER, "DEL"));
  assert.deepEqual(find("parola"), []);
  db.messages.upsert(textMessage(PEER, "EDIT", T0 + 1000, "întâlnire marți", { editedAt: T0 + 60_000 }));
  assert.deepEqual(find("luni"), []);
  assert.deepEqual(find("marti"), ["EDIT"]);
  db.messages.setTranscript(sid(false, PEER, "VOICE"), "adu pâine");
  assert.deepEqual(find("paine"), ["VOICE"]);
  clock.now += 1000;
  assert.deepEqual(find("efemer"), []);
  assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
  db.close();
});

test("a query under three characters scans recent messages and reports when the cap stopped it", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "OLD", T0, "Ședință"));
  for (let i = 1; i <= 100; i++) db.messages.upsert(textMessage(PEER, `N${i}`, T0 + i * 1000, `mesaj ${i}`));
  const capped = db.search.text({ query: "șe", limit: 5, scanCap: 50 });
  assert.equal(capped.mode, "scan");
  assert.deepEqual(capped.items, []);
  assert.equal(capped.scanCapped, true, "no hit within the cap is not proof of absence");
  assert.equal(capped.hasMore, true);
  const rest = db.search.text({ query: "șe", limit: 5, scanCap: 1000, before: capped.nextBefore });
  assert.deepEqual(rest.items.map((m) => m.keyId), ["OLD"]);
  assert.equal(rest.scanCapped, false);
  assert.equal(rest.hasMore, false);
  assert.deepEqual(db.search.text({ query: "SE", limit: 5 }).items.map((m) => m.keyId), ["OLD"]);
  db.close();
});

test("the trigram path reports its cap too, when filters reject most candidates", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(OTHER, "WANTED", T0, "raport lunar"));
  for (let i = 1; i <= 600; i++) db.messages.upsert(textMessage(PEER, `R${i}`, T0 + i * 1000, `raport ${i}`));
  const capped = db.search.text({ query: "raport", chat: OTHER, limit: 5, scanCap: 300 });
  assert.deepEqual([capped.items.length, capped.scanCapped, capped.hasMore], [0, true, true]);
  const found = db.search.text({ query: "raport", chat: OTHER, limit: 5, before: capped.nextBefore });
  assert.deepEqual(found.items.map((m) => m.keyId), ["WANTED"]);
  db.close();
});

test("quotes and operators in a query are literal", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "Q", T0, 'a spus "da" OR nu'));
  db.messages.upsert(textMessage(OTHER, "X", T0 + 1000, "altceva"));
  assert.deepEqual(db.search.text({ query: '"da" OR', limit: 5 }).items.map((m) => m.keyId), ["Q"]);
  assert.deepEqual(db.search.text({ query: "NEAR(", limit: 5 }).items, []);
  db.close();
});

test("finding 12a: an empty or whitespace-only query names nothing and returns nothing", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "Q", T0, "orice"));
  for (const query of ["", "   ", "\t\n"]) {
    const result = db.search.text({ query, chat: PEER, limit: 5 });
    assert.deepEqual([result.items, result.hasMore, result.scanCapped], [[], false, false], JSON.stringify(query));
  }
  db.close();
});

test("finding 12a: a short query folds exactly like the trigram index, in Greek and Cyrillic as in Romanian", () => {
  const { db } = openTemp();
  ["Αθήνα ταξίδι", "Привет Ёлка", "ȘEDINȚĂ"].forEach((text, i) => db.messages.upsert(textMessage(PEER, `K${i}`, T0 + i * 1000, text)));
  const find = (query) => db.search.text({ query, limit: 10 }).items.map((m) => m.keyId);
  // What the index does with three letters, the scan must do with two.
  assert.deepEqual([find("θήν"), find("θην")], [["K0"], []], "the index keeps the Greek tonos");
  assert.deepEqual([find("θή"), find("θη")], [["K0"], []]);
  assert.deepEqual([find("ёлк"), find("елк")], [["K1"], []], "the index keeps ё distinct from е");
  assert.deepEqual([find("Ёл"), find("ел")], [["K1"], []]);
  assert.deepEqual([find("sed"), find("șe"), find("SE")], [["K2"], ["K2"], ["K2"]]);
  db.close();
});

test("finding 12a: the JavaScript fold is the trigram index's fold for every code point up to U+1FFFF", async () => {
  const { foldTableFromSqlite } = await import("../dist/db/fold-probe.js");
  const { foldCodePoint } = await import("../dist/db/fold.js");
  const sqliteFolds = new Map(foldTableFromSqlite(0x20, 0x20000));
  const drift = [];
  for (let cp = 0x20; cp < 0x20000; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const expected = sqliteFolds.get(cp) ?? cp;
    if (foldCodePoint(cp) !== expected) drift.push(`U+${cp.toString(16)}`);
  }
  assert.deepEqual(drift.slice(0, 20), [], "rerun scripts/gen-fold-table.mjs: the bundled SQLite folds differently");
});
