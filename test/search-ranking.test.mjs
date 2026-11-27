/**
 * Search ranking and #no-catchup filtering:
 * - direct chats tagged #no-catchup (bots, assistants) stay out of broad search
 *   without spending lexical candidate slots, unless chat_id/from/tag or the
 *   query itself names them;
 * - Romanian inflections ("Elenei" -> "Elena") and chat/sender display names
 *   strengthen lexical matches when at least one content word matched the
 *   message text;
 * - broad queries naming a known contact also run a name-stripped semantic
 *   boost inside that contact's chats so messages that do not repeat their
 *   name still surface.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools } from "./helpers.mjs";
import { openTemp, sid, textMessage, wordsOf, T0 } from "./db-fixtures.mjs";

const ME = "40700000001@s.whatsapp.net";
const ELENA = "40700000010@s.whatsapp.net";
const ELENA_NEW = "40700000011@s.whatsapp.net";
const BOT = "40700000050@s.whatsapp.net";
const OTHER = "40700000099@s.whatsapp.net";
const MODEL = "embeddinggemma-300m";
const DIMS = 768;

function dirVec(axis, blend = null, weight = 0) {
  const v = new Array(DIMS).fill(0);
  v[axis] = 1;
  if (blend !== null) v[blend] = weight;
  return v;
}

/** Deterministic stub embedder that distinguishes Elena-named vs name-stripped queries. */
async function startCustomEmbedder(vectorFor) {
  let hits = 0;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/embedding") {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const texts = Array.isArray(body.content) ? body.content : Array.isArray(body.input) ? body.input : [body.content ?? ""];
      hits += texts.length;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(texts.map((text, index) => ({ index, embedding: [vectorFor(text)] }))));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function setupService(t, vectorFor) {
  const stub = vectorFor ? await startCustomEmbedder(vectorFor) : null;
  const keys = ["WAZAP_RECALL", "WAZAP_EMBED_URL", "WAZAP_EMBED_MODEL", "WAZAP_RECALL_MIN_SIMILARITY"];
  const saved = keys.map((key) => [key, process.env[key]]);
  for (const key of keys) delete process.env[key];
  Object.assign(
    process.env,
    stub
      ? { WAZAP_RECALL: "local", WAZAP_EMBED_MODEL: MODEL, WAZAP_RECALL_MIN_SIMILARITY: "0.55", WAZAP_EMBED_URL: stub.url }
      : { WAZAP_RECALL: "off" }
  );
  let f;
  try {
    f = connectedService(WhatsAppService, {
      prefix: "wazap-rank-",
      id: ME,
      name: "Owner",
      config: { persistHistory: true },
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  t.after(async () => {
    await f.svc.stop();
    await stub?.close();
  });
  await f.svc.bootStorage();
  let seq = 0;
  const arrive = (chat, body, tsOffset = 0) => {
    const id = `R${++seq}`;
    f.sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: chat, fromMe: false, id },
          messageTimestamp: Math.floor(Date.now() / 1000) - 3600 + seq * 5 + tsOffset,
          message: { conversation: body },
        },
      ],
    });
    return `false_${chat}_${id}`;
  };
  return { ...f, stub, arrive, ...schemaCheckedTools(f.svc, { allowWrite: false }) };
}

test("db hybrid: Romanian inflections and chat display name keep a real message from being dropped as weak", () => {
  const { db } = openTemp();
  try {
    db.identity.upsertContact({ jid: ELENA, name: "Elena" });
    db.identity.upsertContact({ jid: OTHER, name: "Ion" });
    db.messages.upsert(textMessage(ELENA, "BISC", T0, "5 cutii de biscuiți din ăștia pt domnul director"));
    db.messages.upsert(textMessage(OTHER, "NOISE", T0 + 1000, "A venit un director la poartă"));
    db.messages.upsert(textMessage(ELENA, "STOP", T0 + 2000, "pentru cine este asta"));

    // Give BISC and NOISE low similarity (< 0.55) so only non-weak lexical matches survive.
    db.vectors.put(sid(false, ELENA, "BISC"), MODEL, dirVec(1), wordsOf(db, sid(false, ELENA, "BISC")));
    db.vectors.put(sid(false, OTHER, "NOISE"), MODEL, dirVec(2), wordsOf(db, sid(false, OTHER, "NOISE")));
    db.vectors.put(sid(false, ELENA, "STOP"), MODEL, dirVec(3), wordsOf(db, sid(false, ELENA, "STOP")));

    const res = db.vectors.hybrid({
      query: "Vezi ce trebuia sa ii iau Elenei pt director din oras",
      model: MODEL,
      vector: dirVec(0),
      limit: 10,
      minSimilarity: 0.55,
    });
    assert.deepEqual(
      res.hits.map((h) => h.message.keyId),
      ["BISC"],
      "director (text) + Elenei->Elena (chat name) satisfies 2 content words; Ion's 1-word hit and stopword-only hit are dropped"
    );

    // Romanian inflected word inside message text also matches base form.
    db.messages.upsert(textMessage(OTHER, "CTR", T0 + 3000, "Am semnat un contract nou ieri"));
    const inflected = db.vectors.hybrid({ query: "contractul", model: MODEL, limit: 5, minSimilarity: 0.55 });
    assert.deepEqual(inflected.hits.map((h) => h.message.keyId), ["CTR"]);

    // English -le words must not falsely stem ("handle" must not match "hand").
    db.messages.upsert(textMessage(OTHER, "HAND", T0 + 4000, "Give me a hand with this box"));
    const english = db.vectors.hybrid({ query: "handle", model: MODEL, limit: 5, minSimilarity: 0.55 });
    assert.deepEqual(english.hits, []);
  } finally {
    db.close();
  }
});

test("broad search omits #no-catchup bot chats without losing slots, while explicit chat_id, tag or bot name finds them", async (t) => {
  const f = await setupService(t, () => dirVec(5));
  f.svc.db.identity.upsertContact({ jid: ELENA, name: "Elena" });
  f.svc.db.identity.upsertContact({ jid: BOT, name: "AssistBot" });
  f.svc.db.identity.updateFields(BOT, { addTags: ["no-catchup"] });

  const realId = f.arrive(ELENA, "5 cutii de biscuiți din ăștia pt domnul director", -2000);
  // 110 recent bot brief messages mentioning Elena & director: would otherwise eat all 100 lexical slots.
  for (let i = 0; i < 110; i++) {
    f.arrive(BOT, `Brief #${i}: N-am găsit nicăieri ce trebuia pentru Elena și director`, i);
  }
  await f.svc.recallIdle();

  // Broad hybrid search skips AssistBot, finds Elena's real message, and names AssistBot in the #no-catchup note.
  const broad = await f.call("search", { query: "Elena director", limit: 10 });
  assert.equal(broad.isError, undefined);
  assert.deepEqual(broad.structuredContent.messages.map((m) => m.message_id), [realId]);
  assert.equal(broad.structuredContent.scan_capped, false, "bot spam must not trigger false lexical cap");
  assert.ok(broad.structuredContent.no_catchup_omitted > 0);
  assert.match(broad.content[0].text, /#no-catchup \(AssistBot\)/);

  // Broad words search also skips AssistBot, counts no_catchup_omitted, and names AssistBot.
  const words = await f.call("search", { query: "director", match: "words", limit: 10 });
  assert.deepEqual(words.structuredContent.messages.map((m) => m.message_id), [realId]);
  assert.ok(words.structuredContent.no_catchup_omitted > 0);
  assert.match(words.content[0].text, /#no-catchup \(AssistBot\)/);

  // Explicit chat_id searches the #no-catchup chat.
  const scoped = await f.call("search", { query: "director", chat_id: BOT, limit: 5 });
  assert.equal(scoped.structuredContent.count, 5);
  assert.equal(scoped.structuredContent.no_catchup_omitted, undefined);

  // Naming the bot in the query itself exempts it from exclusion.
  const named = await f.call("search", { query: "ce a zis AssistBot despre director", limit: 5 });
  assert.ok(named.structuredContent.messages.some((m) => m.chat_id === BOT));
  assert.equal(named.structuredContent.no_catchup_omitted, undefined);
});

test("person-scoped semantic boost finds messages inside a named contact's chat that do not repeat their name", async (t) => {
  // Query WITH "Elenei" lands near axis 1 (noise); stripped query WITHOUT "Elenei" lands on axis 0 (birou message).
  const f = await setupService(t, (text) => {
    if (text.includes("avize")) return dirVec(0);
    if (text.includes("Elenei")) return dirVec(1);
    if (text.includes("director")) return dirVec(0, 2, 0.2); // cosine ~0.98 with avize, 0 with Elenei query
    return dirVec(3);
  });
  f.svc.db.identity.upsertContact({ jid: ELENA, name: "Elena" });
  f.svc.db.identity.upsertContact({ jid: OTHER, name: "Dan" });

  const officeId = f.arrive(ELENA, "Astea trebuie neaparat sa le aduc la biroul de avize");
  f.arrive(OTHER, "Am vorbit cu Elena despre vreme");
  await f.svc.recallIdle();

  const res = await f.call("search", { query: "Vezi ce trebuia sa ii iau Elenei pt director din oras", limit: 5 });
  assert.equal(res.isError, undefined);
  assert.ok(
    res.structuredContent.messages.some((m) => m.message_id === officeId),
    `expected office message inside Elena's chat to surface via person-scoped boost; got ${JSON.stringify(res.structuredContent.messages.map((m) => m.text))}`
  );
});

test("capped high-frequency filler words do not outrank a genuinely rare topic noun", () => {
  const { db } = openTemp();
  try {
    db.identity.upsertContact({ jid: ELENA, name: "Elena" });
    db.identity.upsertContact({ jid: OTHER, name: "Ion" });
    // Flood 120 messages with two common framing words ("vezi", "trebuia") so both overflow want=100.
    for (let i = 0; i < 120; i++) {
      db.messages.upsert(textMessage(OTHER, `FILL${i}`, T0 + i * 1000, `Vezi ca nu trebuia sa faci asta ${i}`));
    }
    db.messages.upsert(textMessage(ELENA, "FILL_EL", T0 + 130_000, "Nu trebuia sa faci asa o sa vezi"));
    // One rare message containing "director" inside Elena's chat (older than the filler).
    db.messages.upsert(textMessage(ELENA, "RARE", T0 + 5_000, "5 cutii de biscuiti pt domnul director"));

    const res = db.vectors.hybrid({
      query: "Vezi ce trebuia sa ii iau Elenei pt director",
      model: MODEL,
      limit: 5,
      minSimilarity: 0.55,
      lexicalCandidates: 100,
    });
    assert.equal(res.hits[0]?.message.keyId, "RARE", "rare 'director' + Elena must beat two capped common words");
  } finally {
    db.close();
  }
});

test("search accepts a list of chat_ids to search multi-number contacts in one call", async (t) => {
  const f = await setupService(t, () => dirVec(0));
  f.svc.db.identity.upsertContact({ jid: ELENA, name: "Elena" });
  f.svc.db.identity.upsertContact({ jid: ELENA_NEW, name: "Elena" });
  f.svc.db.identity.upsertContact({ jid: OTHER, name: "Dan" });

  const oldId = f.arrive(ELENA, "5 cutii de biscuiti pentru director");
  const newId = f.arrive(ELENA_NEW, "jucariile pentru director de la birou");
  f.arrive(OTHER, "alt director complet nerelevant");
  await f.svc.recallIdle();

  const hybrid = await f.call("search", { query: "director", chat_id: [ELENA, ELENA_NEW], limit: 10 });
  assert.equal(hybrid.isError, undefined);
  assert.deepEqual(new Set(hybrid.structuredContent.messages.map((m) => m.message_id)), new Set([oldId, newId]));

  const words = await f.call("search", { query: "director", match: "words", chat_id: [ELENA, ELENA_NEW], limit: 10 });
  assert.equal(words.isError, undefined);
  assert.deepEqual(new Set(words.structuredContent.messages.map((m) => m.message_id)), new Set([oldId, newId]));
});
