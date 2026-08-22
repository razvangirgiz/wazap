import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runSmoke } from "./smoke-stdio.mjs";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

/** The CLI writes to stderr, because stdout belongs to the MCP protocol. */
function wazap(...args) {
  return run(process.execPath, [binary, ...args], { env: { ...process.env, WAZAP_NO_UPDATE_CHECK: "1" } });
}

test("--help explains every command and exits 0", async () => {
  const { stderr } = await wazap("--help");
  for (const fragment of ["wazap login", "wazap status", "wazap logout", "--data-dir", "--read-only"]) {
    assert.ok(stderr.includes(fragment), `--help must mention ${fragment}`);
  }
});

test("--version prints the package version and exits 0", async () => {
  const { stderr } = await wazap("--version");
  const { version } = JSON.parse(
    await import("node:fs").then((fs) => fs.readFileSync(join(dirname(binary), "..", "package.json"), "utf8")),
  );
  assert.equal(stderr.trim(), version);
});

test("status on an empty data dir reports nothing linked, without touching WhatsApp", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-status-"));
  const { stderr } = await wazap("status", "--data-dir", dataDir);
  assert.match(stderr, /linked: no/);
  assert.match(stderr, new RegExp(`data dir: ${dataDir}`));
  assert.match(stderr, /server: not running/);
});

test("an unknown command fails with a pointer to --help", async () => {
  await assert.rejects(wazap("frobnicate"), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /--help/);
    return true;
  });
});

test("the built server answers MCP over stdio with no WhatsApp session", async () => {
  const { toolNames, status } = await runSmoke();
  assert.equal(toolNames.length, 22);
  assert.equal(status.status, "not_linked");
});
