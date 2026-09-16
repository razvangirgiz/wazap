/**
 * The embedding feed in isolation, over a real account database: it walks the
 * queue in bounded batches, retries a sick backend and gives up on a dead
 * one, is never held by its own backoff when stopped, walks only what is new
 * once it has seen the history — wherever in time it lands — and re-embeds a
 * message whose words changed; a text the server refuses is skipped alone and
 * for good, and a walk over a large history yields to the event loop.
 * The embed call is a fake that never leaves the process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AccountDb } from "../dist/db/index.js";
import { WazapError } from "../dist/errors.js";
import { EmbedFeed } from "../dist/recall/index.js";
import { PEER, T0, openTemp, sid, textMessage, wordsOf } from "./db-fixtures.mjs";

const MODEL = "embeddinggemma-300m";
const DIMS = 8;

/** One direction per text; the calls it received are kept. */
function fakeEmbed(calls = []) {
  const embed = async (texts) => {
    calls.push([...texts]);
    return texts.map((text) => {
      const vector = new Array(DIMS).fill(0);
      vector[text.length % DIMS] = 1;
      vector[(text.length + 1) % DIMS] = 0.5;
      return vector;
    });
  };
  return { calls, embed };
}

function feedOver(db, embed, words = (message) => message.text) {
  return new EmbedFeed({ db: () => (db.isOpen ? db : null), model: MODEL, words, embed });
}

test("the backlog is embedded in batches of at most 32 texts and 8,192 characters, placeholders left out", async () => {
  const { db } = openTemp();
  for (let i = 0; i < 70; i++) db.messages.upsert(textMessage(PEER, `M${i}`, T0 + i * 1000, `mesajul ${i}`));
  db.messages.upsert(textMessage(PEER, "LONG1", T0 + 100_000, "a".repeat(5_000)));
  db.messages.upsert(textMessage(PEER, "LONG2", T0 + 101_000, "b".repeat(5_000)));
  db.messages.upsert(textMessage(PEER, "STICKER", T0 + 102_000, "[sticker]"));
  const { calls, embed } = fakeEmbed();
  const feed = feedOver(db, embed, (message) => (message.text.startsWith("[") ? null : message.text));
  feed.kick();
  await feed.idle();
  assert.equal(db.vectors.count(MODEL), 72);
  assert.equal(db.vectors.get(sid(false, PEER, "STICKER")), null, "a placeholder is nothing to embed");
  for (const batch of calls) {
    assert.ok(batch.length <= 32, `batch of ${batch.length}`);
    assert.ok(batch.length === 1 || batch.join("").length <= 8_192, "a batch stays inside the character bound");
  }
  db.close();
});

test("a failing backend is retried, and the batch lands once it answers", async () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "M1", T0, "factura"));
  const { calls, embed } = fakeEmbed();
  let failures = 2;
  const feed = feedOver(db, async (texts) => {
    if (failures-- > 0) throw new Error("llama-server restarting");
    return embed(texts);
  });
  feed.kick();
  await feed.idle();
  assert.equal(feed.dead, null);
  assert.equal(calls.length, 1);
  assert.ok(db.vectors.get(sid(false, PEER, "M1")));
  db.close();
});

test("five failures in a row stop the feed and say why, without holding a stop", async () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "M1", T0, "factura"));
  let attempts = 0;
  const feed = feedOver(db, async () => {
    attempts++;
    throw new Error("model file is corrupt");
  });
  feed.kick();
  await feed.idle();
  assert.equal(attempts, 5);
  assert.match(feed.dead, /indexing stopped after 5 failed embedding calls: model file is corrupt/);
  feed.kick();
  assert.equal(feed.busy, false, "a dead feed takes no more work");

  const again = feedOver(db, async () => {
    throw new Error("down");
  });
  again.kick();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const started = Date.now();
  await again.stop();
  assert.ok(Date.now() - started < 1_000, "the backoff sleep does not hold the stop");
  db.close();
});

test("once the history is walked, a new message costs a walk of what is new, and an edit below it is embedded again", async () => {
  const { db } = openTemp();
  for (let i = 0; i < 50; i++) db.messages.upsert(textMessage(PEER, `M${i}`, T0 + i * 1000, `mesajul ${i}`));
  const { calls, embed } = fakeEmbed();
  let examined = 0;
  const feed = feedOver(db, embed, (message) => {
    examined++;
    return message.text;
  });
  feed.kick();
  await feed.idle();
  assert.equal(db.vectors.count(MODEL), 50);

  examined = 0;
  calls.length = 0;
  db.messages.upsert(textMessage(PEER, "NEW", T0 + 60_000, "mesaj nou"));
  feed.kick();
  await feed.idle();
  assert.deepEqual(calls, [["mesaj nou"]]);
  assert.equal(examined, 1, "the history below the last walk is not looked at again");

  calls.length = 0;
  db.messages.upsert(textMessage(PEER, "M3", T0 + 3000, "mesajul 3, editat", { editedAt: T0 + 70_000 }));
  assert.equal(db.vectors.get(sid(false, PEER, "M3")), null, "the edit dropped the stale vector");
  feed.kick();
  await feed.idle();
  assert.deepEqual(calls, [["mesajul 3, editat"]]);
  assert.ok(db.vectors.get(sid(false, PEER, "M3")));
  db.close();
});

test("a vector made from words the message no longer says is refused, and the next walk makes it again", async () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "M1", T0, "prima formă"));
  let release;
  let entered;
  const gate = new Promise((resolve) => (release = resolve));
  const reached = new Promise((resolve) => (entered = resolve));
  const { embed } = fakeEmbed();
  const feed = feedOver(db, async (texts) => {
    entered();
    await gate;
    return embed(texts);
  });
  feed.kick();
  await reached;
  db.messages.upsert(textMessage(PEER, "M1", T0, "a doua formă", { editedAt: T0 + 5_000 }));
  release();
  await feed.idle();
  assert.equal(db.vectors.get(sid(false, PEER, "M1")), null, "the in-flight vector described the old words");
  feed.kick();
  await feed.idle();
  assert.ok(db.vectors.get(sid(false, PEER, "M1")));
  db.close();
});

test("a text the embedding server refuses is skipped alone, the rest lands, and a restart does not send it again", async () => {
  const { db, path, clock } = openTemp();
  const bodies = { M1: "factura pe august", M2: "POISON de nedigerat", M3: "chiria e plătită", M4: "avansul vine vineri" };
  Object.entries(bodies).forEach(([key, body], i) => db.messages.upsert(textMessage(PEER, key, T0 + i * 1000, body)));
  const refusing = (calls) => {
    const { embed } = fakeEmbed();
    return async (texts) => {
      calls.push([...texts]);
      if (texts.some((text) => text.includes("POISON"))) throw new WazapError("RECALL_BAD_INPUT", "Embedding server returned HTTP 400.");
      return embed(texts);
    };
  };
  const calls = [];
  const feed = feedOver(db, refusing(calls));
  feed.kick();
  await feed.idle();
  assert.equal(feed.dead, null, "one bad text does not stop the feed");
  for (const key of ["M1", "M3", "M4"]) assert.ok(db.vectors.get(sid(false, PEER, key)), `${key} is embedded`);
  assert.equal(db.vectors.get(sid(false, PEER, "M2")), null);
  db.close();

  const reopened = AccountDb.open(path, { now: () => clock.now, checkpointDelayMs: 0 });
  const later = [];
  const again = feedOver(reopened, refusing(later));
  again.kick();
  await again.idle();
  assert.equal(later.flat().some((text) => text.includes("POISON")), false, "the refused text is not sent again after a restart");
  assert.equal(again.dead, null);

  // New words are a new chance.
  reopened.messages.upsert(textMessage(PEER, "M2", T0 + 1000, "acum se poate citi", { editedAt: T0 + 90_000 }));
  again.kick();
  await again.idle();
  assert.ok(reopened.vectors.get(sid(false, PEER, "M2")));
  reopened.close();
});

test("a message stored below what a finished walk covered — later history, an older page — is embedded without a restart", async () => {
  const { db } = openTemp();
  for (let i = 0; i < 50; i++) db.messages.upsert(textMessage(PEER, `M${i}`, T0 + i * 1000, `mesajul ${i}`));
  const { embed } = fakeEmbed();
  const feed = feedOver(db, embed);
  feed.kick();
  await feed.idle();
  assert.equal(db.vectors.count(MODEL), 50);

  db.messages.upsert(textMessage(PEER, "OLD", T0 - 86_400_000, "factura din iulie"));
  feed.kick();
  await feed.idle();
  assert.ok(db.vectors.get(sid(false, PEER, "OLD")), "the older message got its vector");
  assert.equal(feed.pending, 0);
});

test("a first walk over a history whose vectors all came with the import yields to the event loop between pages", async () => {
  const { db } = openTemp();
  const COUNT = 12_000;
  for (let batch = 0; batch < COUNT / 2000; batch++) {
    db.messages.upsertMany(Array.from({ length: 2000 }, (_, i) => textMessage(PEER, `M${batch}_${i}`, T0 + (batch * 2000 + i) * 1000, `mesajul ${batch} ${i}`)));
  }
  db.transaction(() => {
    for (let batch = 0; batch < COUNT / 2000; batch++) {
      for (let i = 0; i < 2000; i++) {
        const key = sid(false, PEER, `M${batch}_${i}`);
        db.vectors.put(key, MODEL, [1, (i % 7) + 1, 0, 0, 0, 0, 0, 1], wordsOf(db, key));
      }
    }
  });
  const { calls, embed } = fakeEmbed();
  const feed = feedOver(db, embed);
  let busyMeanwhile = null;
  feed.kick();
  setImmediate(() => (busyMeanwhile = feed.busy));
  await feed.idle();
  assert.equal(busyMeanwhile, true, "a timer or a message gets a turn while the history is walked");
  assert.equal(calls.length, 0, "nothing needed embedding");
  db.close();
});
