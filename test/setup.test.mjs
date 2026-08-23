import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CLIENTS, detectClients } from "../dist/connect.js";
import { readService } from "../dist/service.js";
import { keepRunningOptions, parseChoice } from "../dist/setup.js";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binary = join(root, "dist", "index.js");
const SKILLS = readdirSync(join(root, "skills"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

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

test("setup --agent is AGENT.md on stdout, nothing on stderr", async () => {
  const document = readFileSync(join(root, "AGENT.md"), "utf8");
  // A non-zero exit rejects, so reaching the assertions is the exit-0 check.
  const { stdout, stderr } = await run(process.execPath, [binary, "setup", "--agent", "--data-dir", dataDir("wazap-agent-")], {
    env: childEnv(),
  });

  assert.equal(stdout, document, "the command and the file must be the same document");
  assert.equal(stderr, "");
  assert.match(stdout, /pairing code:/);
  assert.match(stdout, /connect/);
});

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

/**
 * The credentials above are a stub, so the live probe never reaches `connected`
 * and setup exits 1. Every case that owns a linked dir goes through here.
 */
async function failingSetup(box, ...args) {
  const err = await setup(box, ...args).then(
    () => assert.fail("a failing live check must exit non-zero"),
    (rejected) => rejected,
  );
  assert.equal(err.code, 1);
  assert.match(err.stderr, /→ run `wazap status --live` after fixing it/);
  assert.match(err.stderr, /Setup finished with a failing check/);
  return err.stderr;
}

test("setup on a linked session connects the named client and reports the session it could not reach", async () => {
  const box = sandbox();
  const dir = linkedDataDir();
  const stderr = await failingSetup(box, "--yes", "--client", "cursor", "--data-dir", dir);

  assert.match(stderr, /Already linked as/);
  assert.match(stderr, /✓ launch Cursor runs `wazap` from your shell PATH/);
  assert.match(stderr, /Reload the Cursor window\./);
  const written = JSON.parse(readFileSync(join(box.home, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(written.mcpServers.whatsapp, { command: "wazap", args: ["--data-dir", dir] });

  // Connecting a client is also where its skills land: no second command.
  for (const name of SKILLS) {
    assert.ok(existsSync(join(box.home, ".cursor", "skills", name, "SKILL.md")), `${name} never reached Cursor`);
  }
});

test("setup skips the live check while another process holds the session", async () => {
  const box = sandbox();
  const dir = linkedDataDir();
  writeFileSync(join(dir, "server.lock"), `${process.pid}\n`);
  const { stderr } = await setup(box, "--yes", "--client", "cursor", "--data-dir", dir);

  assert.match(stderr, new RegExp(`A server already holds the session \\(pid ${process.pid}\\); skipping the live check\\.`));
  assert.match(stderr, /Setup complete/);
});

test("setup tells a client with no skills directory that the server carries the workflows", async () => {
  const box = sandbox();
  const stderr = await failingSetup(box, "--yes", "--client", "claude-desktop", "--data-dir", linkedDataDir());

  assert.match(stderr, /Claude Desktop gets the workflows from the server itself, as MCP prompts\./);
  assert.ok(!existsSync(join(box.home, ".claude", "skills")), "Claude Desktop reads no skills directory");
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

test("a 401 at logout means the phone already removed the device, not a bad pairing code", async () => {
  const { alreadyUnlinked } = await import("../dist/cli.js");
  const { WazapError } = await import("../dist/errors.js");
  assert.equal(alreadyUnlinked(new WazapError("SESSION_EXPIRED", "WhatsApp rejected the link.")), true);
  assert.equal(alreadyUnlinked({ output: { statusCode: 401 } }), true);
  assert.equal(alreadyUnlinked(new WazapError("TIMEOUT", "WhatsApp did not answer in time.")), false);
  assert.equal(alreadyUnlinked(new Error("socket hang up")), false);
  assert.equal(alreadyUnlinked(undefined), false);
});

test("the keep-running menu offers a public URL only when something can tunnel", () => {
  const none = keepRunningOptions([{ available: () => false }]);
  assert.deepEqual(none.map((option) => option.choice), ["client", "service"]);

  const some = keepRunningOptions([{ available: () => false }, { available: () => true }]);
  assert.deepEqual(some.map((option) => option.choice), ["client", "service", "expose"]);
});

/**
 * A `launchctl`/`systemctl` of our own: it reads the unit wazap just wrote and
 * starts exactly that command, so the install, the lock and /healthz are the
 * real ones. The user's own launchd is never reached.
 */
const SUPERVISOR_STUB = {
  darwin: ["launchctl"],
  linux: ["systemctl", "loginctl", "journalctl"],
}[process.platform];

function stubSupervisor(box) {
  const state = join(box.home, "loaded");
  // The unit is the only source of truth here: the same environment and the
  // same argv the real supervisor would launch, data dir included.
  const reader =
    process.platform === "darwin"
      ? `/usr/bin/python3 -c "import plistlib,sys;d=plistlib.load(open(sys.argv[1],'rb'));print(' '.join([k+'='+v for k,v in d['EnvironmentVariables'].items()]+d['ProgramArguments']))" "$UNIT"`
      : `{ sed -n 's/^Environment=//p' "$UNIT" | tr '\\n' ' '; sed -n 's/^ExecStart=//p' "$UNIT"; }`;
  const unit =
    process.platform === "darwin"
      ? `${join(box.home, "Library", "LaunchAgents")}/com.wazap.server.plist`
      : `${join(box.home, ".config", "systemd", "user")}/wazap.service`;
  const script = `#!/bin/sh
UNIT=${unit}
case "$*" in
  *print*|*MainPID*)
    if [ -f ${state} ] && kill -0 $(cat ${state}) 2>/dev/null; then
      printf '\tpid = %s\n' "$(cat ${state})"
      cat ${state}
      exit 0
    fi
    echo 0; exit 113 ;;
  *bootout*|*"--user stop"*) [ -f ${state} ] && kill $(cat ${state}) 2>/dev/null; rm -f ${state}; exit 0 ;;
esac
[ -f "$UNIT" ] || exit 0
LINE=$(${reader})
env $LINE >/dev/null 2>&1 &
echo $! > ${state}
exit 0
`;
  for (const binary of SUPERVISOR_STUB) writeFileSync(join(box.bin, binary), script, { mode: 0o755 });
  return () => {
    if (!existsSync(state)) return;
    try {
      process.kill(Number(readFileSync(state, "utf8").trim()), "SIGKILL");
    } catch {
      /* already gone */
    }
  };
}

test(
  "setup --service installs the service, and Finish reports its health instead of opening the session",
  { skip: SUPERVISOR_STUB === undefined ? `no launchd or systemd on ${process.platform}` : false },
  async () => {
    const box = sandbox();
    const dir = linkedDataDir();
    const port = 43_311;
    const kill = stubSupervisor(box);
    try {
      // The stub credentials never reach `connected`, so Finish fails; what this
      // pins is that it failed on the service's own /healthz.
      const err = await setup(box, "--yes", "--service", "--client", "cursor", "--port", String(port), "--data-dir", dir).then(
        () => assert.fail("stub credentials cannot reach connected"),
        (rejected) => rejected,
      );

      assert.match(err.stderr, /Step 4 of 5 · Keep running/);
      assert.match(err.stderr, new RegExp(`Running · pid \\d+ · http://127\\.0\\.0\\.1:${port}/mcp`));
      assert.match(err.stderr, /the service reports \w+/);
      assert.match(err.stderr, /→ run `wazap service logs`/);
      assert.ok(!err.stderr.includes("already owns this session"), "Finish must not fight the service for the socket");

      const record = readService(dir);
      assert.equal(record.port, port);
      assert.equal(existsSync(record.unitFile), true, "the unit landed in the sandbox HOME");
      assert.ok(record.unitFile.startsWith(box.home), `the unit must stay in the sandbox: ${record.unitFile}`);
    } finally {
      kill();
    }
  },
);

test("setup with no answer keeps wazap running only while a client has it open", async () => {
  const box = sandbox();
  const dir = linkedDataDir();
  const stderr = await failingSetup(box, "--yes", "--client", "cursor", "--data-dir", dir);
  assert.match(stderr, /Step 4 of 5 · Keep running/);
  assert.equal(readService(dir), null, "the default must install nothing");
});
