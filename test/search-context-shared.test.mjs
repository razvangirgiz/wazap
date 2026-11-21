import { test } from "node:test";
import assert from "node:assert/strict";

import { contextRows, laterOf, laterRows } from "../dist/service/search-context.js";
import { openTemp, PEER, T0, textMessage } from "./db-fixtures.mjs";

test("shared later ranges preserve per-hit results, privacy, dates and hidden anchors", (t) => {
  const { db } = openTemp();
  t.after(() => db.close());
  db.messages.upsertMany(Array.from({ length: 240 }, (_, i) => textMessage(PEER, `L${i}`, T0 + i * 1000, `contract factura programare ${i}`)));
  const hits = db.messages.chatPage(PEER, { limit: 240 }).items.slice(-5).reverse();
  const compare = (opts = {}, people = null) => {
    const windows = new Map(hits.map((hit) => [hit.id, contextRows(db, hit, opts, people)]));
    const expected = new Map(hits.map((hit) => [hit.id, laterRows(db, hit, windows.get(hit.id), opts, people)]));
    assert.deepEqual(laterOf(db, hits, windows, opts, people), expected);
  };
  compare();
  const calls = t.mock.method(db.messages, "later");
  laterOf(db, hits, new Map(), {}, null);
  assert.equal(calls.mock.callCount(), 1, "five hits share the newest range");
  calls.mock.restore();
  for (const opts of [{ sinceMs: T0 + 50_000 }, { untilMs: T0 + 10_000 }, { sinceMs: T0 + 6_000, untilMs: T0 + 3_000 }]) compare(opts);
  compare({}, { message: (message) => message.id % 2 === 0 });
  db.messages.delete(hits[0].sid, { at: T0 + 300_000 });
  compare();
  db.messages.upsert(textMessage(PEER, "L239", T0 + 239_000, "expired", { expiresAt: T0 + 300_000 }));
  compare();
  db.messages.clearChat(PEER, T0 + 3_600_000);
  compare();
  assert.deepEqual(laterOf(db, [], new Map(), {}, null), new Map());
});

test("shared later ranges fall back when narrower bounds could hide candidates", (t) => {
  const { db } = openTemp();
  t.after(() => db.close());
  db.messages.upsertMany(Array.from({ length: 205 }, (_, i) => textMessage(PEER, `F${i}`, T0 + i * 1000, "contract factura")));
  const all = db.messages.chatPage(PEER, { limit: 205 }).items;
  const hits = [all.at(-1), all[1], all[2]];
  const expected = new Map(hits.map((hit) => [hit.id, laterRows(db, hit, [hit], {}, null)]));
  assert.deepEqual(laterOf(db, hits, new Map(), {}, null), expected);
});
