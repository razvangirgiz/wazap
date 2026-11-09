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

  sock.groupMetadata = async () => {
    throw Object.assign(new Error("forbidden"), { output: { statusCode: 403 } });
  };
  assert.equal(await opened.cachedGroupMetadata("120363000000000078@g.us"), undefined, "a group that cannot be read is left to Baileys");
});
