/**
 * The running roster follows accounts.json: an account added or enabled gets a
 * service, one disabled or removed loses it, and a logout runs against the
 * running process. WhatsApp is a fake socket throughout; nothing reaches the
 * network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

import { AccountHub } from "../dist/account-hub.js";
import { resolveToolAccount } from "../dist/account-resolve.js";
import { AccountRegistry } from "../dist/accounts.js";
import { accountPaths, paths } from "../dist/config.js";
import { AccountDb } from "../dist/db/index.js";
import { logoutAccount } from "../dist/logout.js";
import { socketFactory } from "../dist/pairing.js";
import { anyAccountAllowsWrites, registerTools } from "../dist/tools.js";
import { asToolSource, fakeSocket, offlineConfig, stubSockets, waitFor } from "./helpers.mjs";

const HOME = "40700000001@s.whatsapp.net";
const WORK = "40700000002@s.whatsapp.net";
const DAN = "40700000004@s.whatsapp.net";

function toolsOf(hub) {
  const tools = new Map();
  registerTools(
    { registerTool: (name, _meta, handler) => tools.set(name, handler) },
    asToolSource(hub),
    { allowWrite: anyAccountAllowsWrites(hub) }
  );
  return tools;
}

function connect(svc, { id, name }) {
  const sock = fakeSocket();
  svc.sockClient = sock;
  svc.wireEvents(sock, ++svc.generation);
  svc.account = { id, name, number: id.split("@")[0] };
  svc.status = "connected";
  svc.initialSyncDone = true;
  return sock;
}

/** Credentials that read as linked; the fake socket factory never looks inside. */
function seedCreds(dataDir, id, jid) {
  const storage = accountPaths(dataDir, id);
  mkdirSync(storage.authDir, { recursive: true });
  writeFileSync(join(storage.authDir, "creds.json"), JSON.stringify({ me: { id: jid.replace("@", ":7@"), name: "Work" } }));
  writeFileSync(storage.storeFile, '{"v":1,"chats":{}}');
  return storage;
}

/**
 * A hub serving `default` and `work`, both connected over fake sockets, marked
 * started without starting anything: a real start on linked credentials would
 * open a Baileys socket.
 */
function twoAccountHub(t, { linkedWork = false, persistHistory = false } = {}) {
  const config = offlineConfig("wazap-roster-", { readOnly: false, persistHistory });
  const registry = AccountRegistry.load(config.dataDir);
  registry.add("work", "Work");
  if (linkedWork) {
    seedCreds(config.dataDir, "work", WORK);
    registry.setOwner("work", WORK);
  }
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  hub.started = true;
  const home = hub.get("default");
  const work = hub.get("work");
  connect(home, { id: HOME, name: "Home" });
  const workSock = connect(work, { id: WORK, name: "Work" });
  t.after(() => hub.stop());
  return { config, hub, home, work, workSock };
}

/** What linkSession opens for a logout: a socket that opens, and records the unlink. */
function unlinkSockets(t, { refuse } = {}) {
  const calls = { logout: 0 };
  const original = socketFactory.open;
  socketFactory.open = () => {
    const sock = fakeSocket();
    sock.logout = async () => {
      calls.logout += 1;
      if (refuse) throw refuse;
      sock.end();
    };
    setImmediate(() => sock.ev.emit("connection.update", { connection: "open" }));
    return sock;
  };
  t.after(() => (socketFactory.open = original));
  return calls;
}

test("an account added on disk is started by a reload, and a started one is not_linked", async (t) => {
  const { config, hub } = twoAccountHub(t);
  AccountRegistry.load(config.dataDir).add("late");
  const change = hub.reload();
  assert.deepEqual(change, { added: ["late"], removed: [], kept: [] });
  const late = hub.get("late");
  assert.ok(late);
  await waitFor(() => late.getStatus().status === "not_linked", 5_000, "the new account to settle");
  assert.equal(hub.record("late").enabled, true);
});

test("a hot-added account resolves for link_account without any reload call", async (t) => {
  const { config, hub } = twoAccountHub(t);
  AccountRegistry.load(config.dataDir).add("late");
  const result = await toolsOf(hub).get("link_account")({ phone: "not-a-phone", account_id: "late" });
  assert.notEqual(result.structuredContent.error, "ACCOUNT_NOT_FOUND", result.structuredContent.message);
  assert.equal(result.structuredContent.account_id, "late");
  assert.ok(hub.get("late"));
});

test("an id that is on disk nowhere is still ACCOUNT_NOT_FOUND after the re-read", async (t) => {
  const { hub } = twoAccountHub(t);
  const result = await toolsOf(hub).get("get_status")({ account_id: "ghost" });
  assert.equal(result.structuredContent.error, "ACCOUNT_NOT_FOUND");
  assert.equal(hub.get("ghost"), undefined);
});

test("disable stops the account's service, and every tool that names it refuses ACCOUNT_DISABLED", async (t) => {
  const { config, hub, work, workSock } = twoAccountHub(t);
  workSock.ev.emit("chats.upsert", [{ id: DAN }]);
  AccountRegistry.load(config.dataDir).disable("work");
  assert.deepEqual(hub.reload(), { added: [], removed: ["work"], kept: [] });
  await hub.settled();
  assert.equal(work.stopped, true, "the socket's service is stopped");
  assert.equal(workSock.ended, true, "the socket is closed");
  assert.equal(hub.get("work"), undefined);

  const tools = toolsOf(hub);
  for (const [name, args] of [
    ["get_status", {}],
    ["read_messages", { chat_id: DAN, limit: 20 }],
    ["send_message", { chat_id: DAN, text: "hi" }],
  ]) {
    const result = await tools.get(name)({ ...args, account_id: "work" });
    assert.equal(result.structuredContent.error, "ACCOUNT_DISABLED", name);
  }
  // A chat only the stopped account knew no longer routes to it.
  const implicit = await tools.get("read_messages")({ chat_id: DAN, limit: 20 });
  assert.equal(implicit.structuredContent.account_id, "default");

  const listed = await tools.get("list_accounts")({});
  assert.equal(listed.structuredContent.accounts.find((row) => row.id === "work").status, "disabled");
});

test("enable brings a fresh service back, without the stopped one's state", async (t) => {
  const { config, hub, work } = twoAccountHub(t);
  AccountRegistry.load(config.dataDir).disable("work");
  hub.reload();
  await hub.settled();
  AccountRegistry.load(config.dataDir).enable("work");
  assert.deepEqual(hub.reload().added, ["work"]);
  const back = hub.get("work");
  assert.ok(back);
  assert.notEqual(back, work);
  await waitFor(() => back.getStatus().status === "not_linked", 5_000, "the fresh service to start");
});

test("the default follows the registry", async (t) => {
  const { config, hub } = twoAccountHub(t);
  assert.equal(hub.defaultBinding().id, "default");
  AccountRegistry.load(config.dataDir).setDefault("work");
  hub.reload();
  assert.equal(hub.defaultBinding().id, "work");
  const listed = await toolsOf(hub).get("list_accounts")({});
  assert.equal(listed.structuredContent.default, "work");
});

test("a reload never stops the last running account", async (t) => {
  const config = offlineConfig("wazap-roster-last-", { readOnly: false });
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  t.after(() => hub.stop());
  const only = hub.get("default");
  AccountRegistry.load(config.dataDir).disable("default");
  assert.deepEqual(hub.reload(), { added: [], removed: [], kept: ["default"] });
  assert.equal(hub.get("default"), only);
  assert.equal(only.stopped, false);
  // Still fail-closed where it matters: the record says disabled.
  const result = await toolsOf(hub).get("get_status")({ account_id: "default" });
  assert.equal(result.structuredContent.error, "ACCOUNT_DISABLED");
});

for (const [label, damage] of [
  ["malformed", (file) => writeFileSync(file, "{not json")],
  // The .required marker is what turns a lost policy into an error, not open defaults.
  ["missing", (file) => rmSync(file)],
]) {
  test(`a ${label} registry fails the reload closed and leaves the roster alone`, async (t) => {
    const { config, hub, work } = twoAccountHub(t);
    const file = paths(config.dataDir).accountsFile;
    assert.equal(existsSync(`${file}.required`), true);
    damage(file);
    assert.throws(() => hub.reload(), (err) => err.code === "INVALID_ID");
    assert.equal(hub.get("work"), work);
    assert.equal(work.stopped, false);
    const result = await toolsOf(hub).get("get_status")({ account_id: "ghost" });
    assert.equal(result.structuredContent.error, "INVALID_ID", "an unknown id is not reported as merely absent");
  });
}

test("remove cancels the account's transcription under way before its service stops", async (t) => {
  const { hub, work } = twoAccountHub(t, { linkedWork: true });
  const order = [];
  const abort = work.abortTranscription.bind(work);
  work.abortTranscription = () => {
    order.push("abort");
    abort();
  };
  const stop = work.stop.bind(work);
  work.stop = async () => {
    order.push("stop");
    await stop();
  };
  await hub.remove("work");
  assert.deepEqual(order, ["abort", "stop"]);
});

test("remove while connected stops the socket and closes the database before the folder goes", async (t) => {
  const { config, hub, work, workSock } = twoAccountHub(t, { linkedWork: true });
  await work.bootStorage();
  const root = accountPaths(config.dataDir, "work").root;
  assert.equal(existsSync(join(root, "wazap.sqlite")), true);
  let stoppedBeforeDelete = null;
  let closedBeforeDelete = null;
  const originalStop = work.stop.bind(work);
  work.stop = async () => {
    const db = work.db;
    await originalStop();
    stoppedBeforeDelete = existsSync(root);
    closedBeforeDelete = db.isOpen === false;
  };
  await hub.remove("work");
  assert.equal(stoppedBeforeDelete, true, "the folder was still there when the service finished stopping");
  assert.equal(closedBeforeDelete, true, "the database was closed before its folder was deleted");
  assert.equal(workSock.ended, true);
  assert.equal(existsSync(root), false, "the folder goes whole, the database with it");
  assert.equal(AccountRegistry.load(config.dataDir).get("work"), undefined);
  assert.equal(hub.get("work"), undefined);
  assert.equal(hub.record("work"), undefined);
  const result = await toolsOf(hub).get("get_status")({ account_id: "work" });
  assert.equal(result.structuredContent.error, "ACCOUNT_NOT_FOUND");
});

test("remove refuses the only account being served, and an unknown one", async (t) => {
  const config = offlineConfig("wazap-roster-remove-last-", { readOnly: false });
  const registry = AccountRegistry.load(config.dataDir);
  registry.add("work");
  registry.disable("work");
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  t.after(() => hub.stop());
  await assert.rejects(hub.remove("default"), /only account being served/);
  assert.equal(hub.get("default").stopped, false);
  await assert.rejects(hub.remove("ghost"), /No account "ghost"/);
  await hub.remove("work");
  assert.equal(AccountRegistry.load(config.dataDir).get("work"), undefined);
});

test("logout of a connected account unlinks it and leaves a fresh not_linked service", async (t) => {
  const { config, hub, work, workSock } = twoAccountHub(t, { linkedWork: true, persistHistory: true });
  await work.bootStorage();
  workSock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: DAN, fromMe: false, id: "KEPT" },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: "istoric păstrat" },
      },
    ],
  });
  const kept = `false_${DAN}_KEPT`;
  assert.equal(work.hasMessage(kept), true);
  const calls = unlinkSockets(t);
  const storage = accountPaths(config.dataDir, "work");

  assert.equal(await hub.logout("work"), "logged_out");
  assert.equal(calls.logout, 1, "WhatsApp was told to unlink");
  assert.equal(work.stopped, true);
  assert.equal(workSock.ended, true, "the account's own socket closed first");
  assert.equal(existsSync(storage.authDir), false, "credentials deleted");
  assert.equal(existsSync(join(storage.root, "legacy", "store.json")), true, "the legacy snapshot the boot moved aside is left to its week");
  assert.equal(AccountRegistry.load(config.dataDir).get("work").owner, null);
  assert.equal(hub.record("work").owner, null);

  const fresh = hub.get("work");
  assert.notEqual(fresh, work);
  await waitFor(() => fresh.getStatus().status === "not_linked", 5_000, "the fresh service to settle");
  assert.equal(hub.get("default").getStatus().status, "connected", "the other account never noticed");

  // A logout unlinks the device; the message history stays for the same number to link again.
  assert.equal(existsSync(join(storage.root, "wazap.sqlite")), true, "the database is kept");
  await fresh.bootStorage();
  assert.equal(fresh.hasMessage(kept), true, "the fresh service reads the history the old one stored");
});

test("logout when the phone already removed the device still clears everything", async (t) => {
  const { config, hub } = twoAccountHub(t, { linkedWork: true });
  unlinkSockets(t, { refuse: { output: { statusCode: 401 } } });
  assert.equal(await hub.logout("work"), "already_unlinked");
  assert.equal(existsSync(accountPaths(config.dataDir, "work").authDir), false);
});

test("logout of an account that never linked is not_linked and changes nothing on disk", async (t) => {
  const { config, hub } = twoAccountHub(t);
  const calls = unlinkSockets(t);
  const before = AccountRegistry.load(config.dataDir).get("work");
  assert.equal(await hub.logout("work"), "not_linked");
  assert.equal(calls.logout, 0, "no socket for nothing to unlink");
  assert.deepEqual(AccountRegistry.load(config.dataDir).get("work"), before);
  await assert.rejects(hub.logout("ghost"), /No account "ghost"/);
});

test("logout of a disabled account unlinks it without starting it", async (t) => {
  const { config, hub } = twoAccountHub(t, { linkedWork: true });
  AccountRegistry.load(config.dataDir).disable("work");
  hub.reload();
  await hub.settled();
  const calls = unlinkSockets(t);
  assert.equal(await hub.logout("work"), "logged_out");
  assert.equal(calls.logout, 1);
  assert.equal(hub.get("work"), undefined);
});

test("logout cancels a pairing in flight, so no credentials land after it", async (t) => {
  const { hub } = twoAccountHub(t);
  const work = hub.get("work");
  work.status = "not_linked";
  work.sockClient = null;
  const phoneSide = fakeSocket({ pairingCode: "K7PX3MQZ", user: { id: `${WORK.split("@")[0]}:12@s.whatsapp.net` } });
  const pairing = stubSockets(socketFactory, [phoneSide]);
  t.after(() => pairing.restore());

  const linking = toolsOf(hub).get("link_account")({ phone: `+${WORK.split("@")[0]}`, account_id: "work" });
  await waitFor(() => pairing.opened.length > 0, 5_000, "the pairing socket to open");
  phoneSide.ev.emit("connection.update", { qr: "pairing-qr" });
  const code = await linking;
  assert.equal(code.isError, undefined, JSON.stringify(code.structuredContent));
  assert.equal(work.getStatus().status, "linking");

  assert.equal(await hub.logout("work"), "not_linked");
  assert.equal(phoneSide.ended, true, "the pairing socket was closed");
  const fresh = hub.get("work");
  await waitFor(() => fresh.getStatus().status === "not_linked", 5_000, "the fresh service to settle");
  assert.equal(hub.record("work").owner, null);
});

test("a give-up from a service that was replaced does not count toward exiting", async (t) => {
  const { config, hub, work } = twoAccountHub(t);
  let exited = 0;
  hub.onGiveUp = () => (exited += 1);
  AccountRegistry.load(config.dataDir).disable("work");
  hub.reload();
  AccountRegistry.load(config.dataDir).enable("work");
  hub.reload();
  assert.notEqual(hub.get("work"), work);
  // The stopped service reporting late is not the account giving up.
  work.onGiveUp();
  const home = hub.get("default");
  home.reconnectAttempts = 10;
  home.scheduleReconnect("Connection Terminated");
  assert.equal(exited, 0, "the fresh work service is still up");
});

// ---------------------------------------------------------------------------
// A logout or a removal that fails half-way leaves the account served, at once.
// ---------------------------------------------------------------------------

/** Run `after` once `svc` has finished stopping: the failure lands between the stop and the rest. */
function afterStop(svc, after) {
  const stop = svc.stop.bind(svc);
  svc.stop = async () => {
    await stop();
    after();
  };
}

/**
 * What link_account does with an account: resolve it the way the tool does,
 * then link on that service. The tool's own budget (two calls a minute, for
 * the whole process) is spent by the tests above, so the handler is not the
 * way in here.
 */
async function linkThrough(hub, id) {
  const phoneSide = fakeSocket({ pairingCode: "K7PX3MQZ", user: { id: "40700000002:12@s.whatsapp.net" } });
  const pairing = stubSockets(socketFactory, [phoneSide]);
  try {
    const { wa } = resolveToolAccount(hub, { account_id: id, phone: "+40700000002" }, { name: "link_account", write: false });
    const linking = wa.link("+40700000002");
    await waitFor(() => pairing.opened.length > 0, 5_000, "the pairing socket to open");
    phoneSide.ev.emit("connection.update", { qr: "pairing-qr" });
    return { wa, code: (await linking).code };
  } finally {
    pairing.restore();
  }
}

/** The account answers from a live service that is not `old`: get_status through the tool, then a link. */
async function assertServedAgain(hub, id, old) {
  const fresh = hub.get(id);
  assert.ok(fresh, "the account is on the roster");
  assert.notEqual(fresh, old, "not the service the failed operation stopped");
  assert.equal(fresh.stopped, false);
  await waitFor(() => fresh.getStatus().status === "not_linked", 5_000, "the fresh service to settle");
  const status = await toolsOf(hub).get("get_status")({ account_id: id });
  assert.equal(status.isError, undefined, JSON.stringify(status.structuredContent));
  assert.equal(status.structuredContent.account_id, id);
  assert.equal(status.structuredContent.status, "not_linked");
  const linked = await linkThrough(hub, id);
  assert.equal(linked.wa, fresh);
  assert.equal(linked.code, "K7PX-3MQZ");
  assert.equal(fresh.getStatus().status, "linking");
}

test("a logout binds the account database to the number before its credentials go, creating it for an account never started", async (t) => {
  const config = offlineConfig("wazap-roster-bind-", { readOnly: false });
  const storage = accountPaths(config.dataDir, "default");
  mkdirSync(storage.authDir, { recursive: true });
  writeFileSync(join(storage.authDir, "creds.json"), JSON.stringify({ me: { id: "40700000001:7@s.whatsapp.net" } }));
  writeFileSync(storage.storeFile, '{"v":1,"chats":{}}');
  unlinkSockets(t);
  const dbPath = join(storage.root, "wazap.sqlite");
  assert.equal(existsSync(dbPath), false);
  assert.equal(await logoutAccount(config.dataDir, "default", 2_000), "logged_out");
  assert.equal(existsSync(storage.authDir), false);
  assert.equal(existsSync(storage.storeFile), true, "the legacy file is left for its number");
  const db = AccountDb.open(dbPath, { readOnly: true });
  assert.equal(db.getMeta("owner"), "40700000001@s.whatsapp.net");
  db.close();
});

test("a logout whose clear step throws propagates the error and leaves the account served by a live service", async (t) => {
  const { config, hub, work } = twoAccountHub(t, { linkedWork: true });
  unlinkSockets(t);
  const storage = accountPaths(config.dataDir, "work");
  // The credentials delete throws once the service stopped. It is simulated at
  // fs.rmSync rather than with a read-only folder: whether a recursive delete
  // fails there, and after which entries, depends on the platform and on who
  // runs the tests (Linux walks to the folder before creds.json, macOS after
  // it, and a container user may be allowed to delete from it).
  const realRmSync = fs.rmSync;
  const restore = () => {
    fs.rmSync = realRmSync;
    syncBuiltinESMExports();
  };
  t.after(restore);
  afterStop(work, () => {
    fs.rmSync = (path, options) => {
      if (String(path) === storage.authDir) {
        // A partial delete: the credentials are gone, the rest of the folder is not.
        realRmSync(join(storage.authDir, "creds.json"), { force: true });
        throw Object.assign(new Error(`EACCES: permission denied, rm '${path}'`), { code: "EACCES" });
      }
      return realRmSync(path, options);
    };
    syncBuiltinESMExports();
  });
  await assert.rejects(hub.logout("work"), (err) => err.code === "EACCES");
  restore();
  assert.equal(work.stopped, true);
  await assertServedAgain(hub, "work", work);
});

test("a logout that cannot record the owner on an unreadable policy still leaves the account served", async (t) => {
  const { config, hub, work } = twoAccountHub(t, { linkedWork: true });
  unlinkSockets(t);
  const file = paths(config.dataDir).accountsFile;
  const policy = readFileSync(file, "utf8");
  afterStop(work, () => writeFileSync(file, "{broken"));
  await assert.rejects(hub.logout("work"), (err) => err.code === "INVALID_ID");
  assert.ok(hub.get("work") && hub.get("work") !== work && !hub.get("work").stopped, "served again before repair");
  writeFileSync(file, policy);
  await assertServedAgain(hub, "work", work);
});

test("a removal whose registry write fails propagates the error and serves the account again at once", async (t) => {
  const { config, hub, work } = twoAccountHub(t);
  const file = paths(config.dataDir).accountsFile;
  // A directory at the temp path the registry writes through: the rename never happens.
  afterStop(work, () => mkdirSync(`${file}.${process.pid}.tmp`));
  t.after(() => rmSync(`${file}.${process.pid}.tmp`, { recursive: true, force: true }));
  await assert.rejects(hub.remove("work"), (err) => err.code === "EISDIR");
  assert.equal(work.stopped, true);
  assert.ok(AccountRegistry.load(config.dataDir).get("work"), "the registry still has the account");
  assert.equal(existsSync(accountPaths(config.dataDir, "work").root), true, "and its folder");
  rmSync(`${file}.${process.pid}.tmp`, { recursive: true, force: true });
  await assertServedAgain(hub, "work", work);
});

test("a removal that finds the policy unreadable propagates the error and serves the account again at once", async (t) => {
  const { config, hub, work } = twoAccountHub(t);
  const file = paths(config.dataDir).accountsFile;
  const policy = readFileSync(file, "utf8");
  afterStop(work, () => writeFileSync(file, "{broken"));
  await assert.rejects(hub.remove("work"), (err) => err.code === "INVALID_ID");
  assert.ok(hub.get("work") && hub.get("work") !== work && !hub.get("work").stopped, "served again before repair");
  writeFileSync(file, policy);
  await assertServedAgain(hub, "work", work);
});
