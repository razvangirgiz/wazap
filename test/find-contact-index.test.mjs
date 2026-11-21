import { test } from "node:test";
import assert from "node:assert/strict";

import { openTemp } from "./db-fixtures.mjs";

test("token candidates preserve the exhaustive matcher for names, details and fuzzy fallbacks", (t) => {
  const { db } = openTemp();
  t.after(() => db.close());
  const names = ["Ana Maria", "Mariana Pop", "Mama lui Andrei", "Cristian Matei", "Mihai Ionescu", "Ștefan Luca", "Andreea Ana", "Ioana Popescu", "John Smith"];
  names.forEach((name, i) => {
    const jid = `4070000010${i}@s.whatsapp.net`;
    db.identity.upsertContact({ jid, name, listed: true });
    db.identity.updateFields(jid, { set: { nickname: i % 2 ? "Mișu" : "Puiu", relatie: i % 3 ? "dentist" : "mama", caz: `AP-${i}23` } });
  });
  const indexed = db.contacts.matchPeople.bind(db.contacts);
  const exhaustive = (people, ...args) => indexed([...people], ...args);
  const queries = ["Ana", "ana maria", "aria", "a m", "mamei", "Andrei", "Andreei", "Cristi", "Mișu", "dentista", "AP-123", "Stefa", "Mihail", "Jhon", "Zzyzx", "zz"];
  for (const name of queries) {
    const actual = db.contacts.find({ name });
    db.contacts.matchPeople = exhaustive;
    try {
      assert.deepEqual(actual, db.contacts.find({ name }), name);
    } finally {
      db.contacts.matchPeople = indexed;
    }
  }
  db.identity.upsertContact({ jid: "40700000100@s.whatsapp.net", name: "Nobody" });
  const actual = db.contacts.find({ name: "Ana" });
  db.contacts.matchPeople = exhaustive;
  assert.deepEqual(actual, db.contacts.find({ name: "Ana" }));
});
