/**
 * Phase 4 e2e: a v0 dir migrates, a second account is added through the
 * binary, then two fake sockets drive list_accounts, get_status, a send
 * resolved by chat, and AMBIGUOUS_ACCOUNT.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AccountHub } from "../dist/account-hub.js";
import { AccountRegistry } from "../dist/accounts.js";
import { accountPaths, paths } from "../dist/config.js";
import { anyAccountAllowsWrites, registerTools } from "../dist/tools.js";
import { asToolSource, fakeSocket, offlineConfig, spawnWazap } from "./helpers.mjs";

const HOME = "40700000001@s.whatsapp.net";
const WORK = "40700000002@s.whatsapp.net";
const ANA = "40700000003@s.whatsapp.net";
const STRANGER = "40700000099@s.whatsapp.net";

function dataDir() {
  return mkdtempSync(join(tmpdir(), "wazap-multi-e2e-"), { mode: 0o700 });
}

function seedV0(dir) {
  const files = {
    "auth/creds.json": JSON.stringify({ registered: true, me: { id: "15550100:12@s.whatsapp.net", name: "Ada" } }),
    "store.json": '{"v":1,"chats":{}}',
    "history/40700000001@s.whatsapp.net.jsonl": '{"sid":"x"}\n',
    "media/photo.bin": "img",
    "previews/m1.jpg": "jpg",
    "notes.json": '{"v":1,"contacts":{}}',
  };
  for (const [rel, body] of Object.entries(files)) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
  }
}

function runCli(dir, args) {
  const { child, stderr } = spawnWazap({ dataDir: dir, args });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr: stderr.join("") }));
  });
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

function toolsOf(hub) {
  const server = {
    tools: new Map(),
    registerTool(name, meta, handler) {
      this.tools.set(name, { meta, handler });
    },
  };
  registerTools(server, asToolSource(hub), { allowWrite: anyAccountAllowsWrites(hub) });
  return server.tools;
}

test("migrate, two accounts, list_accounts, get_status, send by chat, AMBIGUOUS_ACCOUNT", async () => {
  const dir = dataDir();
  seedV0(dir);

  const migrated = await runCli(dir, ["status"]);
  assert.equal(migrated.code, 0, migrated.stderr);
  assert.equal(existsSync(join(dir, "auth")), false);
  assert.equal(existsSync(accountPaths(dir, "default").authDir), true);
  assert.equal(existsSync(paths(dir).accountsFile), true);

  const added = await runCli(dir, ["account", "add", "work", "--name", "Work"]);
  assert.equal(added.code, 0, added.stderr);
  assert.equal(existsSync(accountPaths(dir, "work").root), true);
  assert.deepEqual(
    AccountRegistry.load(dir).all().map((account) => account.id),
    ["default", "work"],
  );

  const config = offlineConfig("wazap-multi-e2e-hub-", { dataDir: dir, readOnly: false, rateLimitPerMinute: 20 });
  const hub = new AccountHub(config, AccountRegistry.load(dir));
  const home = hub.get("default");
  const work = hub.get("work");
  assert.ok(home);
  assert.ok(work);
  connect(home, { id: HOME, name: "Home" });
  const workSock = connect(work, { id: WORK, name: "Work" });
  workSock.ev.emit("chats.upsert", [{ id: ANA, conversationTimestamp: Math.floor(Date.now() / 1000) }]);
  workSock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana" }]);
  workSock.sendMessage = async () => undefined;

  const tools = toolsOf(hub);

  const listed = await tools.get("list_accounts").handler({});
  assert.equal(listed.structuredContent.count, 2);
  assert.deepEqual(
    listed.structuredContent.accounts.map((row) => row.id),
    ["default", "work"],
  );
  assert.equal(listed.structuredContent.accounts[1].name, "Work");

  const status = await tools.get("get_status").handler({});
  assert.equal(status.structuredContent.account_id, "default");
  assert.deepEqual(
    status.structuredContent.accounts.map((row) => row.id),
    ["default", "work"],
  );
  assert.equal(status.structuredContent.accounts[0].status, "connected");
  assert.equal(status.structuredContent.accounts[1].status, "connected");

  const sent = await tools.get("send_message").handler({ chat_id: ANA, text: "hi from work" });
  assert.equal(sent.isError, undefined);
  assert.equal(sent.structuredContent.account_id, "work");
  assert.equal(typeof sent.structuredContent.draft_id, "string");

  const ambiguous = await tools.get("send_message").handler({ chat_id: STRANGER, text: "nope" });
  assert.equal(ambiguous.structuredContent.error, "AMBIGUOUS_ACCOUNT");
  assert.match(ambiguous.structuredContent.fix, /account_id/);
});
