/**
 * The recall queue in isolation: batching, per-sid last-write-wins, tombstone
 * ordering, retry on a sick backend, and the file seals that move history
 * offsets only behind committed writes. Runs against a real RecallStore on a
 * throwaway dir; the embed call is a fake that never leaves the process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { WazapError } from "../dist/errors.js";
import { embedModelSpec } from "../dist/recall/models.js";
import { RecallQueue } from "../dist/recall/queue.js";
import { RecallStore } from "../dist/recall/store.js";

const DIMS = embedModelSpec("embeddinggemma-300m").dims;

/** One deterministic direction per text; duplicates collapse to the same vector. */
function fakeEmbed(calls) {
  return async (texts) => {
    calls.push(texts.length);
    return texts.map((text) => {
      const vector = new Array(DIMS).fill(0);
      let hash = 0;
      for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) % 997;
      vector[hash % DIMS] = 1;
      return vector;
    });
  };
}

function item(sid, text, over = {}) {
  return { sid, jid: "40700000002@s.whatsapp.net", ts: Date.now(), sender: "40700000002@s.whatsapp.net", type: "text", text, ...over };
}

async function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "wazap-recall-queue-"));
  return RecallStore.open(dir, embedModelSpec("embeddinggemma-300m"), 100);
}

test("a feed lands in the index in batches of one embedding call per 32 texts", async () => {
  const store = await openStore();
  const calls = [];
  const queue = new RecallQueue(store, fakeEmbed(calls));
  const ops = [];
  for (let i = 0; i < 70; i++) ops.push({ sid: `s${i}`, item: item(`s${i}`, `mesajul numărul ${i}`) });
  queue.feed(ops, { file: "chat.jsonl", bytes: 5000 });
  await queue.idle();
  assert.equal(store.count, 70);
  assert.deepEqual(calls, [32, 32, 6]);
  assert.equal(store.offsets()["chat.jsonl"], 5000);
  await store.close();
});

test("a batch also splits on its character budget, not only on count", async () => {
  const store = await openStore();
  const calls = [];
  const queue = new RecallQueue(store, fakeEmbed(calls));
  const big = "x".repeat(5000);
  queue.feed([
    { sid: "a", item: item("a", big) },
    { sid: "b", item: item("b", big) },
    { sid: "c", item: item("c", "mic") },
  ]);
  await queue.idle();
  // 5k + 5k does not fit one 8192-char call, but 5k + small does.
  assert.deepEqual(calls, [1, 2]);
  assert.equal(store.count, 3);
  await store.close();
});

test("a sid re-queued before its batch runs lands once, with the latest text", async () => {
  const store = await openStore();
  const calls = [];
  let release;
  const gate = new Promise((done) => (release = done));
  const queue = new RecallQueue(store, async (texts) => {
    await gate;
    return fakeEmbed(calls)(texts);
  });
  queue.enqueue({ sid: "s1", item: item("s1", "prima variantă") });
  queue.enqueue({ sid: "s1", item: item("s1", "a doua variantă") });
  release();
  await queue.idle();
  // The in-flight batch cannot be rewritten, so the newer op lands in a second
  // batch — what matters is that the last write wins.
  assert.equal(store.count, 1);
  assert.equal(store.record("s1").text, "a doua variantă");
  assert.equal(calls.length, 2);
  await store.close();
});

test("a tombstone queued behind its put wins, and the put never becomes findable", async () => {
  const store = await openStore();
  const queue = new RecallQueue(store, fakeEmbed([]));
  queue.enqueue({ sid: "s1", item: item("s1", "parola este castan") });
  queue.enqueue({ sid: "s1" });
  await queue.idle();
  assert.equal(store.count, 0);
  assert.equal(store.record("s1"), undefined);
  await store.close();
});

test("a failing embed call retries the batch instead of dropping it", async () => {
  const store = await openStore();
  let attempts = 0;
  const queue = new RecallQueue(store, async (texts) => {
    if (++attempts === 1) throw new Error("sidecar restarting");
    return texts.map(() => new Array(DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0)));
  });
  queue.enqueue({ sid: "s1", item: item("s1", "merge până la urmă") });
  await queue.idle();
  assert.equal(attempts, 2);
  assert.equal(store.count, 1);
  await store.close();
});

test("a permanently unembeddable message is dropped, not retried into queue death", async () => {
  const store = await openStore();
  const queue = new RecallQueue(store, async (texts) => {
    if (texts.some((t) => t.includes("prea-lung"))) {
      throw new WazapError("RECALL_BAD_INPUT", "embedding server answered 400: input too large");
    }
    return texts.map(() => [1, ...new Array(DIMS - 1).fill(0)]);
  });
  queue.enqueue({ sid: "good1", item: item("good1", "mesaj bun unu") });
  queue.enqueue({ sid: "bad", item: item("bad", "mesaj prea-lung") });
  queue.enqueue({ sid: "good2", item: item("good2", "mesaj bun doi") });
  await queue.idle();
  assert.equal(queue.dead, null);
  assert.equal(store.count, 2);
  assert.equal(store.record("bad"), undefined);
  assert.ok(store.record("good1") !== undefined);
  assert.ok(store.record("good2") !== undefined);
  await store.close();
});

test("a 4xx in one text isolates it without losing its batchmates", async () => {
  const store = await openStore();
  const calls = [];
  const queue = new RecallQueue(store, async (texts) => {
    calls.push(texts.length);
    if (texts.some((t) => t.includes("otravit"))) {
      throw new WazapError("RECALL_BAD_INPUT", "embedding server answered 400: input too large");
    }
    return texts.map(() => [1, ...new Array(DIMS - 1).fill(0)]);
  });
  const ops = [];
  for (let i = 0; i < 8; i++) ops.push({ sid: `s${i}`, item: item(`s${i}`, i === 5 ? "text otravit" : `text ok ${i}`) });
  queue.feed(ops);
  await queue.idle();
  // 8-put batch fails, bisects to 4+4, the half with the poison bisects again
  // — and the survivors all land.
  assert.equal(queue.dead, null);
  assert.equal(store.count, 7);
  assert.equal(store.record("s5"), undefined);
  await store.close();
});

test("a 4xx on a query does not masquerade as a backend failure", async () => {
  const store = await openStore();
  const queue = new RecallQueue(store, async (texts) => {
    if (texts[0] === "bad query") {
      throw new WazapError("RECALL_BAD_INPUT", "embedding server answered 400: input too large");
    }
    return texts.map(() => [1, ...new Array(DIMS - 1).fill(0)]);
  });
  queue.enqueue({ sid: "s1", item: item("s1", "mesaj normal") });
  await queue.idle();
  assert.equal(store.count, 1);
  // 4xx only ever surfaces for puts — a queue embed is never a query — but a
  // dropped put must not starve a seal behind it.
  queue.feed([{ sid: "s2", item: item("s2", "bad query") }], { file: "h.jsonl", bytes: 7 });
  await queue.idle();
  assert.equal(store.count, 1);
  assert.equal(store.offsets()["h.jsonl"], 7);
  await store.close();
});

test("an engine that stays down kills the queue but keeps the messages out of the index, not lost", async () => {
  const store = await openStore();
  const queue = new RecallQueue(
    store,
    async () => {
      throw new Error("llama-server is gone");
    },
    { baseMs: 1, maxMs: 5 }
  );
  queue.enqueue({ sid: "s1", item: item("s1", "nu ajunge") });
  await queue.idle();
  assert.ok(queue.dead !== null);
  assert.equal(store.count, 0);
  // A dead queue refuses new work rather than pretending to accept it.
  queue.enqueue({ sid: "s2", item: item("s2", "nici asta") });
  await queue.idle();
  assert.equal(store.count, 0);
  await store.close();
});

test("a seal waits for everything enqueued before it, not only its own feed", async () => {
  const store = await openStore();
  let release;
  const gate = new Promise((done) => (release = done));
  let first = true;
  const queue = new RecallQueue(store, async (texts) => {
    if (first) {
      first = false;
      await gate;
    }
    return texts.map(() => [1, ...new Array(DIMS - 1).fill(0)]);
  });
  queue.enqueue({ sid: "old", item: item("old", "mesaj vechi încă necomis") });
  // The file's ops arrive while the first embed is still parked.
  queue.feed([{ sid: "f1", item: item("f1", "din fișier") }], { file: "h.jsonl", bytes: 42 });
  await sleep(50);
  assert.equal(store.offsets()["h.jsonl"], undefined);
  release();
  await queue.idle();
  assert.equal(store.offsets()["h.jsonl"], 42);
  await store.close();
});

test("stop drops the backlog and lets an in-flight commit finish", async () => {
  const store = await openStore();
  const queue = new RecallQueue(store, fakeEmbed([]));
  for (let i = 0; i < 40; i++) queue.enqueue({ sid: `s${i}`, item: item(`s${i}`, `m${i}`) });
  await queue.stop();
  const committed = store.count;
  assert.ok(committed <= 40);
  await sleep(50);
  assert.equal(store.count, committed);
  await store.close();
});
