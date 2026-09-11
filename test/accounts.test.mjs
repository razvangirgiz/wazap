import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AccountRegistry, parseAccountId, resolveAccount } from "../dist/accounts.js";
import { accountPaths, paths } from "../dist/config.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService } from "./helpers.mjs";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function dataDir() {
  return mkdtempSync(join(tmpdir(), "wazap-accounts-"), { mode: 0o700 });
}

function wazap(dir, args) {
  return run(process.execPath, [binary, ...args, "--data-dir", dir], {
    env: { ...process.env, WAZAP_NO_UPDATE_CHECK: "1" },
  });
}

test("parseAccountId accepts a 32-character slug and refuses the rest", () => {
  assert.equal(parseAccountId("default"), "default");
  assert.equal(parseAccountId("a"), "a");
  assert.equal(parseAccountId("work-2"), "work-2");
  assert.throws(() => parseAccountId("Default"), (err) => err.code === "INVALID_ID");
  assert.throws(() => parseAccountId("-work"), (err) => err.code === "INVALID_ID");
  assert.throws(() => parseAccountId("a".repeat(33)), (err) => err.code === "INVALID_ID");
});

test("a missing accounts.json is a default account in memory, not a crash", () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  assert.equal(registry.defaultId(), "default");
  assert.equal(existsSync(paths(dir).accountsFile), false);
  const account = registry.get("default");
  assert.equal(account.id, "default");
  assert.equal(account.enabled, true);
  assert.equal(account.owner, null);
});

test("add, list, enable, disable and remove persist through a reload", () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  registry.add("work", "Work phone");
  assert.equal(statSync(paths(dir).accountsFile).mode & 0o777, 0o600);
  assert.equal(statSync(accountPaths(dir, "work").root).mode & 0o777, 0o700);

  const loaded = AccountRegistry.load(dir);
  assert.deepEqual(
    loaded.all().map((account) => account.id),
    ["default", "work"],
  );
  assert.equal(loaded.get("work").name, "Work phone");
  loaded.disable("work");
  assert.equal(AccountRegistry.load(dir).get("work").enabled, false);
  loaded.enable("work");
  assert.equal(AccountRegistry.load(dir).get("work").enabled, true);

  loaded.remove("work");
  assert.equal(existsSync(accountPaths(dir, "work").root), false);
  assert.equal(AccountRegistry.load(dir).get("work"), undefined);
  assert.equal(AccountRegistry.load(dir).defaultId(), "default");
});

test("remove refuses the last account and a missing id", () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  assert.throws(() => registry.remove("default"), (err) => err.code === "INVALID_ID");
  registry.add("work");
  assert.throws(() => registry.remove("nope"), (err) => err.code === "INVALID_ID");
});

test("resolveAccount uses --account or the default, and unknown ids fail", () => {
  const dir = dataDir();
  AccountRegistry.load(dir).add("work");
  assert.equal(resolveAccount(dir).account.id, "default");
  assert.equal(resolveAccount(dir, "work").account.id, "work");
  assert.throws(() => resolveAccount(dir, "ghost"), (err) => err.code === "INVALID_ID");
});

test("getStatus carries the registry id and name", () => {
  const { svc } = connectedService(WhatsAppService, { prefix: "wazap-acct-status-", id: "1@s.whatsapp.net", name: "Ada" });
  const status = svc.getStatus();
  assert.equal(status.account_id, "default");
  assert.equal(status.account_name, "default");
  assert.equal(status.account.name, "Ada");
});

test("wazap account list on a fresh dir prints the synthesized default", async () => {
  const dir = dataDir();
  const { stderr } = await wazap(dir, ["account", "list"]);
  assert.match(stderr, /default  enabled  not linked  \(default\)/);
});

test("wazap account add/remove/enable/disable round-trip through the binary", async () => {
  const dir = dataDir();
  await wazap(dir, ["account", "add", "work", "--name", "Work"]);
  const listed = await wazap(dir, ["account", "list"]);
  assert.match(listed.stderr, /work  enabled  not linked/);
  assert.match(listed.stderr, /Work|work/);

  await wazap(dir, ["account", "disable", "work"]);
  assert.match((await wazap(dir, ["account", "list"])).stderr, /work  disabled/);

  await wazap(dir, ["account", "enable", "work"]);
  assert.match((await wazap(dir, ["account", "list"])).stderr, /work  enabled/);

  await wazap(dir, ["account", "remove", "work", "--yes"]);
  assert.equal(existsSync(accountPaths(dir, "work").root), false);
  assert.doesNotMatch((await wazap(dir, ["account", "list"])).stderr, /^work /m);
});

test("config writes --account stores the override in accounts.json, not .env", async () => {
  const dir = dataDir();
  await wazap(dir, ["account", "add", "work"]);
  const { stderr } = await wazap(dir, ["config", "writes", "off", "--account", "work"]);
  assert.match(stderr, /writes: off for work/);
  assert.equal(existsSync(join(dir, ".env")), false);
  const file = JSON.parse(readFileSync(paths(dir).accountsFile, "utf8"));
  assert.equal(file.accounts.find((account) => account.id === "work").writes, false);
});

test("config writes without --account still writes WAZAP_READ_ONLY", async () => {
  const dir = dataDir();
  await wazap(dir, ["config", "writes", "off"]);
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /WAZAP_READ_ONLY=1/);
});

test("status --json on one account keeps linked/account and adds accounts[]", async () => {
  const dir = dataDir();
  mkdirSync(join(dir, "auth"), { recursive: true });
  writeFileSync(
    join(dir, "auth", "creds.json"),
    JSON.stringify({ registered: true, me: { id: "15550100:1@s.whatsapp.net", name: "Test" } }),
  );
  const { stdout, stderr } = await wazap(dir, ["status", "--json"]);
  const report = JSON.parse(stdout);
  assert.equal(report.linked, true);
  assert.equal(report.account.name, "Test");
  assert.equal(report.accounts.length, 1);
  assert.equal(report.accounts[0].id, "default");
  assert.equal(report.accounts[0].account.name, "Test");
  assert.doesNotMatch(stderr, /accounts:/);
});
