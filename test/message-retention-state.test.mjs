import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageRetention } from "../dist/message-retention.js";

async function stateFile(t) {
  const dir = await mkdtemp(join(tmpdir(), "wazap-retention-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "retention.json");
}
const gate = () => { let release; const promise = new Promise((done) => { release = done; }); return { promise, release }; };

test("private content-free barriers survive independently of history and include the cutoff instant", async (t) => {
  const file = await stateFile(t);
  const state = new MessageRetention();
  state.deleted.set("deleted-sid", "chat-a");
  state.cleared.set("chat-b", 10_000);
  await state.serialize(() => state.save(file));
  const loaded = new MessageRetention();
  await loaded.load(file);
  assert.equal(loaded.allows("deleted-sid", "chat-a", 99_999), false);
  assert.equal(loaded.allows("unseen", "chat-b", 10_000), false);
  assert.equal(loaded.allows("newer", "chat-b", 10_001), true);
  assert.equal(loaded.allows("unrelated", "chat-c", 0), true);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8"))).sort(), ["cleared", "deleted", "version"]);
});

test("future expiry metadata survives a restart, cannot be extended, and survives alias normalization", async (t) => {
  const file = await stateFile(t);
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const state = new MessageRetention();
  const lid = "false_42@lid_M1"; const phone = "false_42@s.whatsapp.net_M1";
  assert.equal(state.noteExpiry(lid, "42@lid", 10_000), true);
  assert.equal(state.noteExpiry(lid, "42@lid", 20_000), false);
  state.alias("42@lid", "42@s.whatsapp.net");
  await state.serialize(() => state.save(file));
  const loaded = new MessageRetention(); await loaded.load(file);
  assert.equal(loaded.nextExpiry(), 10_000);
  assert.equal(loaded.allows(phone, "42@s.whatsapp.net", 1_000), true);
  now = 10_000;
  assert.equal(loaded.allows(phone, "42@s.whatsapp.net", 1_000), false);
  assert.deepEqual(new Set(loaded.expire()), new Set([lid, phone]));
  assert.equal(loaded.nextExpiry(), undefined);
  now = 1_000;
  assert.equal(loaded.allows(phone, "42@s.whatsapp.net", 1_000), false);
});

const malformed = [null, {}, { version: 2, deleted: [], cleared: [] },
  { version: 1, deleted: [], cleared: [], expires: null },
  { version: 1, deleted: [], cleared: [], expires: [["sid", "chat", -1]] },
  { version: 1, deleted: [], cleared: [], expires: [["sid", "chat", 0.5]] },
  { version: 1, deleted: [["good", "chat"]], cleared: [], expires: [["sid", "chat", "synthetic-secret"]] },
  { version: 1, deleted: {}, cleared: [] },
  { version: 1, deleted: [["good", "chat"], ["bad", 42]], cleared: [] },
  { version: 1, deleted: [], cleared: [["chat", -1]] },
  { version: 1, deleted: [], cleared: [["chat", "1000"]] }];
for (const [i, value] of malformed.entries()) test(`malformed retention schema ${i + 1} fails closed without partial application`, async (t) => {
  const file = await stateFile(t);
  await writeFile(file, JSON.stringify(value));
  const state = new MessageRetention();
  await assert.rejects(state.load(file), { code: "WHATSAPP_ERROR" });
  assert.equal(state.deleted.size, 0);
  assert.equal(state.cleared.size, 0);
});

test("cleanup coalesces pending work but schedules another pass for deletes arriving mid-rewrite", async () => {
  const state = new MessageRetention();
  const start = gate(); const finish = gate();
  const trace = [];
  state.cleanup(async () => { trace.push("first"); start.release(); await finish.promise; });
  state.cleanup(async () => { assert.fail("coalesced callback should not run"); });
  await start.promise;
  state.cleanup(async () => { trace.push("second"); });
  finish.release();
  await state.idle();
  assert.deepEqual(trace, ["first", "second"]);
});

test("serialized storage keeps progressing after failure, but cannot acknowledge successful cleanup", async () => {
  const state = new MessageRetention();
  const privateError = "synthetic-private-error-text";
  await state.serialize(async () => { throw new Error(privateError); });
  let ran = false;
  await state.serialize(async () => { ran = true; });
  assert.equal(ran, true);
  await assert.rejects(state.idle(), (err) => err.code === "WHATSAPP_ERROR" && !err.message.includes(privateError));
});
