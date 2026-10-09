/**
 * An old Node must fail in one line, naming the Node it needs and the fix,
 * from every way in — the bare stdio start an MCP client launches above all —
 * and before anything imports node:sqlite, which is what used to fail first,
 * deep in the import graph, with "No such built-in module".
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { INSTALL_LINE, nodeProblem, nodeSupported } from "../dist/node-version.js";
import { BINARY, childEnv } from "./helpers.mjs";

const run = promisify(execFile);

test("the supported range is package.json's engines: ^22.16.0 || >=24", () => {
  const engines = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).engines.node;
  assert.equal(engines, "^22.16.0 || >=24.0.0", "the guard below spells this range out; change both together");
  for (const version of ["22.16.0", "v22.23.3", "22.99.1", "24.0.0", "25.2.1"]) assert.ok(nodeSupported(version), version);
  for (const version of ["20.19.2", "22.15.1", "23.11.0", "18.0.0", "garbage", ""]) assert.ok(!nodeSupported(version), version);
});

test("the problem line names the version needed, the version found, and the one-line fix", () => {
  assert.equal(nodeProblem("24.1.0", "/usr/bin/node"), null);
  const line = nodeProblem("v20.19.2", "/usr/bin/node");
  assert.match(line, /^✗ wazap needs Node 22\.16 or newer/);
  assert.match(line, /this is Node 20\.19\.2 \(\/usr\/bin\/node\)/);
  assert.ok(line.includes(INSTALL_LINE));
  assert.doesNotMatch(line, /\n/, "one line");
});

/**
 * A preload that makes this Node claim 20.19.2 and fails any import of
 * node:sqlite, so the test proves the order: the guard answers first.
 */
function oldNodePreload(version = "20.19.2") {
  const dir = mkdtempSync(join(tmpdir(), "wazap-old-node-"));
  const file = join(dir, "old-node.mjs");
  writeFileSync(
    file,
    `import { registerHooks } from "node:module";
Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "node:sqlite") throw new Error("node:sqlite was imported");
    return next(specifier, context);
  },
});
`
  );
  return file;
}

for (const args of [[], ["serve"], ["serve", "--http"], ["status", "--json"], ["--version"], ["setup", "--agent"]]) {
  test(`an old Node stops \`wazap ${args.join(" ")}\` in one stderr line, before node:sqlite, with stdout empty`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wazap-old-node-data-"));
    await assert.rejects(
      run(process.execPath, ["--import", oldNodePreload(), BINARY, ...args, "--data-dir", dataDir], { env: childEnv() }),
      (err) => {
        assert.equal(err.code, 1);
        assert.equal(err.stdout, "", "stdout is the MCP protocol: nothing on it");
        const lines = err.stderr.trim().split("\n");
        assert.equal(lines.length, 1, err.stderr);
        assert.match(lines[0], /wazap needs Node 22\.16 or newer .*; this is Node 20\.19\.2/);
        assert.match(lines[0], /install\.sh \| sh/);
        assert.doesNotMatch(err.stderr, /node:sqlite/);
        return true;
      }
    );
  });
}

test("the preload's sqlite trap is real: a supported Node that loads wazap does reach node:sqlite", async () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), "wazap-old-node-data-")), "demo");
  await assert.rejects(
    run(process.execPath, ["--import", oldNodePreload(process.versions.node), BINARY, "demo", "seed", "--data-dir", dataDir], {
      env: childEnv(),
    }),
    (err) => {
      assert.match(err.stderr, /node:sqlite was imported/);
      return true;
    }
  );
});
