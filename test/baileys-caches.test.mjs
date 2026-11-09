/**
 * What the service's socket is opened with so a send costs less: Signal keys
 * served from a bounded cache in front of the credential files (every write
 * still lands in a file), and group metadata from the service's own group
 * cache instead of a WhatsApp query per group send.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BoundedKeyCache, cachedAuthState, useAtomicAuthState } from "../dist/auth-state.js";
import { socketFactory } from "../dist/pairing.js";
import { AccountGroups, SEND_METADATA_MS } from "../dist/service/groups.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { fakeSocket, offlineConfig, openService, waitFor } from "./helpers.mjs";

const GROUP = "120363000000000077@g.us";
const ME = "40700000001@s.whatsapp.net";

test("the key cache keeps the newest-used keys up to its bound and forgets them after their time", () => {
  let now = 0;
  const cache = new BoundedKeyCache(3, 1000, () => now);
  for (const key of ["a", "b", "c"]) cache.set(key, key.toUpperCase());
  assert.equal(cache.get("a"), "A", "reading a key makes it the newest");
  cache.set("d", "D");
  assert.equal(cache.size, 3);
  assert.equal(cache.get("b"), undefined, "the least recently used went first");
  assert.deepEqual(["a", "c", "d"].map((key) => cache.get(key)), ["A", "C", "D"]);
  now = 1000;
  assert.equal(cache.get("a"), undefined, "a key is served for its time and no longer");
  cache.set("e", null);
  assert.equal(cache.get("e"), null, "a deleted key is remembered as deleted");
  cache.del("e");
  assert.equal(cache.get("e"), undefined);
  cache.flushAll();
  assert.equal(cache.size, 0);
});

async function authDir() {
  const dir = mkdtempSync(join(tmpdir(), "wazap-keys-"));
  const { state } = await useAtomicAuthState(dir);
  return { dir, state };
}

test("cached keys are written through to their files, and read from memory afterwards", async () => {
  const { dir, state } = await authDir();
  const cached = cachedAuthState(state);
  assert.equal(cached.creds, state.creds, "the credentials Baileys updates in place are the same object saveCreds writes");
  await cached.keys.set({ session: { "40700000002.0": { record: "one" } } });
  const file = join(dir, "session-40700000002.0.json");
  assert.ok(existsSync(file), "the write reached its file");
  assert.deepEqual((await state.keys.get("session", ["40700000002.0"]))["40700000002.0"], { record: "one" });
  rmSync(file);
  assert.deepEqual(
    (await cached.keys.get("session", ["40700000002.0"]))["40700000002.0"],
    { record: "one" },
    "the second read came from memory, not the file"
  );
  await cached.keys.set({ session: { "40700000002.0": null } });
  assert.equal((await cached.keys.get("session", ["40700000002.0"]))["40700000002.0"], null, "a deleted key reads as deleted");
});

test("a write that fails leaves nothing in the cache the files do not hold", async () => {
  const { dir, state } = await authDir();
  const cached = cachedAuthState(state);
  await cached.keys.set({ "pre-key": { 1: { public: Buffer.from("aa"), private: Buffer.from("bb") } } });
  const circular = {};
  circular.self = circular;
  await assert.rejects(cached.keys.set({ "pre-key": { 1: circular } }));
  const read = (await cached.keys.get("pre-key", ["1"]))["1"];
  assert.deepEqual(Buffer.from(read.public), Buffer.from("aa"), "after the failure the key is read from its file again");
  assert.ok(existsSync(join(dir, "pre-key-1.json")));
});

test("the service socket gets the cached key store, and group sends address members from the group cache", async (t) => {
  const config = offlineConfig("wazap-caches-", { readOnly: false });
  const svc = openService(WhatsAppService, config);
  t.after(() => svc.stop());
  const authDirPath = join(config.dataDir, "accounts", "default", "auth");
  mkdirSync(authDirPath, { recursive: true });
  writeFileSync(join(authDirPath, "creds.json"), JSON.stringify({ me: { id: "40700000001:12@s.whatsapp.net", name: "Owner" } }));

  const meta = (subject) => ({ id: GROUP, subject, participants: [{ id: ME, admin: null }, { id: "40700000002@s.whatsapp.net", admin: null }] });
  const fetched = [];
  let opened = null;
  const sock = fakeSocket({ user: { id: "40700000001:12@s.whatsapp.net", name: "Owner" } });
  sock.groupMetadata = async (jid) => {
    fetched.push(jid);
    return meta("Fetched");
  };
  const original = socketFactory.open;
  socketFactory.open = (options) => {
    opened = options;
    return sock;
  };
  t.after(() => (socketFactory.open = original));

  await svc.start();
  await waitFor(() => opened !== null, 5000, "the service socket");
  assert.equal(typeof opened.auth.keys.get, "function");
  await opened.auth.keys.set({ "sender-key": { [`${GROUP}::40700000002::0`]: { k: 1 } } });
  assert.ok(existsSync(join(authDirPath, `sender-key-${GROUP}--40700000002--0.json`)), "a key the socket stores is written to its file");

  svc.status = "connected";
  sock.ev.emit("groups.upsert", [meta("Cached")]);
  assert.equal((await opened.cachedGroupMetadata(GROUP)).subject, "Cached", "a group the account has is served from the cache");
  assert.deepEqual(fetched, [], "no metadata query for it");

  sock.ev.emit("group-participants.update", { id: GROUP, participants: ["40700000003@s.whatsapp.net"], action: "add" });
  assert.equal((await opened.cachedGroupMetadata(GROUP)).subject, "Fetched", "membership changed: read again");
  assert.equal((await opened.cachedGroupMetadata(GROUP)).subject, "Fetched");
  assert.deepEqual(fetched, [GROUP], "once, then kept");

  // Another admin turns disappearing messages on: Baileys reports it as a chat update, and the next send must carry it.
  sock.ev.emit("chats.update", [{ id: GROUP, ephemeralExpiration: 86_400, ephemeralSettingTimestamp: 1 }]);
  sock.ev.emit("chats.update", [{ id: "40700000002@s.whatsapp.net", ephemeralExpiration: 86_400 }]);
  assert.equal((await opened.cachedGroupMetadata(GROUP)).subject, "Fetched");
  assert.deepEqual(fetched, [GROUP, GROUP], "the setting changed: read again before the send");
  await opened.cachedGroupMetadata(GROUP);
  assert.equal(fetched.length, 2, "then kept");

  // A new socket may have missed changes while none was connected: every group is read again once.
  const reopened = opened;
  await svc.start();
  await waitFor(() => opened !== reopened, 5000, "the second socket");
  svc.status = "connected";
  await opened.cachedGroupMetadata(GROUP);
  await opened.cachedGroupMetadata(GROUP);
  assert.deepEqual(fetched, [GROUP, GROUP, GROUP], "read again once after the reconnect");

  sock.groupMetadata = async () => {
    throw Object.assign(new Error("forbidden"), { output: { statusCode: 403 } });
  };
  assert.equal(await opened.cachedGroupMetadata("120363000000000078@g.us"), undefined, "a group that cannot be read is left to Baileys");
});

function groupsWith(fetch) {
  const clock = { now: 1_000_000 };
  const sock = { groupMetadata: fetch };
  const host = { guarded: (work) => work(), ensureConnected: () => sock, beginWrite: () => sock, learnGroup: () => {} };
  const identity = { canonical: (jid) => jid };
  return { groups: new AccountGroups(host, identity, {}, () => clock.now), clock };
}

test("a send trusts a group's members for five minutes after they were read, then reads them again", async () => {
  let members = ["40700000001@s.whatsapp.net", "40700000002@s.whatsapp.net"];
  let fetches = 0;
  const { groups, clock } = groupsWith(async (jid) => {
    fetches++;
    return { id: jid, subject: "Grup", participants: members.map((id) => ({ id, admin: null })) };
  });
  const ids = async () => (await groups.forSend(GROUP)).participants.map((p) => p.id);
  assert.equal((await ids()).length, 2);
  assert.equal(fetches, 1);
  // Someone joins and no event says so (the socket was down): the cache cannot know.
  members = [...members, "40700000005@s.whatsapp.net"];
  clock.now += SEND_METADATA_MS - 1;
  assert.equal((await ids()).length, 2, "within its time the entry is served as read");
  assert.equal(fetches, 1);
  clock.now += 1;
  assert.equal((await ids()).length, 3, "past it, the send reads the group again and addresses the newcomer");
  assert.equal(fetches, 2);
  assert.equal(groups.groupCache.get(GROUP).participants.length, 3, "the read refreshes the cache the reads use");

  groups.rereadBeforeSend(GROUP);
  await ids();
  assert.equal(fetches, 3, "a group marked for a re-read is read again");
  groups.rereadBeforeSend();
  await ids();
  assert.equal(fetches, 4, "and so is every group after a reconnect");
});

test("sends waiting on the same group share one read; a read that fails leaves the send to Baileys", async () => {
  let fetches = 0;
  let fail = false;
  const { groups, clock } = groupsWith(async (jid) => {
    fetches++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (fail) throw new Error("timed out");
    return { id: jid, subject: "Grup", participants: [{ id: ME, admin: null }] };
  });
  const [a, b, c] = await Promise.all([groups.forSend(GROUP), groups.forSend(GROUP), groups.forSend(GROUP)]);
  assert.equal(fetches, 1, "one query for three sends");
  assert.ok(a === b && b === c);
  clock.now += SEND_METADATA_MS;
  fail = true;
  assert.equal(await groups.forSend(GROUP), undefined, "an entry past its time is not served when it cannot be read again");
  assert.equal(await groups.forSend("40700000002@s.whatsapp.net"), undefined, "not a group: nothing to address");
  assert.equal(fetches, 2);
});
