/**
 * The legacy files after the import: moved into legacy/ once the database
 * holds them (and again after a crash between two renames), deleted a week
 * later or at once under WAZAP_RETENTION=1, never when the import is
 * unverified; the beta archive moved only once every account linked to its
 * number imported it; set-aside databases deleted after their week; a logout
 * that deletes none of it; and what `wazap status` says about all of it, with
 * a server holding the database and without one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { AccountRegistry } from "../dist/accounts.js";
import { accountPaths } from "../dist/config.js";
import { AccountDb } from "../dist/db/index.js";
import { sqlite } from "../dist/db/sqlite.js";
import {
  LEGACY_TTL_MS,
  moveAccountLegacy,
  purgeAccountLegacy,
  purgePreviousOwners,
  settleBetaArchive,
} from "../dist/legacy-files.js";
import { logoutAccount } from "../dist/logout.js";
import { socketFactory } from "../dist/pairing.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { ANA, ME, buildLegacyAccount } from "./legacy-fixtures.mjs";
import { BINARY, childEnv, connectedService, fakeSocket } from "./helpers.mjs";

const run = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;
const OTHER = "40799999999@s.whatsapp.net";
const LEGACY_NAMES = ["history", "notes.json", "recall", "retention.json", "store.json"];

function serviceOn(dataDir, config = {}) {
  return connectedService(WhatsAppService, {
    prefix: "wazap-legacy-files-",
    id: ME,
    name: "Răzvan",
    config: { dataDir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0, ...config },
  }).svc;
}

/** Boots a service on the data dir at `at` and stops it: what one start of the server does to the files. */
async function bootAt(t, dataDir, at, config = {}) {
  t.mock.method(Date, "now", () => at);
  const svc = serviceOn(dataDir, config);
  await svc.bootStorage();
  await svc.stop();
  t.mock.restoreAll();
  return svc;
}

function readMeta(dbPath, key) {
  const db = AccountDb.open(dbPath, { readOnly: true });
  try {
    return db.getMeta(key);
  } finally {
    db.close();
  }
}

/** A database set aside by a different number's link, dated `at` by name and mtime. */
function previousOwner(root, at) {
  const file = join(root, `wazap.${at}.previous-owner.sqlite`);
  for (const suffix of ["", "-wal"]) {
    writeFileSync(`${file}${suffix}`, "set aside");
    utimesSync(`${file}${suffix}`, at / 1000, at / 1000);
  }
  return file;
}

function status(dataDir, env = {}) {
  return run(process.execPath, [BINARY, "status", "--json", "--data-dir", dataDir], {
    env: childEnv({ WAZAP_TRANSCRIBE: "off", WAZAP_WEBHOOK: "off", ...env }),
  }).then(({ stdout }) => JSON.parse(stdout));
}

function statusText(dataDir, env = {}) {
  return run(process.execPath, [BINARY, "status", "--data-dir", dataDir], {
    env: childEnv({ WAZAP_TRANSCRIBE: "off", WAZAP_WEBHOOK: "off", ...env }),
  }).then(({ stderr }) => stderr);
}

test("the boot that imports an account moves its legacy files and the beta archive aside, deletes nothing, and a later boot moves nothing", async (t) => {
  const fx = await buildLegacyAccount();
  const legacy = join(fx.paths.root, "legacy");
  await bootAt(t, fx.dataDir, fx.now);

  assert.deepEqual(readdirSync(legacy).sort(), LEGACY_NAMES);
  assert.equal(statSync(legacy).mode & 0o777, 0o700);
  for (const name of LEGACY_NAMES) assert.equal(existsSync(join(fx.paths.root, name)), false, `${name} left its place`);
  assert.equal(readdirSync(join(legacy, "history")).length > 0, true, "the history came whole");
  assert.equal(existsSync(join(fx.paths.authDir, "creds.json")), true, "the credentials are the service's own");
  assert.equal(existsSync(join(fx.dataDir, "archive.sqlite")), false);
  assert.equal(existsSync(join(fx.dataDir, "legacy", "archive.sqlite")), true, "the archive of the linked number moved aside");
  assert.equal(Math.round(statSync(join(fx.dataDir, "legacy", "archive.sqlite")).mtimeMs / 1000), Math.round(fx.now / 1000), "its week counts from the move");
  const dbPath = join(fx.paths.root, "wazap.sqlite");
  assert.equal(readMeta(dbPath, "legacy_moved_at"), String(fx.now));
  assert.equal(readMeta(dbPath, "legacy_keep"), null);
  assert.equal(readMeta(dbPath, "legacy_deleted_at"), null);

  const svc = serviceOn(fx.dataDir);
  t.after(() => svc.stop());
  await svc.bootStorage();
  assert.deepEqual(moveAccountLegacy(fx.paths.root, svc.db, fx.now + DAY), { moved: 0, recorded: false });
  assert.deepEqual(readdirSync(legacy).sort(), LEGACY_NAMES, "nothing doubled, nothing renamed");
  assert.equal(svc.db.getMeta("legacy_moved_at"), String(fx.now));
  assert.ok((await svc.readMessages(ANA, 10)).data.length > 0, "the database serves without them");
  assert.equal(svc.getStatus().storage.state, "ready");
  assert.match(svc.getStatus().storage.legacy_files.deleted_after, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(svc.legacyTimer.hasRef(), false, "the daily pass does not keep the process alive");
  await svc.stop();
  assert.equal(svc.legacyTimer, null);
});

test("a crash between two renames leaves the move unrecorded, and the next pass moves the rest", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wazap-legacy-crash-"));
  mkdirSync(join(root, "history"));
  writeFileSync(join(root, "history", "chat.jsonl"), "{}\n");
  mkdirSync(join(root, "recall"));
  for (const name of ["store.json", "retention.json", "notes.json", "notes.json.tmp"]) writeFileSync(join(root, name), "{}");
  const db = AccountDb.open(join(root, "wazap.sqlite"));
  t.after(() => db.close());
  assert.deepEqual(moveAccountLegacy(root, db, 1_000), { moved: 0, recorded: false }, "nothing moves before the import is done");
  db.setMeta("import_state", "running");
  assert.deepEqual(moveAccountLegacy(root, db, 1_000), { moved: 0, recorded: false }, "nor while it runs: a resumed import reads them");
  db.setMeta("import_state", "done");

  const rename = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, "renameSync", function (...args) {
    if (++calls === 3) throw Object.assign(new Error("simulated crash"), { code: "EIO" });
    return rename.apply(this, args);
  });
  syncBuiltinESMExports();
  assert.throws(() => moveAccountLegacy(root, db, 2_000), { code: "EIO" });
  t.mock.restoreAll();
  syncBuiltinESMExports();

  assert.equal(readdirSync(join(root, "legacy")).length, 2, "two entries moved before the crash");
  assert.equal(db.getMeta("legacy_moved_at"), null, "the move is not recorded half-done");
  assert.equal(purgeAccountLegacy(root, db, 2_000 + 30 * DAY, true), null, "and nothing half-moved is deleted");

  assert.deepEqual(moveAccountLegacy(root, db, 3_000), { moved: 4, recorded: true });
  assert.deepEqual(readdirSync(join(root, "legacy")).sort(), ["history", "notes.json", "notes.json.tmp", "recall", "retention.json", "store.json"]);
  assert.deepEqual(readdirSync(root).sort(), ["legacy", "wazap.sqlite", "wazap.sqlite-shm", "wazap.sqlite-wal"]);
  assert.equal(db.getMeta("legacy_moved_at"), "3000");
});

test("an import a stop cut off keeps every legacy file where the next boot resumes from, and moves them once it is done", async (t) => {
  const fx = await buildLegacyAccount();
  t.mock.method(Date, "now", () => fx.now);
  const first = serviceOn(fx.dataDir);
  const booting = first.bootStorage().catch(() => {});
  for (let turns = 0; first.accountDb.getMeta("import_state") !== "running"; turns++) {
    assert.ok(turns < 10_000, "the import started");
    await new Promise((resolve) => setImmediate(resolve));
  }
  await first.stop();
  await booting;
  for (const name of LEGACY_NAMES) assert.equal(existsSync(join(fx.paths.root, name)), true, `${name} is still in place`);
  assert.equal(existsSync(join(fx.paths.root, "legacy")), false);
  assert.equal(existsSync(join(fx.dataDir, "archive.sqlite")), true);

  const next = serviceOn(fx.dataDir);
  t.after(() => next.stop());
  await next.bootStorage();
  assert.equal(next.db.getMeta("import_state"), "done");
  assert.deepEqual(readdirSync(join(fx.paths.root, "legacy")).sort(), LEGACY_NAMES);
  assert.equal(existsSync(join(fx.dataDir, "legacy", "archive.sqlite")), true);
});

test("a week after the move the legacy files, the beta archive and a set-aside database are deleted; a day before, nothing is", async (t) => {
  const fx = await buildLegacyAccount();
  await bootAt(t, fx.dataDir, fx.now);
  const aside = previousOwner(fx.paths.root, fx.now);

  await bootAt(t, fx.dataDir, fx.now + 6 * DAY);
  assert.deepEqual(readdirSync(join(fx.paths.root, "legacy")).sort(), LEGACY_NAMES);
  assert.equal(existsSync(join(fx.dataDir, "legacy", "archive.sqlite")), true);
  assert.equal(existsSync(aside), true);

  const logged = [];
  t.mock.method(process.stderr, "write", (chunk) => {
    logged.push(String(chunk));
    return true;
  });
  await bootAt(t, fx.dataDir, fx.now + 8 * DAY);
  assert.equal(existsSync(join(fx.paths.root, "legacy")), false);
  assert.equal(existsSync(join(fx.dataDir, "legacy")), false, "the archive and its folder are gone");
  assert.equal(existsSync(aside), false);
  assert.equal(existsSync(`${aside}-wal`), false);
  assert.equal(existsSync(join(fx.paths.root, "wazap.sqlite")), true, "the database is not a legacy file");
  assert.equal(readMeta(join(fx.paths.root, "wazap.sqlite"), "legacy_deleted_at"), String(fx.now + 8 * DAY));
  const lines = logged.join("");
  assert.match(lines, /deleted legacy\/ \(5 entries\)/);
  assert.match(lines, /deleted 1 database\(s\) set aside/);
  assert.match(lines, /deleted the beta archive\.sqlite/);
  assert.equal(/Salut|40700000002/.test(lines), false, "counts, never contents or numbers");

  const svc = serviceOn(fx.dataDir);
  t.after(() => svc.stop());
  await svc.bootStorage();
  assert.equal((await svc.getMessage(`false_${ANA}_A1`)).text, "Salut, ce mai faci azi?", "what was imported stays");
  assert.equal(svc.getStatus().storage.legacy_files, undefined);
});

test("purgePreviousOwners goes by the later of the name's time and the files' mtime", () => {
  const root = mkdtempSync(join(tmpdir(), "wazap-legacy-aside-"));
  const old = previousOwner(root, 1_000_000);
  const touched = previousOwner(root, 2_000_000);
  // Named long ago, written to recently: the recent write decides.
  utimesSync(touched, (2_000_000 + 5 * DAY) / 1000, (2_000_000 + 5 * DAY) / 1000);
  assert.equal(purgePreviousOwners(root, 1_000_000 + LEGACY_TTL_MS - 1, false), 0);
  assert.equal(purgePreviousOwners(root, 2_000_000 + LEGACY_TTL_MS, false), 1);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(touched), true);
  assert.equal(purgePreviousOwners(root, 2_000_000 + LEGACY_TTL_MS, true), 1, "retention does not wait");
  assert.deepEqual(readdirSync(root), []);
});

test("with WAZAP_RETENTION=1 the legacy files, the beta archive and set-aside databases go at the boot that moves them", async (t) => {
  const fx = await buildLegacyAccount({ retention: true });
  const aside = previousOwner(fx.paths.root, fx.now);
  await bootAt(t, fx.dataDir, fx.now, { retention: true });
  assert.equal(existsSync(join(fx.paths.root, "legacy")), false);
  for (const name of LEGACY_NAMES) assert.equal(existsSync(join(fx.paths.root, name)), false);
  assert.equal(existsSync(join(fx.dataDir, "archive.sqlite")), false);
  assert.equal(existsSync(join(fx.dataDir, "legacy")), false);
  assert.equal(existsSync(aside), false);
  assert.equal(readMeta(join(fx.paths.root, "wazap.sqlite"), "import_state"), "done");
});

test("an unverified import's legacy files are moved and kept, whatever the clock and WAZAP_RETENTION say", async (t) => {
  const fx = await buildLegacyAccount();
  t.mock.method(Date, "now", () => fx.now);
  const first = serviceOn(fx.dataDir);
  first.accountDb.messages.upsert({ chatJid: ANA, keyId: "STRAY", fromMe: false, ts: fx.T * 1000, type: "text", text: "stray" });
  await first.bootStorage();
  assert.equal(first.db.getMeta("import_state"), "imported");
  assert.equal(first.db.getMeta("legacy_keep"), "unverified");
  assert.deepEqual(first.getStatus().storage, { state: "imported-unverified", legacy_files: { kept: "unverified" } });
  await first.stop();
  t.mock.restoreAll();
  assert.deepEqual(readdirSync(join(fx.paths.root, "legacy")).sort(), LEGACY_NAMES);
  assert.equal(existsSync(join(fx.dataDir, "archive.sqlite")), true, "the archive waits for a verified import");

  await bootAt(t, fx.dataDir, fx.now + 60 * DAY, { retention: true });
  assert.deepEqual(readdirSync(join(fx.paths.root, "legacy")).sort(), LEGACY_NAMES);
  assert.equal(existsSync(join(fx.dataDir, "archive.sqlite")), true);

  const report = await status(fx.dataDir);
  const account = report.storage.accounts[0];
  assert.equal(account.state, "imported-unverified");
  assert.deepEqual(account.unverified.unexpected, { extraInDb: 1 });
  assert.equal(account.legacy.state, "kept-unverified");
  assert.deepEqual(report.storage.beta_archive.waiting_for, ["default"]);
  const kept = report.checks.find((check) => check.name === "legacy files");
  assert.equal(kept.state, "warn");
  assert.equal(kept.fix, `once the account reads right, delete them yourself: \`rm -rf ${join(fx.paths.root, "legacy")}\``);
  assert.match(report.checks.find((check) => check.name === "storage").detail, /differences the check could not explain \(extraInDb 1\)/);
});

test("a beta archive no enabled account is linked to stays where it is, and says so", async (t) => {
  const fx = await buildLegacyAccount({ betaOwner: OTHER });
  await bootAt(t, fx.dataDir, fx.now);
  await bootAt(t, fx.dataDir, fx.now + 30 * DAY, { retention: true });
  assert.equal(existsSync(join(fx.dataDir, "archive.sqlite")), true);
  assert.equal(existsSync(join(fx.dataDir, "legacy")), false);

  const report = await status(fx.dataDir);
  assert.deepEqual(report.storage.beta_archive, {
    state: "in-place",
    path: join(fx.dataDir, "archive.sqlite"),
    bytes: report.storage.beta_archive.bytes,
    accounts: [],
    waiting_for: [],
    owner_readable: true,
    delete_after: null,
  });
  const check = report.checks.find((c) => c.name === "beta archive");
  assert.match(check.detail, /left in place: no enabled account is linked to its number/);
});

test("the beta archive waits for every enabled account linked to its number, and no other", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-legacy-beta-"));
  const registry = AccountRegistry.load(dataDir);
  registry.save();
  for (const id of ["work", "spare"]) AccountRegistry.load(dataDir).add(id);
  const link = (id, jid, importState) => {
    const paths = accountPaths(dataDir, id);
    mkdirSync(paths.authDir, { recursive: true });
    writeFileSync(join(paths.authDir, "creds.json"), JSON.stringify({ me: { id: jid.replace("@", ":3@") } }));
    if (importState === undefined) return;
    const db = AccountDb.open(join(paths.root, "wazap.sqlite"));
    db.setMeta("import_state", importState);
    db.close();
  };
  link("default", ME, "done");
  link("work", OTHER, "running");
  link("spare", ME);
  const archive = join(dataDir, "archive.sqlite");
  const { DatabaseSync } = sqlite();
  const beta = new DatabaseSync(archive);
  beta.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE messages(sid TEXT PRIMARY KEY)");
  beta.prepare("INSERT INTO meta VALUES('owner', ?)").run(ME);
  beta.close();

  const now = Date.UTC(2026, 8, 20);
  assert.deepEqual(settleBetaArchive(dataDir, now, false), { moved: false, deleted: false }, "spare, linked to the same number, has not imported");
  const spare = AccountDb.open(join(accountPaths(dataDir, "spare").root, "wazap.sqlite"));
  spare.setMeta("import_state", "imported");
  spare.close();
  assert.deepEqual(settleBetaArchive(dataDir, now, false), { moved: false, deleted: false }, "an unverified import does not count as done");

  AccountRegistry.load(dataDir).disable("spare");
  assert.deepEqual(settleBetaArchive(dataDir, now, false), { moved: true, deleted: false }, "a disabled account is not waited for; work is another number");
  assert.equal(existsSync(join(dataDir, "legacy", "archive.sqlite")), true);
  assert.deepEqual(settleBetaArchive(dataDir, now + LEGACY_TTL_MS - 1, false), { moved: false, deleted: false });
  assert.deepEqual(settleBetaArchive(dataDir, now + LEGACY_TTL_MS, false), { moved: false, deleted: true });
  assert.equal(existsSync(join(dataDir, "legacy")), false);
});

test("a logout deletes the credentials only: the database and every legacy file stay untouched", async (t) => {
  const fx = await buildLegacyAccount();
  await bootAt(t, fx.dataDir, fx.now);
  const dbPath = join(fx.paths.root, "wazap.sqlite");
  const before = { db: statSync(dbPath).size, legacy: readdirSync(join(fx.paths.root, "legacy")).sort(), archive: existsSync(join(fx.dataDir, "legacy", "archive.sqlite")) };

  const original = socketFactory.open;
  socketFactory.open = () => {
    const sock = fakeSocket();
    sock.logout = async () => sock.end();
    setImmediate(() => sock.ev.emit("connection.update", { connection: "open" }));
    return sock;
  };
  t.after(() => (socketFactory.open = original));
  const watched = [join(fx.paths.root, "legacy"), join(fx.dataDir, "legacy"), dbPath];
  const touched = [];
  for (const name of ["rmSync", "renameSync", "unlinkSync", "writeFileSync", "readFileSync", "openSync"]) {
    const fn = fs[name];
    t.mock.method(fs, name, function (path, ...rest) {
      if (typeof path === "string" && watched.some((prefix) => path.startsWith(prefix))) touched.push(`${name} ${path}`);
      return fn.call(this, path, ...rest);
    });
  }
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  assert.equal(await logoutAccount(fx.dataDir, "default", 2_000), "logged_out");
  t.mock.restoreAll();
  syncBuiltinESMExports();
  assert.deepEqual(touched, []);
  assert.equal(existsSync(fx.paths.authDir), false, "credentials deleted");
  assert.equal(statSync(dbPath).size, before.db);
  assert.deepEqual(readdirSync(join(fx.paths.root, "legacy")).sort(), before.legacy);
  assert.equal(existsSync(join(fx.dataDir, "legacy", "archive.sqlite")), before.archive);
});

test("status reports each account's storage read-only, with a server holding the database and with none", async (t) => {
  const fx = await buildLegacyAccount();
  await bootAt(t, fx.dataDir, fx.now);
  previousOwner(fx.paths.root, fx.now);

  const stopped = await status(fx.dataDir, { WAZAP_RECALL: "local" });
  assert.equal(stopped.server_pid, null);
  const account = stopped.storage.accounts[0];
  assert.equal(account.account, "default");
  assert.equal(account.state, "ready");
  assert.ok(account.counts.messages > 0 && account.counts.chats > 0);
  assert.ok(account.db_bytes > 0);
  assert.equal(typeof account.embedding_queue, "number", "recall on counts the queue");
  assert.equal(account.legacy.state, "moved");
  assert.equal(account.legacy.path, join(fx.paths.root, "legacy"));
  assert.equal(Date.parse(account.legacy.delete_after), fx.now - (fx.now % 1000) + LEGACY_TTL_MS);
  assert.deepEqual(account.previous_owner.map((db) => db.file), [`wazap.${fx.now}.previous-owner.sqlite`]);
  assert.equal(stopped.storage.beta_archive.state, "moved");
  assert.deepEqual(
    stopped.checks.filter((check) => ["storage", "legacy files", "previous owner", "beta archive"].includes(check.name)).map((check) => [check.name, check.state]),
    [["storage", "ok"], ["legacy files", "info"], ["previous owner", "info"], ["beta archive", "info"]]
  );
  const text = await statusText(fx.dataDir);
  assert.match(text, new RegExp(`✓ storage: ${account.counts.messages} messages in ${account.counts.chats} chats, \\d+ (KiB|MiB)`));
  assert.match(text, /– legacy files: kept in .*legacy until \d{4}-\d{2}-\d{2}, then deleted/);
  assert.equal(/Salut|mulțumesc/.test(text), false);

  // This process plays the running server: it holds the lock and the database, writable, mid-use.
  const svc = serviceOn(fx.dataDir);
  t.after(() => svc.stop());
  await svc.bootStorage();
  writeFileSync(join(fx.dataDir, "server.lock"), `${process.pid}\n`);
  t.after(() => fs.rmSync(join(fx.dataDir, "server.lock"), { force: true }));
  svc.db.messages.upsert({ chatJid: ANA, keyId: "WHILE", fromMe: false, ts: Date.now(), type: "text", text: "în timp ce rulează" });
  const running = await status(fx.dataDir);
  assert.equal(running.server_pid, process.pid);
  assert.equal(running.storage.accounts[0].state, "ready");
  assert.equal(running.storage.accounts[0].counts.messages, account.counts.messages + 1, "the read sees the server's commit");
  assert.equal(running.storage.accounts[0].embedding_queue, null, "recall off: no queue");
  svc.db.messages.upsert({ chatJid: ANA, keyId: "AFTER", fromMe: false, ts: Date.now(), type: "text", text: "după status" });
  assert.equal(svc.db.getMeta("import_state"), "done", "the server's connection is unharmed");
});

test("status tells a preparing import, running or waiting for the next start, a database it cannot open, and an account with nothing yet", async () => {
  const fx = await buildLegacyAccount();
  const dbPath = join(fx.paths.root, "wazap.sqlite");
  const db = AccountDb.open(dbPath);
  db.setMeta("import_state", "running");
  db.setMeta("import_progress", JSON.stringify({ phase: 2, cursor: null }));
  db.close();

  const waiting = await status(fx.dataDir);
  assert.equal(waiting.storage.accounts[0].state, "preparing");
  assert.deepEqual(waiting.storage.accounts[0].progress, { phase: "history", step: 3, steps: 9 });
  assert.deepEqual(waiting.storage.accounts[0].legacy, { state: "in-place", entries: 5 });
  assert.equal(
    waiting.checks.find((check) => check.name === "storage").detail,
    "the earlier message files are imported at the next start, resuming (history, step 3 of 9)"
  );
  assert.deepEqual(waiting.storage.beta_archive.waiting_for, ["default"]);

  writeFileSync(join(fx.dataDir, "server.lock"), `${process.pid}\n`);
  const importing = await status(fx.dataDir);
  fs.rmSync(join(fx.dataDir, "server.lock"));
  assert.equal(importing.checks.find((check) => check.name === "storage").detail, "importing the earlier message files (history, step 3 of 9)");

  const broken = mkdtempSync(join(tmpdir(), "wazap-legacy-broken-"));
  const root = accountPaths(broken, "default").root;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "wazap.sqlite"), "not a database at all, not even close to one");
  const failed = await status(broken);
  assert.equal(failed.storage.accounts[0].state, "error");
  assert.equal(failed.checks.find((check) => check.name === "storage").state, "fail");

  const fresh = await status(mkdtempSync(join(tmpdir(), "wazap-legacy-fresh-")));
  assert.equal(fresh.storage.accounts[0].state, "absent");
  assert.equal(fresh.storage.beta_archive, null);
  assert.equal(fresh.checks.some((check) => ["storage", "legacy files", "previous owner", "beta archive"].includes(check.name)), false);
});
