import { test } from "node:test";
import assert from "node:assert/strict";

import { DraftStore, formatDraftPreview, formatToLine, looksUnnamed, renderDraft } from "../dist/drafts.js";
import { registerTools } from "../dist/tools.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { asToolSource, connectedService, offlineConfig, openService } from "./helpers.mjs";

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

  assert.equal(store.has(draft.id), true);
  const taken = store.take(draft.id);
  assert.equal(taken.id, draft.id);
  assert.equal(store.has(draft.id), false);
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
    `To: Ana (+40 722 123 456)\n[document] contract.pdf\n"actele"`
  );
  assert.equal(
    formatDraftPreview(BLOC, {
      kind: "poll",
      chatId: BLOC.chat_id,
      question: "Pizza or pasta?",
      options: ["Pizza", "Pasta"],
      multiSelect: false,
    }),
    "To: Bloc 12 (group)\n[poll] Pizza or pasta?\nPizza / Pasta"
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
    "To: Ana (+40 722 123 456)\n[location] Notar\nStr. Lunii 14"
  );
  assert.equal(
    formatDraftPreview(ANA, { kind: "forward", chatId: ANA.chat_id, messageId: "m1", text: "factura" }),
    `To: Ana (+40 722 123 456)\nForward: "factura"`
  );
});

test("looksUnnamed trips on digits and unresolved lids, not on real names", () => {
  assert.equal(looksUnnamed({ chat_id: "40700999888@s.whatsapp.net", name: "40700999888" }), true);
  assert.equal(looksUnnamed({ chat_id: "40700999888@s.whatsapp.net", name: "+40 700 999 888" }), true);
  assert.equal(looksUnnamed({ chat_id: "x@lid", name: "unknown (lid …1234)" }), true);
  assert.equal(looksUnnamed({ chat_id: "x@s.whatsapp.net", name: "unknown" }), true);
  assert.equal(looksUnnamed({ chat_id: "x@s.whatsapp.net", name: "flormidable15" }), false);
  assert.equal(looksUnnamed({ chat_id: "x@g.us", name: "Bloc 12" }), false);
});

test("renderDraft says it is not sent, shows the preview, and names the next step", () => {
  const { store } = storeAt();
  const draft = store.put(ANA, textPayload);
  const text = renderDraft(store.view(draft));
  assert.match(text, new RegExp(`^Draft ${draft.id}\\. Not sent\\.`));
  assert.match(text, /To: Ana \(\+40 722 123 456\)\n"Joi la 10 e perfect\."/);
  assert.match(text, /call confirm_send with this draft_id/);
});

test("renderDraft calls out an unnamed recipient", () => {
  const { store } = storeAt();
  const nobody = { chat_id: "40700999888@s.whatsapp.net", name: "40700999888", number: "40700999888" };
  const text = renderDraft(store.view(store.put(nobody, { kind: "text", chatId: nobody.chat_id, text: "hi" })));
  assert.match(text, /not a saved contact/);
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

/**
 * A wa stub that plays the service's side of the draft contract: the payload
 * is stored against the resolved recipient, and a forward carries the original
 * message's text the way WhatsAppService.draft fills it.
 */
function previewApi(to, store = new DraftStore()) {
  return {
    store,
    draft: async (payload) =>
      store.view(store.put(to, payload.kind === "forward" ? { ...payload, text: "factura de plătit" } : payload)),
    confirm: async (id) => {
      const draft = store.take(id);
      const text = draft.payload.kind === "text" ? draft.payload.text : "";
      return { message_id: "mid", chat_id: draft.to.chat_id, text, timestamp: "now" };
    },
  };
}

test("every send tool renders the resolved recipient and the exact body", async () => {
  const server = fakeServer();
  registerTools(server, asToolSource(previewApi(ANA)), { allowWrite: true });
  const call = (name, args) => server.tools.get(name).handler(args);

  const text = await call("send_message", { chat_id: ANA.chat_id, text: "Joi la 10." });
  assert.match(text.content[0].text, /^Draft d_[0-9a-f]{16}\. Not sent\./);
  assert.match(text.content[0].text, /To: Ana \(\+40 722 123 456\)\n"Joi la 10\."/);
  assert.equal(text.structuredContent.kind, "text");
  assert.equal(text.structuredContent.to.number, "40722123456");

  const media = await call("send_media", {
    chat_id: ANA.chat_id,
    file_path: "/tmp/acte finale.pdf",
    caption: "contract",
  });
  assert.match(media.content[0].text, /\[media\] acte finale\.pdf\n"contract"/);
  assert.equal(media.structuredContent.kind, "media");

  const poll = await call("send_poll", {
    chat_id: ANA.chat_id,
    question: "Pizza sau paste?",
    options: ["Pizza", "Paste"],
    multi_select: true,
  });
  assert.match(poll.content[0].text, /\[poll\] Pizza sau paste\? \(multiple answers\)\nPizza \/ Paste/);
  assert.equal(poll.structuredContent.kind, "poll");

  const location = await call("send_location", {
    chat_id: ANA.chat_id,
    latitude: 44.4,
    longitude: 26.1,
    name: "Notar",
    address: "Str. Lunii 14",
  });
  assert.match(location.content[0].text, /\[location\] Notar\nStr\. Lunii 14/);
  assert.equal(location.structuredContent.kind, "location");

  const forward = await call("forward_message", { message_id: "m-1", to_chat_id: ANA.chat_id });
  assert.match(forward.content[0].text, /To: Ana \(\+40 722 123 456\)\nForward: "factura de plătit"/);
  assert.equal(forward.structuredContent.kind, "forward");
});

test("a group draft names the group, with no number in the To line", async () => {
  const server = fakeServer();
  registerTools(server, asToolSource(previewApi(BLOC)), { allowWrite: true });
  const result = await server.tools.get("send_message").handler({ chat_id: BLOC.chat_id, text: "ne vedem" });
  assert.match(result.content[0].text, /To: Bloc 12 \(group\)/);
});

test("confirm_send on a missing draft says to draft again first", async () => {
  const server = fakeServer();
  registerTools(server, asToolSource(previewApi(ANA)), { allowWrite: true });
  const result = await server.tools.get("confirm_send").handler({ draft_id: "d_nope" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "DRAFT_NOT_FOUND");
  assert.match(result.structuredContent.fix, /send_message/);
  assert.match(result.structuredContent.fix, /confirm_send/);
});

test("confirm_send on an expired draft says to show the new preview", async () => {
  let now = 0;
  const api = previewApi(ANA, new DraftStore(() => now, 1_000));
  const server = fakeServer();
  registerTools(server, asToolSource(api), { allowWrite: true });

  const drafted = await server.tools.get("send_message").handler({ chat_id: ANA.chat_id, text: "hi" });
  now += 2_000;
  const result = await server.tools.get("confirm_send").handler({ draft_id: drafted.structuredContent.draft_id });
  assert.equal(result.structuredContent.error, "DRAFT_EXPIRED");
  assert.match(result.structuredContent.fix, /show the new preview/);
});

const PEER = "40722123456@s.whatsapp.net";

test("draft rejects a missing local file before it touches the socket", async () => {
  const svc = openService(WhatsAppService, offlineConfig("wazap-draft-media-"));
  await assert.rejects(
    () =>
      svc.draft({
        kind: "media",
        chatId: PEER,
        source: { file_path: "/no/such/wazap-media.bin" },
        asDocument: false,
        asVoice: false,
      }),
    (err) => err.code === "FILE_NOT_FOUND"
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
  await assert.rejects(
    () => svc.manageChat(PEER, "pin"),
    (err) => err.code === "RATE_LIMITED"
  );
  await svc.stop();
});
