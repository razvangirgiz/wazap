/**
 * `wazap update`. The plan is pure, so every case here drives it without the
 * registry; the one spawned run is a dry run with an `npm` on PATH that fails
 * loudly if anything calls it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { WAZAP_VERSION } from "../dist/config.js";
import { planUpdate } from "../dist/update.js";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const NEWER = "99.0.0";

const GLOBAL = { kind: "global", script: "/usr/local/bin/wazap" };
const CHECKOUT = { kind: "checkout", script: "/Users/x/Projects/wazap/dist/index.js" };
const NPX = { kind: "npx", script: "/Users/x/.npm/_npx/8a1b/node_modules/wazap-mcp/dist/index.js" };

function service(installedVersion = WAZAP_VERSION) {
  return { supervisor: { name: "launchd" }, record: { label: "com.wazap.server", installedVersion } };
}

function target(name, state) {
  return { target: { name, describe: name, dir: () => join(tmpdir(), name), next: "" }, state };
}

function probes({ install = GLOBAL, service: found = null, targets = [] } = {}) {
  return { install, service: found, targets };
}

test("a current wazap with nothing stale has nothing to do", () => {
  const plan = planUpdate(probes({ service: service(), targets: [target("cursor", "installed")] }), WAZAP_VERSION);
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.current, WAZAP_VERSION);
  assert.equal(plan.latest, WAZAP_VERSION);
});

test("a newer release upgrades, restarts the service and refreshes the skills, in that order", () => {
  const plan = planUpdate(
    probes({ service: service(), targets: [target("cursor", "stale"), target("codex", "installed")] }),
    NEWER,
  );
  assert.deepEqual(
    plan.steps.map((step) => step.kind),
    ["npm", "service-restart", "skills"],
  );
  assert.deepEqual(plan.steps[0], { kind: "npm", version: NEWER });
  assert.deepEqual(
    plan.steps[2].targets.map((entry) => entry.name),
    ["cursor", "codex"],
    "the new package ships new skills, so every detected harness is behind",
  );
});

test("a checkout is told what to run instead of being upgraded for it", () => {
  const plan = planUpdate(probes({ install: CHECKOUT }), NEWER);
  assert.deepEqual(plan.steps, [{ kind: "note", text: "git pull && npm run build" }]);
});

test("an npx run is told to refresh the cache and the clients", () => {
  const plan = planUpdate(probes({ install: NPX }), NEWER);
  assert.deepEqual(plan.steps, [
    { kind: "note", text: `run \`npx wazap-mcp@${NEWER} setup\` to refresh the npx cache and the clients` },
  ]);
});

test("no service record means no restart", () => {
  const plan = planUpdate(probes(), NEWER);
  assert.deepEqual(
    plan.steps.map((step) => step.kind),
    ["npm"],
  );
});

test("a service left on an older build is restarted even with nothing to install", () => {
  const plan = planUpdate(probes({ service: service("0.0.1") }), WAZAP_VERSION);
  assert.deepEqual(
    plan.steps.map((step) => step.kind),
    ["service-restart"],
  );
});

test("a silent registry plans no npm step, only a note", () => {
  const plan = planUpdate(probes({ targets: [target("cursor", "installed")] }), null);
  assert.equal(plan.latest, null);
  assert.deepEqual(
    plan.steps.map((step) => step.kind),
    ["note"],
  );
  assert.match(plan.steps[0].text, /registry did not answer/);
});

test("a missing skill target is installed even when the version is current", () => {
  const plan = planUpdate(probes({ targets: [target("cursor", "missing")] }), WAZAP_VERSION);
  assert.deepEqual(
    plan.steps.map((step) => step.kind),
    ["skills"],
  );
});

test("update --dry-run prints the plan and runs nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "wazap-update-home-"));
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-update-"), { mode: 0o700 });
  const bin = join(home, "bin");
  mkdirSync(bin);
  const called = join(home, "npm-was-called");
  writeFileSync(join(bin, "npm"), `#!/bin/sh\ntouch ${called}\nexit 1\n`, { mode: 0o755 });

  const { stdout, stderr } = await run(process.execPath, [binary, "update", "--dry-run", "--data-dir", dataDir], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`,
      WAZAP_NO_UPDATE_CHECK: "1",
    },
  });

  assert.match(stderr, new RegExp(`wazap ${WAZAP_VERSION.replace(/\./g, "\\.")} · \\w+ install · latest unknown`));
  assert.match(stderr, /1\. the npm registry did not answer/);
  assert.equal(stdout, "", "stdout stays the MCP channel");
  assert.equal(existsSync(called), false, "a dry run must not reach npm");
});
