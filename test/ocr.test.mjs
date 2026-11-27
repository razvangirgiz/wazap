/**
 * Opt-in local image OCR indexing (WAZAP_OCR=off|local, schema v9):
 * - off by default; invalid WAZAP_OCR refused;
 * - empty OCR marks an image scanned without dropping existing embeddings or
 *   re-queuing embed_queue;
 * - non-empty OCR joins messages_fts, hybrid/words search, nearby context, and
 *   semantic recall embeddings;
 * - tombstones wipe ocr_text and FTS entries; #private hides ocr_text;
 * - background AccountOcr scans kept images on boot when WAZAP_OCR=local.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ocrSetting } from "../dist/config.js";
import { cleanOcrText, OCR_TEXT_MAX } from "../dist/ocr.js";
import { contentHash } from "../dist/db/index.js";
import { withoutWords } from "../dist/private-contacts.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { startEmbedStub } from "../scripts/eval/embed-stub.mjs";
import { connectedService, schemaCheckedTools } from "./helpers.mjs";
import { openTemp, sid, textMessage, wordsOf, PEER, T0 } from "./db-fixtures.mjs";

const ME = "40700000001@s.whatsapp.net";
const MODEL = "embeddinggemma-300m";

test("WAZAP_OCR setting defaults to off, accepts local, and refuses unknown values", () => {
  assert.equal(ocrSetting(undefined), "off");
  assert.equal(ocrSetting(""), "off");
  assert.equal(ocrSetting("off"), "off");
  assert.equal(ocrSetting("0"), "off");
  assert.equal(ocrSetting("local"), "local");
  assert.equal(ocrSetting("LOCAL"), "local");
  assert.throws(() => ocrSetting("cloud"), /WAZAP_OCR must be off or local/);
});

test("cleanOcrText strips noise, rejects textless fragments and caps long text", () => {
  assert.equal(cleanOcrText("  | . _ \n ! "), "");
  assert.equal(cleanOcrText("abc"), "");
  assert.equal(
    cleanOcrText("McVitie's   Victoria\n|\nDelicious Chocolatey\u0007 Biscuit 490g\n"),
    "McVitie's Victoria\nDelicious Chocolatey Biscuit 490g"
  );
  assert.equal(cleanOcrText("A".repeat(OCR_TEXT_MAX + 500)).length, OCR_TEXT_MAX);
});

test("v9 DB: empty ocr_text keeps existing embeddings intact; non-empty joins FTS + embed_queue; tombstone wipes it", () => {
  const { db } = openTemp();
  try {
    assert.equal(contentHash("hello", null), contentHash("hello", null, null));
    assert.equal(contentHash("hello", null), contentHash("hello", null, ""));
    assert.notEqual(contentHash("hello", null), contentHash("hello", null, "McVities"));

    db.vectors.feed(MODEL);
    while (db.vectors.refill(50)) {
      /* drain */
    }
    const imgSid = sid(false, PEER, "IMG1");
    const capSid = sid(false, PEER, "IMG2");
    db.messages.upsert({ ...textMessage(PEER, "IMG1", T0, null), type: "image", text: null });
    db.messages.upsert({ ...textMessage(PEER, "IMG2", T0 + 1000, "biscuiti"), type: "image" });
    db.vectors.put(capSid, MODEL, [1, 0, 0, 0], wordsOf(db, capSid));
    assert.equal(db.vectors.queueSize(), 0);

    // Marking a captioned image as textless ("") does NOT invalidate its embedding or enqueue re-embed.
    assert.equal(db.messages.setOcrText(capSid, ""), true);
    assert.notEqual(db.vectors.get(capSid), null);
    assert.equal(db.vectors.queueSize(), 0);

    // Storing real OCR text on a captionless image makes it searchable in FTS, hybrid, and queued for embedding.
    assert.equal(db.messages.setOcrText(imgSid, "Littlest Pet Shop Deluxe Advent Calendar Ref: 258740"), true);
    assert.equal(db.messages.get(imgSid).ocrText, "Littlest Pet Shop Deluxe Advent Calendar Ref: 258740");
    assert.deepEqual(db.search.text({ query: "258740", limit: 5 }).items.map((m) => m.sid), [imgSid]);
    assert.deepEqual(db.vectors.hybrid({ query: "Littlest Pet Shop", model: MODEL, limit: 5, minSimilarity: 0.35 }).hits.map((h) => h.message.sid), [imgSid]);
    const queued = db.vectors.queued({ model: MODEL, limit: 5 }).items;
    assert.deepEqual(queued.map((q) => q.sid), [imgSid]);
    assert.equal(db.vectors.put(imgSid, MODEL, [0, 1, 0, 0], queued[0].contentHash), true);
    assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });

    // Tombstoning wipes ocr_text and removes it from FTS.
    db.messages.delete(imgSid);
    assert.equal(db.messages.get(imgSid, { includeHidden: true }).ocrText, null);
    assert.deepEqual(db.search.text({ query: "258740", limit: 5 }).items, []);
    assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
  } finally {
    db.close();
  }
});

test("AccountOcr stays off by default, indexes kept images when WAZAP_OCR=local, and respects #private", async (t) => {
  const stub = await startEmbedStub();
  const keys = ["WAZAP_RECALL", "WAZAP_EMBED_URL", "WAZAP_EMBED_MODEL", "WAZAP_RECALL_MIN_SIMILARITY"];
  const saved = keys.map((key) => [key, process.env[key]]);
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { WAZAP_RECALL: "local", WAZAP_EMBED_MODEL: MODEL, WAZAP_RECALL_MIN_SIMILARITY: "0.3", WAZAP_EMBED_URL: stub.url });

  let offSvc;
  let onSvc;
  try {
    offSvc = connectedService(WhatsAppService, {
      prefix: "wazap-ocr-off-",
      id: ME,
      name: "Owner",
      config: { persistHistory: true, ocr: "off" },
    });
    onSvc = connectedService(WhatsAppService, {
      prefix: "wazap-ocr-on-",
      id: ME,
      name: "Owner",
      config: { persistHistory: true, ocr: "local" },
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

  // Configure deterministic OCR runner before bootStorage.
  let offCalls = 0;
  offSvc.svc.ocrRunner = async () => {
    offCalls++;
    return "should never run";
  };
  const onScanned = [];
  onSvc.svc.ocrRunner = async (filePath) => {
    onScanned.push(filePath);
    return "McVitie's Victoria\nDelicious Chocolatey Biscuit\nSelection Box 490g";
  };
  onSvc.svc.ocr.paceMs = 0;

  // Seed kept image on both services BEFORE bootStorage.
  for (const fx of [offSvc, onSvc]) {
    const keptDir = join(fx.svc.config.dataDir, "accounts", "default", "kept");
    mkdirSync(keptDir, { recursive: true });
    const filePath = join(keptDir, "1700000000000-1234abcd.jpeg");
    writeFileSync(filePath, Buffer.from("fake-jpeg"));
    fx.svc.db.messages.upsert({
      chatJid: PEER,
      keyId: "PHOTO1",
      fromMe: false,
      ts: Date.now() - 60_000,
      type: "image",
      text: "[image]",
    });
    fx.svc.db.messages.upsert({
      chatJid: PEER,
      keyId: "TXT1",
      fromMe: false,
      ts: Date.now() - 55_000,
      type: "text",
      text: "5 cutii din astea te rog",
    });
    fx.svc.db.messages.setMedia(sid(false, PEER, "PHOTO1"), "original", filePath);
  }

  await offSvc.svc.bootStorage();
  await offSvc.svc.ocrIdle();
  assert.equal(offCalls, 0, "WAZAP_OCR=off never invokes OCR");

  await onSvc.svc.bootStorage();
  await onSvc.svc.ocrIdle();
  await onSvc.svc.recallIdle();
  assert.equal(onScanned.length, 1);

  const imgSid = sid(false, PEER, "PHOTO1");
  const { call } = schemaCheckedTools(onSvc.svc, { allowWrite: false });
  // Search finds the image directly via its OCR text and renders single-line compact ocr: in list output.
  const hit = await call("search", { query: "McVitie Victoria", limit: 5 });
  assert.equal(hit.isError, undefined);
  assert.equal(hit.structuredContent.messages[0].message_id, imgSid);
  assert.match(hit.structuredContent.messages[0].ocr_text, /McVitie's Victoria\nDelicious/);
  assert.match(hit.content[0].text, /ocr: McVitie's Victoria · Delicious Chocolatey Biscuit · Selection Box 490g/);

  // read_messages renders compact single-line ocr:, while get_message preserves full multi-line OCR.
  const listed = await call("read_messages", { chat_id: PEER, limit: 10 });
  assert.match(listed.content[0].text, /ocr: McVitie's Victoria · Delicious Chocolatey Biscuit · Selection Box 490g/);
  const full = await call("get_message", { message_id: imgSid });
  assert.match(full.content[0].text, /ocr: McVitie's Victoria\nDelicious Chocolatey Biscuit/);

  // Searching the neighbouring text message shows the photo's compact OCR text inside Nearby context!
  const ctx = await call("search", { query: "5 cutii din astea", match: "words", limit: 5 });
  assert.match(ctx.content[0].text, /\[ocr: McVitie's Victoria · Delicious/);

  // #private hides ocr_text completely.
  const view = onSvc.svc.views.viewOfStored(onSvc.svc.db.messages.get(imgSid));
  assert.ok(view.ocr_text);
  assert.equal(withoutWords(view).ocr_text, undefined);
  onSvc.svc.db.identity.updateFields(PEER, { addTags: ["private"] });
  const hidden = await call("search", { query: "McVitie Victoria", limit: 5 });
  assert.equal(hidden.structuredContent.count, 0);
  assert.ok(hidden.structuredContent.private_omitted > 0);
});
