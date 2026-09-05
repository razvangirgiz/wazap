/** Exercise a built distribution over real stdio with an isolated empty data directory. */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [kind = "local", target = "dist/index.js"] = process.argv.slice(2);
const dir = await mkdtemp(join(tmpdir(), "wazap-distribution-"));
const docker = kind === "docker";
const multi = process.argv.includes("--multi");
const ids = [
  "a_00000000000000000000000000000001",
  "a_00000000000000000000000000000002",
];
if (multi)
  await writeFile(
    join(dir, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: ids.map((id, i) => ({
        id,
        name: i ? "Business fixture" : "Personal fixture",
        enabled: true,
      })),
    }),
    // Synthetic registry mounted read-only for the image's uid 1000 on Linux.
    { mode: docker ? 0o644 : 0o600 },
  );
const transport = new StdioClientTransport({
  command: docker ? "docker" : process.execPath,
  args: docker
    ? [
        "run",
        "--rm",
        "-i",
        "--tmpfs",
        "/data:uid=1000,gid=1000,mode=700",
        ...(multi
          ? ["-v", `${join(dir, "accounts.json")}:/data/accounts.json:ro`]
          : []),
        target,
        "serve",
      ]
    : [resolve(target), "serve", "--data-dir", dir],
  env: {
    PATH: process.env.PATH,
    WAZAP_NO_UPDATE_CHECK: "1",
    WAZAP_READ_ONLY: "1",
  },
  stderr: "pipe",
});
const client = new Client({ name: "distribution-check", version: "1" });
let errors = "";
transport.stderr?.on("data", (b) => (errors += b));
try {
  await client.connect(transport);
  const list = await client.listPrompts();
  assert.equal(list.prompts.length, 5);
  for (const p of list.prompts) {
    const result = await client.getPrompt({ name: p.name });
    assert.ok(result.messages[0].content.text.length > 100);
  }
  const learned = await client.callTool({ name: "learn", arguments: {} });
  assert.ok(!learned.isError, JSON.stringify(learned));
  if (multi) {
    const accounts = await client.callTool({
      name: "list_accounts",
      arguments: {},
    });
    assert.equal(accounts.structuredContent.accounts.length, 2);
    assert.equal(
      (await client.callTool({ name: "get_status", arguments: {} }))
        .structuredContent.error,
      "ACCOUNT_REQUIRED",
    );
    for (const account_id of ids)
      assert.equal(
        (
          await client.callTool({
            name: "get_status",
            arguments: { account_id },
          })
        ).structuredContent.status,
        "not_linked",
      );
    const combined = await client.callTool({
      name: "search_messages",
      arguments: { all_accounts: true, query: "synthetic" },
    });
    assert.equal(combined.structuredContent.partial, true);
    assert.equal(combined.structuredContent.next_before, null);
  }
  const status = await client.callTool({
    name: "get_status",
    arguments: multi ? { account_id: ids[0] } : {},
  });
  assert.equal(status.structuredContent.status, "not_linked");
  assert.equal(status.structuredContent.read_only, true);
  assert.equal((await client.listTools()).tools.length, 20);
  console.log(
    `${kind}${multi ? " multi-account" : ""}: initialized, 5 prompts loaded, learn and get_status passed, read-only default`,
  );
} catch (error) {
  console.error(errors);
  throw error;
} finally {
  await client.close();
  await rm(dir, { recursive: true, force: true });
}
