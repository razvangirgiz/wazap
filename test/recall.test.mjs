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
import { connectedService } from "./helpers.mjs";
import { accountPaths } from "../dist/config.js";

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const DIMS = 768;

const RECALL_ENV = ["WAZAP_RECALL", "WAZAP_EMBED_MODEL", "WAZAP_EMBED_BIN", "WAZAP_EMBED_URL", "WAZAP_RECALL_MAX"];

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
  Object.assign(process.env, env);
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
    ]);
    await svc.recallIdle();
    assert.equal(svc.recallStore.count, 2);
    assert.equal(svc.recallStore.record(`false_${PEER}_M1`).text, "ți-am trimis factura pe e-mail ieri");
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
