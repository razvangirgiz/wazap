/**
 * find_contact inside one process, where an end-to-end world cannot reach:
 * the address book asked for once per boot when it looks empty, an account
 * that may not send getting no draft context in a session that may, an
 * account that cannot answer, and a stand-in without the service behind it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AccountHub } from "../dist/account-hub.js";
import { AccountRegistry } from "../dist/accounts.js";
import { registerTools } from "../dist/tools.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { asToolSource, connectedService, fakeSocket, offlineConfig } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const WORK_ME = "40700000002@s.whatsapp.net";
const ANA = "40722000001@s.whatsapp.net";
const DAN = "40722000002@s.whatsapp.net";
const COLLECTIONS = ["critical_block", "critical_unblock_low", "regular_high", "regular_low", "regular"];

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) };
}

function connect(svc, id) {
  const sock = fakeSocket();
  svc.sockClient = sock;
  svc.wireEvents(sock, ++svc.generation);
  svc.account = { id, name: "Andrei", number: id.split("@")[0] };
  svc.status = "connected";
  svc.initialSyncDone = true;
  return sock;
}

/** A person with a saved name and a short exchange, both ways. */
function seed(svc, jid, name) {
  svc.db.identity.upsertContact({ jid, name, listed: true });
  const now = Date.now();
  svc.db.messages.upsert({ chatJid: jid, keyId: `${name}1`, fromMe: false, ts: now - 60_000, type: "text", text: `Salut de la ${name}` });
  svc.db.messages.upsert({ chatJid: jid, keyId: `${name}2`, fromMe: true, ts: now - 30_000, type: "text", text: "hai ca vin" });
}

test("an empty address book is asked for once per boot before the first answer, then never again", async () => {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-find-sync-", id: ME, name: "Andrei" });
  const stored = Object.fromEntries(COLLECTIONS.map((name) => [name, { version: 3 }]));
  sock.authState = {
    keys: {
      get: async (_type, ids) => Object.fromEntries(ids.map((id) => [id, stored[id]])),
      set: async (data) => {
        for (const id of Object.keys(data["app-state-sync-version"] ?? {})) delete stored[id];
      },
    },
  };
  const asked = [];
  // WhatsApp answers the resync with the address book, the way the snapshot arrives.
  sock.resyncAppState = async (collections) => {
    asked.push(collections);
    sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana Pop" }]);
  };

  const first = await svc.findContact({ name: "Ana" });
  assert.equal(asked.length, 1, "asked before answering");
  assert.equal(first.verdict, "resolved", "and the answer already reads the names that came back");
  assert.equal(first.candidates[0].candidate.jid, ANA);
  await svc.findContact({ name: "Ana" });
  assert.equal(asked.length, 1, "once per boot");
  await svc.stop();

  const named = connectedService(WhatsAppService, { prefix: "wazap-find-sync-", id: ME, name: "Andrei" });
  named.sock.resyncAppState = async () => assert.fail("an address book with names is not asked for");
  named.sock.ev.emit("contacts.upsert", [{ id: DAN, name: "Dan Radu" }]);
  assert.equal((await named.svc.findContact({ name: "Dan" })).verdict, "resolved");
  await named.svc.stop();
});

test("a failed ask for the address book still answers from what is stored", async () => {
  const { svc } = connectedService(WhatsAppService, { prefix: "wazap-find-sync-", id: ME, name: "Andrei" });
  svc.db.identity.upsertContact({ jid: ANA, pushName: "Ana" });
  const found = await svc.findContact({ name: "Ana" });
  assert.equal(found.verdict, "resolved");
  assert.equal(found.accountId, "default");
  await svc.stop();
});

test("a session that may write gets no draft context for an account that may not; the account that may keeps it", async () => {
  const config = offlineConfig("wazap-find-hub-", { readOnly: false });
  const registry = AccountRegistry.load(config.dataDir);
  registry.add("work", "Work");
  registry.setWrites("work", false);
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  const home = hub.get("default");
  const work = hub.get("work");
  connect(home, ME);
  connect(work, WORK_ME);
  seed(home, ANA, "Ana Pop");
  seed(work, DAN, "Dan Radu");
  const server = fakeServer();
  registerTools(server, asToolSource(hub), { allowWrite: true });
  const find = (args) => server.tools.get("find_contact").handler(args);

  const dan = (await find({ name: "Dan Radu" })).structuredContent;
  assert.deepEqual([dan.status, dan.contact.account_id, dan.context], ["resolved", "work", undefined]);
  const ana = (await find({ name: "Ana Pop" })).structuredContent;
  assert.deepEqual([ana.status, ana.contact.account_id], ["resolved", "default"]);
  assert.deepEqual(
    ana.context.recent.map((line) => [line.from_me, line.text]),
    [
      [false, "Salut de la Ana Pop"],
      [true, "hai ca vin"],
    ]
  );

  const readServer = fakeServer();
  registerTools(readServer, asToolSource(hub), { allowWrite: false });
  assert.ok(readServer.tools.has("find_contact"), "a read session has the tool");
  assert.equal((await readServer.tools.get("find_contact").handler({ name: "Ana Pop" })).structuredContent.context, undefined);

  // One account down: the other still answers, and says which one could not.
  work.status = "disconnected";
  const partial = (await find({ name: "Ana Pop" })).structuredContent;
  assert.equal(partial.status, "resolved");
  assert.deepEqual(partial.accounts_unavailable, [{ account_id: "work", error: "NOT_CONNECTED" }]);
  home.status = "disconnected";
  const down = await find({ name: "Ana Pop" });
  assert.equal(down.isError, true);
  assert.equal(down.structuredContent.error, "NOT_CONNECTED");
  await hub.stop();
});

test("a stand-in without the service behind it answers SERVICE_ERROR, never a crash", async () => {
  const server = fakeServer();
  registerTools(server, asToolSource({}), { allowWrite: false });
  const result = await server.tools.get("find_contact").handler({ name: "Ana" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "SERVICE_ERROR");
});
