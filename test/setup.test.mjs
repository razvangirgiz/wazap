import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CLIENTS, detectClients } from "../dist/connect.js";
import { WAZAP_VERSION } from "../dist/config.js";
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

function sandbox({ wazap = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "wazap-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "wazap-cwd-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  if (wazap) symlinkSync(binary, join(bin, "wazap"));
  return { home, cwd, bin };
}

/**
 * `isNpxPath` only reads the path, so a symlink under a `_npx` directory is a
 * wazap started through npx as far as everything downstream is concerned.
 */
function npxBinary() {
  const dir = join(mkdtempSync(join(tmpdir(), "wazap-npx-")), "_npx", "a1b2", "node_modules", "wazap-mcp", "dist");
  mkdirSync(dir, { recursive: true });
  const link = join(dir, "index.js");
  symlinkSync(binary, link);
  return link;
}

/** An `npm` that records its argv, and writes the `wazap` a global install would put on PATH. */
function stubNpm(box, { status = 0 } = {}) {
  const log = join(box.home, "npm.log");
  writeFileSync(
    join(box.bin, "npm"),
    `#!/bin/sh
echo "$@" >> ${log}
[ "$1" = "prefix" ] && { echo ${box.home}/prefix; exit 0; }
[ ${status} -eq 0 ] || exit ${status}
printf '#!/bin/sh\nexit 0\n' > ${join(box.bin, "wazap")}
chmod +x ${join(box.bin, "wazap")}
exit 0
`,
    { mode: 0o755 },
  );
  return () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
}

function setup(box, ...args) {
  return run(process.execPath, [box.binary ?? binary, "setup", ...args], {
    cwd: box.cwd,
    env: childEnv({
      HOME: box.home,
      USERPROFILE: box.home,
      APPDATA: join(box.home, "AppData", "Roaming"),
      PATH: box.path ?? box.bin,
      WAZAP_LIVE_TIMEOUT_MS: "1000",
      ...box.env,
    }),
  });
}

/** A `brew` that records its argv and drops in the binaries the real one installs. */
function stubBrew(box) {
  const log = join(box.home, "brew.log");
  writeFileSync(
    join(box.bin, "brew"),
    `#!/bin/sh
echo "$@" >> ${log}
shift
for formula in "$@"; do
  [ "$formula" = whisper-cpp ] && formula=whisper-cli
  : > ${box.bin}/$formula
  /bin/chmod +x ${box.bin}/$formula
done
exit 0
`,
    { mode: 0o755 },
  );
  return () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
}

test("setup --agent is USE-ME.md on stdout, nothing on stderr", async () => {
  const document = readFileSync(join(root, "USE-ME.md"), "utf8");
  const dir = dataDir("wazap-agent-");
  // A non-zero exit rejects, so reaching the assertions is the exit-0 check.
  const { stdout, stderr } = await run(process.execPath, [binary, "setup", "--agent", "--data-dir", dir], {
    env: childEnv(),
  });

  assert.equal(stdout, document, "the command and the file must be the same document");
  assert.equal(stderr, "");
  assert.deepEqual(readdirSync(dir), [], "reading the guide must not create account data");
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
  assert.match(stderr, /connection not verified/);
  assert.doesNotMatch(stderr, /Setup complete/);
});

test("setup tells a client with no skills directory that the server carries the workflows", async () => {
  const box = sandbox();
  const stderr = await failingSetup(box, "--yes", "--client", "claude-desktop", "--data-dir", linkedDataDir());

  assert.match(stderr, /Claude Desktop gets the workflows from the server itself, as MCP prompts\./);
  assert.ok(!existsSync(join(box.home, ".claude", "skills")), "Claude Desktop reads no skills directory");
});

/** A `pgrep`, `osascript` and `open` that log their argv; quitting clears the running marker. */
function stubRelaunch(box) {
  const log = join(box.home, "relaunch.log");
  const running = join(box.home, "running");
  writeFileSync(running, "");
  const scripts = {
    pgrep: `[ -f ${running} ] || exit 1`,
    osascript: `/bin/rm -f ${running}`,
    open: "",
  };
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(box.bin, name), `#!/bin/sh\necho "${name} $@" >> ${log}\n${body}\nexit 0\n`, { mode: 0o755 });
  }
  return () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
}

const DARWIN_ONLY = process.platform === "darwin" ? false : "relaunch is a macOS answer";

test("setup --relaunch restarts Claude Desktop for the user, and says so instead of asking", { skip: DARWIN_ONLY }, async () => {
  const box = sandbox();
  const calls = stubRelaunch(box);
  const stderr = await failingSetup(box, "--yes", "--relaunch", "--client", "claude-desktop", "--data-dir", linkedDataDir());

  assert.deepEqual(calls(), [
    "pgrep -x Claude",
    "pgrep -x Claude",
    'osascript -e tell application "Claude" to quit',
    "pgrep -x Claude",
    "open -a Claude",
  ]);
  assert.match(stderr, /✓ Claude Desktop restarted/);
  assert.ok(!stderr.includes("– Restart Claude Desktop."), "the restarted client keeps no leftover instruction");
});

test("setup --yes alone leaves Claude Desktop alone: an agent inside it must not quit itself", { skip: DARWIN_ONLY }, async () => {
  const box = sandbox();
  const calls = stubRelaunch(box);
  const stderr = await failingSetup(box, "--yes", "--client", "claude-desktop", "--data-dir", linkedDataDir());

  assert.deepEqual(calls(), ["pgrep -x Claude"], "the running check is all that may run");
  assert.match(stderr, /Restart Claude Desktop\./);
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
  const noBrew = { onPath: () => false };
  const none = keepRunningOptions([{ available: () => false }], noBrew);
  assert.deepEqual(none.map((option) => option.choice), ["client", "service"]);

  const some = keepRunningOptions([{ available: () => false }, { available: () => true }], noBrew);
  assert.deepEqual(some.map((option) => option.choice), ["client", "service", "expose"]);

  const brewable = keepRunningOptions([{ available: () => false }], { onPath: (command) => command === "brew" });
  assert.deepEqual(brewable.map((option) => option.choice), ["client", "service", "expose"], "brew can install one");
});

test("setup --transcribe local brews the binaries, then goes straight on to the model", async () => {
  const box = sandbox();
  // Nothing but the sandbox on PATH, so the stub brew is the only brew in reach
  // and a real ffmpeg on this machine cannot answer for the one being installed.
  box.path = box.bin;
  box.env = { WAZAP_WHISPER_MODEL: "turbo" };
  const calls = stubBrew(box);
  const dir = linkedDataDir();
  // The model is 574 MB from Hugging Face. A file where its directory belongs
  // stops the download at its first mkdir, before anything is fetched.
  writeFileSync(join(dir, "models"), "");

  const err = await setup(box, "--yes", "--transcribe", "local", "--client", "cursor", "--data-dir", dir).then(
    () => assert.fail("a blocked models directory must fail the run"),
    (rejected) => rejected,
  );

  assert.deepEqual(calls(), ["install whisper-cpp ffmpeg"], "one brew call for the whole set");
  assert.match(err.stderr, /whisper-cli is not installed; it transcribes voice messages locally\./);
  assert.match(err.stderr, /Checking ggml-large-v3-turbo-q5_0\.bin…/, "the same run must reach the download");
  assert.ok(
    !err.stderr.includes("once they are installed"),
    "setup must not send the user off to `transcribe download` after installing the binaries",
  );
});

test("setup --transcribe local --no-brew leaves the fix line standing and installs nothing", async () => {
  const box = sandbox();
  box.path = box.bin;
  const calls = stubBrew(box);
  const stderr = await failingSetup(box, "--yes", "--no-brew", "--transcribe", "local", "--client", "cursor", "--data-dir", linkedDataDir());

  assert.deepEqual(calls(), [], "brew must not be called");
  assert.match(stderr, /whisper\.cpp not found/);
  assert.match(stderr, process.platform === "darwin"
    ? /→ Run `brew install whisper-cpp ffmpeg`/
    : /→ Build whisper\.cpp from .* and install ffmpeg from your package manager/);
  assert.match(stderr, /Run `wazap transcribe download` once they are installed\./);
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
      ${process.platform === "darwin" ? `printf '\\tpid = %s\\n' "$(cat ${state})"` : ""}
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
    // The supervisor stub is a shell script that needs sed, env and kill. The
    // system directories also hold osascript, which this run never reaches:
    // the client is Cursor and there is no --relaunch.
    box.path = `${box.bin}${delimiter}/usr/bin${delimiter}/bin`;
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

      assert.match(err.stderr, /Step 3 of 5 · Keep running/);
      assert.match(err.stderr, new RegExp(`Running · pid \\d+ · http://127\\.0\\.0\\.1:${port}/mcp`));
      assert.match(err.stderr, /The selected account reports/);
      assert.match(err.stderr, /Run wazap status to diagnose it/);
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
  assert.match(stderr, /Step 3 of 5 · Keep running/);
  assert.equal(readService(dir), null, "the default must install nothing");
});

test("setup through npx installs wazap globally, then connects the client to that install", async () => {
  const box = { ...sandbox({ wazap: false }), binary: npxBinary() };
  const calls = stubNpm(box);
  const stderr = await failingSetup(box, "--yes", "--client", "cursor", "--data-dir", linkedDataDir());

  assert.match(stderr, /Step 2 of 6 · Install/);
  assert.match(stderr, /wazap was started through npx/);
  assert.deepEqual(
    calls().filter((line) => line.startsWith("install")),
    [`install -g wazap-mcp@${WAZAP_VERSION}`],
    "exactly one global install",
  );
  assert.ok(calls().includes("prefix -g"), "then setup asks npm where that bin landed");
  assert.match(stderr, new RegExp(`wazap-mcp@${WAZAP_VERSION.replace(/\./g, "\\.")} installed globally`));

  const written = JSON.parse(readFileSync(join(box.home, ".cursor", "mcp.json"), "utf8"));
  assert.equal(written.mcpServers.whatsapp.command, "wazap", "the rest of setup must behave as the global install");
});

test("setup --no-global never calls npm and leaves the clients on the npx entry", async () => {
  const box = { ...sandbox({ wazap: false }), binary: npxBinary() };
  const calls = stubNpm(box);
  const stderr = await failingSetup(box, "--yes", "--no-global", "--client", "cursor", "--data-dir", linkedDataDir());

  assert.deepEqual(calls(), [], "npm must not be called");
  assert.match(stderr, /need a global install; run `npm i -g wazap-mcp@[^ ]+` before either/);
  const written = JSON.parse(readFileSync(join(box.home, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(written.mcpServers.whatsapp.command, "npx");
});

test("setup --service through npx without a global wazap prints the repair and still finishes", async () => {
  const box = { ...sandbox({ wazap: false }), binary: npxBinary() };
  const dir = linkedDataDir();
  const stderr = await failingSetup(box, "--yes", "--no-global", "--service", "--client", "cursor", "--data-dir", dir);

  assert.match(stderr, /npx cache, which npm clears/);
  assert.match(stderr, /wazap service install/);
  assert.match(stderr, /Setup finished with a failing check/);
  assert.equal(readService(dir), null, "the service must not be installed from the cache");
});

test("a failing npm prints the repair and setup carries on to Connect", async () => {
  const box = { ...sandbox({ wazap: false }), binary: npxBinary() };
  stubNpm(box, { status: 1 });
  const stderr = await failingSetup(box, "--yes", "--client", "cursor", "--data-dir", linkedDataDir());

  assert.match(stderr, /✗ install npm install -g wazap-mcp@.* failed \(exit 1\)/);
  assert.match(stderr, /→ run `npm i -g wazap-mcp@[^ ]+` yourself \(sudo on some Linux installs\), then `wazap setup` again/);
  assert.match(stderr, /Step 3 of 6 · Connect/);
  assert.equal(existsSync(join(box.home, ".cursor", "mcp.json")), true, "Connect must still run");
});
