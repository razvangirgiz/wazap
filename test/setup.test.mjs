import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CLIENTS, detectClients } from "../dist/connect.js";
import { parseChoice } from "../dist/setup.js";

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

test("detectClients reports the clients the probes find, in table order", () => {
  const found = detectClients({ exists: (p) => p.endsWith(".cursor"), onPath: (c) => c === "claude" });
  assert.deepEqual(found.map((spec) => spec.name), ["claude-code", "cursor"]);
});

test("detectClients finds nothing when nothing is installed", () => {
  assert.deepEqual(detectClients({ exists: () => false, onPath: () => false }), []);
});

const DETECTED = [CLIENTS[2]];
const CHOICES = [
  ["", ["cursor"]],
  ["all", CLIENTS.map((spec) => spec.name)],
  ["none", []],
  ["1,3", ["claude-code", "cursor"]],
  ["1 3", ["claude-code", "cursor"]],
  ["9", null],
  ["x", null],
  ["1 1", ["claude-code"]],
];

for (const [answer, expected] of CHOICES) {
  test(`the client choice ${JSON.stringify(answer)} means ${JSON.stringify(expected)}`, () => {
    const picked = parseChoice(answer, DETECTED);
    assert.deepEqual(picked === null ? null : picked.map((spec) => spec.name), expected);
  });
}

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "wazap-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "wazap-cwd-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "wazap"), "", { mode: 0o755 });
  return { home, cwd, bin };
}

function setup(box, ...args) {
  return run(process.execPath, [binary, "setup", ...args], {
    cwd: box.cwd,
    env: childEnv({
      HOME: box.home,
      USERPROFILE: box.home,
      APPDATA: join(box.home, "AppData", "Roaming"),
      PATH: `${box.bin}${delimiter}${process.env.PATH ?? ""}`,
    }),
  });
}

/** Enough of a creds.json for readLinkedAccount to call the session linked. */
function linkedDataDir() {
  const dir = dataDir("wazap-setup-");
  mkdirSync(join(dir, "auth"));
  writeFileSync(
    join(dir, "auth", "creds.json"),
    JSON.stringify({ registered: true, me: { id: "15550100:1@s.whatsapp.net", name: "Test" } }),
  );
  return dir;
}

test("setup on a linked session connects the named client and finishes", async () => {
  const box = sandbox();
  const dir = linkedDataDir();
  const { stderr } = await setup(box, "--yes", "--client", "cursor", "--data-dir", dir);

  assert.match(stderr, /Already linked as/);
  assert.match(stderr, /Setup complete/);
  assert.match(stderr, /Reload the Cursor window\./);
  const written = JSON.parse(readFileSync(join(box.home, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(written.mcpServers.whatsapp, { command: "wazap", args: ["--data-dir", dir] });
});

test("setup refuses to link while another process owns the session", async () => {
  const box = sandbox();
  const dir = dataDir("wazap-setup-locked-");
  writeFileSync(join(dir, "server.lock"), `${process.pid}\n`);
  await assert.rejects(setup(box, "--yes", "--client", "cursor", "--data-dir", dir), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /wazap is running \(pid \d+\)/);
    return true;
  });
});
