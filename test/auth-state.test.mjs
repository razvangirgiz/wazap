/**
 * The stock Baileys useMultiFileAuthState truncates a file before rewriting it,
 * so a kill -9 in that window leaves unreadable creds and the account has to be
 * re-linked. These tests pin the properties that replace that behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { useAtomicAuthState, readLinkedAccount, clearAuth } from "../dist/auth-state.js";

function authDir() {
  return join(mkdtempSync(join(tmpdir(), "wazap-auth-")), "auth");
}

test("creates the auth directory private to the user", async () => {
  const dir = authDir();
  await useAtomicAuthState(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("saveCreds writes creds.json with 0600 and leaves no temp file behind", async () => {
  const dir = authDir();
  const { saveCreds } = await useAtomicAuthState(dir);
  await saveCreds();
  assert.equal(statSync(join(dir, "creds.json")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("a failed write leaves the previous file byte-for-byte intact", async () => {
  const dir = authDir();
  const { state } = await useAtomicAuthState(dir);
  await state.keys.set({ "pre-key": { 1: { public: Buffer.from("aa"), private: Buffer.from("bb") } } });
  const file = join(dir, "pre-key-1.json");
  const before = readFileSync(file);

  const circular = {};
  circular.self = circular;
  await assert.rejects(state.keys.set({ "pre-key": { 1: circular } }));

  assert.deepEqual(readFileSync(file), before, "the old key survived the failed write");
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no partial file left behind");
});

test("concurrent writes to one key never leave torn JSON", async () => {
  const dir = authDir();
  const { state } = await useAtomicAuthState(dir);
  await Promise.all(
    Array.from({ length: 200 }, (_, i) =>
      state.keys.set({ "pre-key": { 1: { public: Buffer.alloc(i + 1, i % 256), private: Buffer.alloc(64, 7) } } }),
    ),
  );
  const text = readFileSync(join(dir, "pre-key-1.json"), "utf8");
  assert.doesNotThrow(() => JSON.parse(text), "every observable state of the file is valid JSON");
  const read = await state.keys.get("pre-key", ["1"]);
  assert.ok(read["1"], "the key is still readable after the write storm");
});

test("a deleted key removes its file", async () => {
  const dir = authDir();
  const { state } = await useAtomicAuthState(dir);
  await state.keys.set({ "pre-key": { 1: { public: Buffer.from("aa"), private: Buffer.from("bb") } } });
  await state.keys.set({ "pre-key": { 1: null } });
  assert.equal(readdirSync(dir).includes("pre-key-1.json"), false);
});

test("readLinkedAccount reports nothing before a login", async () => {
  const dir = authDir();
  const { saveCreds } = await useAtomicAuthState(dir);
  assert.equal(readLinkedAccount(dir), null, "no creds file at all");
  await saveCreds();
  assert.equal(readLinkedAccount(dir), null, "fresh creds are not registered yet");
});

test("unreadable creds surface as SESSION_CORRUPT with a fix", async () => {
  const dir = authDir();
  await useAtomicAuthState(dir);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "creds.json"), "{ not json");
  assert.throws(
    () => readLinkedAccount(dir),
    (err) => {
      assert.equal(err.code, "SESSION_CORRUPT");
      assert.match(err.fix, /wazap-mcp logout/);
      return true;
    },
  );
});

test("clearAuth removes the whole directory and is idempotent", async () => {
  const dir = authDir();
  const { saveCreds } = await useAtomicAuthState(dir);
  await saveCreds();
  clearAuth(dir);
  assert.throws(() => statSync(dir));
  clearAuth(dir);
});
