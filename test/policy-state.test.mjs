import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountRegistry } from "../dist/accounts.js";
import { AccountHub, singletonSource } from "../dist/account-hub.js";
import { DraftStore } from "../dist/drafts.js";
import { registerTools } from "../dist/tools.js";
import { migrateLayout } from "../dist/migrate.js";

const PEER = { chat_id: "40700000002@s.whatsapp.net", name: "Synthetic" };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "wazap-policy-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registry = AccountRegistry.load(dir); registry.save();
  return { dir, registry, file: join(dir, "accounts.json") };
}

test("a previously persisted policy cannot be reset by removing accounts.json", (t) => {
  const { dir, registry, file } = fixture(t);
  registry.setSendRules("default", { allow: [] });
  rmSync(file);
  assert.throws(() => AccountRegistry.load(dir), /restore|missing/i);
  assert.throws(() => migrateLayout(dir), /restore|missing/i);
});

test("sealing legacy policy preserves its bytes, extra metadata and read-only permissions", (t) => {
  const { dir, file } = fixture(t);
  const state = JSON.parse(readFileSync(file, "utf8")); state.extra = "synthetic metadata";
  const text = JSON.stringify(state); writeFileSync(file, text); chmodSync(file, 0o400);
  rmSync(`${file}.required`);
  AccountRegistry.load(dir).seal();
  assert.equal(readFileSync(file, "utf8"), text);
  assert.equal(statSync(file).mode & 0o777, 0o400);
  assert.equal(statSync(`${file}.required`).mode & 0o777, 0o600);
});

test("the policy-presence marker contains no account data and is private", (t) => {
  const { file } = fixture(t);
  assert.equal(readFileSync(`${file}.required`, "utf8"), "");
  assert.equal(statSync(`${file}.required`).mode & 0o777, 0o600);
});

for (const change of ["missing", "corrupt", "disabled", "read-only", "removed"]) test(`${change} live policy blocks an owned confirmation without consuming it`, async (t) => {
  const { dir, registry, file } = fixture(t);
  const original = readFileSync(file, "utf8");
  const store = new DraftStore(); let sent = 0;
  const wa = {
    getStatus: () => ({ read_only: false, account_id: "default" }),
    draft: async (payload) => store.view(store.put(PEER, payload)),
    confirm: async (id) => { store.take(id); sent++; return { message_id: "synthetic", chat_id: PEER.chat_id, text: "synthetic", timestamp: "now" }; },
  };
  const source = singletonSource(wa);
  const startupRecord = registry.get("default");
  source.record = id => id === "default" ? { ...startupRecord } : undefined;
  source.recordOnDisk = id => AccountHub.prototype.recordOnDisk.call({ dataDir: dir }, id);
  const tools = new Map(); registerTools({ registerTool(name, _meta, handler) { tools.set(name, handler); } }, source, { allowWrite: true });
  const draft = await tools.get("send_message")({ chat_id: PEER.chat_id, text: "synthetic" });
  assert.equal(draft.structuredContent.status, "draft");
  if (change === "missing") rmSync(file);
  if (change === "corrupt") writeFileSync(file, "{SYNTHETIC-SECRET");
  if (change === "disabled") registry.disable("default");
  if (change === "read-only") registry.setWrites("default", false);
  if (change === "removed") writeFileSync(file, JSON.stringify({ v: 2, default: "other", accounts: [{ id: "other", name: "Other", enabled: true, owner: null }] }));
  const result = await tools.get("confirm_send")({ draft_id: draft.structuredContent.draft_id });
  assert.equal(result.isError, true);
  assert.equal(sent, 0);
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC-SECRET"));
  writeFileSync(file, original);
  // Restore the in-memory startup record too; tightening must not silently relax it.
  source.record = id => AccountRegistry.load(dir).get(id);
  assert.equal((await tools.get("confirm_send")({ draft_id: draft.structuredContent.draft_id })).isError, undefined);
  assert.equal(sent, 1);
});
