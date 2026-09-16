/**
 * confirm_send against the account database: a draft is sent at most once,
 * whatever the socket, a second confirm, a crash or a restart does. A draft
 * carries the WhatsApp key it goes out under; a failure before that key
 * reached the socket gives the draft back with the code it had, one after it
 * is SEND_OUTCOME_UNKNOWN until WhatsApp echoes the key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DraftStore } from "../dist/drafts.js";
import { registerTools } from "../dist/tools.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { asToolSource, connectedService, storageRows, waitFor } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const STRANGER = "40700000099@s.whatsapp.net";
const OWNER = "session_a";
const WEBHOOK_KEYS = ["WAZAP_WEBHOOK", "WAZAP_WEBHOOK_URL", "WAZAP_WEBHOOK_SECRET", "WAZAP_WEBHOOK_EVENTS"];

function dataDirFor(t) {
  const dir = mkdtempSync(join(tmpdir(), "wazap-sends-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A connected service over `dataDir`: the same directory again is a restart. */
function serviceOn(t, dataDir, config = {}) {
  const connected = connectedService(WhatsAppService, {
    prefix: "wazap-sends-",
    id: ME,
    name: "Răzvan",
    config: { dataDir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0, ...config },
  });
  t.after(() => connected.svc.stop());
  connected.sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
  connected.sent = [];
  answerSends(connected.sock, connected.sent);
  return connected;
}

/** Baileys' media upload and relay: what goes out, and the id it goes out under. */
function answerSends(sock, sent) {
  sock.waUploadToServer = async () => ({ mediaUrl: "https://mmg.whatsapp.net/synthetic", directPath: "/synthetic" });
  sock.relayMessage = async (jid, message, options) => {
    sent.push({ jid, message, options });
    return options.messageId;
  };
}

function inbound(id, body, chat = PEER) {
  return { key: { remoteJid: chat, fromMe: false, id }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: body } };
}

/** What WhatsApp echoes of the account's own message, whichever device sent it. */
function own(id, body, chat = PEER) {
  return { key: { remoteJid: chat, fromMe: true, id }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: body } };
}

function upsert(sock, type, ...messages) {
  sock.ev.emit("messages.upsert", { type, messages });
}

function sendRow(svc, draftId) {
  return storageRows(svc, "SELECT state, key_id, payload, receipt, error_code FROM sends WHERE draft_id = ?", draftId)[0];
}

test("two confirms of one draft at once send it once and answer the same receipt", async (t) => {
  const { svc, sock, sent } = serviceOn(t, dataDirFor(t));
  const view = await svc.draft({ kind: "text", chatId: PEER, text: "Joi la 10." }, OWNER);
  let letGo;
  const gate = new Promise((resolve) => (letGo = resolve));
  const answer = sock.relayMessage;
  sock.relayMessage = async (...args) => {
    await gate;
    return answer(...args);
  };

  const first = svc.confirm(view.draft_id, OWNER);
  const second = svc.confirm(view.draft_id, OWNER);
  await assert.rejects(svc.confirm(view.draft_id, "session_b"), { code: "DRAFT_NOT_FOUND" }, "another session learns nothing");
  letGo();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(sent.length, 1);
  assert.deepEqual(a, b);
  assert.equal(sendRow(svc, view.draft_id).state, "sent");
});

test("confirming a sent draft again answers its receipt with already_sent and sends nothing", async (t) => {
  const { svc, sent } = serviceOn(t, dataDirFor(t));
  const view = await svc.draft({ kind: "text", chatId: PEER, text: "Joi la 10." }, OWNER);
  const receipt = await svc.confirm(view.draft_id, OWNER);
  assert.equal(receipt.already_sent, undefined);
  assert.equal(receipt.message_id, `true_${PEER}_${sent[0].options.messageId}`, "the send went out under the draft's key");

  const again = await svc.confirm(view.draft_id, OWNER);
  assert.deepEqual(again, { ...receipt, already_sent: true });
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sendRow(svc, view.draft_id).payload).payload, undefined, "a sent draft no longer keeps its words");
  await assert.rejects(svc.confirm(view.draft_id, "session_b"), { code: "DRAFT_NOT_FOUND" });
  await assert.rejects(svc.confirm(view.draft_id), { code: "DRAFT_NOT_FOUND" });
});

test("a send that fails after reaching the socket is unknown, never sent again, and becomes sent when WhatsApp echoes its key", async (t) => {
  const { svc, sock, sent } = serviceOn(t, dataDirFor(t));
  const view = await svc.draft({ kind: "text", chatId: PEER, text: "Joi la 10." }, OWNER);
  const keys = [];
  sock.relayMessage = async (_jid, _message, options) => {
    keys.push(options.messageId);
    throw new Error("Timed Out");
  };
  await assert.rejects(svc.confirm(view.draft_id, OWNER), (err) => {
    assert.equal(err.code, "SEND_OUTCOME_UNKNOWN");
    assert.match(err.message, /Timed Out/);
    assert.match(err.fix, /read_messages/);
    return true;
  });
  assert.equal(sendRow(svc, view.draft_id).state, "unknown");
  answerSends(sock, sent);
  await assert.rejects(svc.confirm(view.draft_id, OWNER), { code: "SEND_OUTCOME_UNKNOWN" });
  assert.equal(keys.length, 1);
  assert.equal(sent.length, 0, "an unknown send is never tried again");

  upsert(sock, "notify", own(keys[0], "Joi la 10."));
  const receipt = await svc.confirm(view.draft_id, OWNER);
  assert.equal(receipt.message_id, `true_${PEER}_${keys[0]}`);
  assert.equal(receipt.text, "Joi la 10.");
  assert.equal(receipt.already_sent, true);
  assert.equal(sendRow(svc, view.draft_id).state, "sent");
  assert.equal(sent.length, 0);
});

test("a crash while a send is under way leaves it unknown after the restart, until WhatsApp echoes its key", async (t) => {
  const dataDir = dataDirFor(t);
  const first = serviceOn(t, dataDir);
  const view = await first.svc.draft({ kind: "text", chatId: PEER, text: "Joi la 10." }, OWNER);
  const keys = [];
  first.sock.relayMessage = (_jid, _message, options) => {
    keys.push(options.messageId);
    return new Promise(() => {});
  };
  void first.svc.confirm(view.draft_id, OWNER).catch(() => {});
  await waitFor(() => keys.length === 1, 3_000, "the send handed to the socket");
  assert.equal(sendRow(first.svc, view.draft_id).state, "sending");
  // The process dies here: nothing settles the row.
  first.svc.accountDb.close();

  const second = serviceOn(t, dataDir);
  assert.equal(sendRow(second.svc, view.draft_id).state, "unknown");
  await assert.rejects(second.svc.confirm(view.draft_id, OWNER), { code: "SEND_OUTCOME_UNKNOWN" });
  await assert.rejects(second.svc.confirm(view.draft_id, "session_b"), { code: "DRAFT_NOT_FOUND" });
  assert.equal(second.sent.length, 0);

  upsert(second.sock, "notify", own(keys[0], "Joi la 10."));
  assert.equal((await second.svc.confirm(view.draft_id, OWNER)).message_id, `true_${PEER}_${keys[0]}`);
  assert.equal(second.sent.length, 0);
});

test("a message stored under the key before a crash makes the send sent at the restart", async (t) => {
  const dataDir = dataDirFor(t);
  const first = serviceOn(t, dataDir);
  const view = await first.svc.draft({ kind: "text", chatId: PEER, text: "Joi la 10." }, OWNER);
  const keys = [];
  first.sock.relayMessage = (_jid, _message, options) => {
    keys.push(options.messageId);
    return new Promise(() => {});
  };
  void first.svc.confirm(view.draft_id, OWNER).catch(() => {});
  await waitFor(() => keys.length === 1, 3_000, "the send handed to the socket");
  upsert(first.sock, "append", own(keys[0], "Joi la 10."));
  first.svc.accountDb.close();

  const second = serviceOn(t, dataDir);
  assert.equal(sendRow(second.svc, view.draft_id).state, "sent");
  const receipt = await second.svc.confirm(view.draft_id, OWNER);
  assert.equal(receipt.message_id, `true_${PEER}_${keys[0]}`);
  assert.equal(second.sent.length, 0);
});

test("failures before the send leaves give the draft back with Calfa's definitely-unsent codes, and its key stays live", async (t) => {
  const { svc, sock, sent } = serviceOn(t, dataDirFor(t), { rateLimitPerMinute: 1 });
  const view = await svc.draft({ kind: "text", chatId: STRANGER, text: "Bună ziua." }, OWNER);
  const back = () => assert.equal(sendRow(svc, view.draft_id).state, "draft");

  for (const [status, code] of [
    ["connecting", "NOT_CONNECTED"],
    ["disconnected", "NOT_CONNECTED"],
    ["linking", "NOT_CONNECTED"],
    ["auth_failure", "NOT_CONNECTED"],
    ["not_linked", "NOT_LINKED"],
    ["logged_out", "SESSION_EXPIRED"],
    ["session_corrupt", "SESSION_CORRUPT"],
  ]) {
    svc.status = status;
    await assert.rejects(svc.confirm(view.draft_id, OWNER), { code }, status);
    back();
  }
  svc.status = "connected";

  // The number is checked again at confirm; a lookup with no answer is not a verdict on it.
  // That attempt spends the minute's one write.
  sock.onWhatsApp = async () => {
    throw new Error("Timed Out");
  };
  await assert.rejects(svc.confirm(view.draft_id, OWNER), { code: "NOT_CONNECTED" });
  back();
  sock.onWhatsApp = async (jid) => [{ jid, exists: true }];

  await assert.rejects(svc.confirm(view.draft_id, OWNER), { code: "RATE_LIMITED" });
  back();
  assert.equal(sent.length, 0);

  svc.writes = { take() {} };
  const receipt = await svc.confirm(view.draft_id, OWNER);
  const key = sendRow(svc, view.draft_id).key_id;
  assert.equal(receipt.message_id, `true_${STRANGER}_${key}`, "the draft's own key, after every refusal");
  assert.equal(storageRows(svc, "SELECT count(*) AS n FROM retracted WHERE key_id = ?", key)[0].n, 0);
  const stored = await svc.getMessage(receipt.message_id);
  assert.equal(stored.text, "Bună ziua.", "stored as a message, not a tombstone");
});

test("a failure while the message is built, before the relay, leaves the draft unsent; a relay that fails is unknown", async (t) => {
  const dataDir = dataDirFor(t);
  const { svc, sock, sent } = serviceOn(t, dataDir);
  const file = join(dataDir, "contract.pdf");
  writeFileSync(file, "%PDF-1.4 synthetic");
  const view = await svc.draft(
    { kind: "media", chatId: PEER, source: { file_path: file }, caption: "actele", asDocument: true, asVoice: false, asGif: false },
    OWNER
  );
  const upload = sock.waUploadToServer;
  sock.waUploadToServer = async () => {
    throw new Error("upload refused");
  };
  await assert.rejects(svc.confirm(view.draft_id, OWNER), (err) => {
    assert.notEqual(err.code, "SEND_OUTCOME_UNKNOWN", "nothing reached WhatsApp");
    assert.match(err.message, /upload refused/);
    return true;
  });
  assert.equal(sendRow(svc, view.draft_id).state, "draft");
  assert.equal(sent.length, 0);

  sock.waUploadToServer = upload;
  const relay = sock.relayMessage;
  sock.relayMessage = async () => {
    throw new Error("Connection Closed");
  };
  await assert.rejects(svc.confirm(view.draft_id, OWNER), { code: "SEND_OUTCOME_UNKNOWN" });
  sock.relayMessage = relay;
  await assert.rejects(svc.confirm(view.draft_id, OWNER), { code: "SEND_OUTCOME_UNKNOWN" });
  assert.equal(sent.length, 0);
});

test("a poll goes out as sendMessage sends one, with its creation node", async (t) => {
  const { svc, sent } = serviceOn(t, dataDirFor(t));
  const view = await svc.draft({ kind: "poll", chatId: PEER, question: "Pizza?", options: ["da", "nu"], multiSelect: false }, OWNER);
  const receipt = await svc.confirm(view.draft_id, OWNER);
  assert.equal(receipt.text, "[poll] Pizza?");
  const [{ message, options }] = sent;
  assert.ok(message.pollCreationMessageV3 ?? message.pollCreationMessage, "a poll creation message");
  assert.deepEqual(options.additionalNodes, [{ tag: "meta", attrs: { polltype: "creation" } }]);
});

test("a draft past its lifetime is DRAFT_EXPIRED once and sends nothing", async (t) => {
  const { svc, sent } = serviceOn(t, dataDirFor(t));
  let now = Date.now();
  svc.drafts = new DraftStore(() => now);
  const view = await svc.draft({ kind: "text", chatId: PEER, text: "salut" }, OWNER);
  now += 16 * 60_000;
  await assert.rejects(svc.confirm(view.draft_id, OWNER), { code: "DRAFT_EXPIRED" });
  await assert.rejects(svc.confirm(view.draft_id, OWNER), { code: "DRAFT_NOT_FOUND" });
  assert.equal(sent.length, 0);
});

test("a media draft is confirmed after a restart as it was frozen: the recipient, the file, the caption and its kind", async (t) => {
  const dataDir = dataDirFor(t);
  const file = join(dataDir, "contract.pdf");
  writeFileSync(file, "%PDF-1.4 synthetic");
  const first = serviceOn(t, dataDir);
  const view = await first.svc.draft(
    { kind: "media", chatId: "+40 700 000 002", source: { file_path: file }, caption: "actele", asDocument: true, asVoice: false, asGif: false },
    OWNER
  );
  assert.equal(view.to.chat_id, PEER);
  await first.svc.stop();

  const second = serviceOn(t, dataDir);
  const receipt = await second.svc.confirm(view.draft_id, OWNER);
  assert.equal(second.sent.length, 1);
  const [{ jid, message, options }] = second.sent;
  assert.equal(jid, PEER);
  assert.equal(message.documentMessage.caption, "actele");
  assert.equal(message.documentMessage.fileName, "contract.pdf");
  assert.equal(message.documentMessage.mimetype, "application/pdf");
  assert.equal(receipt.text, "actele");
  assert.equal(receipt.message_id, `true_${PEER}_${options.messageId}`);
});

test("a draft outlives a restart on disk, but no session after it can confirm it", async (t) => {
  const dataDir = dataDirFor(t);
  const toolsOf = (svc) => {
    const tools = new Map();
    registerTools({ registerTool: (name, _meta, handler) => tools.set(name, handler) }, asToolSource(svc), { allowWrite: true });
    return (name, args) => tools.get(name)(args);
  };
  const first = serviceOn(t, dataDir);
  const drafted = await toolsOf(first.svc)("send_message", { chat_id: PEER, text: "salut" });
  const draftId = drafted.structuredContent.draft_id;
  await first.svc.stop();

  const second = serviceOn(t, dataDir);
  assert.equal(second.svc.hasDraft(draftId), true);
  const replay = await toolsOf(second.svc)("confirm_send", { draft_id: draftId });
  assert.equal(replay.structuredContent.error, "DRAFT_NOT_FOUND");
  await assert.rejects(second.svc.confirm(draftId, "session_b"), { code: "DRAFT_NOT_FOUND" });
  assert.equal(second.sent.length, 0);
});

test("past the draft's 15 minutes, its session still gets the receipt of a sent draft and SEND_OUTCOME_UNKNOWN of an unknown one", async (t) => {
  const { svc, sock, sent } = serviceOn(t, dataDirFor(t));
  const tools = new Map();
  registerTools({ registerTool: (name, _meta, handler) => tools.set(name, handler) }, asToolSource(svc), { allowWrite: true });
  const call = (name, args) => tools.get(name)(args);

  const sentDraft = (await call("send_message", { chat_id: PEER, text: "trimis" })).structuredContent.draft_id;
  const receipt = (await call("confirm_send", { draft_id: sentDraft })).structuredContent;
  const unknownDraft = (await call("send_message", { chat_id: PEER, text: "poate" })).structuredContent.draft_id;
  const relay = sock.relayMessage;
  sock.relayMessage = async () => {
    throw new Error("Timed Out");
  };
  assert.equal((await call("confirm_send", { draft_id: unknownDraft })).structuredContent.error, "SEND_OUTCOME_UNKNOWN");
  sock.relayMessage = relay;

  const later = Date.now() + 16 * 60_000;
  t.mock.method(Date, "now", () => later);
  // Drafting later is what ages the session's routes out.
  await call("send_message", { chat_id: PEER, text: "altceva" });
  const again = (await call("confirm_send", { draft_id: sentDraft })).structuredContent;
  assert.equal(again.message_id, receipt.message_id);
  assert.equal(again.already_sent, true);
  assert.equal((await call("confirm_send", { draft_id: unknownDraft })).structuredContent.error, "SEND_OUTCOME_UNKNOWN");
  assert.equal(sent.length, 1);
});

test("the echo of a confirmed draft is not announced as message_sent, even after a restart", async (t) => {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const saved = WEBHOOK_KEYS.map((key) => [key, process.env[key]]);
  Object.assign(process.env, {
    WAZAP_WEBHOOK: "on",
    WAZAP_WEBHOOK_URL: `http://127.0.0.1:${server.address().port}/hook`,
    WAZAP_WEBHOOK_SECRET: "sends-test-secret",
    WAZAP_WEBHOOK_EVENTS: "all",
  });
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const dataDir = dataDirFor(t);
  const first = serviceOn(t, dataDir);
  const view = await first.svc.draft({ kind: "text", chatId: PEER, text: "Te aștept." }, OWNER);
  const keys = [];
  first.sock.relayMessage = async (_jid, _message, options) => {
    keys.push(options.messageId);
    throw new Error("Connection Closed");
  };
  await assert.rejects(first.svc.confirm(view.draft_id, OWNER), { code: "SEND_OUTCOME_UNKNOWN" });
  await first.svc.stop();

  const second = serviceOn(t, dataDir);
  upsert(second.sock, "notify", own(keys[0], "Te aștept."));
  upsert(second.sock, "notify", own("PHONE", "Te aștept."));
  upsert(second.sock, "notify", inbound("IN", "Mulțumesc"));
  await waitFor(() => received.length >= 2, 3_000, "the phone's message_sent and the inbound message");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    received.map((body) => [body.event, body.message_id]).sort(),
    [
      ["message_received", `false_${PEER}_IN`],
      ["message_sent", `true_${PEER}_PHONE`],
    ],
    "wazap's own send stays quiet; the same words typed on the phone do not"
  );
  assert.equal(sendRow(second.svc, view.draft_id).state, "sent");
});

test("a number WhatsApp gave no answer about is NOT_CONNECTED; only an answer makes it NOT_ON_WHATSAPP", async (t) => {
  const { svc, sock } = serviceOn(t, dataDirFor(t));
  const draft = () => svc.draft({ kind: "text", chatId: STRANGER, text: "salut" }, OWNER);
  for (const [lookup, code] of [
    [async () => { throw new Error("Timed Out"); }, "NOT_CONNECTED"],
    [async () => undefined, "NOT_CONNECTED"],
    [async () => [], "NOT_ON_WHATSAPP"],
    [async (jid) => [{ jid, exists: false }], "NOT_ON_WHATSAPP"],
  ]) {
    sock.onWhatsApp = lookup;
    await assert.rejects(draft(), { code });
  }
  sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
  assert.equal((await draft()).to.chat_id, STRANGER);
});

for (const action of ["clear", "delete"]) {
  test(`a chat ${action} takes the words out of the chat's sends, and a repeated confirm still sends nothing`, async (t) => {
    const { svc, sock, sent } = serviceOn(t, dataDirFor(t));
    sock.chatModify = async () => {};
    const sentView = await svc.draft({ kind: "text", chatId: PEER, text: "cuvinte trimise" }, OWNER);
    const receipt = await svc.confirm(sentView.draft_id, OWNER);
    const unknownView = await svc.draft({ kind: "text", chatId: PEER, text: "cuvinte poate" }, OWNER);
    const relay = sock.relayMessage;
    sock.relayMessage = async () => {
      throw new Error("Timed Out");
    };
    await assert.rejects(svc.confirm(unknownView.draft_id, OWNER), { code: "SEND_OUTCOME_UNKNOWN" });
    sock.relayMessage = relay;
    const otherChat = await svc.draft({ kind: "text", chatId: STRANGER, text: "cuvinte altundeva" }, OWNER);
    await svc.confirm(otherChat.draft_id, OWNER);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await svc.manageChat(PEER, action);

    for (const id of [sentView.draft_id, unknownView.draft_id]) {
      const row = sendRow(svc, id);
      assert.doesNotMatch(`${row.payload}${row.receipt}`, /cuvinte/, `${row.state} send`);
    }
    assert.match(sendRow(svc, otherChat.draft_id).receipt, /cuvinte altundeva/, "another chat's send keeps its words");
    const again = await svc.confirm(sentView.draft_id, OWNER);
    assert.equal(again.message_id, receipt.message_id);
    assert.equal(again.text, "");
    await assert.rejects(svc.confirm(unknownView.draft_id, OWNER), { code: "SEND_OUTCOME_UNKNOWN" });
    assert.equal(sent.length, 2);
  });
}

test("a chat clear reaches an unknown send drafted to the person's lid before their number was known", async (t) => {
  const { svc, sock } = serviceOn(t, dataDirFor(t));
  sock.chatModify = async () => {};
  const LID = "123456789012345@lid";
  const view = await svc.draft({ kind: "text", chatId: LID, text: "cuvinte prin lid" }, OWNER);
  assert.equal(view.to.chat_id, LID);
  sock.relayMessage = async () => {
    throw new Error("Timed Out");
  };
  await assert.rejects(svc.confirm(view.draft_id, OWNER), { code: "SEND_OUTCOME_UNKNOWN" });
  sock.ev.emit("lid-mapping.update", { lid: LID, pn: PEER });
  await svc.db.learnLidPhone(LID, PEER);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await svc.manageChat(PEER, "clear");
  assert.doesNotMatch(sendRow(svc, view.draft_id).payload, /cuvinte/);
});

/** A draft left unsent, one sent and one unknown, all saying "cuvinte". */
async function threeSends(svc, sock) {
  await svc.draft({ kind: "text", chatId: PEER, text: "cuvinte nesemnate" }, OWNER);
  const sentView = await svc.draft({ kind: "text", chatId: PEER, text: "cuvinte trimise" }, OWNER);
  await svc.confirm(sentView.draft_id, OWNER);
  const unknownView = await svc.draft({ kind: "text", chatId: PEER, text: "cuvinte poate" }, OWNER);
  const relay = sock.relayMessage;
  sock.relayMessage = async () => {
    throw new Error("Timed Out");
  };
  await assert.rejects(svc.confirm(unknownView.draft_id, OWNER), { code: "SEND_OUTCOME_UNKNOWN" });
  sock.relayMessage = relay;
}

function assertNoSendWords(svc) {
  const rows = storageRows(svc, "SELECT state, payload, receipt FROM sends ORDER BY state");
  assert.deepEqual(rows.map((row) => row.state), ["sent", "unknown"], "no draft is kept");
  for (const row of rows) assert.doesNotMatch(`${row.payload}${row.receipt}`, /cuvinte/, `${row.state} send`);
}

test("an account that keeps no history keeps no draft and no sent words once it stops", async (t) => {
  const { svc, sock } = serviceOn(t, dataDirFor(t), { persistHistory: false });
  await threeSends(svc, sock);
  await svc.stop();
  assertNoSendWords(svc);
});

test("an account that keeps no history forgets the words of its sends at the start after a crash", async (t) => {
  const dataDir = dataDirFor(t);
  const first = serviceOn(t, dataDir);
  await threeSends(first.svc, first.sock);
  first.svc.accountDb.close();

  const second = serviceOn(t, dataDir, { persistHistory: false });
  await second.svc.bootStorage();
  assertNoSendWords(second.svc);
});

test("deleting a sent message takes its words out of the send record, and a repeated confirm still sends nothing", async (t) => {
  const { svc, sock, sent } = serviceOn(t, dataDirFor(t));
  sock.chatModify = async () => {};
  const view = await svc.draft({ kind: "text", chatId: PEER, text: "cuvinte de șters" }, OWNER);
  const receipt = await svc.confirm(view.draft_id, OWNER);
  await svc.deleteMessage(receipt.message_id, false);

  const row = sendRow(svc, view.draft_id);
  assert.equal(row.state, "sent");
  assert.doesNotMatch(`${row.payload}${row.receipt}`, /cuvinte/);
  const again = await svc.confirm(view.draft_id, OWNER);
  assert.equal(again.message_id, receipt.message_id);
  assert.equal(again.text, "");
  assert.equal(sent.length, 1);
});
