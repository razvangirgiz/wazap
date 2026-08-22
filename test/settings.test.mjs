import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { offerWrites } from "../dist/cli.js";
import { setEnvSetting } from "../dist/settings.js";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function wazap(dataDir, args, env = {}) {
  return run(process.execPath, [binary, ...args, "--data-dir", dataDir], {
    env: { ...process.env, WAZAP_NO_UPDATE_CHECK: "1", ...env },
  });
}

function dataDir() {
  return mkdtempSync(join(tmpdir(), "wazap-settings-"));
}

test("setEnvSetting replaces its own line and keeps every other one", () => {
  const dir = dataDir();
  const envFile = join(dir, ".env");
  writeFileSync(envFile, "# notes\nWAZAP_READ_TOKEN=abc\nWAZAP_READ_ONLY=1\nWAZAP_RATE_LIMIT=5\n");

  setEnvSetting(envFile, "WAZAP_READ_ONLY", "0");
  assert.equal(readFileSync(envFile, "utf8"), "# notes\nWAZAP_READ_TOKEN=abc\nWAZAP_READ_ONLY=0\nWAZAP_RATE_LIMIT=5\n");

  setEnvSetting(envFile, "WAZAP_HOST", "0.0.0.0");
  assert.equal(
    readFileSync(envFile, "utf8"),
    "# notes\nWAZAP_READ_TOKEN=abc\nWAZAP_READ_ONLY=0\nWAZAP_RATE_LIMIT=5\nWAZAP_HOST=0.0.0.0\n",
  );
});

test("setEnvSetting matches a line however it was spaced, instead of adding a second one", () => {
  const envFile = join(dataDir(), ".env");
  writeFileSync(envFile, "A=1\nWAZAP_READ_ONLY = 1\nB=2\n");
  setEnvSetting(envFile, "WAZAP_READ_ONLY", "0");
  assert.equal(readFileSync(envFile, "utf8"), "A=1\nWAZAP_READ_ONLY=0\nB=2\n");
});

test("setEnvSetting removes every duplicate, because dotenv lets the last one win", () => {
  const envFile = join(dataDir(), ".env");
  writeFileSync(envFile, "WAZAP_READ_ONLY=0\nWAZAP_HOST=1.2.3.4\nexport WAZAP_READ_ONLY=0\n");
  setEnvSetting(envFile, "WAZAP_READ_ONLY", "1");
  assert.equal(readFileSync(envFile, "utf8"), "WAZAP_READ_ONLY=1\nWAZAP_HOST=1.2.3.4\n");
});

test("setEnvSetting creates the file when the data dir has no .env yet", () => {
  const envFile = join(dataDir(), ".env");
  setEnvSetting(envFile, "WAZAP_READ_ONLY", "1");
  assert.equal(readFileSync(envFile, "utf8"), "WAZAP_READ_ONLY=1\n");
});

const ANSWERS = [
  ["--writes", { writesAnswer: true, assumeYes: false }, "WAZAP_READ_ONLY=0\n"],
  ["--no-writes", { writesAnswer: false, assumeYes: false }, "WAZAP_READ_ONLY=1\n"],
  ["--yes", { writesAnswer: null, assumeYes: true }, null],
  ["no TTY and no flag", { writesAnswer: null, assumeYes: false }, null],
];

for (const [name, flags, expected] of ANSWERS) {
  test(`login with ${name} does not prompt, and ${expected === null ? "leaves .env alone" : "persists the answer"}`, async () => {
    const dir = dataDir();
    await offerWrites({ dataDir: dir, ...flags });
    assert.equal(existsSync(join(dir, ".env")) ? readFileSync(join(dir, ".env"), "utf8") : null, expected);
  });
}

test("config writes off persists the setting, and config reads it back from .env", async () => {
  const dir = dataDir();
  const off = await wazap(dir, ["config", "writes", "off"]);
  assert.match(off.stderr, /writes: off/);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "WAZAP_READ_ONLY=1\n");

  const shown = await wazap(dir, ["config"]);
  assert.match(shown.stderr, /writes: off \(\.env\)/);
  assert.match(shown.stderr, new RegExp(`data dir: ${dir} \\(flag\\)`));
  assert.match(shown.stderr, /transport: stdio \(default\)/);
  assert.match(shown.stderr, /rate limit: 20 writes\/minute \(default\)/);

  const on = await wazap(dir, ["config", "writes", "on"]);
  assert.match(on.stderr, /writes: on/);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "WAZAP_READ_ONLY=0\n");
  assert.match((await wazap(dir, ["config"])).stderr, /writes: on \(\.env\)/);
});

test("the flag beats the environment, which beats .env", async () => {
  const dir = dataDir();
  await wazap(dir, ["config", "writes", "on"]);

  assert.match((await wazap(dir, ["config", "--read-only"])).stderr, /writes: off \(flag\)/);
  assert.match((await wazap(dir, ["config"], { WAZAP_READ_ONLY: "1" })).stderr, /writes: off \(env\)/);
  assert.match((await wazap(dir, ["config"])).stderr, /writes: on \(\.env\)/);
});

test("status reflects the persisted writes setting", async () => {
  const dir = dataDir();
  await wazap(dir, ["config", "writes", "off"]);
  assert.match((await wazap(dir, ["status"])).stderr, /writes: off \(\.env\)/);
});

test("config rejects a setting it does not know", async () => {
  const dir = dataDir();
  await assert.rejects(wazap(dir, ["config", "writes", "maybe"]), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /wazap config writes on\|off/);
    return true;
  });
});
