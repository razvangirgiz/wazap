/**
 * The copy an upgrade leaves beside an account database, after it is taken:
 * the week it is kept and who may delete it, what `wazap status` and the doctor
 * checks say about it, the `wazap backup` command that asks for one by hand,
 * and the promise that neither kind of copy brings deleted messages back.
 *
 * db-migration-chain.test.mjs proves the copy is taken, is the file as it was,
 * and that an upgrade which cannot take it does not start.
 *
 * Every file here is dated with utimes rather than written "now": the week
 * counts from a copy's own mtime, and a fixture written on the machine's clock
 * and read against a fixed one would pass today and fail on a later machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { accountPaths } from "../dist/config.js";
import { AccountDb, PRE_MIGRATION_TTL_MS, preMigrationBackups, preMigrationName, purgePreMigrationBackups, SCHEMA_VERSION } from "../dist/db/index.js";
import { MIGRATIONS } from "../dist/db/schema.js";
import { sqlite } from "../dist/db/sqlite.js";
import { storageChecks } from "../dist/doctor.js";
import { LEGACY_TTL_MS } from "../dist/legacy-files.js";
import { accountStorage } from "../dist/storage-status.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { PEER, T0, tempDir, textMessage } from "./db-fixtures.mjs";
import { BINARY, childEnv, connectedService } from "./helpers.mjs";

const run = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;
const ME = "40700000001@s.whatsapp.net";
const OTHER = "40700000003@s.whatsapp.net";
const modesApply = process.platform !== "win32" && process.getuid?.() !== 0;

/** An account directory inside a data dir, the way the service lays one out. */
function accountDir(prefix = "wazap-premig-") {
  const dataDir = tempDir(prefix);
  const root = accountPaths(dataDir, "default").root;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return { dataDir, root, dbPath: join(root, "wazap.sqlite") };
}

/** A real database at `version`, as a released wazap would have left it. */
function databaseAt(path, version) {
  const db = new (sqlite().DatabaseSync)(path);
  db.exec("BEGIN IMMEDIATE");
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.exec(migration.sql);
    db.exec(`PRAGMA user_version = ${migration.version}`);
  }
  db.exec("COMMIT");
  db.close();
  return path;
}

/** A copy beside the database, at `version`, dated `at`: what a past upgrade left. */
function plantCopy(root, version, at) {
  const path = databaseAt(join(root, preMigrationName(version)), version);
  utimesSync(path, at / 1000, at / 1000);
  return path;
}

const names = (root) => readdirSync(root).sort();

// -------------------------------------------------------------- the week

test("a pre-migration copy is kept for the legacy files' own week, counted from its mtime", () => {
  assert.equal(PRE_MIGRATION_TTL_MS, LEGACY_TTL_MS, "one week, named in one place and matched here");

  const { root } = accountDir();
  const copy = plantCopy(root, 1, T0 - 3 * DAY);
  const [found] = preMigrationBackups(root);
  assert.equal(found.file, "wazap.1.pre-migration.sqlite");
  assert.equal(found.fromVersion, 1);
  assert.equal(found.takenAt, T0 - 3 * DAY, "its own mtime, not the clock reading it");
  assert.equal(found.deleteAfter, T0 - 3 * DAY + PRE_MIGRATION_TTL_MS);
  assert.ok(found.bytes > 0);
  assert.equal(found.path, copy);
});

test("a copy goes only once its week is up, and only once the database is past the version it holds", () => {
  const { root } = accountDir();
  plantCopy(root, 1, T0 - 8 * DAY);

  assert.equal(purgePreMigrationBackups(root, T0, 1), 0, "the database is still at v1: the upgrade never finished, so the copy stays");
  assert.equal(existsSync(join(root, preMigrationName(1))), true);

  assert.equal(purgePreMigrationBackups(root, T0 - 2 * DAY, SCHEMA_VERSION), 0, "six days old is not a week");
  assert.equal(existsSync(join(root, preMigrationName(1))), true);

  assert.equal(purgePreMigrationBackups(root, T0, SCHEMA_VERSION), 1, "eight days old, and the upgrade landed");
  assert.equal(existsSync(join(root, preMigrationName(1))), false);
});

test("strict retention deletes a copy at once: the database beside it holds everything it holds", () => {
  const { root } = accountDir();
  plantCopy(root, 2, T0 - 60_000);
  assert.equal(purgePreMigrationBackups(root, T0, SCHEMA_VERSION, true), 1);
  assert.equal(existsSync(join(root, preMigrationName(2))), false);
});

test("strict retention still does not delete the copy of an upgrade that has not landed", () => {
  const { root } = accountDir();
  plantCopy(root, 3, T0 - 60_000);
  assert.equal(purgePreMigrationBackups(root, T0, 3, true), 0);
  assert.equal(existsSync(join(root, preMigrationName(3))), true);
});

test("nothing without exactly that name is ever deleted, however old it is", () => {
  const { root } = accountDir();
  const bystanders = [
    "wazap.sqlite",
    "wazap.sqlite-wal",
    "wazap.1.previous-owner.sqlite",
    "wazap.pre-migration.sqlite",
    "wazap.1.pre-migration.sqlite.bak",
    "wazap.v1.pre-migration.sqlite",
    "my wazap.1.pre-migration.sqlite",
    "wazap.1.pre-migration.sqlite.tmp",
  ];
  for (const name of bystanders) {
    writeFileSync(join(root, name), "keep me");
    utimesSync(join(root, name), (T0 - 400 * DAY) / 1000, (T0 - 400 * DAY) / 1000);
  }
  plantCopy(root, 1, T0 - 400 * DAY);

  assert.equal(purgePreMigrationBackups(root, T0, SCHEMA_VERSION), 1);
  assert.deepEqual(names(root), bystanders.sort(), "only the one that matched went");
});

test("the daily pass a service runs deletes the copy when its week is up, and not before", async (t) => {
  const { dataDir, root } = accountDir();
  plantCopy(root, 1, T0 - 3 * DAY);
  await bootAt(t, dataDir, T0);
  assert.equal(existsSync(join(root, preMigrationName(1))), true, "three days in, the copy is still there");

  await bootAt(t, dataDir, T0 + 5 * DAY);
  assert.equal(existsSync(join(root, preMigrationName(1))), false, "eight days after it was taken, a start deletes it");
  assert.equal(existsSync(join(root, "wazap.sqlite")), true, "the database itself is untouched");
});

/** Boots a service on the data dir at `at` and stops it: one start of the server. */
async function bootAt(t, dataDir, at, config = {}) {
  t.mock.method(Date, "now", () => at);
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-premig-svc-",
    id: ME,
    name: "Răzvan",
    config: { dataDir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0, ...config },
  });
  await svc.bootStorage();
  await svc.stop();
  t.mock.restoreAll();
  return svc;
}

// ------------------------------------------------------ status and doctor

test("wazap status reports the copy per account, read without opening it", () => {
  const { dataDir, root, dbPath } = accountDir();
  AccountDb.open(dbPath, { checkpointDelayMs: 0 }).close();
  plantCopy(root, 2, T0 - 2 * DAY);

  const report = accountStorage(dataDir, "default", false);
  assert.deepEqual(
    report.pre_migration.map((copy) => ({ file: copy.file, from_version: copy.from_version })),
    [{ file: "wazap.2.pre-migration.sqlite", from_version: 2 }]
  );
  assert.match(report.pre_migration[0].taken_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(report.pre_migration[0].delete_after, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(Date.parse(report.pre_migration[0].delete_after) - Date.parse(report.pre_migration[0].taken_at), PRE_MIGRATION_TTL_MS);
  assert.equal(report.state, "ready", "and the rest of the account reads as it did");

  const [check] = storageChecks({ accounts: [report], beta_archive: null }, false, T0).filter((line) => line.name === "pre-migration copy");
  assert.equal(check.state, "info");
  assert.match(check.detail, /from schema v2/, "the version it was taken from");
  assert.match(check.detail, /2 days old/, "how old it is");
  assert.match(check.detail, /deleted after \d{4}-\d{2}-\d{2}/, "and when it goes");
});

test("an account with no copy beside it says nothing about one", () => {
  const { dataDir, dbPath } = accountDir();
  AccountDb.open(dbPath, { checkpointDelayMs: 0 }).close();
  const report = accountStorage(dataDir, "default", false);
  assert.deepEqual(report.pre_migration, []);
  assert.deepEqual(
    storageChecks({ accounts: [report], beta_archive: null }, false, T0).filter((line) => line.name === "pre-migration copy"),
    []
  );
});

test("the status command carries it, in JSON and on the screen", async () => {
  const { dataDir, root, dbPath } = accountDir();
  AccountDb.open(dbPath, { checkpointDelayMs: 0 }).close();
  plantCopy(root, 1, Date.now() - 2 * DAY);

  const { stdout } = await run(process.execPath, [BINARY, "status", "--json", "--data-dir", dataDir], {
    env: childEnv({ WAZAP_TRANSCRIBE: "off", WAZAP_WEBHOOK: "off" }),
  });
  const report = JSON.parse(stdout);
  assert.equal(report.storage.accounts[0].pre_migration[0].from_version, 1);

  const { stderr } = await run(process.execPath, [BINARY, "status", "--data-dir", dataDir], {
    env: childEnv({ WAZAP_TRANSCRIBE: "off", WAZAP_WEBHOOK: "off" }),
  });
  assert.match(stderr, /pre-migration copy.*from schema v1, 2 days old/);
});

// -------------------------------------------------------- wazap backup

function seed(db) {
  db.bindOwner(ME);
  db.messages.upsert(textMessage(PEER, "B1", T0 + 1_000, "prima factură de august"));
  db.messages.upsert(textMessage(PEER, "B2", T0 + 2_000, "a doua, pentru ședință"));
  db.messages.upsert(textMessage(OTHER, "B3", T0 + 3_000, "de la Bogdan"));
}

function backup(dataDir, args, env = {}) {
  return run(process.execPath, [BINARY, "backup", ...args, "--data-dir", dataDir], {
    env: childEnv({ WAZAP_TRANSCRIBE: "off", WAZAP_WEBHOOK: "off", ...env }),
  });
}

/** Everything a copy holds, read through a connection of its own. */
function rowsOf(path, sql = "SELECT text FROM messages ORDER BY id", ...params) {
  const reader = new (sqlite().DatabaseSync)(path, { readOnly: true });
  try {
    return reader.prepare(sql).all(...params);
  } finally {
    reader.close();
  }
}

test("wazap backup writes an owner-only copy of the account, and says where it is and how big", async () => {
  const { dataDir, dbPath } = accountDir();
  const db = AccountDb.open(dbPath, { checkpointDelayMs: 0 });
  seed(db);
  db.close();
  const destination = join(dataDir, "elsewhere", "copy.sqlite");

  const { stderr } = await backup(dataDir, [destination]);
  assert.match(stderr, /copy\.sqlite/, "the path it wrote");
  assert.match(stderr, /KiB|MiB/, "and how big it is");
  assert.match(stderr, /not encrypted/, "and what it is");
  if (modesApply) assert.equal(statSync(destination).mode & 0o777, 0o600);
  assert.deepEqual(rowsOf(destination).map((row) => row.text), ["prima factură de august", "a doua, pentru ședință", "de la Bogdan"]);
  assert.deepEqual(rowsOf(destination, "PRAGMA integrity_check").map((row) => row.integrity_check), ["ok"]);
});

test("wazap backup refuses a file already there, and replaces it with --force", async () => {
  const { dataDir, dbPath } = accountDir();
  const db = AccountDb.open(dbPath, { checkpointDelayMs: 0 });
  seed(db);
  db.close();
  const destination = join(dataDir, "copy.sqlite");
  writeFileSync(destination, "something of mine");

  const refusal = await backup(dataDir, [destination]).catch((err) => err);
  assert.equal(refusal.code, 1, "a refusal is not an exit code of zero");
  assert.match(refusal.stderr, /already exists/);
  assert.match(refusal.stderr, /--force/);
  assert.equal(readFileSync(destination, "utf8"), "something of mine", "and it did not touch it");

  const { stderr } = await backup(dataDir, [destination, "--force"]);
  assert.match(stderr, /copy\.sqlite/);
  assert.equal(rowsOf(destination).length, 3);
});

test("wazap backup refuses a folder, and refuses to write over the database it copies", async () => {
  const { dataDir, root, dbPath } = accountDir();
  AccountDb.open(dbPath, { checkpointDelayMs: 0 }).close();

  const folder = await backup(dataDir, [root]).catch((err) => err);
  assert.equal(folder.code, 1);
  assert.match(folder.stderr, /is a folder/);

  const live = await backup(dataDir, [dbPath, "--force"]).catch((err) => err);
  assert.equal(live.code, 1);
  assert.match(live.stderr, /cannot overwrite the database it copies/);
  assert.equal(existsSync(dbPath), true, "and the database is still there");

  if (modesApply) {
    const alias = join(dataDir, "alias.sqlite");
    symlinkSync(dbPath, alias);
    const linked = await backup(dataDir, [alias, "--force"]).catch((err) => err);
    assert.equal(linked.code, 1);
    assert.match(linked.stderr, /cannot overwrite the database it copies/);
  }
});

test("wazap backup works while another process holds the database, and copies what only its log holds", async () => {
  const { dataDir, dbPath } = accountDir();
  const held = AccountDb.open(dbPath, { checkpointDelayMs: 0 });
  seed(held);
  try {
    // Committed but never checkpointed: these rows live in the write-ahead log
    // alone, which is what a running server's database looks like.
    held.messages.upsert(textMessage(PEER, "B4", T0 + 4_000, "doar in jurnal"));
    assert.ok(statSync(`${dbPath}-wal`).size > 0, "the log really holds something");

    const destination = join(dataDir, "while-open.sqlite");
    await backup(dataDir, [destination]);
    assert.deepEqual(
      rowsOf(destination).map((row) => row.text),
      ["prima factură de august", "a doua, pentru ședință", "de la Bogdan", "doar in jurnal"]
    );
    // And the live database is none the worse for it.
    assert.deepEqual(held.integrityCheck(), { ok: true, problems: [] });
    assert.equal(held.counts().messages, 4);
  } finally {
    held.close();
  }
});

test("wazap backup takes the account it is told to", async () => {
  const { dataDir } = accountDir();
  await run(process.execPath, [BINARY, "account", "add", "other", "--data-dir", dataDir], { env: childEnv() });
  const second = accountPaths(dataDir, "other").root;
  mkdirSync(second, { recursive: true, mode: 0o700 });

  const first = AccountDb.open(join(accountPaths(dataDir, "default").root, "wazap.sqlite"), { checkpointDelayMs: 0 });
  seed(first);
  first.close();
  const other = AccountDb.open(join(second, "wazap.sqlite"), { checkpointDelayMs: 0 });
  other.bindOwner(OTHER);
  other.messages.upsert(textMessage(PEER, "O1", T0 + 9_000, "al doilea cont"));
  other.close();

  const destination = join(dataDir, "other.sqlite");
  await backup(dataDir, [destination, "--account", "other"]);
  assert.deepEqual(rowsOf(destination).map((row) => row.text), ["al doilea cont"]);
});

test("wazap backup on an account with no database says so rather than writing an empty one", async () => {
  const { dataDir } = accountDir();
  const missing = await backup(dataDir, [join(dataDir, "copy.sqlite")]).catch((err) => err);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /has no database yet/);
  assert.equal(existsSync(join(dataDir, "copy.sqlite")), false);
});

// ------------------------------------------------------- what a copy holds

/** Whether any byte of a file spells `needle`: free pages and all, the way `strings` would find it. */
function fileHolds(path, needle) {
  return readFileSync(path).includes(Buffer.from(needle));
}

const GONE = "parola de la seif este sapte";
const RETRACTED = "sterge asta te rog imediat";
const CLEARED = "conversatia asta a fost stearsa";
const STAYS = "asta ramane in cont";

test("a copy does not bring back what was deleted before it was taken: not in the rows, not in the index, not in the file", async () => {
  const { dataDir, dbPath } = accountDir();
  const scrubbed = new Uint8Array(Buffer.from("SCRUBBED"));
  const db = AccountDb.open(dbPath, { checkpointDelayMs: 0, scrubQuote: () => scrubbed });
  db.bindOwner(ME);
  db.messages.upsert(textMessage(PEER, "D1", T0 + 1_000, GONE));
  db.messages.upsert(textMessage(PEER, "D2", T0 + 2_000, RETRACTED));
  // A reply that carries its own copy of the retracted message inside its protobuf.
  db.messages.upsert(
    textMessage(PEER, "D5", T0 + 5_000, "am inteles", {
      quotedSid: `false_${PEER}_D2`,
      raw: new Uint8Array(Buffer.from(`REPLY+EMBEDDED:${RETRACTED}`)),
    })
  );
  db.messages.upsert(textMessage(OTHER, "D3", T0 + 3_000, CLEARED));
  db.messages.upsert(textMessage(PEER, "D4", T0 + 4_000, STAYS));

  // Deleted for me, retracted for everyone, and a whole chat cleared: the three
  // ways a message stops existing, each of them before the copy is taken.
  db.messages.delete(`false_${PEER}_D1`);
  db.messages.delete(`false_${PEER}_D2`);
  await db.messages.clearChat(OTHER, T0 + 3_500);
  await db.idle();
  db.checkpoint();

  const destination = join(dataDir, "after-the-deletes.sqlite");
  await backup(dataDir, [destination]);
  db.close();

  for (const needle of [GONE, RETRACTED, CLEARED]) {
    assert.deepEqual(rowsOf(destination, "SELECT text FROM messages WHERE text = ?", needle), [], `${needle} is in no row of the copy`);
    assert.deepEqual(rowsOf(destination, "SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?", needle.split(" ")[0]), [], `${needle} is not in the copy's trigram index`);
    // And not in a free page either: what a `strings` over the file would find.
    assert.equal(fileHolds(destination, needle), false, `no page of the copy still spells ${needle}`);
  }
  assert.deepEqual(
    rowsOf(destination).map((row) => row.text).filter((text) => text !== null).sort(),
    ["am inteles", STAYS].sort(),
    "and what was not deleted is all there"
  );
  // The tombstones came too, which is the point: they are the record that says
  // those messages are gone, and they carry no words.
  assert.equal(rowsOf(destination, "SELECT count(*) AS n FROM messages WHERE deleted_at IS NOT NULL")[0].n, 2);
  assert.equal(rowsOf(destination, "SELECT count(*) AS n FROM retracted")[0].n, 2);
  assert.equal(fileHolds(destination, STAYS), true, "which is how we know the scan would have found the others");
});

test("the copy an upgrade takes does not bring back what was deleted either", async () => {
  const { root, dbPath } = accountDir();
  // A database an older wazap left, holding a tombstone: the words left it when
  // the message was deleted, long before this upgrade found the file.
  databaseAt(dbPath, 1);
  const older = new (sqlite().DatabaseSync)(dbPath);
  older.exec("PRAGMA secure_delete = ON");
  const idAt = (ts) => (ts / 1000) * 1048576;
  older.prepare("INSERT INTO contacts(id, phone_jid, updated_at) VALUES (1, ?, ?)").run(PEER, T0);
  older.prepare("INSERT INTO chats(id, jid, kind, contact_id) VALUES (1, ?, 'direct', 1)").run(PEER);
  const insert = older.prepare("INSERT INTO messages(id, chat_id, key_id, from_me, ts, type, text, raw) VALUES (?, 1, ?, 0, ?, 'text', ?, NULL)");
  insert.run(idAt(T0), "E1", T0, GONE);
  insert.run(idAt(T0 + 1000), "E2", T0 + 1000, STAYS);
  older.prepare("UPDATE messages SET text = NULL, deleted_at = ? WHERE id = ?").run(T0 + 5_000, idAt(T0));
  older.exec("VACUUM");
  older.close();
  assert.equal(fileHolds(dbPath, GONE), false, "the database itself holds no trace of it before the upgrade");

  AccountDb.open(dbPath, { checkpointDelayMs: 0 }).close();
  const copy = join(root, preMigrationName(1));
  assert.equal(existsSync(copy), true);
  assert.equal(fileHolds(copy, GONE), false, "and neither does the copy the upgrade took");
  assert.equal(fileHolds(copy, STAYS), true);
  assert.deepEqual(rowsOf(copy, "PRAGMA integrity_check").map((row) => row.integrity_check), ["ok"]);
});
