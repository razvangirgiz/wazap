/**
 * Calls placed while wazap is running. Baileys reports these on the `call`
 * event and never as a message, so the service has to turn them into one and
 * then keep WhatsApp's own account of the same call from doubling it up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const GROUP = "447851830860-1443638182@g.us";

const makeService = () => connectedService(WhatsAppService, { prefix: "wazap-calls-", id: ME, name: "Răzvan" });

const callEvent = (status, { from = PEER, id = "C1", at = Date.now(), ...rest } = {}) => ({
  chatId: from,
  from,
  id,
  date: new Date(at),
  status,
  offline: false,
  ...rest,
});

test("a call nobody picked up shows up in the peer's chat", async () => {
  const { svc, sock } = makeService();
  const at = Date.now() - 30_000;
  sock.ev.emit("call", [callEvent("offer", { at })]);
  sock.ev.emit("call", [callEvent("ringing", { at })]);
  sock.ev.emit("call", [callEvent("timeout", { at })]);

  const messages = (await svc.readMessages(PEER, 10)).data;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "call");
  assert.equal(messages[0].text, "[missed voice call]");
  assert.deepEqual(messages[0].call, { kind: "voice", direction: "incoming", outcome: "missed" });
  assert.equal(messages[0].message_id, `false_${PEER}_call_C1`, "a stable id, so a redelivery lands on it");

  const digest = (await svc.getRecentMessages(24, "all")).data;
  assert.deepEqual(
    digest.map((chat) => chat.chat_id),
    [PEER],
    "and the digest reports it like any other message",
  );
  await svc.stop();
});

test("a call that was picked up is stored as answered", async () => {
  const { svc, sock } = makeService();
  sock.ev.emit("call", [callEvent("offer")]);
  sock.ev.emit("call", [callEvent("accept")]);
  sock.ev.emit("call", [callEvent("terminate")]);

  const messages = (await svc.readMessages(PEER, 10)).data;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].call.outcome, "answered");
  await svc.stop();
});

test("the sweep timer runs only while a call is in flight", async () => {
  const { svc, sock } = makeService();
  assert.equal(svc.callSweepTimer, null, "nothing to sweep before any call");
  sock.ev.emit("call", [callEvent("offer")]);
  assert.notEqual(svc.callSweepTimer, null, "a ringing call needs a deadline");
  await svc.stop();
  assert.equal(svc.callSweepTimer, null, "a stopped service must not hold the process open");
});

test("wazap's own record of a call and the stub baileys makes for it are one call", async () => {
  const { svc, sock } = makeService();
  const at = Date.now() - 40_000;
  sock.ev.emit("call", [callEvent("offer", { at })]);
  sock.ev.emit("call", [callEvent("timeout", { at })]);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: PEER, fromMe: false, id: "BAILEYS" },
        messageTimestamp: Math.floor((at + 20_000) / 1000),
        messageStubType: proto.WebMessageInfo.StubType.CALL_MISSED_VOICE,
      },
    ],
  });

  const messages = (await svc.readMessages(PEER, 10)).data;
  assert.equal(messages.length, 1, `one call, got ${JSON.stringify(messages.map((m) => m.text))}`);
  assert.equal(messages[0].message_id, `false_${PEER}_call_C1`, "the one already stored wins a tie");
  await svc.stop();
});

test("the bare placeholder baileys upserts for a group offer gives way to the real call", async () => {
  const { svc, sock } = makeService();
  const at = Date.now() - 20_000;
  const group = { isGroup: true, groupJid: GROUP, chatId: GROUP, at };
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: GROUP, fromMe: false, id: "OFFER" },
        messageTimestamp: Math.floor(at / 1000),
        message: { call: { callKey: new Uint8Array([1, 2]) } },
      },
    ],
  });
  sock.ev.emit("call", [callEvent("offer", group)]);
  sock.ev.emit("call", [callEvent("reject", group)]);

  const messages = (await svc.readMessages(GROUP, 10)).data;
  assert.equal(messages.length, 1, `one call, got ${JSON.stringify(messages.map((m) => m.text))}`);
  assert.equal(messages[0].text, "[rejected voice call]");
  await svc.stop();
});

test("an ordinary message near a call is left alone", async () => {
  const { svc, sock } = makeService();
  const at = Date.now() - 10_000;
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: PEER, fromMe: false, id: "T1" },
        messageTimestamp: Math.floor(at / 1000),
        message: { conversation: "call me" },
      },
    ],
  });
  sock.ev.emit("call", [callEvent("offer", { at })]);
  sock.ev.emit("call", [callEvent("reject", { at })]);

  const messages = (await svc.readMessages(PEER, 10)).data;
  assert.deepEqual(
    messages.map((m) => m.type),
    ["text", "call"],
  );
  await svc.stop();
});
