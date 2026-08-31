import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { pickDefaultAction } from "../dist/config.js";
import { runSmoke } from "./smoke-stdio.mjs";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const CASES = [
  { name: "bare wazap at a terminal greets", config: {}, stdin: true, stderr: true, expect: "greet" },
  { name: "explicit serve at a terminal serves", config: { explicitCommand: true }, stdin: true, stderr: true, expect: "serve" },
  { name: "piped stdin serves", config: {}, stdin: false, stderr: true, expect: "serve" },
  { name: "piped stderr serves", config: {}, stdin: true, stderr: false, expect: "serve" },
  { name: "http at a terminal serves", config: { transport: "http" }, stdin: true, stderr: true, expect: "serve" },
  { name: "another command is never greeted", config: { command: "login", explicitCommand: true }, stdin: true, stderr: true, expect: "serve" },
];

for (const { name, config, stdin, stderr, expect } of CASES) {
  test(`pickDefaultAction: ${name}`, () => {
    const input = { command: "serve", explicitCommand: false, transport: "stdio", ...config };
    assert.equal(pickDefaultAction(input, stdin, stderr), expect);
  });
}

test("bare wazap with piped stdio serves rather than greeting", async () => {
  const { toolNames } = await runSmoke();
  assert.equal(toolNames.length, 26);
});

test("explicit `wazap serve` with piped stdio still answers initialize", async () => {
  const { toolNames, status } = await runSmoke({ args: ["serve"] });
  assert.equal(toolNames.length, 26);
  assert.equal(status.status, "not_linked");
});

test("writes off in .env leaves the server with the 14 read tools only", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-readonly-"));
  await run(process.execPath, [binary, "config", "writes", "off", "--data-dir", dataDir]);
  const { toolNames } = await runSmoke({ args: ["serve"], dataDir, keepDataDir: true, expectedTools: 14, expectReadOnly: true });
  assert.ok(!toolNames.includes("send_message"));
});
