import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function childEnv(extra) {
  return { ...process.env, WAZAP_NO_UPDATE_CHECK: "1", ...extra };
}

function dataDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("login refuses to touch a session another process holds", async () => {
  const dir = dataDir("wazap-login-lock-");
  writeFileSync(join(dir, "server.lock"), `${process.pid}\n`);
  await assert.rejects(
    run(process.execPath, [binary, "login", "--phone", "+15550100", "--yes", "--data-dir", dir], {
      env: childEnv(),
    }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /wazap is running \(pid \d+\)/);
      return true;
    },
  );
});

const PAIRING_DEADLINE_MS = 30_000;

test("login prints a machine-readable pairing code and releases the lock when killed", async () => {
  const dir = dataDir("wazap-pairing-");
  const child = spawn(process.execPath, [binary, "login", "--phone", "+15550100", "--yes", "--data-dir", dir], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv(),
  });
  const exited = new Promise((resolve) => child.once("close", resolve));

  try {
    const code = await new Promise((resolve, reject) => {
      let seen = "";
      const timer = setTimeout(() => reject(new Error(`no pairing code in ${PAIRING_DEADLINE_MS}ms: ${seen}`)), PAIRING_DEADLINE_MS);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        seen += chunk;
        const match = /pairing code: ([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(seen);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once("close", () => {
        clearTimeout(timer);
        reject(new Error(`login exited before pairing: ${seen}`));
      });
    });
    assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.equal(existsSync(join(dir, "server.lock")), true, "the lock is held while pairing");
  } finally {
    child.kill("SIGTERM");
    await exited;
  }

  assert.equal(existsSync(join(dir, "server.lock")), false, "a killed login must not leave its lock behind");
});
