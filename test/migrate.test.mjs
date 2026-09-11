import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AccountRegistry, DEFAULT_ACCOUNT_ID } from "../dist/accounts.js";
import { accountPaths, paths } from "../dist/config.js";
import { LAYOUT_ENTRIES, migrateLayout, rollbackMigration } from "../dist/migrate.js";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function dataDir() {
  return mkdtempSync(join(tmpdir(), "wazap-migrate-"), { mode: 0o700 });
}

function writeTree(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
  }
}

function readAll(path) {
  const st = statSync(path);
  if (st.isFile()) return { "": readFileSync(path) };
  const out = {};
  for (const entry of readdirSync(path)) {
    const nested = readAll(join(path, entry));
    for (const [key, value] of Object.entries(nested)) {
      out[key === "" ? entry : `${entry}/${key}`] = value;
    }
  }
  return out;
}

function snapshotEntries(dir) {
  const out = {};
  for (const name of LAYOUT_ENTRIES) {
    const path = join(dir, name);
    if (existsSync(path)) out[name] = readAll(path);
  }
  return out;
}

function seedV0(dir, { linked = false } = {}) {
  const creds = linked
    ? JSON.stringify({ registered: true, me: { id: "15550100:12@s.whatsapp.net", name: "Ada" } })
    : JSON.stringify({ registered: false });
  writeTree(dir, {
    "auth/creds.json": creds,
    "store.json": '{"v":1,"chats":{}}',
    "history/40700000001@s.whatsapp.net.jsonl": '{"sid":"x"}\n',
    "media/photo.bin": "img",
    "previews/m1.jpg": "jpg",
    "notes.json": '{"v":1,"contacts":{}}',
  });
}

test("a flat v0 dir moves into accounts/default and a second run is a no-op", () => {
  const dir = dataDir();
  seedV0(dir, { linked: true });
  const before = snapshotEntries(dir);

  migrateLayout(dir);
  const dest = accountPaths(dir, DEFAULT_ACCOUNT_ID);
  assert.equal(existsSync(join(dir, "auth")), false);
  assert.equal(existsSync(dest.authDir), true);
  assert.equal(existsSync(dest.storeFile), true);
  assert.equal(existsSync(join(dest.historyDir, "40700000001@s.whatsapp.net.jsonl")), true);
  assert.equal(existsSync(join(dest.mediaDir, "photo.bin")), true);
  assert.equal(existsSync(join(dest.previewsDir, "m1.jpg")), true);
  assert.equal(existsSync(dest.notesFile), true);
  assert.equal(existsSync(join(dir, "migration.json")), true);
  assert.equal(existsSync(paths(dir).accountsFile), true);

  const file = JSON.parse(readFileSync(paths(dir).accountsFile, "utf8"));
  assert.equal(file.v, 2);
  assert.equal(file.default, "default");
  assert.equal(file.accounts[0].owner, "15550100@s.whatsapp.net");
  assert.deepEqual(snapshotEntries(dest.root), before);

  migrateLayout(dir);
  assert.deepEqual(snapshotEntries(dest.root), before, "idempotent: nothing moves twice");
  assert.deepEqual(snapshotEntries(dir), {}, "the six v0 names stay off the root");
});

test("rollback restores the six entries byte for byte and removes the manifest", () => {
  const dir = dataDir();
  seedV0(dir);
  const before = snapshotEntries(dir);

  migrateLayout(dir);
  rollbackMigration(dir);

  assert.deepEqual(snapshotEntries(dir), before);
  assert.equal(existsSync(join(dir, "migration.json")), false);
  assert.equal(existsSync(paths(dir).accountsFile), false);
  assert.equal(existsSync(join(dir, "auth", "creds.json")), true);
  assert.equal(existsSync(accountPaths(dir, DEFAULT_ACCOUNT_ID).authDir), false);
});

test("an unlinked v0 session migrates with a missing default owner", () => {
  const dir = dataDir();
  seedV0(dir, { linked: false });
  migrateLayout(dir);
  const file = JSON.parse(readFileSync(paths(dir).accountsFile, "utf8"));
  assert.equal(file.accounts[0].id, "default");
  assert.equal(file.accounts[0].owner, null);
});

test("a missing accounts.json next to accounts/default is created, not an error", () => {
  const dir = dataDir();
  mkdirSync(accountPaths(dir, DEFAULT_ACCOUNT_ID).authDir, { recursive: true });
  writeFileSync(
    join(accountPaths(dir, DEFAULT_ACCOUNT_ID).authDir, "creds.json"),
    JSON.stringify({ me: { id: "40700000001:1@s.whatsapp.net", name: "Răzvan" } }),
  );
  migrateLayout(dir);
  const file = JSON.parse(readFileSync(paths(dir).accountsFile, "utf8"));
  assert.equal(file.accounts[0].owner, "40700000001@s.whatsapp.net");
});

test("the migrator refuses a symlink instead of following it", () => {
  const dir = dataDir();
  const other = dataDir();
  mkdirSync(join(other, "auth"), { recursive: true });
  writeFileSync(join(other, "auth", "creds.json"), "{}");
  symlinkSync(join(other, "auth"), join(dir, "auth"));
  assert.throws(() => migrateLayout(dir), (err) => {
    assert.equal(err.code, "WHATSAPP_ERROR");
    assert.match(err.message, /symlink/i);
    assert.match(err.fix, /migrate rollback/);
    return true;
  });
  assert.equal(existsSync(accountPaths(dir, DEFAULT_ACCOUNT_ID).authDir), false);
});

test("leftover root entries still migrate after auth/ has already moved", () => {
  const dir = dataDir();
  seedV0(dir, { linked: true });
  const dest = accountPaths(dir, DEFAULT_ACCOUNT_ID);
  mkdirSync(dest.root, { recursive: true, mode: 0o700 });
  renameSync(join(dir, "auth"), dest.authDir);
  writeFileSync(
    join(dir, "migration.json"),
    `${JSON.stringify({ v: 2, at: "2026-01-01T00:00:00.000Z", moved: ["auth"] }, null, 2)}\n`,
  );

  migrateLayout(dir);
  assert.equal(existsSync(join(dir, "store.json")), false);
  assert.equal(existsSync(dest.storeFile), true);
  assert.equal(existsSync(join(dest.historyDir, "40700000001@s.whatsapp.net.jsonl")), true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "migration.json"), "utf8")).moved.sort(), [
    ...LAYOUT_ENTRIES.filter((name) => name !== "qr.png"),
  ].sort());
});

test("a dest that exists with no source is treated as already moved", () => {
  const dir = dataDir();
  seedV0(dir);
  const dest = accountPaths(dir, DEFAULT_ACCOUNT_ID);
  mkdirSync(dest.root, { recursive: true, mode: 0o700 });
  renameSync(join(dir, "auth"), dest.authDir);
  // Crash between rename and journal: dest has auth, journal does not list it.
  writeFileSync(join(dir, "migration.json"), `${JSON.stringify({ v: 2, at: "2026-01-01T00:00:00.000Z", moved: [] }, null, 2)}\n`);

  migrateLayout(dir);
  assert.equal(existsSync(dest.authDir), true);
  assert.equal(existsSync(join(dir, "auth")), false);
  assert.equal(existsSync(dest.storeFile), true);
  assert.ok(JSON.parse(readFileSync(join(dir, "migration.json"), "utf8")).moved.includes("auth"));
});

test("migrate rollback on a flat dir does not migrate first", async () => {
  const dir = dataDir();
  seedV0(dir);
  await assert.rejects(
    run(process.execPath, [binary, "migrate", "rollback", "--data-dir", dir], {
      env: { ...process.env, WAZAP_NO_UPDATE_CHECK: "1" },
    }),
    (err) => {
      assert.match(err.stderr, /No migration\.json/);
      return true;
    },
  );
  assert.equal(existsSync(join(dir, "auth", "creds.json")), true);
  assert.equal(existsSync(accountPaths(dir, DEFAULT_ACCOUNT_ID).authDir), false);
});

test("rollback still runs when a leftover symlink would make a forward migrate throw", async () => {
  const dir = dataDir();
  seedV0(dir);
  migrateLayout(dir);
  const other = dataDir();
  writeFileSync(join(other, "qr.png"), "qr");
  symlinkSync(join(other, "qr.png"), join(dir, "qr.png"));
  assert.throws(() => migrateLayout(dir), (err) => err.code === "WHATSAPP_ERROR");

  await run(process.execPath, [binary, "migrate", "rollback", "--data-dir", dir], {
    env: { ...process.env, WAZAP_NO_UPDATE_CHECK: "1" },
  });
  assert.equal(existsSync(join(dir, "auth", "creds.json")), true);
  assert.equal(existsSync(join(dir, "migration.json")), false);
});

test("rollback refuses when a second account exists", () => {
  const dir = dataDir();
  seedV0(dir);
  migrateLayout(dir);
  AccountRegistry.load(dir).add("work");
  assert.throws(() => rollbackMigration(dir), (err) => {
    assert.equal(err.code, "INVALID_ID");
    assert.match(err.message, /more than one account/);
    return true;
  });
  assert.equal(existsSync(accountPaths(dir, DEFAULT_ACCOUNT_ID).authDir), true);
});

test("qr.png at the data-dir root moves with the rest", () => {
  const dir = dataDir();
  seedV0(dir);
  writeFileSync(join(dir, "qr.png"), "qr");
  migrateLayout(dir);
  assert.equal(existsSync(join(dir, "qr.png")), false);
  assert.equal(readFileSync(accountPaths(dir, DEFAULT_ACCOUNT_ID).qrFile, "utf8"), "qr");
});

test("wazap migrate rollback undoes a previous migrate through the CLI", async () => {
  const dir = dataDir();
  seedV0(dir, { linked: true });
  await run(process.execPath, [binary, "status", "--data-dir", dir], {
    env: { ...process.env, WAZAP_NO_UPDATE_CHECK: "1" },
  });
  assert.equal(existsSync(accountPaths(dir, DEFAULT_ACCOUNT_ID).authDir), true);

  await run(process.execPath, [binary, "migrate", "rollback", "--data-dir", dir], {
    env: { ...process.env, WAZAP_NO_UPDATE_CHECK: "1" },
  });
  assert.equal(existsSync(join(dir, "auth", "creds.json")), true);
  assert.equal(existsSync(join(dir, "migration.json")), false);
});
