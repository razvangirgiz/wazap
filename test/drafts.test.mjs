import { test } from "node:test";
import assert from "node:assert/strict";

import { DraftStore, formatDraftPreview, formatToLine } from "../dist/drafts.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, offlineConfig } from "./helpers.mjs";

const ANA = { chat_id: "40722@s.whatsapp.net", name: "Ana", number: "40722123456" };
const BLOC = { chat_id: "120363@g.us", name: "Bloc 12" };

function storeAt(ttlMs = 15 * 60_000, cap = 20) {
  let now = 0;
  const store = new DraftStore(() => now, ttlMs, cap);
  return { store, advance: (ms) => (now += ms) };
}

const textPayload = { kind: "text", chatId: ANA.chat_id, text: "Joi la 10 e perfect." };

test("put returns a preview and take consumes it once", () => {
  const { store } = storeAt();
  const draft = store.put(ANA, textPayload);
  assert.match(draft.id, /^d_[0-9a-f]{16}$/);
  assert.equal(draft.preview, `To: Ana (+40 722 123 456)\n"Joi la 10 e perfect."`);
  const view = store.view(draft);
  assert.equal(view.status, "draft");
  assert.equal(view.kind, "text");
  assert.equal(view.draft_id, draft.id);

  const taken = store.take(draft.id);
  assert.equal(taken.id, draft.id);
  assert.equal(store.size, 0);
  store.putBack(taken);
  assert.equal(store.take(draft.id).id, draft.id);
  assert.throws(() => store.take(draft.id), { code: "DRAFT_NOT_FOUND" });
});

test("an expired draft is DRAFT_EXPIRED, not NOT_FOUND", () => {
  const { store, advance } = storeAt(1_000);
  const draft = store.put(ANA, textPayload);
  advance(1_001);
  assert.throws(() => store.take(draft.id), { code: "DRAFT_EXPIRED" });
  assert.throws(() => store.take(draft.id), { code: "DRAFT_NOT_FOUND" });
});

test("put sweeps expired drafts and evicts the oldest at the cap", () => {
  const { store, advance } = storeAt(10_000, 2);
  const first = store.put(ANA, textPayload);
  advance(1);
  store.put(ANA, { ...textPayload, text: "second" });
  assert.equal(store.size, 2);
  advance(1);
  store.put(ANA, { ...textPayload, text: "third" });
  assert.equal(store.size, 2);
  assert.throws(() => store.take(first.id), { code: "DRAFT_NOT_FOUND" });

  advance(10_000);
  store.put(ANA, { ...textPayload, text: "fresh" });
  assert.equal(store.size, 1);
});

test("To: line names a group without a number, and a nameless jid without parens", () => {
  assert.equal(formatToLine(BLOC), "To: Bloc 12 (group)");
  assert.equal(formatToLine({ chat_id: "x@s.whatsapp.net", name: "unknown" }), "To: unknown");
});

test("preview bodies cover every draft kind", () => {
  assert.equal(formatDraftPreview(ANA, textPayload), `To: Ana (+40 722 123 456)\n"Joi la 10 e perfect."`);
  assert.equal(
    formatDraftPreview(ANA, {
      kind: "media",
      chatId: ANA.chat_id,
      source: { file_path: "/tmp/contract.pdf" },
      asDocument: true,
      asVoice: false,
      caption: "actele",
    }),
    `To: Ana (+40 722 123 456)\n[document] contract.pdf\n"actele"`,
  );
  assert.equal(
    formatDraftPreview(BLOC, {
      kind: "poll",
      chatId: BLOC.chat_id,
      question: "Pizza or pasta?",
      options: ["Pizza", "Pasta"],
      multiSelect: false,
    }),
    "To: Bloc 12 (group)\n[poll] Pizza or pasta?\nPizza / Pasta",
  );
  assert.equal(
    formatDraftPreview(ANA, {
      kind: "location",
      chatId: ANA.chat_id,
      latitude: 44.4,
      longitude: 26.1,
      name: "Notar",
      address: "Str. Lunii 14",
    }),
    "To: Ana (+40 722 123 456)\n[location] Notar\nStr. Lunii 14",
  );
  assert.equal(
    formatDraftPreview(ANA, { kind: "forward", chatId: ANA.chat_id, messageId: "m1", text: "factura" }),
    `To: Ana (+40 722 123 456)\nForward: "factura"`,
  );
});

const PEER = "40722123456@s.whatsapp.net";

test("draft rejects a missing local file before it touches the socket", async () => {
  const svc = new WhatsAppService(offlineConfig("wazap-draft-media-"));
  await assert.rejects(
    () =>
      svc.draft({
        kind: "media",
        chatId: PEER,
        source: { file_path: "/no/such/wazap-media.bin" },
        asDocument: false,
        asVoice: false,
      }),
    (err) => err.code === "FILE_NOT_FOUND",
  );
  await svc.stop();
});

test("a failed confirm puts the draft back", async () => {
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-draft-putback-",
    id: "40700000000@s.whatsapp.net",
    name: "Răzvan",
    config: { readOnly: false },
  });
  sock.onWhatsApp = async () => [{ exists: true }];
  let blows = true;
  sock.sendMessage = async () => {
    if (blows) throw new Error("still connecting");
    return undefined;
  };
  const view = await svc.draft({ kind: "text", chatId: PEER, text: "hi" });
  await assert.rejects(() => svc.confirm(view.draft_id));
  blows = false;
  const sent = await svc.confirm(view.draft_id);
  assert.equal(sent.chat_id, PEER);
  assert.equal(sent.text, "hi");
  await svc.stop();
});

test("beginWrite spends the session write bucket", async () => {
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-write-bucket-",
    id: "40700000000@s.whatsapp.net",
    name: "Răzvan",
    config: { readOnly: false, rateLimitPerMinute: 2 },
  });
  sock.chatModify = async () => {};
  await svc.manageChat(PEER, "pin");
  await svc.manageChat(PEER, "unpin");
  await assert.rejects(() => svc.manageChat(PEER, "pin"), (err) => err.code === "RATE_LIMITED");
  await svc.stop();
});
