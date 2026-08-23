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

test("a redial is a second call, not a duplicate of the first", async () => {
  const { svc, sock } = makeService();
  const first = Date.now() - 90_000;
  sock.ev.emit("call", [callEvent("offer", { id: "C1", at: first })]);
  sock.ev.emit("call", [callEvent("timeout", { id: "C1", at: first })]);

  const second = first + 40_000;
  sock.ev.emit("call", [callEvent("offer", { id: "C2", at: second })]);
  sock.ev.emit("call", [callEvent("reject", { id: "C2", at: second })]);

  const messages = (await svc.readMessages(PEER, 10)).data;
  assert.deepEqual(
    messages.map((m) => m.text),
    ["[missed voice call]", "[rejected voice call]"],
    "calling back forty seconds later must not eat the call before it",
  );
  await svc.stop();
});

test("a call the user placed from a LID-addressed device is outgoing", async () => {
  const { svc, sock } = makeService();
  const MY_LID = "273520764416235@lid";
  sock.ev.emit("lid-mapping.update", { lid: MY_LID, pn: ME });

  const at = Date.now() - 30_000;
  const mine = { from: MY_LID, chatId: PEER, at };
  sock.ev.emit("call", [callEvent("offer", mine)]);
  sock.ev.emit("call", [callEvent("timeout", mine)]);

  const messages = (await svc.readMessages(PEER, 10)).data;
  assert.equal(messages.length, 1, "and it lands in the peer's chat, not the user's own");
  assert.equal(messages[0].text, "[outgoing voice call · unanswered]");
  assert.equal(messages[0].from_me, true);
  await svc.stop();
});

test("types narrows a read to calls, and the limit counts the calls it kept", async () => {
  const { svc, sock } = makeService();
  const t0 = Date.now() - 600_000;
  const text = (id, at, body) => ({
    key: { remoteJid: PEER, fromMe: false, id },
    messageTimestamp: Math.floor(at / 1000),
    message: { conversation: body },
  });
  const call = (id, at) => ({
    key: { remoteJid: PEER, fromMe: false, id },
    messageTimestamp: Math.floor(at / 1000),
    messageStubType: proto.WebMessageInfo.StubType.CALL_MISSED_VOICE,
  });

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      text("T1", t0, "before"),
      // Well over CALL_DEDUPE_WINDOW_MS apart, or the second call would eat the first.
      call("CALL_A", t0 + 60_000),
      text("T2", t0 + 120_000, "between"),
      call("CALL_B", t0 + 300_000),
      text("T3", t0 + 360_000, "after"),
    ],
  });

  const all = (await svc.readMessages(PEER, 10)).data;
  assert.deepEqual(
    all.map((m) => m.type),
    ["text", "call", "text", "call", "text"],
    "the unfiltered read keeps the interleaving",
  );

  const calls = (await svc.readMessages(PEER, 10, undefined, ["call"])).data;
  assert.deepEqual(
    calls.map((m) => m.type),
    ["call", "call"],
  );

  const capped = (await svc.readMessages(PEER, 2, undefined, ["call"])).data;
  assert.equal(capped.length, 2, "limit 2 must mean two calls, not two messages of which one is a call");

  await svc.stop();
});
