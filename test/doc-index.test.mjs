/**
 * Opt-in local document text indexing (WAZAP_INDEX_DOCUMENTS=off|local, schema v10):
 * - off by default; invalid values refused;
 * - empty doc_text ("") keeps existing embeddings intact without re-queuing;
 * - non-empty doc_text joins messages_fts, hybrid/words search, nearby context,
 *   and semantic recall embeddings;
 * - tombstones wipe doc_text and FTS entries; #private hides doc_text;
 * - background AccountDocIndex extracts text from kept documents on boot when enabled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { indexDocumentsSetting } from "../dist/config.js";
import { cleanDocText, DOC_TEXT_MAX } from "../dist/service/doc-index.js";
import { contentHash } from "../dist/db/index.js";
import { withoutWords } from "../dist/private-contacts.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { startEmbedStub } from "../scripts/eval/embed-stub.mjs";
import { connectedService, schemaCheckedTools } from "./helpers.mjs";
import { openTemp, sid, textMessage, wordsOf, PEER, T0 } from "./db-fixtures.mjs";

const ME = "40700000001@s.whatsapp.net";
const MODEL = "embeddinggemma-300m";

test("WAZAP_INDEX_DOCUMENTS defaults to off, accepts local, and refuses unknown values", () => {
  assert.equal(indexDocumentsSetting(undefined), "off");
  assert.equal(indexDocumentsSetting(""), "off");
  assert.equal(indexDocumentsSetting("off"), "off");
  assert.equal(indexDocumentsSetting("0"), "off");
  assert.equal(indexDocumentsSetting("local"), "local");
  assert.equal(indexDocumentsSetting("LOCAL"), "local");
  assert.throws(() => indexDocumentsSetting("cloud"), /WAZAP_INDEX_DOCUMENTS must be off or local/);
});

test("cleanDocText strips control characters, drops noise lines and caps at DOC_TEXT_MAX", () => {
  assert.equal(cleanDocText("  - \n . "), "");
  assert.equal(
    cleanDocText("Invoice #9921\r\n  Total:\u0007 1500 RON  \n|\nPaid in full\n"),
    "Invoice #9921\nTotal: 1500 RON\nPaid in full"
  );
  assert.equal(cleanDocText("X".repeat(DOC_TEXT_MAX + 500)).length, DOC_TEXT_MAX);
});

test("v10 DB: empty doc_text keeps existing embeddings intact; non-empty joins FTS + embed_queue; tombstone wipes it", () => {
  const { db } = openTemp();
  try {
    assert.equal(contentHash("hello", null, null), contentHash("hello", null, null, null));
    assert.equal(contentHash("hello", null, null), contentHash("hello", null, null, ""));
    assert.notEqual(contentHash("hello", null, null), contentHash("hello", null, null, "CHEDA.GB.2026"));

    db.vectors.feed(MODEL);
    while (db.vectors.refill(50)) {
      /* drain */
    }
    const docSid = sid(false, PEER, "DOC1");
    const capSid = sid(false, PEER, "DOC2");
    db.messages.upsert({ ...textMessage(PEER, "DOC1", T0, null), type: "document", text: null });
    db.messages.upsert({ ...textMessage(PEER, "DOC2", T0 + 1000, "contract.pdf"), type: "document" });
    db.vectors.put(capSid, MODEL, [1, 0, 0, 0], wordsOf(db, capSid));
    assert.equal(db.vectors.queueSize(), 0);

    // Marking an unreadable/scanned document as "" does NOT invalidate its embedding or enqueue re-embed.
    assert.equal(db.messages.setDocText(capSid, ""), true);
    assert.notEqual(db.vectors.get(capSid), null);
    assert.equal(db.vectors.queueSize(), 0);

    // Storing real extracted document text makes it searchable in FTS, hybrid, and queued for embedding.
    assert.equal(db.messages.setDocText(docSid, "Export Health Certificate CHEDA.GB.2026.998877"), true);
    assert.equal(db.messages.get(docSid).docText, "Export Health Certificate CHEDA.GB.2026.998877");
    assert.deepEqual(db.search.text({ query: "998877", limit: 5 }).items.map((m) => m.sid), [docSid]);
    assert.deepEqual(db.vectors.hybrid({ query: "Export Health Certificate", model: MODEL, limit: 5, minSimilarity: 0.35 }).hits.map((h) => h.message.sid), [docSid]);
    const queued = db.vectors.queued({ model: MODEL, limit: 5 }).items;
    assert.deepEqual(queued.map((q) => q.sid), [docSid]);
    assert.equal(db.vectors.put(docSid, MODEL, [0, 1, 0, 0], queued[0].contentHash), true);
    assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });

    // Tombstoning wipes doc_text and removes it from FTS.
    db.messages.delete(docSid);
    assert.equal(db.messages.get(docSid, { includeHidden: true }).docText, null);
    assert.deepEqual(db.search.text({ query: "998877", limit: 5 }).items, []);
    assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
  } finally {
    db.close();
  }
});

test("AccountDocIndex stays off by default, indexes kept documents when WAZAP_INDEX_DOCUMENTS=local, and respects #private", async (t) => {
  const stub = await startEmbedStub();
  const keys = ["WAZAP_RECALL", "WAZAP_EMBED_URL", "WAZAP_EMBED_MODEL", "WAZAP_RECALL_MIN_SIMILARITY"];
  const saved = keys.map((key) => [key, process.env[key]]);
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { WAZAP_RECALL: "local", WAZAP_EMBED_MODEL: MODEL, WAZAP_RECALL_MIN_SIMILARITY: "0.3", WAZAP_EMBED_URL: stub.url });

  let offSvc;
  let onSvc;
  try {
    offSvc = connectedService(WhatsAppService, {
      prefix: "wazap-doc-off-",
      id: ME,
      name: "Owner",
      config: { persistHistory: true, indexDocuments: "off" },
    });
    onSvc = connectedService(WhatsAppService, {
      prefix: "wazap-doc-on-",
      id: ME,
      name: "Owner",
      config: { persistHistory: true, indexDocuments: "local" },
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  t.after(async () => {
    await offSvc.svc.stop();
    await onSvc.svc.stop();
    await stub.close();
  });

  // Use real worker extraction on a real UTF-8 text document on onSvc, and a spy on offSvc.
  let offCalls = 0;
  offSvc.svc.docExtractor = async () => {
    offCalls++;
    return "should never run";
  };
  onSvc.svc.docIndex.paceMs = 0;

  for (const fx of [offSvc, onSvc]) {
    const keptDir = join(fx.svc.config.dataDir, "accounts", "default", "kept");
    mkdirSync(keptDir, { recursive: true });
    const filePath = join(keptDir, "1700000000000-abcd1234.txt");
    writeFileSync(filePath, "Contract Transport Animale\nFactura #774411\nDestinatie: Dover UK\n", "utf8");
    fx.svc.db.messages.upsert({
      chatJid: PEER,
      keyId: "DOC1",
      fromMe: false,
      ts: Date.now() - 60_000,
      type: "document",
      text: "[document] factura.txt",
    });
    fx.svc.db.messages.upsert({
      chatJid: PEER,
      keyId: "TXT1",
      fromMe: false,
      ts: Date.now() - 55_000,
      type: "text",
      text: "Ti-am trimis factura pe cursa de UK",
    });
    fx.svc.db.messages.setMedia(sid(false, PEER, "DOC1"), "original", filePath);
  }

  await offSvc.svc.bootStorage();
  await offSvc.svc.docIndexIdle();
  assert.equal(offCalls, 0, "WAZAP_INDEX_DOCUMENTS=off never extracts documents");

  await onSvc.svc.bootStorage();
  await onSvc.svc.docIndexIdle();
  await onSvc.svc.recallIdle();

  const docSid = sid(false, PEER, "DOC1");
  const { call } = schemaCheckedTools(onSvc.svc, { allowWrite: false });
  const hit = await call("search", { query: "774411", limit: 5 });
  assert.equal(hit.isError, undefined);
  assert.equal(hit.structuredContent.messages[0].message_id, docSid);
  assert.match(hit.structuredContent.messages[0].doc_text, /Factura #774411/);
  assert.match(hit.content[0].text, /doc: Contract Transport Animale · Factura #774411/);

  // Nearby context surfaces [doc: ...] on the neighbouring text message.
  const ctx = await call("search", { query: "factura pe cursa", match: "words", limit: 5 });
  assert.match(ctx.content[0].text, /\[doc: Contract Transport Animale · Factura #774411/);

  // #private hides doc_text completely.
  const view = onSvc.svc.views.viewOfStored(onSvc.svc.db.messages.get(docSid));
  assert.ok(view.doc_text);
  assert.equal(withoutWords(view).doc_text, undefined);
  onSvc.svc.db.identity.updateFields(PEER, { addTags: ["private"] });
  const hidden = await call("search", { query: "774411", limit: 5 });
  assert.equal(hidden.structuredContent.count, 0);
  assert.ok(hidden.structuredContent.private_omitted > 0);
});
