/**
 * scripts/check-linux.mjs decides which tests a change reaches before it starts
 * a container, so the deciding is what is tested here; the container is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DOCUMENT_GUARDS, IMAGES, parseArgs, testsFor } from "../scripts/check-linux.mjs";

const script = fileURLToPath(new URL("../scripts/check-linux.mjs", import.meta.url));
const tests = [
  "test/wizard.test.mjs",
  "test/ui.test.mjs",
  "test/cli.test.mjs",
  "test/docs-links.test.mjs",
  "test/tool-names.test.mjs",
  "test/distribution.test.mjs",
  "test/stability-doc.test.mjs",
  "test/skills.test.mjs",
];
const bodies = {
  "test/wizard.test.mjs": 'import { qrScreenBody } from "../dist/wizard.js";',
  "test/ui.test.mjs": 'import { qrFits } from "../dist/ui.js";',
  "test/cli.test.mjs": 'import { parseLinkChoice } from "../dist/cli.js"; import { x } from "../dist/ui.js";',
};
const readTest = (path) => bodies[path] ?? "";

test("a changed test file is a test to run, and a file that is not a test is not", () => {
  assert.deepEqual(testsFor(["test/wizard.test.mjs", "test/helpers.mjs", "scripts/x.mjs"], tests, readTest), ["test/wizard.test.mjs"]);
});

test("a changed module reaches the tests that import it, by reading them", () => {
  assert.deepEqual(testsFor(["src/ui.ts"], tests, readTest), ["test/cli.test.mjs", "test/ui.test.mjs"]);
  assert.deepEqual(testsFor(["src/wizard.ts"], tests, readTest), ["test/wizard.test.mjs"]);
  assert.deepEqual(testsFor(["src/db/nothing-imports-this.ts"], tests, readTest), []);
});

test("a changed document, skill or manifest reaches the tests that guard them", () => {
  for (const path of ["docs/install.md", "skills/wazap-setup/SKILL.md", "README.md", "CHANGELOG.md", "package.json", "manifest.json"]) {
    assert.deepEqual(testsFor([path], tests, readTest), DOCUMENT_GUARDS.map((name) => `test/${name}.test.mjs`).sort(), path);
  }
});

test("the document guards are all real test files", () => {
  const real = new Set(readdirSync(fileURLToPath(new URL("../test/", import.meta.url))));
  for (const name of DOCUMENT_GUARDS) assert.ok(real.has(`${name}.test.mjs`), `${name}.test.mjs does not exist`);
});

test("the images are the two Node versions CI runs, on Debian", () => {
  assert.deepEqual(Object.keys(IMAGES).sort(), ["22.16.0", "24"]);
  for (const image of Object.values(IMAGES)) assert.match(image, /^node:[\d.]+-bookworm$/);
});

test("arguments: names, --all, --node and --dry-run, and nothing else", () => {
  assert.deepEqual(parseArgs(["wizard", "ui", "--node", "24"]), { all: false, dryRun: false, node: "24", names: ["wizard", "ui"] });
  assert.equal(parseArgs(["--all", "--dry-run"]).all, true);
  assert.throws(() => parseArgs(["--node", "23"]), /22\.16\.0, 24 or both/);
  assert.throws(() => parseArgs(["--fast"]), /unknown option/);
});

test("--dry-run names the files and starts no container", () => {
  const named = spawnSync(process.execPath, [script, "--dry-run", "wizard", "ui.test.mjs", "--node", "24"], { encoding: "utf8" });
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.stdout, /2 test files on Node 24, Linux/);
  assert.match(named.stdout, /test\/wizard\.test\.mjs/);
  assert.match(named.stdout, /test\/ui\.test\.mjs/);
  const unknown = spawnSync(process.execPath, [script, "--dry-run", "no-such-test"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /no test file test\/no-such-test\.test\.mjs/);
});
