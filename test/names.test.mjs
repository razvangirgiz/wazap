/**
 * Name resolution. A group sender used to render as a bare LID — fifteen digits
 * that look exactly like a phone number and are not one — and a stranger with a
 * pushName rendered as their phone number. These pin the ladder that fixed it.
 *
 * Run: npm test  (requires npm run build first — these drive dist/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WhatsAppService } from "../dist/whatsapp.js";

const ME = "40700000001@s.whatsapp.net";

function config() {
  return {
    dataDir: mkdtempSync(join(tmpdir(), "wazap-names-")),
    readOnly: true,
    syncFullHistory: false,
    persistHistory: false,
    transport: "stdio",
    httpHost: "127.0.0.1",
    httpPort: 8766,
    readToken: null,
    writeToken: null,
    rateLimitPerMinute: 20,
    command: "serve",
    loginCode: false,
  };
}

/** Minimal stand-in for a Baileys socket: just the event surface wireEvents uses. */
function makeFakeSocket() {
  const listeners = new Map();
  return {
    ev: {
      on(event, fn) {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      },
      removeAllListeners(event) {
        listeners.delete(event);
      },
      emit(event, arg) {
        for (const fn of listeners.get(event) ?? []) fn(arg);
      },
    },
    end() {},
  };
}

/** A connected service fed only by events, so no socket and no disk are involved. */
function makeService() {
  const svc = new WhatsAppService(config());
  const sock = makeFakeSocket();
  svc.sockClient = sock;
  svc.wireEvents(sock, ++svc.generation);
  svc.account = { id: ME, name: "Răzvan", number: "40700000001" };
  svc.status = "connected";
  svc.initialSyncDone = true;
  return { svc, sock };
}

const message = (chat, { participant, pushName, text = "hi", id = "M1", fromMe = false } = {}) => ({
  key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) },
  message: { conversation: text },
  messageTimestamp: Math.floor(Date.now() / 1000),
  ...(pushName ? { pushName } : {}),
});

test("displayName resolves a jid through one ladder", () => {
  const { svc, sock } = makeService();
  sock.ev.emit("contacts.upsert", [
    { id: "40700000002@s.whatsapp.net", name: "Ana", notify: "ana-on-wa" },
    { id: "40700000003@s.whatsapp.net", notify: "Bogdan" },
    { id: "40700000005@s.whatsapp.net", name: "Dana", lid: "111222333444555@lid" },
    { id: "40700000006@s.whatsapp.net", verifiedName: "Pizza SRL" },
  ]);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [message("40700000004@s.whatsapp.net", { pushName: "Carmen" })],
  });

  const cases = [
    ["saved name wins over the sender's own", "40700000002@s.whatsapp.net", "Ana"],
    ["notify when nothing is saved", "40700000003@s.whatsapp.net", "Bogdan"],
    ["a business name counts as saved", "40700000006@s.whatsapp.net", "Pizza SRL"],
    ["pushName seen on a message", "40700000004@s.whatsapp.net", "Carmen"],
    ["a lid resolves through its phone jid", "111222333444555@lid", "Dana"],
    ["an unresolved lid never poses as a phone number", "4226298167515@lid", "unknown (lid …7515)"],
    ["a phone number with no name at all", "40700000009@s.whatsapp.net", "40700000009"],
    ["the linked account is you", ME, "Răzvan"],
  ];
  for (const [label, jid, expected] of cases) {
    assert.equal(svc.displayName(jid), expected, label);
  }
});

test("a group learns its participants' names and numbers from its metadata", () => {
  const { svc, sock } = makeService();
  const group = "120363000000000001@g.us";
  sock.ev.emit("contacts.upsert", [{ id: "40700000007@s.whatsapp.net", name: "Elena" }]);
  sock.ev.emit("groups.upsert", [
    {
      id: group,
      subject: "Familia",
      participants: [
        { id: "999888777666555@lid", phoneNumber: "40700000007@s.whatsapp.net" },
        { id: "555666777888999@lid", phoneNumber: "40700000008@s.whatsapp.net", notify: "Florin" },
      ],
    },
  ]);

  assert.equal(svc.displayName(group), "Familia");
  assert.equal(svc.displayName("999888777666555@lid"), "Elena", "the saved contact behind the lid");
  assert.equal(svc.displayName("555666777888999@lid"), "Florin", "the name the metadata carried");
  assert.equal(svc.lidToPn.get("999888777666555@lid"), "40700000007@s.whatsapp.net");
});

test("a group message renders its sender as a name, not as a LID", async () => {
  const { svc, sock } = makeService();
  const group = "120363000000000002@g.us";
  sock.ev.emit("groups.upsert", [
    {
      id: group,
      subject: "Drum",
      participants: [{ id: "123123123123123@lid", phoneNumber: "40700000010@s.whatsapp.net" }],
    },
  ]);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [message(group, { participant: "123123123123123@lid", pushName: "Gigi", text: "am ajuns" })],
  });

  const { data } = await svc.readMessages(group, 10);
  assert.equal(data.length, 1);
  assert.equal(data[0].sender.name, "Gigi");
  assert.equal(data[0].sender.id, "40700000010@s.whatsapp.net", "the lid is resolved to the phone jid");
  assert.equal(data[0].sender.phone, "40700000010");
});

test("pushNames survive a store round trip, so a restart does not forget who wrote", () => {
  const { svc, sock } = makeService();
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [message("40700000011@s.whatsapp.net", { pushName: "Horia" })],
  });

  const revived = new WhatsAppService(config());
  revived.store.hydrate(JSON.parse(JSON.stringify(svc.store.serialize())));
  assert.equal(revived.store.pushNames.get("40700000011@s.whatsapp.net"), "Horia");
});
