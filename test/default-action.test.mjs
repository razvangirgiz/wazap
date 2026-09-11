import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { pickDefaultAction } from "../dist/config.js";
import { childEnv } from "./helpers.mjs";
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
  assert.equal(toolNames.length, 33);
});

test("explicit `wazap serve` with piped stdio still answers initialize", async () => {
  const { toolNames, status } = await runSmoke({ args: ["serve"] });
  assert.equal(toolNames.length, 33);
  assert.equal(status.status, "not_linked");
});

test("child env drops a shell WAZAP_TRANSPORT unless the test sets it", () => {
  const saved = { transport: process.env.WAZAP_TRANSPORT, share: process.env.WAZAP_NO_SHARE };
  process.env.WAZAP_TRANSPORT = "http";
  process.env.WAZAP_NO_SHARE = "1";
  try {
    const isolated = childEnv({});
    assert.equal(isolated.WAZAP_TRANSPORT, undefined);
    assert.equal(isolated.WAZAP_NO_SHARE, undefined);
    assert.equal(isolated.WAZAP_NO_UPDATE_CHECK, "1");
    assert.equal(isolated.WAZAP_READ_TOKEN, "");
    assert.equal(isolated.WAZAP_WRITE_TOKEN, "");
    assert.equal(childEnv({ WAZAP_TRANSPORT: "http" }).WAZAP_TRANSPORT, "http");
    assert.equal(childEnv({ WAZAP_NO_SHARE: "1" }).WAZAP_NO_SHARE, "1");
  } finally {
    if (saved.transport === undefined) delete process.env.WAZAP_TRANSPORT;
    else process.env.WAZAP_TRANSPORT = saved.transport;
    if (saved.share === undefined) delete process.env.WAZAP_NO_SHARE;
    else process.env.WAZAP_NO_SHARE = saved.share;
  }
});

test("writes off in .env leaves the server with the 20 read tools only", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-readonly-"));
  await run(process.execPath, [binary, "config", "writes", "off", "--data-dir", dataDir], { env: childEnv() });
  const { toolNames } = await runSmoke({ args: ["serve"], dataDir, keepDataDir: true, expectedTools: 20, expectReadOnly: true });
  assert.ok(!toolNames.includes("send_message"));
});
