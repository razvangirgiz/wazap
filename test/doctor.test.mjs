import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { isNewer } from "../dist/doctor.js";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

/**
 * No test may reach the npm registry, so the update check is off by default, and
 * the transcription checks are pinned off so a configured machine cannot change
 * how many checks these tests see.
 */
function status(dataDir, args = [], env = {}) {
  return run(process.execPath, [binary, "status", "--data-dir", dataDir, ...args], {
    env: { ...process.env, WAZAP_NO_UPDATE_CHECK: "1", WAZAP_TRANSCRIBE: "off", ...env },
  });
}

function dataDir() {
  return mkdtempSync(join(tmpdir(), "wazap-doctor-"), { mode: 0o700 });
}

const VERSIONS = [
  ["0.9.1", "0.9.0", true],
  ["0.10.0", "0.9.9", true],
  ["1.0.0", "0.99.99", true],
  ["0.9.0", "0.9.0", false],
  ["0.8.9", "0.9.0", false],
  ["0.9.0", "0.9.0-rc1", false],
];

for (const [candidate, current, expected] of VERSIONS) {
  test(`isNewer ${candidate} over ${current} is ${expected}`, () => {
    assert.equal(isNewer(candidate, current), expected);
  });
}

test("a healthy data dir passes every check it can", async () => {
  const dir = dataDir();
  chmodSync(dir, 0o700);
  const { stderr } = await status(dir);
  assert.match(stderr, /checks:/);
  assert.match(stderr, new RegExp(`✓ node: ${process.versions.node.replace(/\\./g, "\\.")}`));
  assert.match(stderr, /✓ data dir: .* \(0700, writable\)/);
  assert.match(stderr, /– lock: none/);
  assert.match(stderr, /– service: not installed$/m);
  assert.ok(!stderr.includes("wazap service install"), "unlinked status must not send the user past setup");
  assert.match(stderr, /– credentials: no account linked yet/);
  assert.match(stderr, /✓ writes: off \(default\)/);
});

test("a data dir with the wrong mode fails with the chmod that fixes it", async () => {
  const dir = dataDir();
  chmodSync(dir, 0o755);
  const { stderr } = await status(dir);
  assert.match(stderr, /✗ data dir: .* is mode 0755, not 0700 — run `chmod 700 /);
});

test("a lock left by a dead process reads as stale, not as a running server", async () => {
  const dir = dataDir();
  writeFileSync(join(dir, "server.lock"), "999999\n");
  const { stderr } = await status(dir);
  assert.match(stderr, /– lock: stale \(pid 999999 is gone\); the next start reclaims it/);
  assert.match(stderr, /server: not running/);
});

test("unreadable credentials fail the check and carry the repair", async () => {
  const dir = dataDir();
  mkdirSync(join(dir, "auth"), { recursive: true });
  writeFileSync(join(dir, "auth", "creds.json"), "{ truncated");
  const { stderr } = await status(dir);
  assert.match(stderr, /✗ credentials: Stored credentials in .* are unreadable/);
  assert.match(stderr, /wazap logout/);
});

test("WAZAP_NO_UPDATE_CHECK=1 skips the registry call and says so", async () => {
  const { stderr } = await status(dataDir());
  assert.match(stderr, /– update: update check skipped \(WAZAP_NO_UPDATE_CHECK=1\)/);
});

test("status --json prints one parseable object carrying the same checks", async () => {
  const dir = dataDir();
  const { stdout } = await status(dir, ["--json"]);
  const report = JSON.parse(stdout);
  assert.equal(report.data_dir, dir);
  assert.equal(report.linked, false);
  assert.equal(report.server_pid, null);
  assert.deepEqual(
    report.checks.map((check) => check.name),
    ["node", "data dir", "lock", "service", "credentials", "writes", "archive", "skills", "transcribe", "update"],
  );
  assert.equal(report.checks.find((check) => check.name === "writes").detail, "off (default)");
  assert.ok(["global", "checkout", "npx"].includes(report.install.kind), `install: ${JSON.stringify(report.install)}`);
  assert.match(report.install.script, /index\.js$/);
});

test("status --live on an unlinked data dir reports that, without waiting out the deadline", async () => {
  const started = Date.now();
  const { stderr } = await status(dataDir(), ["--live"]);
  assert.match(stderr, /live: no connection \(not_linked\)/);
  assert.ok(Date.now() - started < 12_000, "it must not sit through the 15s live deadline");
});

test("status --live refuses to touch the session a running server owns", async () => {
  const dir = dataDir();
  writeFileSync(join(dir, "server.lock"), `${process.pid}\n`);
  await assert.rejects(status(dir, ["--live"]), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, new RegExp(`A server \\(pid ${process.pid}\\) already owns this session`));
    assert.match(err.stderr, /get_status/);
    return true;
  });
});

/**
 * A HOME and a PATH of their own, so the skills check sees only the harnesses a
 * case sets up. `~/.cursor` is what makes Cursor detected; the skills land in
 * `~/.cursor/skills`.
 */
function skillsBox() {
  const home = mkdtempSync(join(tmpdir(), "wazap-doctor-home-"));
  return { home, env: { HOME: home, USERPROFILE: home, PATH: join(home, "bin") } };
}

function skillsLine(stderr) {
  return /^[^\n]*skills: .*$/m.exec(stderr)?.[0];
}

test("the skills check stays quiet when no skill-aware client is installed", async () => {
  const box = skillsBox();
  const { stderr } = await status(dataDir(), [], box.env);
  assert.match(skillsLine(stderr), /– skills: no skill-aware client detected/);
});

test("the skills check names the harness that never got them", async () => {
  const box = skillsBox();
  mkdirSync(join(box.home, ".cursor"), { recursive: true });
  const { stderr } = await status(dataDir(), [], box.env);
  assert.match(skillsLine(stderr), /– skills: missing for cursor$/);
  assert.ok(!stderr.includes("wazap skills install"), "unlinked status must not send the user past setup");
});

test("the skills check passes once they are installed, and calls an edited copy stale", async () => {
  const box = skillsBox();
  mkdirSync(join(box.home, ".cursor"), { recursive: true });
  await run(process.execPath, [binary, "skills", "install", "cursor"], {
    env: { ...process.env, ...box.env, PATH: `${box.env.PATH}${delimiter}${process.env.PATH ?? ""}` },
  });

  const installed = await status(dataDir(), [], box.env);
  assert.match(skillsLine(installed.stderr), /✓ skills: installed for cursor/);

  writeFileSync(join(box.home, ".cursor", "skills", "whatsapp-send", "SKILL.md"), "what an older wazap shipped\n");
  const stale = await status(dataDir(), [], box.env);
  assert.match(skillsLine(stale.stderr), /– skills: stale for cursor$/);
});
