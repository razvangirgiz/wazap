/**
 * Embeddings in the account database: quantized exactly the way recall's
 * index does it (so its vectors import without re-embedding), tied to their
 * message so every deletion takes them along, and searched both on their own
 * and fused with the trigram index — where a hit found only by meaning must
 * clear the floor, so a question with no answer comes back empty.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AccountDb, hybridTokens, int8Similarity, quantizeVector, unitVector } from "../dist/db/index.js";
import { RecallStore } from "../dist/recall/store.js";
import { EMBED_MODELS } from "../dist/recall/models.js";
import { GROUP, PEER, T0, openTemp, sid, tempDir, textMessage } from "./db-fixtures.mjs";

const MODEL = "embeddinggemma-300m";
const OTHER = "40700000003@s.whatsapp.net";
const DIMS = 8;

/** A unit-ish direction in 8 dimensions: `axis` weighted 1, `blend` weighted `w`. */
function direction(axis, blend = null, w = 0) {
  const v = new Array(DIMS).fill(0);
  v[axis] = 1;
  if (blend !== null) v[blend] = w;
  return v;
}

test("quantization and similarity match recall's index byte for byte", async () => {
  const spec = EMBED_MODELS[MODEL];
  const dir = tempDir();
  const store = await RecallStore.open(join(dir, "recall"), spec, 100);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const vectors = Array.from({ length: 5 }, () => Array.from({ length: spec.dims }, rnd));
  await store.add(
    vectors.map((_, i) => ({ sid: `false_${PEER}_V${i}`, jid: PEER, ts: T0 + i, sender: PEER, type: "text", text: `t${i}` })),
    vectors
  );
  await store.close();
  const bytes = readFileSync(join(dir, "recall", "vectors.bin"));
  const query = Array.from({ length: spec.dims }, rnd);
  const recallHits = new Map();
  const reopened = await RecallStore.open(join(dir, "recall"), spec, 100);
  for (const hit of reopened.query({ vector: query, limit: 10 }, T0)) recallHits.set(hit.record.sid, hit.similarity);
  await reopened.close();
  vectors.forEach((vector, i) => {
    const ours = quantizeVector(vector);
    const theirs = new Int8Array(bytes.buffer, bytes.byteOffset + i * spec.dims, spec.dims);
    assert.deepEqual([...ours], [...theirs], `row ${i}`);
    const expected = recallHits.get(`false_${PEER}_V${i}`);
    if (expected !== undefined) assert.ok(Math.abs(int8Similarity(unitVector(query), ours) - expected) < 1e-12);
  });
});

test("an embedding goes with its message: delete, clear, expiry, and edits or transcripts that change its words", async () => {
  const { db, clock } = openTemp();
  const put = (key) => db.vectors.put(sid(false, PEER, key), MODEL, direction(0));
  db.messages.upsert(textMessage(PEER, "DEL", T0, "șterge"));
  db.messages.upsert(textMessage(PEER, "EDIT", T0 + 1000, "prima formă"));
  db.messages.upsert({ ...textMessage(PEER, "VOICE", T0 + 2000, "[voice]"), type: "audio" });
  db.messages.upsert(textMessage(PEER, "EXP", T0 + 3000, "efemer", { expiresAt: clock.now + 5000 }));
  db.messages.upsert(textMessage(OTHER, "CLR", T0 + 4000, "golit"));
  db.messages.upsert(textMessage(OTHER, "KEEP", T0 + 5000, "rămâne"));
  for (const key of ["DEL", "EDIT", "VOICE", "EXP"]) assert.equal(put(key), true);
  for (const key of ["CLR", "KEEP"]) assert.equal(db.vectors.put(sid(false, OTHER, key), MODEL, direction(1)), true);
  assert.equal(db.vectors.count(MODEL), 6);

  db.messages.delete(sid(false, PEER, "DEL"));
  assert.equal(db.vectors.get(sid(false, PEER, "DEL")), null);
  db.messages.upsert(textMessage(PEER, "EDIT", T0 + 1000, "a doua formă", { editedAt: T0 + 9000 }));
  assert.equal(db.vectors.get(sid(false, PEER, "EDIT")), null, "a vector of words the message no longer says is dropped");
  db.messages.upsert(textMessage(PEER, "EDIT", T0 + 1000, "a doua formă", { editedAt: T0 + 9000 }));
  db.messages.setTranscript(sid(false, PEER, "VOICE"), "cumpără lapte");
  assert.equal(db.vectors.get(sid(false, PEER, "VOICE")), null);
  await db.messages.clearChat(OTHER, T0 + 4000);
  assert.equal(db.vectors.get(sid(false, OTHER, "KEEP")).model, MODEL);
  clock.now += 5000;
  await db.messages.expireDue();
  assert.equal(db.vectors.count(), 1);
  assert.deepEqual(
    db.vectors.backlog({ model: MODEL, limit: 10 }).items.map((item) => item.sid),
    [sid(false, PEER, "VOICE"), sid(false, PEER, "EDIT")]
  );
  db.close();
});

test("the backlog lists visible messages with words and no vector from that model, newest first, resumably", () => {
  const { db, clock } = openTemp();
  for (let i = 0; i < 12; i++) db.messages.upsert(textMessage(PEER, `B${i}`, T0 + i * 1000, `mesaj ${i}`));
  db.messages.upsert({ ...textMessage(PEER, "IMG", T0 + 20_000, null), type: "image", text: null });
  db.messages.upsert(textMessage(PEER, "GONE", T0 + 21_000, "expirat", { expiresAt: clock.now - 1 }));
  db.messages.delete(sid(false, PEER, "B11"));
  for (const i of [10, 9, 8, 7]) db.vectors.put(sid(false, PEER, `B${i}`), MODEL, direction(i % DIMS));
  db.vectors.put(sid(false, PEER, "B6"), "e5-base-multilingual", direction(2));

  const first = db.vectors.backlog({ model: MODEL, limit: 3, scanCap: 100 });
  assert.deepEqual(first.items.map((item) => item.sid.split("_").pop()), ["B6", "B5", "B4"]);
  assert.equal(first.hasMore, true);
  const capped = db.vectors.backlog({ model: MODEL, limit: 3, before: first.nextBefore, scanCap: 2 });
  assert.deepEqual(capped.items.map((item) => item.sid.split("_").pop()), ["B3", "B2"]);
  assert.equal(capped.hasMore, true);
  const rest = db.vectors.backlog({ model: MODEL, limit: 10, before: capped.nextBefore });
  assert.deepEqual(rest.items.map((item) => item.sid.split("_").pop()), ["B1", "B0"]);
  assert.equal(rest.hasMore, false);
  db.close();
});

test("vector search ranks by cosine under the filters and the floor, and skips expired rows", () => {
  const { db, clock } = openTemp();
  const docs = [
    ["NEAR", PEER, T0, direction(0, 1, 0.1)],
    ["MID", PEER, T0 + 1000, direction(0, 1, 1)],
    ["FAR", OTHER, T0 + 2000, direction(1)],
    ["GRP", GROUP, T0 + 3000, direction(0, 2, 0.05)],
    ["EXP", PEER, T0 + 4000, direction(0)],
  ];
  for (const [key, chat, ts, vector] of docs) {
    const extra = chat === GROUP ? { senderJid: OTHER } : key === "EXP" ? { expiresAt: clock.now + 10 } : {};
    db.messages.upsert(textMessage(chat, key, ts, `doc ${key}`, extra));
    assert.equal(db.vectors.put(sid(false, chat, key), MODEL, vector), true);
  }
  clock.now += 10;
  const keys = (hits) => hits.map((hit) => hit.message.keyId);
  const all = db.vectors.vectorSearch({ model: MODEL, vector: direction(0), limit: 10 });
  assert.deepEqual(keys(all), ["GRP", "NEAR", "MID"]);
  assert.ok(all[0].similarity > 0.99 && all[2].similarity < 0.72 && all[2].similarity > 0.7);
  assert.deepEqual(keys(db.vectors.vectorSearch({ model: MODEL, vector: direction(0), limit: 10, minSimilarity: 0.9 })), ["GRP", "NEAR"]);
  assert.deepEqual(keys(db.vectors.vectorSearch({ model: MODEL, vector: direction(0), limit: 10, chat: PEER })), ["NEAR", "MID"]);
  assert.deepEqual(keys(db.vectors.vectorSearch({ model: MODEL, vector: direction(0), limit: 10, from: OTHER })), ["GRP"]);
  assert.deepEqual(keys(db.vectors.vectorSearch({ model: MODEL, vector: direction(0), limit: 10, since: T0 + 1, until: T0 + 3000 })), ["GRP", "MID"]);
  assert.deepEqual(keys(db.vectors.vectorSearch({ model: MODEL, vector: direction(0), limit: 1 })), ["GRP"]);
  assert.deepEqual(keys(db.vectors.vectorSearch({ model: "e5-base-multilingual", vector: direction(0), limit: 10 })), []);
  db.close();
});

test("an int8 vector imported as-is is searched like one quantized here", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "IMP", T0, "importat"));
  const quantized = quantizeVector(direction(3, 4, 0.5));
  assert.equal(db.vectors.put(sid(false, PEER, "IMP"), MODEL, quantized), true);
  assert.deepEqual([...db.vectors.get(sid(false, PEER, "IMP")).vector], [...quantized]);
  const [hit] = db.vectors.vectorSearch({ model: MODEL, vector: direction(3, 4, 0.5), limit: 1 });
  assert.ok(Math.abs(hit.similarity - 1) < 0.01);
  db.close();
});

test("hybrid search: both ways outranks either, meaning-only hits need the floor, an unanswerable question returns nothing", () => {
  const { db } = openTemp();
  const docs = [
    // Found by the word and by meaning.
    ["BOTH", T0, "Am trimis factura pe august", direction(0, 1, 0.2)],
    // Found only by meaning: a paraphrase that shares no word with the query.
    ["PARA", T0 + 1000, "Ți-am dat documentul de plată pentru luna trecută", direction(0, 1, 0.6)],
    // Found only by meaning, weakly: under a strict floor it is noise.
    ["WEAK", T0 + 2000, "Mergem la munte sâmbătă", direction(0, 5, 2.5)],
    // Found only by the word.
    ["WORD", T0 + 3000, "Factura de gaz a venit", direction(6)],
    ["NONE", T0 + 4000, "Ce mai faci?", direction(7)],
  ];
  for (const [key, ts, text, vector] of docs) {
    db.messages.upsert(textMessage(PEER, key, ts, text));
    db.vectors.put(sid(false, PEER, key), MODEL, vector);
  }
  const keys = (result) => result.hits.map((hit) => hit.message.keyId);

  const result = db.vectors.hybrid({ query: "Unde e factura?", vector: direction(0), model: MODEL, limit: 10, minSimilarity: 0.35 });
  assert.equal(result.semantic, true);
  // RRF with k = 60: BOTH 1/62 + 1/61, WORD 1/61 (lexical 1st), PARA 1/62 (semantic 2nd), WEAK 1/63.
  assert.deepEqual(keys(result), ["BOTH", "WORD", "PARA", "WEAK"]);
  const both = result.hits[0];
  assert.deepEqual([both.lexicalRank !== null, both.semanticRank !== null], [true, true]);
  assert.ok(result.hits.every((hit) => hit.lexicalRank !== null || hit.similarity >= 0.35));

  const strict = db.vectors.hybrid({ query: "Unde e factura?", vector: direction(0), model: MODEL, limit: 10, minSimilarity: 0.8 });
  assert.deepEqual(keys(strict), ["BOTH", "WORD", "PARA"], "a weak meaning-only hit is noise under the floor; a lexical one needs none");

  const nothing = db.vectors.hybrid({ query: "Când pleacă trenul spre Viena?", vector: direction(3), model: MODEL, limit: 10, minSimilarity: 0.35 });
  assert.deepEqual(nothing.hits, []);

  const lexicalOnly = db.vectors.hybrid({ query: "factura", model: MODEL, limit: 10, minSimilarity: 0.35 });
  assert.equal(lexicalOnly.semantic, false);
  assert.deepEqual(keys(lexicalOnly), ["WORD", "BOTH"]);
  assert.deepEqual(keys(db.vectors.hybrid({ query: "factura", vector: direction(0), model: MODEL, limit: 10, minSimilarity: 0.35, chat: OTHER })), []);
  db.close();
});

test("hybrid lexical ranking prefers candidates carrying more of the query words", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "ONE", T0 + 2000, "contractul e gata"));
  db.messages.upsert(textMessage(PEER, "TWO", T0, "contractul de închiriere e semnat"));
  db.messages.upsert(textMessage(PEER, "ZERO", T0 + 3000, "nimic"));
  const result = db.vectors.hybrid({ query: "contractul de închiriere", model: MODEL, limit: 5, minSimilarity: 0.35 });
  assert.deepEqual(result.hits.map((hit) => hit.message.keyId), ["TWO", "ONE"]);
  assert.deepEqual(hybridTokens("Unde e ședința de mâine?"), ["unde", "sedinta", "maine"]);
  assert.deepEqual(hybridTokens("ce zi e"), []);
  assert.deepEqual(hybridTokens("ora 17"), ["ora"]);
  db.close();
});

test("vectors survive reopen and a read-only connection can search them", () => {
  const { db, path } = openTemp();
  db.messages.upsert(textMessage(PEER, "P", T0, "persistent"));
  db.vectors.put(sid(false, PEER, "P"), MODEL, direction(2));
  db.close();
  const reader = AccountDb.open(path, { readOnly: true });
  assert.deepEqual(reader.vectors.vectorSearch({ model: MODEL, vector: direction(2), limit: 1 }).map((hit) => hit.message.keyId), ["P"]);
  assert.equal(reader.vectors.hybrid({ query: "persistent", vector: direction(2), model: MODEL, limit: 1, minSimilarity: 0.35 }).hits.length, 1);
  reader.close();
});
