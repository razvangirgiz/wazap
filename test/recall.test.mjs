/**
 * Semantic recall where it meets WhatsApp: live ingest feeds the index, edits
 * and revokes rewrite it, boot reconcile picks up whatever was left unindexed,
 * and the feature stays off unless asked for. The embedding backend is a stub
 * /embedding server with a word-concept table — enough for a paraphrase to
 * share a concept and hit — so llama.cpp and its model stay out of CI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "baileys";

import { WhatsAppService } from "../dist/whatsapp.js";
import { registerTools } from "../dist/tools.js";
import { EMBED_MODELS, readRecallSettings } from "../dist/recall/index.js";
import { asToolSource, connectedService } from "./helpers.mjs";
import { accountPaths } from "../dist/config.js";

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const DIMS = 768;
const PROMPTS = EMBED_MODELS["embeddinggemma-300m"].prompts;

const RECALL_ENV = [
  "WAZAP_RECALL",
  "WAZAP_EMBED_MODEL",
  "WAZAP_EMBED_BIN",
  "WAZAP_EMBED_URL",
  "WAZAP_RECALL_MAX",
  "WAZAP_RECALL_MIN_SIMILARITY",
];

/**
 * Words that mean the same thing share one slot, so a query can hit a message
 * that never repeats its words. Diacritics are folded first: „factură" and
 * "factura" are one token, and a paraphrase through English still lands.
 */
const CONCEPTS = [
  ["factura", "invoice", "bill"],
  ["chiria", "rent", "renta"],
  ["platit", "paid", "payment", "plata"],
  ["doctor", "medic", "appointment", "programare"],
  ["masina", "car", "auto"],
  ["aeroport", "airport", "terminal"],
];

function conceptOf(word) {
  const folded = word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  for (const group of CONCEPTS) if (group.includes(folded)) return `c${CONCEPTS.indexOf(group)}`;
  return folded;
}

function vectorFor(text) {
  const vector = new Array(DIMS).fill(0);
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    if (word === "") continue;
    const concept = conceptOf(word);
    let hash = 0;
    for (const ch of concept) hash = (hash * 31 + ch.codePointAt(0)) % 9973;
    vector[hash % DIMS] += 1;
  }
  return vector;
}

/** A stand-in llama-server: POST /embedding → [{index, embedding: [[dims]]}]. */
function stubEmbedServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/embedding") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const texts = [JSON.parse(body).content].flat();
      seen.push(...texts);
      const reply = texts.map((_, index) => ({ index, embedding: [vectorFor(texts[index])] }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/**
 * The recall environment is read once, in the constructor — set around it.
 * loadPersisted runs what start() runs before the socket: snapshot, then the
 * index, then the history replay that owes it the backlog.
 */
async function serviceWith(env, config = {}) {
  const saved = RECALL_ENV.map((key) => [key, process.env[key]]);
  for (const key of RECALL_ENV) delete process.env[key];
  // The stub's word-concept vectors sit far under the production cosine floor.
  Object.assign(process.env, { WAZAP_RECALL_MIN_SIMILARITY: "0" }, env);
  try {
    const connected = await connectedService(WhatsAppService, {
      prefix: "wazap-recall-",
      id: ME,
      name: "Răzvan",
      config: { persistHistory: true, ...config },
    });
    await connected.svc.loadPersisted();
    return connected;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const text = (id, body, over = {}) => ({
  key: { remoteJid: PEER, fromMe: false, id },
  messageTimestamp: Math.floor(Date.now() / 1000),
  message: { conversation: body },
  ...over,
});

const deliver = (sock, messages) => sock.ev.emit("messages.upsert", { type: "notify", messages });

/** One history line the store loader accepts — the shape appendHistory writes. */
const historyLine = (raw, sid) => `${JSON.stringify({ sid, ts: raw.messageTimestamp, raw: encodeRaw(raw) })}\n`;
const encodeRaw = (raw) => Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString("base64");

test("live messages land in the index; placeholders do not", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [
      text("M1", "ți-am trimis factura pe e-mail ieri"),
      text("M2", "la ce ora e programarea la doctor?"),
      { ...text("M3"), message: { stickerMessage: { mimetype: "image/webp" } } },
      text("M4", "🥰🥰😘"),
      text("M5", "Da"),
    ]);
    await svc.recallIdle();
    assert.equal(svc.recallStore.count, 2);
    assert.equal(svc.recallStore.record(`false_${PEER}_M1`).text, "ți-am trimis factura pe e-mail ieri");
    assert.ok(
      stub.seen.every((t) => t.startsWith(PROMPTS.document)),
      "documents are embedded under the model's document prompt"
    );
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("an edit re-indexes the sid under its new text", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [text("M1", "ne vedem la aeroport la șase")]);
    await svc.recallIdle();
    const sid = `false_${PEER}_M1`;
    assert.equal(svc.recallStore.record(sid).text, "ne vedem la aeroport la șase");
    sock.ev.emit("messages.update", [
      { key: { remoteJid: PEER, fromMe: false, id: "M1" }, update: { message: { editedMessage: { message: { conversation: "ne vedem la aeroport la șapte" } } } } },
    ]);
    await svc.recallIdle();
    assert.equal(svc.recallStore.count, 1);
    assert.equal(svc.recallStore.record(sid).text, "ne vedem la aeroport la șapte");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a revoke tombstones the message it takes back", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [text("M1", "parola de la masina e 1234"), text("M2", "ignora ce am scris")]);
    await svc.recallIdle();
    assert.equal(svc.recallStore.count, 2);
    deliver(sock, [
      {
        key: { remoteJid: PEER, fromMe: false, id: "R1" },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.REVOKE,
            key: { remoteJid: PEER, fromMe: false, id: "M1" },
          },
        },
      },
    ]);
    await svc.recallIdle();
    assert.equal(svc.recallStore.record(`false_${PEER}_M1`), undefined);
    assert.equal(svc.recallStore.count, 1);
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("boot reconcile indexes what a file still holds, then seals it", async () => {
  const stub = await stubEmbedServer();
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-recall-"));
  const historyDir = join(accountPaths(dataDir, "default").root, "history");
  mkdirSync(historyDir, { recursive: true });
  const file = join(historyDir, `${PEER}.jsonl`);
  writeFileSync(file, [
    historyLine(text("M1", "am plătit chiria pe toată luna"), `false_${PEER}_M1`),
    historyLine(text("M2", "factura vine săptămâna viitoare"), `false_${PEER}_M2`),
  ].join(""));
  try {
    // History existed before this wazap booted — the loader owes the index.
    const first = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url }, { dataDir });
    await first.svc.recallIdle();
    assert.equal(first.svc.recallStore.count, 2);
    const seenAfterFirst = stub.seen.length;
    await first.svc.stop();

    // A second boot over the same data dir sees the sealed file and skips it.
    const second = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url }, { dataDir });
    await second.svc.recallIdle();
    assert.equal(second.svc.recallStore.count, 2);
    assert.equal(stub.seen.length, seenAfterFirst, "a sealed file is not re-embedded");
    await second.svc.stop();

    // Lines appended while wazap was away are the tail the next boot owes.
    appendFileSync(file, historyLine(text("M3", "doctorul mi-a dat programare luni"), `false_${PEER}_M3`));
    const third = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url }, { dataDir });
    await third.svc.recallIdle();
    assert.equal(third.svc.recallStore.count, 3);
    assert.ok(stub.seen.length > seenAfterFirst, "the appended line reached the embedder");
    await third.svc.stop();
  } finally {
    stub.server.close();
  }
});

test("persistHistory off keeps recall off — the index would outlive its source", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith(
    { WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url },
    { persistHistory: false }
  );
  try {
    assert.equal(svc.recallStore, null);
    deliver(sock, [text("M1", "ceva ce nu trebuie indexat")]);
    await svc.recallIdle();
    assert.equal(svc.getStatus().recall.state, "off");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a recall setting wazap does not know degrades to a line, not a crash", async () => {
  const { svc } = await serviceWith({ WAZAP_RECALL: "cloud-please" });
  try {
    const recall = svc.getStatus().recall;
    assert.equal(recall.state, "degraded");
    assert.match(recall.detail, /Unknown recall mode/);
    assert.equal(svc.status, "connected");
  } finally {
    await svc.stop();
  }
});

/** Stand-in for McpServer: records what got registered and lets us call it. */
function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, meta, handler) {
      tools.set(name, { meta, handler });
    },
  };
}

test("recall answers a Romanian paraphrase, ranked by score, with the date on the hit", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [
      text("M1", "ți-am trimis factura pe e-mail ieri"),
      text("M2", "la ce ora e programarea la doctor?"),
    ]);
    await svc.recallIdle();
    const { data } = await svc.recall("when did she send the invoice?", undefined, 10);
    assert.ok(
      stub.seen.at(-1).startsWith(PROMPTS.query),
      "the query is embedded under the model's query prompt"
    );
    assert.equal(data.hits[0].message.message_id, `false_${PEER}_M1`);
    assert.equal(data.hits[0].from_index, false);
    assert.ok(data.hits[0].similarity > 0);
    assert.match(data.hits[0].message.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(data.index.state, "ready");
    assert.equal(data.index.indexed, 2);
    const only = await svc.recall("invoice", undefined, 1);
    assert.equal(only.data.hits.length, 1, "limit caps the ranked list");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("chat, since/until and from narrow recall the way they narrow search_messages", async () => {
  const OTHER = "40700000003@s.whatsapp.net";
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    const nowS = Math.floor(Date.now() / 1000);
    deliver(sock, [
      text("M1", "factura pe e-mail"),
      text("M2", "factura veche", { messageTimestamp: nowS - 10 * 86_400 }),
      { ...text("X1", "factura de la altcineva"), key: { remoteJid: OTHER, fromMe: false, id: "X1" } },
      { ...text("ME1", "factura trimisa de mine"), key: { remoteJid: PEER, fromMe: true, id: "ME1" } },
    ]);
    await svc.recallIdle();
    assert.equal(svc.recallStore.count, 4);

    const inChat = await svc.recall("invoice", PEER, 10);
    assert.equal(inChat.data.hits.length, 3);
    assert.ok(inChat.data.hits.every((h) => h.message.chat_id === PEER));

    const since = await svc.recall("invoice", undefined, 10, { sinceMs: Date.now() - 86_400_000 });
    assert.ok(!since.data.hits.some((h) => h.message.message_id === `false_${PEER}_M2`), "the old one is before since");

    const until = await svc.recall("invoice", undefined, 10, { untilMs: Date.now() - 86_400_000 });
    assert.deepEqual(until.data.hits.map((h) => h.message.message_id), [`false_${PEER}_M2`]);

    const mine = await svc.recall("invoice", undefined, 10, { from: "me" });
    assert.deepEqual(mine.data.hits.map((h) => h.message.message_id), [`true_${PEER}_ME1`]);
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a message that fell out of the store still answers from the index", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [text("M1", "factura din august, plătită integral")]);
    await svc.recallIdle();
    const sid = `false_${PEER}_M1`;
    // What eviction does: the raw message leaves the live store.
    svc.store.messages.delete(sid);
    svc.store.chatOf.delete(sid);
    const { data } = await svc.recall("the paid invoice", undefined, 5);
    const hit = data.hits.find((h) => h.message.message_id === sid);
    assert.ok(hit, "the index still holds it");
    assert.equal(hit.from_index, true);
    assert.equal(hit.message.text, "factura din august, plătită integral");
    assert.equal(hit.message.chat_id, PEER);
    assert.equal(hit.message.sender.id, PEER);
    assert.match(hit.message.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("recall off answers RECALL_UNAVAILABLE with the fix, and the tool falls back to keyword search", async () => {
  const { svc } = await serviceWith({});
  try {
    await assert.rejects(() => svc.recall("anything", undefined, 5), (err) => {
      assert.equal(err.code, "RECALL_UNAVAILABLE");
      assert.match(err.fix, /wazap config recall local/);
      return true;
    });
    const server = fakeServer();
    registerTools(server, asToolSource(svc), { allowWrite: true });
    // The tool does not dead-end: it answers from the local history and says
    // semantic recall is off, with the command that turns it on.
    const result = await server.tools.get("recall").handler({ query: "anything" });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.mode, "keyword_fallback");
    assert.match(result.structuredContent.recall_unavailable.fix, /wazap config recall local/);
    assert.match(result.content[0].text, /keyword results over the local history/);
  } finally {
    await svc.stop();
  }
});

test("when even the keyword fallback cannot run, recall stays a hard error", async () => {
  const { svc } = await serviceWith({});
  // Nothing linked: recall refuses NOT_LINKED before the index question ever
  // comes up, and the fallback's own search would refuse the same way.
  svc.status = "not_linked";
  try {
    const server = fakeServer();
    registerTools(server, asToolSource(svc), { allowWrite: true });
    const dead = await server.tools.get("recall").handler({ query: "anything" });
    assert.equal(dead.isError, true);
    assert.equal(dead.structuredContent.error, "NOT_LINKED");
    assert.equal(dead.structuredContent.mode, undefined, "no fallback was claimed");
  } finally {
    await svc.stop();
  }
});

test("a fallback that itself fails stays a hard error, not a crash", async () => {
  const { svc } = await serviceWith({});
  try {
    const server = fakeServer();
    registerTools(server, asToolSource(svc), { allowWrite: true });
    // Recall is off; the fallback then meets the same bad chat_id.
    const result = await server.tools.get("recall").handler({ query: "x", chat_id: "x@nope.invalid" });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error, "INVALID_ID");
    assert.equal(result.structuredContent.mode, undefined);
    assert.doesNotMatch(result.content[0].text, /keyword_fallback/);
  } finally {
    await svc.stop();
  }
});

test("recall on but history off names the missing piece, not the feature", async () => {
  const stub = await stubEmbedServer();
  const { svc } = await serviceWith(
    { WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url },
    { persistHistory: false }
  );
  try {
    await assert.rejects(() => svc.recall("x", undefined, 5), (err) => {
      assert.equal(err.code, "RECALL_UNAVAILABLE");
      assert.match(err.fix, /WAZAP_PERSIST_HISTORY/);
      return true;
    });
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a recall env wazap cannot parse answers RECALL_UNAVAILABLE, not a crash", async () => {
  const { svc } = await serviceWith({ WAZAP_RECALL: "cloud-please" });
  try {
    await assert.rejects(() => svc.recall("x", undefined, 5), (err) => {
      assert.equal(err.code, "RECALL_UNAVAILABLE");
      assert.match(err.message, /Unknown recall mode/);
      return true;
    });
  } finally {
    await svc.stop();
  }
});

test("the tool renders each hit with its date, score and the index-only mark", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [
      text("M1", "ți-am trimis factura pe e-mail ieri"),
      text("M2", "factura veche din index"),
    ]);
    await svc.recallIdle();
    // M2 fell out of the live store; the index is all that still holds it.
    svc.store.messages.delete(`false_${PEER}_M2`);
    svc.store.chatOf.delete(`false_${PEER}_M2`);

    const server = fakeServer();
    registerTools(server, asToolSource(svc), { allowWrite: false });
    const result = await server.tools.get("recall").handler({ query: "the invoice" });
    assert.equal(result.isError, undefined);
    const out = result.content[0].text;
    assert.match(out, /# Recall results for "the invoice" \(2\)/);
    assert.match(out, /score \d\.\d{2}/);
    assert.match(out, /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    assert.match(out, /index only/);
    assert.match(out, /factura veche din index/);
    assert.equal(result.structuredContent.count, 2);
    assert.equal(result.structuredContent.index.state, "ready");
    const evicted = result.structuredContent.hits.find((h) => h.from_index);
    assert.equal(evicted.message.message_id, `false_${PEER}_M2`);
    assert.equal(evicted.message.text, "factura veche din index");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("an over-cap message re-delivered is diffed by its stored text, not re-embedded", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    const long = `factura ${"pe e-mail ".repeat(400)}`; // ~3.6k chars, over the index cap
    deliver(sock, [text("M1", long)]);
    await svc.recallIdle();
    const seenAfterFirst = stub.seen.length;
    const sid = `false_${PEER}_M1`;
    assert.ok(svc.recallStore.record(sid).text.length < long.length, "the index keeps the capped text");
    // A reconnect or history re-sync delivers the same raw again.
    deliver(sock, [text("M1", long)]);
    await svc.recallIdle();
    assert.equal(stub.seen.length, seenAfterFirst, "same capped text is not fresh work");
    assert.equal(svc.recallStore.count, 1);
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("the similarity floor drops noise hits instead of listing them", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({
    WAZAP_RECALL: "local",
    WAZAP_EMBED_URL: stub.url,
    WAZAP_RECALL_MIN_SIMILARITY: "0.9",
  });
  try {
    deliver(sock, [text("M1", "ți-am trimis factura pe e-mail ieri")]);
    await svc.recallIdle();
    const { data } = await svc.recall("when did she send the invoice?", undefined, 10);
    assert.equal(data.hits.length, 0, "a stub-strength match sits under a real floor");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("the floor defaults to the model's own, and the env override wins over both", () => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-recall-"));
  assert.equal(
    readRecallSettings({}, dir).minSimilarity,
    EMBED_MODELS["embeddinggemma-300m"].defaultMinSimilarity
  );
  const e5 = readRecallSettings({ WAZAP_EMBED_MODEL: "e5-base-multilingual" }, dir);
  assert.equal(e5.minSimilarity, EMBED_MODELS["e5-base-multilingual"].defaultMinSimilarity);
  assert.notEqual(e5.minSimilarity, 0.35, "e5 must not silently inherit gemma's floor");
  for (const model of ["embeddinggemma-300m", "e5-base-multilingual"]) {
    const env = { WAZAP_EMBED_MODEL: model, WAZAP_RECALL_MIN_SIMILARITY: "0.5" };
    assert.equal(readRecallSettings(env, dir).minSimilarity, 0.5, model);
  }
});

test("a min-similarity outside 0..1 is refused at parse, whichever model is picked", () => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-recall-"));
  for (const bad of ["2", "-0.1", "soon"]) {
    assert.throws(
      () => readRecallSettings({ WAZAP_RECALL_MIN_SIMILARITY: bad }, dir),
      (err) => {
        assert.equal(err.code, "INVALID_ID");
        assert.match(err.message, /MIN_SIMILARITY/);
        return true;
      },
      bad
    );
  }
});

test("the idle window parses to ms; 0 disables and bad input is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-recall-"));
  assert.equal(readRecallSettings({}, dir).embedIdleMs, 30 * 60_000);
  assert.equal(readRecallSettings({ WAZAP_EMBED_IDLE_MINUTES: "0" }, dir).embedIdleMs, 0);
  assert.equal(readRecallSettings({ WAZAP_EMBED_IDLE_MINUTES: "1.5" }, dir).embedIdleMs, 90_000);
  for (const bad of ["-1", "soon"]) {
    assert.throws(
      () => readRecallSettings({ WAZAP_EMBED_IDLE_MINUTES: bad }, dir),
      (err) => {
        assert.equal(err.code, "INVALID_ID");
        assert.match(err.message, /IDLE/);
        return true;
      },
      bad
    );
  }
});

test("weak matches are flagged, not sold as answers", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [text("M1", "ți-am trimis factura pe e-mail ieri")]);
    await svc.recallIdle();
    const server = fakeServer();
    registerTools(server, asToolSource(svc), { allowWrite: false });
    const result = await server.tools.get("recall").handler({ query: "the invoice" });
    assert.match(result.content[0].text, /Weak matches only/);
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a min-similarity wazap cannot parse degrades to a line, not a crash", async () => {
  const stub = await stubEmbedServer();
  const { svc } = await serviceWith({
    WAZAP_RECALL: "local",
    WAZAP_EMBED_URL: stub.url,
    WAZAP_RECALL_MIN_SIMILARITY: "2",
  });
  try {
    const recall = svc.getStatus().recall;
    assert.equal(recall.state, "degraded");
    assert.match(recall.detail, /MIN_SIMILARITY/);
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a bad since is INVALID_ID, same as search_messages", async () => {
  const stub = await stubEmbedServer();
  const { svc } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    const server = fakeServer();
    registerTools(server, asToolSource(svc), { allowWrite: true });
    const result = await server.tools.get("recall").handler({ query: "x", since: "last Tuesdayish" });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error, "INVALID_ID");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a one-chat cluster cannot fill the list — another chat's relevant hit surfaces", async () => {
  const OTHER = "40700000003@s.whatsapp.net";
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    // Four PEER hits all outscore the OTHER one semantically; the cap is what
    // keeps the fourth from taking its slot.
    deliver(sock, [
      text("M1", "medicamentul copilului dimineata"),
      text("M2", "medicamentul copilului la pranz"),
      text("M3", "medicamentul copilului seara"),
      text("M4", "medicamentul copilului in weekend"),
      { ...text("X1", "medicamentul e in dulap"), key: { remoteJid: OTHER, fromMe: false, id: "X1" } },
    ]);
    await svc.recallIdle();
    const { data } = await svc.recall("medicamentul copilului", undefined, 10);
    assert.deepEqual(
      data.hits.map((h) => h.message.chat_id),
      [PEER, PEER, PEER, OTHER, PEER],
      "the chat cap demotes the fourth cluster hit below the other chat's"
    );
    assert.equal(data.hits.length, 5, "demotion keeps every relevant hit reachable");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a near-duplicate in a second chat trails the list instead of taking a slot", async () => {
  const OTHER = "40700000003@s.whatsapp.net";
  const THIRD = "40700000004@s.whatsapp.net";
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [
      text("M1", "confirmat petrecerea de sambata"),
      { ...text("X1", "confirmat petrecerea de sambata"), key: { remoteJid: OTHER, fromMe: false, id: "X1" } },
      { ...text("Y1", "confirmat intalnirea de luni dimineata"), key: { remoteJid: THIRD, fromMe: false, id: "Y1" } },
    ]);
    await svc.recallIdle();
    const { data } = await svc.recall("confirmat petrecerea", undefined, 10);
    assert.deepEqual(
      data.hits.map((h) => h.message.chat_id),
      [PEER, THIRD, OTHER],
      "the forwarded copy yields to the distinct answer"
    );
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a rare literal token lifts the exact-name hit above an equisimilar one", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    // All five share one query concept, so the stub scores them alike; only
    // A repeats "cata" verbatim, while "medic" sits in four of five and is
    // too common to count.
    deliver(sock, [
      text("B", "medic dentist"),
      text("A", "cata vizita"),
      text("C", "medic ieri"),
      text("D", "medic azi"),
      text("E", "medic mereu"),
    ]);
    await svc.recallIdle();
    const { data } = await svc.recall("cata medic", undefined, 10);
    assert.equal(data.hits[0].message.message_id, `false_${PEER}_A`, "the rare token wins the tie");
    assert.equal(data.hits[0].similarity, data.hits[1].similarity, "similarity stays the raw cosine");
    assert.ok(data.hits[0].score > data.hits[1].score, "the bonus is what orders them");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a hit under the floor stays out even when it carries the query token", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({
    WAZAP_RECALL: "local",
    WAZAP_EMBED_URL: stub.url,
    WAZAP_RECALL_MIN_SIMILARITY: "0.25",
  });
  try {
    deliver(sock, [text("GOOD", "cata medic"), text("NOISE", "cata pelerina rucsac munte cort saci")]);
    await svc.recallIdle();
    assert.equal(svc.recallStore.count, 2);
    const { data } = await svc.recall("cata medic", undefined, 10);
    assert.deepEqual(
      data.hits.map((h) => h.message.message_id),
      [`false_${PEER}_GOOD`],
      "the bonus reorders survivors; it never rescues noise"
    );
  } finally {
    await svc.stop();
    stub.server.close();
  }
});
