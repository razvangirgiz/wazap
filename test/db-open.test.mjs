/**
 * Opening the account database: the file is owner-only from its first byte,
 * the pragmas behind "deletions stay deleted" are really on, the schema
 * migrates once and a newer file is refused untouched, status/doctor can read
 * without writing, and an online backup is a usable copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

import { AccountDb, SCHEMA_VERSION, StorageError, isSqliteExperimentalWarning } from "../dist/db/index.js";
import { PEER, T0, openTemp, tempDir, textMessage } from "./db-fixtures.mjs";

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const posix = process.platform !== "win32";

const mode = (path) => statSync(path).mode & 0o777;
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("the file, its WAL and its shared memory are owner-only inside an owner-only directory", { skip: !posix }, () => {
  const { db, path } = openTemp();
  db.messages.upsert(textMessage(PEER, "A", T0, "salut"));
  assert.equal(mode(dirname(path)), 0o700);
  assert.equal(mode(path), 0o600);
  assert.ok(existsSync(`${path}-wal`), "WAL mode keeps a -wal file while open");
  assert.equal(mode(`${path}-wal`), 0o600);
  assert.equal(mode(`${path}-shm`), 0o600);
  db.close();
});

test("loose modes left on an existing directory or file are tightened on open", { skip: !posix }, () => {
  const dir = join(tempDir(), "acct");
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  const path = join(dir, "wazap.sqlite");
  writeFileSync(path, "");
  chmodSync(path, 0o644);
  const db = AccountDb.open(path);
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(path), 0o600);
  db.close();
});

test("WAL, synchronous FULL, foreign keys, secure delete (table and index) and a busy timeout are in force", () => {
  const { db } = openTemp({ timeoutMs: 4321 });
  assert.deepEqual(db.settings(), {
    journalMode: "wal",
    synchronous: "full",
    foreignKeys: true,
    secureDelete: true,
    ftsSecureDelete: true,
    busyTimeoutMs: 4321,
  });
  db.close();
});

test("migrations run once: reopening keeps the version and the original migration stamp", () => {
  const { db, path, clock } = openTemp();
  assert.equal(db.schemaVersion, SCHEMA_VERSION);
  const stamp = db.getMeta("migrated_v1");
  const created = db.getMeta("created_at");
  assert.equal(stamp, String(clock.now));
  db.close();

  const reopened = AccountDb.open(path, { now: () => clock.now + 86_400_000 });
  assert.equal(reopened.schemaVersion, SCHEMA_VERSION);
  assert.equal(reopened.getMeta("migrated_v1"), stamp);
  assert.equal(reopened.getMeta("created_at"), created);
  reopened.close();
});

test("a file from a newer schema is refused with a typed error and left byte-for-byte untouched", () => {
  const { db, path } = openTemp();
  db.messages.upsert(textMessage(PEER, "A", T0, "salut"));
  db.close();
  assert.equal(existsSync(`${path}-wal`), false, "closing the last connection checkpoints and removes the WAL");
  // user_version lives at offset 60 of the header, big-endian.
  const bytes = readFileSync(path);
  bytes.writeUInt32BE(SCHEMA_VERSION + 1, 60);
  writeFileSync(path, bytes);
  const before = digest(path);

  for (const readOnly of [false, true]) {
    assert.throws(
      () => AccountDb.open(path, { readOnly }),
      (err) => err instanceof StorageError && err.code === "SCHEMA_TOO_NEW" && /Update wazap/.test(err.fix)
    );
  }
  assert.equal(digest(path), before);
});

test("finding 12c: a process opening a new file while another migrates it waits for that migration instead of repeating it", async () => {
  const path = join(tempDir(), "race", "wazap.sqlite");
  const dist = JSON.stringify(join(repoRoot, "dist", "db", "index.js"));
  // The first process migrates slowly: its clock sleeps inside the migration transaction.
  const slow = `
    const { AccountDb } = await import(${dist});
    let told = false;
    const db = AccountDb.open(${JSON.stringify(path)}, {
      now: () => {
        if (!told) { told = true; process.stdout.write("migrating\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800); }
        return Date.now();
      },
    });
    db.close();
    process.stdout.write("done\\n");
  `;
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--input-type=module", "-e", slow], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("migrating")) resolve();
    });
    child.on("exit", () => reject(new Error(`the slow opener exited early: ${output}`)));
  });
  const db = AccountDb.open(path);
  assert.equal(db.schemaVersion, SCHEMA_VERSION);
  db.close();
  const code = await new Promise((resolve) => (child.exitCode === null ? child.on("exit", resolve) : resolve(child.exitCode)));
  assert.equal(code, 0);
  assert.match(output, /done/);
});

test("read-only open reads beside a writer, refuses writes and migrations, and refuses a missing file", () => {
  const { db, path } = openTemp();
  db.messages.upsert(textMessage(PEER, "A", T0, "salut"));

  const reader = AccountDb.open(path, { readOnly: true });
  assert.equal(reader.readOnly, true);
  assert.equal(reader.messages.get(`false_${PEER}_A`).text, "salut");
  assert.throws(
    () => reader.messages.upsert(textMessage(PEER, "B", T0, "nu")),
    (err) => err instanceof StorageError && err.code === "READ_ONLY"
  );
  reader.close();

  db.close();
  const afterClose = AccountDb.open(path, { readOnly: true });
  assert.equal(afterClose.counts().messages, 1);
  afterClose.close();

  assert.throws(
    () => AccountDb.open(join(tempDir(), "missing.sqlite"), { readOnly: true }),
    (err) => err instanceof StorageError && err.code === "NOT_FOUND"
  );
});

test("an immutable read-only open of a closed file reads it and creates nothing beside it", () => {
  const { db, path } = openTemp();
  db.messages.upsert(textMessage(PEER, "A", T0, "salut"));
  db.close();
  assert.equal(existsSync(`${path}-wal`) || existsSync(`${path}-shm`), false, "a clean close leaves the file alone");
  const reader = AccountDb.open(path, { readOnly: true, immutable: true });
  assert.equal(reader.counts().messages, 1);
  reader.close();
  assert.equal(existsSync(`${path}-wal`), false);
  assert.equal(existsSync(`${path}-shm`), false);
});

test("a read-only open of a file that still needs migrating says so instead of reading a half schema", () => {
  const path = join(tempDir(), "empty.sqlite");
  writeFileSync(path, "");
  assert.throws(
    () => AccountDb.open(path, { readOnly: true }),
    (err) => err instanceof StorageError && err.code === "SCHEMA_OUTDATED"
  );
});

test("everything written survives close and reopen", () => {
  const { db, path } = openTemp();
  db.messages.upsert(textMessage(PEER, "A", T0, "prima"));
  db.messages.upsert(textMessage(PEER, "B", T0 + 1000, "a doua"));
  db.identity.setNote(PEER, "contabilul");
  db.close();
  const reopened = AccountDb.open(path);
  assert.deepEqual(
    reopened.messages.chatPage(PEER, { limit: 10 }).items.map((m) => m.text),
    ["a doua", "prima"]
  );
  assert.equal(reopened.identity.notes(PEER).note, "contabilul");
  reopened.close();
});

test("an online backup is an owner-only, complete, openable copy, and never lands on the live file", async () => {
  const { db, dir, path } = openTemp();
  for (let i = 0; i < 50; i++) db.messages.upsert(textMessage(PEER, `K${i}`, T0 + i * 1000, `mesaj ${i}`));
  const destination = join(dir, "backups", "copy.sqlite");
  const pages = await db.backup(destination);
  assert.ok(pages > 0);
  if (posix) assert.equal(mode(destination), 0o600);
  db.messages.upsert(textMessage(PEER, "after", T0 + 99_000, "after the backup"));
  const copy = AccountDb.open(destination, { readOnly: true });
  assert.equal(copy.counts().messages, 50);
  assert.equal(copy.search.text({ query: "mesaj 4", limit: 20 }).items.length, 11);
  copy.close();
  await assert.rejects(db.backup(path), (err) => err instanceof StorageError && err.code === "INVALID_INPUT");
  assert.equal(db.counts().messages, 51, "the live file is untouched");
  db.close();
});

test("finding 8: a backup aimed at the live file through a symlink or another case is refused and the live file is untouched", { skip: !posix }, async () => {
  for (const variant of ["symlink", "case", "hardlink"]) {
    const { db, path, clock } = openTemp();
    for (let i = 0; i < 200; i++) db.messages.upsert(textMessage(PEER, `K${i}`, T0 + i * 1000, "x".repeat(500)));
    db.checkpoint();
    const before = statSync(path).size;
    let destination;
    if (variant === "symlink") {
      destination = join(dirname(path), "..", "backup-link.sqlite");
      symlinkSync(path, destination);
    } else if (variant === "hardlink") {
      destination = join(dirname(path), "..", "backup-hard.sqlite");
      linkSync(path, destination);
    } else {
      destination = join(dirname(path), "WAZAP.sqlite");
    }
    const sameFile = existsSync(destination) && statSync(destination).ino === statSync(path).ino;
    if (sameFile) {
      await assert.rejects(db.backup(destination), (err) => err instanceof StorageError && err.code === "INVALID_INPUT", variant);
    } else {
      await db.backup(destination);
    }
    assert.equal(statSync(path).size, before, `${variant}: the live file keeps its size`);
    db.close();
    const again = AccountDb.open(path, { now: () => clock.now });
    assert.equal(again.counts().messages, 200, variant);
    assert.equal(again.integrityCheck().ok, true, variant);
    again.close();
    if (variant !== "case") assert.ok(sameFile, `${variant} names the live file on every disk`);
  }
});

test("a closed database refuses with CLOSED rather than a native error", () => {
  const { db } = openTemp();
  db.close();
  db.close();
  assert.throws(
    () => db.messages.get(`false_${PEER}_A`),
    (err) => err instanceof StorageError && err.code === "CLOSED"
  );
});

test("only SQLite's experimental warning is recognised", () => {
  assert.equal(isSqliteExperimentalWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning"), true);
  assert.equal(isSqliteExperimentalWarning("SQLite is an experimental feature", { type: "ExperimentalWarning" }), true);
  assert.equal(isSqliteExperimentalWarning("VM Modules is an experimental feature", "ExperimentalWarning"), false);
  assert.equal(isSqliteExperimentalWarning("SQLite said something", "DeprecationWarning"), false);
});

test("opening a database prints nothing to stdout and no SQLite warning to stderr, other warnings still show", async () => {
  const path = join(tempDir(), "child", "wazap.sqlite");
  const script = `
    const { AccountDb } = await import(${JSON.stringify(join(repoRoot, "dist", "db", "index.js"))});
    const db = AccountDb.open(${JSON.stringify(path)});
    db.close();
    process.emitWarning("something else is experimental", "ExperimentalWarning");
    await new Promise((resolve) => setTimeout(resolve, 20));
  `;
  const { stdout, stderr } = await run(process.execPath, ["--input-type=module", "-e", script]);
  assert.equal(stdout, "");
  assert.doesNotMatch(stderr, /SQLite is an experimental/);
  assert.match(stderr, /something else is experimental/);
});

test("reactions and votes list ties in the order they arrived, and a delete takes them", () => {
  const db = AccountDb.open(join(tempDir("wazap-db-ties-"), "wazap.sqlite"));
  const poll = "false_120363000000000001@g.us_P";
  db.messages.upsert({ chatJid: "120363000000000001@g.us", keyId: "P", fromMe: false, ts: 1_788_256_800_000, type: "poll", text: "poll" });
  db.messages.vote(poll, "40700000003@s.whatsapp.net", '["da"]', 5);
  db.messages.vote(poll, "40700000002@s.whatsapp.net", '["nu"]', 7);
  db.messages.react(poll, "40700000002@s.whatsapp.net", "👍", 9);
  assert.deepEqual(db.messages.votes(poll).map((v) => [v.jid, v.choice]), [
    ["40700000003@s.whatsapp.net", '["da"]'],
    ["40700000002@s.whatsapp.net", '["nu"]'],
  ]);
  assert.deepEqual(db.messages.reactions(poll).map((r) => r.emoji), ["👍"]);

  // Two votes in the same instant: the one that came first is listed first, whoever's contact is older.
  db.messages.vote(poll, "40700000003@s.whatsapp.net", '["da"]', 20);
  db.messages.vote(poll, "40700000002@s.whatsapp.net", '["da"]', 20);
  assert.deepEqual(db.messages.votes(poll).map((v) => v.jid), ["40700000003@s.whatsapp.net", "40700000002@s.whatsapp.net"]);
  db.messages.delete(poll);
  assert.deepEqual(db.messages.votes(poll), [], "the tombstone takes the marks");
  assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
  db.close();
});
