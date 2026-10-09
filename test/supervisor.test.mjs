/**
 * wazap's own supervisor (src/supervisor.ts), for boxes with neither launchd
 * nor systemd. The units here run small Node scripts, and one runs the real
 * `wazap serve --http` on an empty data dir, which never reaches WhatsApp.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { paths } from "../dist/config.js";
import { lockHolder } from "../dist/lock.js";
import { installService, pickSupervisor, readService, runService, SUPERVISORS } from "../dist/service.js";
import {
  MAX_QUICK_CRASHES,
  RESTART_MAX_MS,
  RESTART_MIN_MS,
  builtinSupervisor,
  restartDelay,
} from "../dist/supervisor.js";
import { BINARY, childEnv } from "./helpers.mjs";

const run = promisify(execFile);
const skip = process.platform === "win32" ? "POSIX only" : false;

/** Running: a zombie nobody reaped yet (an orphan whose new parent is slow to) is not. */
function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat[stat.lastIndexOf(")") + 2] !== "Z";
  } catch {
    return true;
  }
}

async function until(check, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** A unit whose command is `node <script>`; the script appends its pid to `pids` and then does `body`. */
function unitWith(dir, label, body) {
  const script = join(dir, `${label}.mjs`);
  const pids = join(dir, `${label}.pids`);
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");\n${body}\n`
  );
  return { argv: [process.execPath, script], pids };
}

function pidsOf(file) {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : [];
}

function setup(body) {
  const dir = mkdtempSync(join(tmpdir(), "wazap-supervisor-"));
  const state = join(dir, "state");
  const supervisor = builtinSupervisor(() => state);
  const label = "wazap-test";
  const unit = unitWith(dir, label, body);
  const ref = { label, unitFile: supervisor.unitFile(label) };
  mkdirSync(state, { recursive: true });
  writeFileSync(ref.unitFile, supervisor.render({ label, describe: "test", argv: unit.argv, env: { PATH: process.env.PATH }, logDir: state }));
  return { dir, state, supervisor, ref, unit };
}

const SUPERVISOR_JS = new URL("../dist/supervisor.js", import.meta.url).href;

/** A wazap command: it leaves when its supervisor does, the way `serve` and `tunnel` do. */
const STAYS = `import { whenSupervisorGone } from ${JSON.stringify(SUPERVISOR_JS)};\nwhenSupervisorGone(() => process.exit(0));\nsetInterval(() => {}, 1000);`;

test("restarts wait a second, double while the crashes stay quick, and stop growing at a minute", () => {
  assert.equal(restartDelay(1), RESTART_MIN_MS);
  assert.equal(restartDelay(2), 2 * RESTART_MIN_MS);
  assert.equal(restartDelay(4), 8 * RESTART_MIN_MS);
  assert.equal(restartDelay(30), RESTART_MAX_MS);
});

test("start runs the unit in the background, a crash is restarted, stop ends both and cleans up", { skip }, async (t) => {
  const { supervisor, ref, unit, state } = setup(STAYS);
  t.after(() => supervisor.stop(ref));

  supervisor.start(ref);
  const first = await until(() => supervisor.pid(ref), "the command");
  await until(() => pidsOf(unit.pids).length === 1, "the command to start");
  assert.deepEqual(pidsOf(unit.pids), [first]);
  supervisor.start(ref);
  assert.equal(supervisor.pid(ref), first, "a second start of a running unit changes nothing");

  process.kill(first, "SIGKILL");
  const second = await until(() => {
    const pid = supervisor.pid(ref);
    return pid !== null && pid !== first ? pid : null;
  }, "the restart");
  assert.ok(alive(second));
  assert.match(supervisor.logs(ref).join("\n"), /exited \(signal SIGKILL\); restarting in 1 s/);
  assert.match(supervisor.describe(ref), /restarted 1 times/);

  const holder = Number(readFileSync(join(state, `${ref.label}.pid`), "utf8"));
  supervisor.stop(ref);
  assert.equal(alive(second), false);
  assert.equal(alive(holder), false, "the supervisor stops with its command");
  assert.equal(existsSync(join(state, `${ref.label}.pid`)), false);
  assert.equal(supervisor.pid(ref), null);
});

test("a supervisor killed outright takes its wazap command with it, and the next start finds nothing stale", { skip }, async (t) => {
  const { supervisor, ref, state } = setup(STAYS);
  t.after(() => supervisor.stop(ref));
  supervisor.start(ref);
  const child = await until(() => supervisor.pid(ref), "the command");
  const holder = Number(readFileSync(join(state, `${ref.label}.pid`), "utf8"));
  process.kill(holder, "SIGKILL");
  await until(() => !alive(child), "the orphan to notice its supervisor is gone");
  supervisor.start(ref);
  const next = await until(() => supervisor.pid(ref), "the command again");
  assert.notEqual(next, child);
});

test("a command whose supervisor died while it was still loading leaves all the same", { skip }, async () => {
  // Its IPC channel closed before anything listened for "disconnect", which then never comes.
  const dir = mkdtempSync(join(tmpdir(), "wazap-supervisor-"));
  const outcome = join(dir, "outcome");
  const child = join(dir, "child.mjs");
  writeFileSync(
    child,
    [
      `import { writeFileSync } from "node:fs";`,
      `await new Promise((resolve) => setTimeout(resolve, 800));`,
      `const { whenSupervisorGone } = await import(${JSON.stringify(SUPERVISOR_JS)});`,
      `whenSupervisorGone(() => { writeFileSync(${JSON.stringify(outcome)}, "left"); process.exit(0); });`,
      `setTimeout(() => { writeFileSync(${JSON.stringify(outcome)}, "orphaned"); process.exit(1); }, 5000);`,
    ].join("\n")
  );
  const parent = join(dir, "parent.mjs");
  writeFileSync(
    parent,
    `import { spawn } from "node:child_process";\nspawn(process.execPath, [${JSON.stringify(child)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });\nsetTimeout(() => process.kill(process.pid, "SIGKILL"), 200);`
  );
  await run(process.execPath, [parent]).catch(() => {});
  assert.equal(await until(() => existsSync(outcome) && readFileSync(outcome, "utf8"), "the orphan's outcome"), "left");
});

test("stop also ends a command whose supervisor is gone when it cannot notice by itself", { skip }, async (t) => {
  // No IPC listener: this command would run on forever without the supervisor.
  const { supervisor, ref, state } = setup(`process.on("disconnect", () => {});\nsetInterval(() => {}, 1000);`);
  t.after(() => supervisor.stop(ref));
  supervisor.start(ref);
  const child = await until(() => supervisor.pid(ref), "the command");
  process.kill(Number(readFileSync(join(state, `${ref.label}.pid`), "utf8")), "SIGKILL");
  await sleep(200);
  assert.ok(alive(child), "orphaned, still running");
  supervisor.stop(ref);
  await until(() => !alive(child), "stop to end it, found by its recorded pid and command line", 5_000);
});

test("a second supervisor of the same unit leaves at once", { skip }, async (t) => {
  const { supervisor, ref } = setup(STAYS);
  t.after(() => supervisor.stop(ref));
  supervisor.start(ref);
  const child = await until(() => supervisor.pid(ref), "the command");
  const { stderr } = await run(process.execPath, [BINARY, "supervise", ref.unitFile], { env: childEnv(), timeout: 10_000 });
  assert.equal(stderr, "");
  assert.match(supervisor.logs(ref).join("\n"), /already runs wazap-test; this one exits/);
  assert.equal(supervisor.pid(ref), child);
});

test("a command that keeps crashing at start is given up on, and status says so", { skip }, async () => {
  const { supervisor, ref, unit } = setup("process.exit(7);");
  const supervise = new URL("../dist/supervisor.js", import.meta.url).href;
  await run(
    process.execPath,
    ["--input-type=module", "-e", `const { runSupervise } = await import(${JSON.stringify(supervise)}); await runSupervise(${JSON.stringify(ref.unitFile)}, { delay: () => 5 });`],
    { env: childEnv(), timeout: 30_000 }
  );
  assert.equal(pidsOf(unit.pids).length, MAX_QUICK_CRASHES + 1);
  assert.match(supervisor.describe(ref), /gave up after 10 quick crashes \(last: code 7\)/);
  assert.equal(supervisor.pid(ref), null);
  assert.match(supervisor.logs(ref).join("\n"), /giving up/);
  supervisor.start(ref);
  await until(() => pidsOf(unit.pids).length > MAX_QUICK_CRASHES + 1, "a fresh start after giving up");
  supervisor.stop(ref);
});

test("wazap's own supervisor is the last resort, after launchd and systemd", () => {
  assert.deepEqual(
    SUPERVISORS.map((entry) => entry.name),
    ["launchd", "systemd", "builtin"]
  );
  const none = { name: "launchd", available: () => false };
  assert.equal(pickSupervisor([none, { ...none, name: "systemd" }, builtinSupervisor(() => tmpdir())]).name, "builtin");
});

test("serve under wazap's own supervisor: healthy, holding the data dir's lock, and stopped by `service stop`", { skip }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-daemon-"));
  const dataDir = join(dir, "data");
  const supervisor = builtinSupervisor(() => join(dir, "state"));
  const port = 43_000 + Math.floor(Math.random() * 2_000);
  const config = { dataDir, httpPort: port, dryRun: false, args: [] };
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    await installService(config, supervisor, 15_000, { kind: "global", script: BINARY });
  } finally {
    console.error = original;
  }
  const record = readService(dataDir);
  t.after(() => supervisor.remove(record));
  assert.equal(record.supervisor, "builtin");
  assert.match(lines.join("\n"), /wazap's own supervisor/);
  assert.match(lines.join("\n"), new RegExp(`Running · pid \\d+ · http://127\\.0\\.0\\.1:${port}/mcp`));
  const pid = supervisor.pid(record);
  assert.equal(lockHolder(paths(dataDir).lockFile), pid, "the supervised server is the one holding the lock");

  const status = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.ok([200, 503].includes(status.status));

  await runService({ ...config, args: ["stop"] }, [supervisor]);
  assert.equal(alive(pid), false);
  assert.equal(lockHolder(paths(dataDir).lockFile), null, "a stopped server lets go of the data dir");
});

test("the supervisor outlives the process that started it", { skip }, async (t) => {
  const { supervisor, ref } = setup(STAYS);
  t.after(() => supervisor.stop(ref));
  // Started from a short-lived child, the way a shell running `wazap serve --daemon` exits.
  const module = new URL("../dist/supervisor.js", import.meta.url).href;
  const starter = spawn(
    process.execPath,
    ["--input-type=module", "-e", `const { builtinSupervisor } = await import(${JSON.stringify(module)}); builtinSupervisor(() => ${JSON.stringify(join(ref.unitFile, ".."))}).start(${JSON.stringify(ref)});`],
    { env: childEnv(), stdio: "ignore" }
  );
  await new Promise((resolve) => starter.once("exit", resolve));
  const child = await until(() => supervisor.pid(ref), "the command");
  await sleep(300);
  assert.ok(alive(child), "still running after its starter exited");
});
