/**
 * Who a name means (db.contacts.find, for find_contact): the Romanian case
 * endings and diminutives it reads through, relationship words that match only
 * what the user filed, and the scoring and verdict — one clear candidate,
 * several to choose from, or none with the nearest ones.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DIMINUTIVES,
  FIND_SCORES,
  StorageError,
  diminutivesOf,
  inflectionForms,
  nameWords,
  relationNameMatch,
  relationOf,
} from "../dist/db/index.js";
import { ME, T0, openTemp } from "./db-fixtures.mjs";

const DAY = 86_400_000;
const phone = (n) => `4072${String(n).padStart(7, "0")}@s.whatsapp.net`;
const group = (n) => `1203630000000${String(n).padStart(5, "0")}@g.us`;

/** An account at T0 + 400 days, so "200 days ago" is still a positive time. */
function account(options = {}) {
  const opened = openTemp(options);
  opened.clock.now = T0 + 400 * DAY;
  opened.db.bindOwner(ME);
  let key = 0;
  const now = opened.clock.now;
  const person = (n, name, extra = {}) => opened.db.identity.upsertContact({ jid: phone(n), name, listed: true, ...extra });
  /** Messages with a person `daysAgo`: theirs, and `own` of the user's. */
  const talk = (n, daysAgo, { theirs = 1, own = 0, text = "hei" } = {}) => {
    for (let i = 0; i < theirs + own; i++) {
      opened.db.messages.upsert({ chatJid: phone(n), keyId: `K${++key}`, fromMe: i >= theirs, ts: now - daysAgo * DAY + i * 1000, type: "text", text });
    }
  };
  const inGroup = (g, n, daysAgo, { own = false } = {}) =>
    opened.db.messages.upsert({ chatJid: group(g), keyId: `G${++key}`, fromMe: own, senderJid: own ? null : phone(n), ts: now - daysAgo * DAY, type: "text", text: "salut" });
  return { ...opened, person, talk, inGroup, find: (input) => opened.db.contacts.find(input) };
}

const names = (result) => result.candidates.map((candidate) => candidate.displayName);

// ---------------------------------------------------------------- tables

test("Romanian case endings reduce to the base form, the longest ending winning where both would fit", () => {
  const reduced = (word) => inflectionForms(nameWords(word)[0]);
  assert.ok(reduced("Mamei").includes("mama"));
  assert.ok(reduced("Mariei").includes("maria"));
  assert.ok(reduced("Andreei").includes("andreea"));
  assert.ok(!reduced("Andreei").includes("andrea"), "-eei is Andreea, never Andrea");
  assert.ok(reduced("Anei").includes("ana"));
  assert.ok(reduced("Ioanei").includes("ioana"));
  assert.ok(reduced("tatălui").includes("tata"));
  assert.ok(reduced("fotbalului").includes("fotbal"));
  assert.ok(reduced("fotbalul").includes("fotbal"));
  assert.ok(reduced("fratele").includes("frate"));
  assert.equal(reduced("Mamei")[0], "mamei", "the word itself first");
  assert.deepEqual(reduced("Ana"), ["ana"], "too short to carry an ending");
  assert.deepEqual(nameWords("  Ştefan-Ţurcanu  ȘTEFAN "), ["stefan", "turcanu", "stefan"], "cedilla and comma forms fold alike");
});

test("the diminutives table is a curated RO/EN list, and a short form is only ever one step from its name", () => {
  assert.ok(Object.keys(DIMINUTIVES).length >= 60, `${Object.keys(DIMINUTIVES).length} names`);
  const has = (word, ...expected) => {
    const related = diminutivesOf(word);
    for (const name of expected) assert.ok(related.has(name), `${word} → ${name}`);
  };
  has("alex", "alexandru", "alexandra", "alexander");
  has("cristi", "cristian", "cristina");
  has("gabi", "gabriel", "gabriela");
  has("dani", "daniel", "daniela");
  has("misu", "mihai");
  has("nelu", "ion", "ioan", "cornel");
  has("ionut", "ion");
  has("mihai", "misu", "mihaita");
  has("bill", "william");
  assert.ok(!diminutivesOf("sandu").has("alex"), "Sandu is Alexandru, not Alex");
  assert.ok(!diminutivesOf("alex").has("alex"));
  for (const [full, shorts] of Object.entries(DIMINUTIVES)) {
    assert.deepEqual(nameWords(full), [full], `${full} is folded`);
    for (const short of shorts) assert.deepEqual(nameWords(short), [short], `${short} is folded`);
  }
});

test("relationship words, through their case endings, and the names a user files for a relative", () => {
  assert.equal(relationOf("mamei"), "mother");
  assert.equal(relationOf("mami"), "mother");
  assert.equal(relationOf("mom"), "mother");
  assert.equal(relationOf("tatalui"), "father");
  assert.equal(relationOf("sotiei"), "wife");
  assert.equal(relationOf("sotului"), "husband");
  assert.equal(relationOf("fratelui"), "brother");
  assert.equal(relationOf("bunicii"), "grandmother");
  assert.equal(relationOf("ana"), null);
  assert.equal(relationOf("mamaia"), "grandmother", "not the mother");

  assert.equal(relationNameMatch("mother", "Mama"), "exact");
  assert.equal(relationNameMatch("mother", "Mami ❤️"), "exact");
  assert.equal(relationNameMatch("mother", "Mama mea"), "exact");
  assert.equal(relationNameMatch("mother", "Mama mobil"), "exact");
  assert.equal(relationNameMatch("mother", "Maria (mama)"), "word");
  assert.equal(relationNameMatch("mother", "La Mama"), null, "a restaurant");
  assert.equal(relationNameMatch("grandmother", "Cazare Mamaia"), null, "a place to stay");
  assert.equal(relationNameMatch("godfather", "Pizza Nasu"), null);
  assert.equal(relationNameMatch("sister", "Andreea Sora"), "word", "a first name, then the word: a sister, or a surname");
  assert.equal(relationNameMatch("mother", "Mama Anei"), null, "Ana's mother");
  assert.equal(relationNameMatch("mother", "Mama lui Andrei"), null, "Andrei's mother");
  assert.equal(relationNameMatch("mother", "Mamaia Resort"), null);
  assert.equal(relationNameMatch("mother", "Tata"), null);
});

// ---------------------------------------------------------------- find

test("Ana, with one of seven written to this week, resolves to her", () => {
  const { find, person, talk } = account();
  const surnames = ["Popescu", "Ionescu", "Marin", "Dobre", "Stan", "Radu", "Munteanu"];
  surnames.forEach((surname, i) => person(i + 1, `Ana ${surname}`));
  surnames.forEach((_, i) => talk(i + 1, 200 + i));
  talk(4, 2, { theirs: 2, own: 3 });
  person(20, "Mariana Pop");

  const result = find({ name: "Ana" });
  assert.equal(result.verdict, "resolved", JSON.stringify(result.candidates.map((c) => [c.displayName, c.score])));
  const [ana] = result.candidates;
  assert.equal(ana.displayName, "Ana Dobre");
  assert.equal(ana.match.class, "word");
  assert.equal(ana.match.source, "name");
  assert.equal(ana.ownMessages90d, 3);
  assert.deepEqual(ana.relationship, { recency: 25, frequency: 3, saved: 5 });
  assert.equal(ana.score, 80 + 25 + 3 + 5);
  assert.equal(ana.lastExchange.fromMe, true);
  assert.equal(ana.phoneLast4, "0004");
  assert.equal(ana.kind, "person");
  assert.ok(ana.chatId > 0);
  assert.deepEqual(result.query, { words: ["ana"], relationship: null, qualifier: [] });
});

test("Andrei, many and none of them recent, is ambiguous with at most five candidates that tell them apart", () => {
  const { db, find, person, talk, inGroup } = account();
  for (let i = 1; i <= 9; i++) {
    person(i, `Andrei ${["Pop", "Ene", "Voicu", "Toma", "Lazar", "Barbu", "Neagu", "Stoica", "Ilie"][i - 1]}`);
    talk(i, 120 + i * 10);
  }
  db.identity.upsertChat({ jid: group(1), name: "Fotbal marți" });
  inGroup(1, 3, 150);
  const result = find({ name: "andrei" });
  assert.equal(result.verdict, "ambiguous");
  assert.equal(result.candidates.length, 5);
  for (const candidate of result.candidates) {
    assert.equal(candidate.match.class, "word");
    assert.ok(candidate.lastExchange !== null);
    assert.ok(candidate.groupsInCommon !== null);
  }
  assert.deepEqual(result.candidates.map((c) => c.score), [85, 85, 85, 85, 85]);
  assert.equal(names(result)[0], "Andrei Pop", "ties go to the most recent exchange");
  const voicu = find({ name: "Andrei", limit: 20 }).candidates.find((c) => c.displayName === "Andrei Voicu");
  assert.deepEqual(voicu.groupsInCommon, { count: 1, names: ["Fotbal marți"] });
  assert.equal(find({ name: "Andrei", limit: 2 }).candidates.length, 2);
});

test("mama matches only what the user filed — a saved name, a tag, a detail — never a group, a business or someone else's mother", () => {
  const { db, find, person, talk } = account({ leftGroup: () => false });
  person(1, "Mama Anei");
  person(2, "Mama lui Andrei");
  person(3, "Mamaia Resort", { verifiedName: "Mamaia Resort", isBusiness: true });
  db.identity.upsertContact({ jid: phone(4), pushName: "Mama" });
  db.identity.upsertChat({ jid: group(1), name: "Mama Anei" });
  for (const n of [1, 2, 3, 4]) talk(n, 1, { own: 5 });

  for (const asked of ["mama", "mamei", "Mama mea"]) {
    const result = find({ name: asked });
    assert.equal(result.verdict, "not_found", asked);
    assert.deepEqual(result.closest, [], "who she is is a question for the user");
    assert.equal(result.query.relationship, "mother");
  }

  person(5, "Mami ❤️");
  talk(5, 40);
  let result = find({ name: "mamei" });
  assert.equal(result.verdict, "resolved");
  assert.equal(result.candidates[0].displayName, "Mami ❤️");
  assert.equal(result.candidates[0].match.class, "exact");
  assert.equal(result.candidates[0].match.inflected, true);
  assert.equal(result.candidates[0].score, 100 - 5 + 8 + 5, "exact, through a case ending; written to 40 days ago; saved");

  // A tag or a relatie detail on someone saved under her own name says the same.
  const { find: find2, person: person2, db: db2 } = account();
  person2(1, "Elena Pop");
  db2.identity.updateFields(phone(1), { set: { relatie: "mama" } });
  result = find2({ name: "mama" });
  assert.equal(result.verdict, "resolved");
  assert.deepEqual([result.candidates[0].match.source, result.candidates[0].match.score], ["relatie", 110]);
  person2(2, "Maria Pop");
  db2.identity.updateFields(phone(2), { addTags: ["mama"] });
  result = find2({ name: "mama" });
  assert.equal(result.verdict, "ambiguous", "two people filed as mother is for the user to settle");
  assert.deepEqual(result.candidates.map((c) => c.match.source).sort(), ["relatie", "tag"]);
});

test("a qualifier lifts the Ana it describes and lowers the ones it does not", () => {
  const { db, find, person, talk, inGroup } = account();
  person(1, "Ana Popescu");
  person(2, "Ana Ionescu");
  person(3, "Ana Marin");
  for (const n of [1, 2, 3]) talk(n, 60);
  assert.equal(find({ name: "Ana" }).verdict, "ambiguous");
  db.identity.updateFields(phone(2), { addTags: ["contabilitate"] });

  const result = find({ name: "Ana", qualifier: "de la contabilitate" });
  assert.deepEqual(result.query.qualifier, ["contabilitate"]);
  assert.equal(result.verdict, "resolved");
  assert.equal(result.candidates[0].displayName, "Ana Ionescu");
  assert.deepEqual(result.candidates[0].qualifier, { hits: [{ source: "tag", value: "contabilitate" }], score: 30 });
  assert.equal(result.candidates[0].score, 80 + 30 + 8 + 5);

  // Without the tag: the business name and a group she wrote in count less, and a detail as much as a tag.
  person(4, "Ana Dobre", { verifiedName: "Contabilitate Dobre SRL", isBusiness: true });
  talk(4, 60);
  db.identity.updateFields(phone(2), { removeTags: ["contabilitate"], set: { departament: "contabilitatea" } });
  db.identity.upsertChat({ jid: group(7), name: "Contabilitate firmă" });
  inGroup(7, 3, 10);
  const all = find({ name: "Ana", qualifier: "contabilitate", limit: 5 });
  const byName = Object.fromEntries(all.candidates.map((c) => [c.displayName, c.qualifier]));
  assert.equal(all.verdict, "ambiguous");
  assert.deepEqual(byName["Ana Ionescu"], { hits: [{ source: "field", value: "departament: contabilitatea" }], score: 30 });
  assert.deepEqual(byName["Contabilitate Dobre SRL"] ?? byName["Ana Dobre"], { hits: [{ source: "business_name", value: "Contabilitate Dobre SRL" }], score: 20 });
  assert.deepEqual(byName["Ana Marin"], { hits: [{ source: "group_name", value: "Contabilitate firmă" }], score: 20 });
  assert.deepEqual(byName["Ana Popescu"], { hits: [], score: -15 });
});

test("diacritics never matter: Ștefan, Stefan and Ştefan are one name", () => {
  const { find, person, talk } = account();
  person(1, "Ștefan Popa");
  person(2, "Stefan Ionescu");
  person(3, "Ştefan Vlad");
  talk(2, 3, { own: 1 });
  for (const asked of ["Stefan", "Ștefan", "ŞTEFAN", "stefan ionescu"]) {
    const result = find({ name: asked, limit: 5 });
    assert.equal(result.candidates[0].displayName, "Stefan Ionescu", asked);
  }
  assert.equal(find({ name: "Stefan" }).verdict, "resolved");
  assert.equal(find({ name: "Ștefan Popa" }).candidates[0].match.class, "exact");
  assert.equal(find({ name: "popa stefan" }).candidates[0].match.class, "exact", "word order is free");
});

test("diminutives rank under the name itself, and a nickname the user filed over any name", () => {
  const { db, find, person, talk } = account();
  person(1, "Cristian Pop");
  person(2, "Cristina Ionescu");
  let result = find({ name: "Cristi" });
  assert.equal(result.verdict, "ambiguous");
  assert.deepEqual(result.candidates.map((c) => c.match.class), ["diminutive", "diminutive"]);
  person(3, "Cristi Vlad");
  result = find({ name: "Cristi" });
  assert.deepEqual(result.candidates.map((c) => [c.displayName, c.match.class]), [
    ["Cristi Vlad", "word"],
    ["Cristian Pop", "diminutive"],
    ["Cristina Ionescu", "diminutive"],
  ]);
  assert.equal(find({ name: "Cristian Pop" }).verdict, "resolved", "the whole name, exact");

  person(4, "Gheorghe Ionescu");
  db.identity.updateFields(phone(4), { set: { nickname: "Puiu" } });
  person(5, "Puiu Marin");
  talk(5, 1, { own: 25 });
  result = find({ name: "puiu", limit: 5 });
  assert.equal(result.candidates[0].displayName, "Gheorghe Ionescu", "the nickname the user filed ranks first, whoever they talk to more");
  assert.equal(result.candidates[0].match.score, 110);
  assert.equal(result.verdict, "ambiguous", "a name talked to daily is still offered next to it");
});

test("groups match by name, a case ending reads through, and a group the account left is not a candidate", () => {
  const { db, find, person, inGroup } = account({ leftGroup: (proto) => proto[0] === 1 });
  db.identity.upsertChat({ jid: group(1), name: "Fotbal marți", proto: new Uint8Array([0]) });
  db.identity.upsertChat({ jid: group(2), name: "Fotbal vechi", proto: new Uint8Array([1]) });
  db.identity.upsertChat({ jid: group(3), name: "Părinți clasa a 5-a" });
  person(9, "Fotbalistul");
  inGroup(1, 9, 2, { own: true });

  let result = find({ name: "fotbalul", kind: "group" });
  assert.equal(result.verdict, "ambiguous", "a case ending the tables do not vouch for is offered, never resolved");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].match.resolvable, false);
  assert.equal(result.candidates[0].displayName, "Fotbal marți");
  assert.equal(result.candidates[0].kind, "group");
  assert.equal(result.candidates[0].match.inflected, true);
  assert.equal(result.candidates[0].ownMessages90d, 1);
  assert.equal(result.candidates[0].groupsInCommon, null);
  assert.equal(find({ name: "fotbal vechi", kind: "group" }).verdict, "not_found", "left");
  assert.equal(find({ name: "fotbal", kind: "person" }).candidates.every((c) => c.kind === "person"), true);
  result = find({ name: "parinti" });
  assert.equal(result.candidates[0].displayName, "Părinți clasa a 5-a");
  assert.equal(result.candidates[0].match.class, "word");
});

test("not found carries the nearest weak matches: a word inside a name, then a near spelling", () => {
  const { find, person } = account();
  person(1, "Mariana Pop");
  person(2, "Andreea Stan");
  let result = find({ name: "Ana" });
  assert.equal(result.verdict, "not_found");
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.closest.map((c) => [c.displayName, c.match.class]), [["Mariana Pop", "substring"]]);
  result = find({ name: "Andreaa" });
  assert.equal(result.verdict, "not_found");
  assert.deepEqual(result.closest.map((c) => [c.displayName, c.match.class]), [["Andreea Stan", "fuzzy"]]);
  assert.deepEqual(find({ name: "Xyzzy" }).closest, []);
});

test("a prefix finds a name, the account itself is never a candidate, and a name someone gave themselves ranks under a saved one", () => {
  const { db, find, person, talk } = account();
  db.identity.upsertContact({ jid: ME, name: "Andrei (eu)", listed: true });
  person(1, "Alexandru");
  db.identity.upsertContact({ jid: phone(2), pushName: "Alexandru" });
  let result = find({ name: "Alexandru", limit: 5 });
  assert.equal(result.verdict, "ambiguous");
  assert.deepEqual(result.candidates.map((c) => [c.match.source, c.match.score, c.score]), [
    ["name", 100, 105],
    ["push_name", 95, 95],
  ]);
  talk(2, 1, { own: 25 });
  result = find({ name: "Alexandru", limit: 5 });
  assert.equal(result.candidates[0].match.source, "name", "the saved name ranks first, however much the user talks to the other");
  assert.equal(result.verdict, "ambiguous");
  assert.equal(find({ name: "Andrei" }).verdict, "not_found");
  result = find({ name: "Alexan" });
  assert.deepEqual(result.candidates.map((c) => c.match.class), ["prefix", "prefix"]);
  assert.equal(FIND_SCORES.match.prefix, 60);
});

test("find refuses what it cannot read", () => {
  const { find } = account();
  for (const input of [{ name: "" }, { name: "  !!  " }, {}, { name: "Ana", kind: "robot" }]) {
    assert.throws(() => find(input), (err) => err instanceof StorageError && err.code === "INVALID_INPUT", JSON.stringify(input));
  }
});

test("a person renamed, tagged or merged between two finds is read as they are now", async () => {
  const { db, find, person } = account();
  person(1, "Ana Popescu");
  assert.equal(find({ name: "Ana" }).verdict, "resolved");
  person(1, "Maria Popescu");
  assert.equal(find({ name: "Ana" }).verdict, "not_found");
  assert.equal(find({ name: "Maria" }).candidates[0].displayName, "Maria Popescu");
  db.identity.updateFields(phone(1), { set: { nickname: "Mimi" } });
  assert.equal(find({ name: "Mimi" }).candidates[0].match.source, "nickname");

  const lid = "777000000000001@lid";
  db.identity.upsertContact({ jid: lid, pushName: "Mimi" });
  assert.equal(find({ name: "Mimi", limit: 5 }).candidates.length, 2);
  await db.learnLidPhone(lid, phone(1));
  const merged = find({ name: "Mimi", limit: 5 });
  assert.equal(merged.candidates.length, 1, "one person once the lid and the number are paired");
  assert.equal(merged.candidates[0].jid, phone(1));
});

// ---------------------------------------------------------------- the review's wrong resolutions

test("a relationship word never resolves a business, a place or a surname, and matches only the details that say a relationship", () => {
  let a = account();
  a.person(1, "La Mama");
  a.talk(1, 3, { own: 2 });
  a.person(2, "Maria Popescu");
  a.talk(2, 2, { own: 10 });
  assert.equal(a.find({ name: "mama" }).verdict, "not_found", "the restaurant is no one's mother");

  a = account();
  a.person(1, "Cazare Mamaia");
  a.talk(1, 20, { own: 1 });
  assert.equal(a.find({ name: "bunica" }).verdict, "not_found");
  assert.equal(a.find({ name: "mamaia" }).verdict, "not_found");

  a = account();
  a.person(1, "Andreea Sora");
  a.talk(1, 5, { own: 3 });
  for (const asked of ["sora", "sora mea"]) {
    const result = a.find({ name: asked });
    assert.equal(result.verdict, "ambiguous", `${asked}: a sister or a surname, for the user to say`);
    assert.equal(result.candidates[0].match.resolvable, false);
    assert.ok(result.candidates[0].score < FIND_SCORES.resolvedScore);
  }

  a = account();
  a.person(1, "Pizza Nasu");
  a.talk(1, 5, { own: 1 });
  assert.equal(a.find({ name: "nasul" }).verdict, "not_found");

  a = account();
  a.person(1, "Ion Popa");
  a.db.identity.updateFields(phone(1), { set: { oras: "Mamaia" } });
  assert.equal(a.find({ name: "bunica" }).verdict, "not_found", "a town in a detail is not a relationship");
  a.db.identity.updateFields(phone(1), { set: { relatie: "bunica mea dinspre mama" } });
  assert.equal(a.find({ name: "bunica" }).verdict, "resolved", "the relationship detail says it");
  a.db.identity.updateFields(phone(1), { set: { relatie: "sora mamei" } });
  assert.equal(a.find({ name: "sora" }).verdict, "not_found", "the mother's sister is not the user's sister");
});

test("a first name is never read as a case ending of another, nor reached through -le or -ul", () => {
  let a = account();
  a.person(1, "Andra Ionescu");
  a.talk(1, 10, { own: 2 });
  assert.equal(a.find({ name: "Andrei" }).verdict, "not_found", "Andrei is not Andra");

  a = account();
  a.person(1, "Daniel Pop");
  a.talk(1, 10, { own: 2 });
  let result = a.find({ name: "Danielle" });
  assert.equal(result.verdict, "not_found");
  assert.deepEqual(result.closest.map((c) => [c.displayName, c.match.class]), [["Daniel Pop", "fuzzy"]], "offered as a near spelling only");
  a.person(2, "Nico");
  a.talk(2, 3, { own: 1 });
  assert.equal(a.find({ name: "Nicole" }).verdict, "not_found");
  a.person(3, "Gabriel Stan");
  assert.equal(a.find({ name: "Gabrielle" }).verdict, "not_found");
  a.person(4, "Matei Radu");
  a.person(5, "Mata Hari");
  result = a.find({ name: "Matei", limit: 5 });
  assert.equal(result.verdict, "resolved");
  assert.deepEqual(result.candidates.map((c) => c.displayName), ["Matei Radu"]);
  assert.deepEqual(inflectionForms("paul"), ["paul"]);
  assert.deepEqual(inflectionForms("andrei"), ["andrei"]);
  assert.ok(inflectionForms("mariei").includes("maria"), "a case ending of a name still reads");
});

test("the start of a word never resolves, and a name that matches as a whole outranks one talked to more", () => {
  const cases = [
    ["Ion", "Maria Ionescu"],
    ["Radu", "Elena Radulescu"],
    ["Dan", "Dana Pop"],
  ];
  for (const [asked, only] of cases) {
    const a = account();
    a.person(1, only);
    a.talk(1, 2, { own: 1 });
    const result = a.find({ name: asked });
    assert.equal(result.verdict, "ambiguous", `${asked} → ${only}`);
    assert.deepEqual([result.candidates[0].match.class, result.candidates[0].match.resolvable], ["prefix", false]);
    assert.ok(result.candidates[0].score <= FIND_SCORES.unresolvableCap);
  }
  const a = account();
  a.person(1, "Radu Stan");
  a.talk(1, 60, { own: 0 });
  a.person(2, "Elena Radulescu");
  a.talk(2, 1, { own: 25 });
  const result = a.find({ name: "Radu" });
  assert.equal(result.verdict, "resolved");
  assert.equal(result.candidates[0].displayName, "Radu Stan");
});

test("someone's relative is not them: Mama lui Andrei and Mama Anei do not answer for Andrei or Ana", () => {
  const a = account();
  a.person(1, "Mama Anei");
  a.person(2, "Mamaia Resort");
  a.person(3, "Mama lui Andrei");
  a.person(4, "Andrei Pop");
  a.person(5, "Ana Pop");
  for (const n of [1, 2, 3, 4, 5]) a.talk(n, 2, { own: 3 });
  const verdict = (asked) => {
    const result = a.find({ name: asked });
    return [result.verdict, result.candidates[0]?.displayName ?? null];
  };
  assert.deepEqual(verdict("mama"), ["not_found", null]);
  assert.deepEqual(verdict("Ana"), ["resolved", "Ana Pop"]);
  assert.deepEqual(verdict("Anei"), ["resolved", "Ana Pop"]);
  assert.deepEqual(verdict("Andrei"), ["resolved", "Andrei Pop"]);
  assert.deepEqual(verdict("lui Andrei"), ["resolved", "Andrei Pop"]);
  assert.deepEqual(verdict("mama lui Andrei"), ["resolved", "Mama lui Andrei"]);
  assert.deepEqual(verdict("mama Anei"), ["resolved", "Mama Anei"]);
  const andrei = a.find({ name: "Andrei", limit: 5 });
  assert.equal(andrei.candidates.length, 1, "resolved shows the one");
});

test("a qualifier is never read from what messages say, and a group named after relatives is not a relationship", () => {
  let a = account();
  a.person(1, "Ana Pop");
  a.talk(1, 1, { own: 3, text: "sunt la contabilitate" });
  a.person(2, "Ana Ionescu");
  a.talk(2, 1, { own: 3 });
  const result = a.find({ name: "Ana", qualifier: "contabilitate" });
  assert.equal(result.verdict, "ambiguous");
  assert.deepEqual(result.candidates.map((c) => c.qualifier), [{ hits: [], score: -15 }, { hits: [], score: -15 }]);

  a = account({ leftGroup: () => false });
  a.db.identity.upsertChat({ jid: group(1), name: "Mama & Tata" });
  a.inGroup(1, 1, 1, { own: true });
  assert.equal(a.find({ name: "mama" }).verdict, "not_found");
  assert.equal(a.find({ name: "tata", kind: "group" }).verdict, "not_found");
});

test("groups in common and a group a qualifier names count only messages a reader may see", async () => {
  const { db, find, person, talk, inGroup } = account();
  db.identity.upsertChat({ jid: group(1), name: "Contabilitate firmă" });
  db.identity.upsertChat({ jid: group(2), name: "Fotbal marți" });
  person(1, "Ana Pop");
  person(2, "Ana Ionescu");
  for (const n of [1, 2]) talk(n, 30);
  const deleted = inGroup(1, 1, 5);
  inGroup(2, 1, 5);
  db.messages.delete(deleted.sid);
  inGroup(1, 2, 5);
  const cleared = db.messages.clearChat(group(1), T0 + 400 * DAY);

  const all = find({ name: "Ana", qualifier: "contabilitate", limit: 5 });
  const byName = Object.fromEntries(all.candidates.map((c) => [c.displayName, c]));
  assert.deepEqual(byName["Ana Pop"].qualifier, { hits: [], score: -15 }, "her message there was deleted");
  assert.deepEqual(byName["Ana Ionescu"].qualifier, { hits: [], score: -15 }, "the group was cleared, its rows not purged yet");
  assert.deepEqual(byName["Ana Pop"].groupsInCommon, { count: 1, names: ["Fotbal marți"] });
  assert.deepEqual(byName["Ana Ionescu"].groupsInCommon, { count: 0, names: [] });
  await cleared;
});
