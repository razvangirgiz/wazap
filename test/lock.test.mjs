import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lockHolder, writeLock, releaseLock } from "../dist/lock.js";

function lockPath() {
  return join(mkdtempSync(join(tmpdir(), "wazap-lock-")), "server.lock");
}

test("an absent lock is free", () => {
  assert.equal(lockHolder(lockPath()), null);
});

test("a lock held by a live process reports its pid", () => {
  const file = lockPath();
  writeLock(file);
  assert.equal(readFileSync(file, "utf8").trim(), String(process.pid));
  assert.equal(lockHolder(file), process.pid);
});

test("a lock left by a dead process is stale, not held", () => {
  const file = lockPath();
  // A pid that cannot be running: the kernel would have to have wrapped past it.
  writeFileSync(file, "2147483646\n");
  assert.equal(lockHolder(file), null);
});

test("garbage in the lock file is treated as free rather than crashing", () => {
  const file = lockPath();
  writeFileSync(file, "not-a-pid\n");
  assert.equal(lockHolder(file), null);
});

test("release removes our own lock and is idempotent", () => {
  const file = lockPath();
  writeLock(file);
  releaseLock(file);
  assert.equal(existsSync(file), false);
  releaseLock(file);
});

test("release leaves another process's lock alone", () => {
  const file = lockPath();
  writeFileSync(file, "2147483646\n");
  releaseLock(file);
  assert.equal(existsSync(file), true, "we must never delete a lock we do not hold");
});

test("a fresh lock is taken", () => {
  assert.equal(writeLock(lockPath()), true);
});

test("a lock held by a live process is never taken from it", () => {
  const file = lockPath();
  // The parent of the test runner: another pid, and certainly alive.
  writeFileSync(file, `${process.ppid}\n`);
  assert.equal(writeLock(file), false);
  assert.equal(readFileSync(file, "utf8").trim(), String(process.ppid), "the holder's lock was overwritten");
});

test("a stale lock is taken", () => {
  const file = lockPath();
  writeFileSync(file, "2147483646\n");
  assert.equal(writeLock(file), true);
  assert.equal(readFileSync(file, "utf8").trim(), String(process.pid));
});

const DEAD = 2147483646;

test("a stale lock another process takes between the check and the delete stays that process's", () => {
  const file = lockPath();
  writeFileSync(file, `${DEAD}\n`);
  const kill = process.kill;
  // The dead pid is found dead, and before this process acts on it another one
  // clears the stale lock and writes its own: the interleaving that let two win.
  process.kill = (pid, signal) => {
    try {
      return kill.call(process, pid, signal);
    } catch (err) {
      if (pid === DEAD) writeFileSync(file, `${process.ppid}\n`);
      throw err;
    }
  };
  try {
    assert.equal(writeLock(file), false);
  } finally {
    process.kill = kill;
  }
  assert.equal(readFileSync(file, "utf8").trim(), String(process.ppid), "the new holder's lock was deleted");
});

test("a claim another process deletes and replaces right after does not count as held", () => {
  const file = lockPath();
  writeFileSync(file, `${DEAD}\n`);
  const write = fs.writeFileSync;
  // Our claim lands, then the other process that also found the stale lock
  // removes it and claims its own.
  fs.writeFileSync = (path, data, options) => {
    write(path, data, options);
    if (path === file && options?.flag === "wx") write(file, `${process.ppid}\n`);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(writeLock(file), false);
  } finally {
    fs.writeFileSync = write;
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(file, "utf8").trim(), String(process.ppid));
});
