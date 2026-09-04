/**
 * The address book. WhatsApp sends it as an app state sync snapshot, once per
 * stored collection version, and for a long time the socket that paired ate
 * that one delivery. These pin the recovery: when wazap decides the address
 * book is missing, and what it does about it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { WhatsAppService, needsContactResync } from "../dist/whatsapp.js";
import { connectedService } from "./helpers.mjs";
import { registerTools } from "../dist/tools.js";

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

const ME = "40700000001@s.whatsapp.net";
const COLLECTIONS = ["critical_block", "critical_unblock_low", "regular_high", "regular_low", "regular"];
const DAY = 24 * 3_600_000;
const NOW = 1_800_000_000_000;

const makeService = () => connectedService(WhatsAppService, { prefix: "wazap-contacts-", id: ME, name: "Răzvan" });

/** A socket that records what the resync asked WhatsApp and the auth state for. */
function syncableSocket(sock, { versions = COLLECTIONS } = {}) {
  const stored = Object.fromEntries(versions.map((name) => [name, { version: 21 }]));
  const asked = [];
  sock.authState = {
    keys: {
      get: async (type, ids) => Object.fromEntries(ids.map((id) => [id, stored[id]])),
      set: async (data) => {
        for (const [id, value] of Object.entries(data["app-state-sync-version"] ?? {})) {
          if (value === null) delete stored[id];
          else stored[id] = value;
        }
      },
    },
  };
  sock.resyncAppState = async (collections, isInitialSync) => asked.push({ collections, isInitialSync });
  return { stored, asked };
}

test("the resync decision reads the same four facts every time", () => {
  const cases = [
    ["no names and versions stored: the delivery went somewhere else", { named: 0, storedVersions: true, resyncedAt: null }, true],
    ["names in hand: nothing to heal", { named: 217, storedVersions: true, resyncedAt: null }, false],
    ["no stored version: this connection is already doing the sync", { named: 0, storedVersions: false, resyncedAt: null }, false],
    ["asked yesterday: the account really has no contacts", { named: 0, storedVersions: true, resyncedAt: NOW - DAY }, false],
    ["asked eight days ago: worth one more try", { named: 0, storedVersions: true, resyncedAt: NOW - 8 * DAY }, true],
    ["one name is enough to stop asking", { named: 1, storedVersions: true, resyncedAt: NOW - 8 * DAY }, false],
  ];
  for (const [label, input, expected] of cases) {
    assert.equal(needsContactResync({ ...input, now: NOW }), expected, label);
  }
});

test("a resync forgets every stored version before it asks", async () => {
  const { svc, sock } = makeService();
  const { stored, asked } = syncableSocket(sock);

  await svc.resyncContacts(sock);

  assert.deepEqual(Object.keys(stored), [], "a version left behind would make WhatsApp send patches, not the snapshot");
  assert.deepEqual(asked, [{ collections: COLLECTIONS, isInitialSync: true }]);
  assert.equal(typeof svc.store.contactsResyncedAt, "number");
});

test("the resync stamp survives a store round trip, so a restart does not repeat it", () => {
  const { svc } = makeService();
  svc.store.contactsResyncedAt = NOW;
  const revived = new WhatsAppService(svc.config);
  revived.store.hydrate(svc.store.serialize());
  assert.equal(revived.store.contactsResyncedAt, NOW);
});

test("an older snapshot, written before the stamp existed, reads as never asked", () => {
  const { svc } = makeService();
  svc.store.hydrate({ v: 1, chats: {}, contacts: {}, messages: {}, byChat: {} });
  assert.equal(svc.store.contactsResyncedAt, null);
});

test("a connection that came up without the address book asks for it, once", async () => {
  const { svc, sock } = makeService();
  const { asked } = syncableSocket(sock);
  svc.waitForNames = async () => svc.namedContacts();

  await svc.healContacts(sock, svc.generation);
  assert.equal(asked.length, 1);

  await svc.healContacts(sock, svc.generation);
  assert.equal(asked.length, 1, "at most once per process, whatever reconnects");
});

test("a connection that already has names leaves WhatsApp alone", async () => {
  const { svc, sock } = makeService();
  const { asked } = syncableSocket(sock);
  sock.ev.emit("contacts.upsert", [{ id: "40700000061@s.whatsapp.net", name: "Ionut" }]);

  await svc.healContacts(sock, svc.generation);
  assert.deepEqual(asked, []);
  assert.equal(svc.store.contactsResyncedAt, null);
});

test("a connection with no stored version is already syncing, so it is left to it", async () => {
  const { svc, sock } = makeService();
  const { asked } = syncableSocket(sock, { versions: [] });
  svc.waitForNames = async () => svc.namedContacts();

  await svc.healContacts(sock, svc.generation);
  assert.deepEqual(asked, []);
});

test("the open connection is what starts it", () => {
  const { svc, sock } = makeService();
  let calls = 0;
  svc.healContacts = async () => {
    calls++;
  };
  sock.ev.emit("connection.update", { connection: "open" });
  assert.equal(calls, 1);
});

test("names arriving on either contact event reach the disk", () => {
  const { svc, sock } = makeService();
  svc.config.persistHistory = true;
  sock.ev.emit("contacts.upsert", [{ id: "40700000051@s.whatsapp.net", name: "Ionut" }]);
  assert.equal(svc.storeDirty, true, "contacts.upsert");

  svc.storeDirty = false;
  sock.ev.emit("contacts.update", [{ id: "40700000051@s.whatsapp.net", name: "Ionut Fox" }]);
  assert.equal(svc.storeDirty, true, "contacts.update");
  assert.equal(svc.displayName("40700000051@s.whatsapp.net"), "Ionut Fox");
  if (svc.storeSaveTimer) clearTimeout(svc.storeSaveTimer);
});

test("sync_contacts reports what the resync changed, and never counts as a write", async () => {
  const server = fakeServer();
  registerTools(server, { syncContacts: async () => ({ requested: true, named_before: 0, named_after: 217 }) }, {
    allowWrite: false,
  });
  const tool = server.tools.get("sync_contacts");
  assert.equal(tool.meta.annotations.readOnlyHint, true, "it changes nothing on WhatsApp");

  const result = await tool.handler({});
  assert.deepEqual(result.structuredContent, { requested: true, named_before: 0, named_after: 217 });
  assert.match(result.content[0].text, /217 named contacts \(was 0\)/);
});

test("sync_contacts tells an empty address book apart from one already in hand", async () => {
  const say = async (named_before, named_after) => {
    const server = fakeServer();
    registerTools(server, { syncContacts: async () => ({ requested: true, named_before, named_after }) }, {
      allowWrite: true,
    });
    return (await server.tools.get("sync_contacts").handler({})).content[0].text;
  };
  assert.match(await say(0, 0), /no names at all/);
  assert.match(await say(217, 217), /already current: 217/);
});

test("sync_contacts on a session that is not connected reports the code, not a crash", async () => {
  const { svc } = makeService();
  svc.status = "connecting";
  const server = fakeServer();
  registerTools(server, svc, { allowWrite: true });
  const result = await server.tools.get("sync_contacts").handler({});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "NOT_CONNECTED");
});

test("get_contact answers within a deadline when WhatsApp never replies for the number", async () => {
  const { svc, sock } = makeService();
  sock.fetchStatus = () => new Promise(() => {});
  sock.profilePictureUrl = () => new Promise(() => {});
  const started = Date.now();
  const contact = await svc.getContact("+40 700 000 099");
  assert.ok(Date.now() - started < 12_000, "did not wait for the MCP request timeout");
  assert.equal(contact.number, "40700000099");
  assert.equal(contact.about, null);
  assert.equal(contact.profile_pic_url, null);
});

test("search_contacts finds a number typed with the national leading zero", async () => {
  const { svc, sock } = makeService();
  sock.ev.emit("contacts.upsert", [{ id: "40734000111@s.whatsapp.net", name: "Ana" }]);
  const found = await svc.searchContacts("0734 000 111", 10);
  assert.deepEqual(found.map((c) => c.name), ["Ana"]);
  const stillFound = await svc.searchContacts("40734", 10);
  assert.deepEqual(stillFound.map((c) => c.name), ["Ana"]);
});
