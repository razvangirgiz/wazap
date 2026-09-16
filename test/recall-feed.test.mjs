/**
 * The embedding feed in isolation, over a real account database: it walks the
 * backlog in bounded batches, retries a sick backend and gives up on a dead
 * one, is never held by its own backoff when stopped, walks only what is new
 * once it has seen the history, and re-embeds a message whose words changed.
 * The embed call is a fake that never leaves the process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { EmbedFeed } from "../dist/recall/index.js";
import { PEER, T0, openTemp, sid, textMessage } from "./db-fixtures.mjs";

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
  feed.kick(true);
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
  feed.kick(true);
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
  feed.kick(true);
  await feed.idle();
  assert.equal(attempts, 5);
  assert.match(feed.dead, /indexing stopped after 5 failed embedding calls: model file is corrupt/);
  feed.kick();
  assert.equal(feed.busy, false, "a dead feed takes no more work");

  const again = feedOver(db, async () => {
    throw new Error("down");
  });
  again.kick(true);
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
  feed.kick(true);
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
  feed.touch(sid(false, PEER, "M3"));
  await feed.idle();
  assert.deepEqual(calls, [["mesajul 3, editat"]]);
  assert.ok(db.vectors.get(sid(false, PEER, "M3")));
  db.close();
});

test("a vector made from words the message no longer says is refused, and the next walk makes it again", async () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "M1", T0, "prima formă"));
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { embed } = fakeEmbed();
  const feed = feedOver(db, async (texts) => {
    await gate;
    return embed(texts);
  });
  feed.kick(true);
  await new Promise((resolve) => setImmediate(resolve));
  db.messages.upsert(textMessage(PEER, "M1", T0, "a doua formă", { editedAt: T0 + 5_000 }));
  release();
  await feed.idle();
  assert.equal(db.vectors.get(sid(false, PEER, "M1")), null, "the in-flight vector described the old words");
  feed.kick(true);
  await feed.idle();
  assert.ok(db.vectors.get(sid(false, PEER, "M1")));
  db.close();
});
