/**
 * End-to-end check of the shipped binary: spawn `dist/index.js` against an empty
 * data directory and talk MCP JSON-RPC to it over stdio, the way Claude Desktop
 * does. Proves an unlinked install still starts, lists its tools, and answers
 * get_status with not_linked instead of hanging or crashing.
 *
 * Rerun on its own with:  node test/smoke-stdio.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_TOOL_COUNT = 22;

export async function runSmoke({ binary = join(repoRoot, "dist", "index.js"), log = () => {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-smoke-"));
  const child = spawn(process.execPath, [binary, "--data-dir", dataDir], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WAZAP_READ_TOKEN: "", WAZAP_WRITE_TOKEN: "" },
  });

  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 20_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

  try {
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "wazap-smoke", version: "0" },
    });
    assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
    assert.equal(init.result.serverInfo.name, "wazap");
    log(`initialize ok — ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);

    notify("notifications/initialized", {});

    const list = await request("tools/list", {});
    assert.equal(list.error, undefined, `tools/list failed: ${JSON.stringify(list.error)}`);
    const names = list.result.tools.map((t) => t.name).sort();
    assert.equal(names.length, EXPECTED_TOOL_COUNT, `expected ${EXPECTED_TOOL_COUNT} tools, got ${names.length}: ${names}`);
    log(`tools/list ok — ${names.length} tools`);

    const status = await request("tools/call", { name: "get_status", arguments: {} });
    assert.equal(status.error, undefined, `get_status failed: ${JSON.stringify(status.error)}`);
    const structured = status.result.structuredContent;
    assert.equal(structured.status, "not_linked", `expected not_linked, got ${structured.status}`);
    assert.equal(structured.read_only, false);
    assert.equal(structured.data_dir, dataDir);
    log(`get_status ok — status=${structured.status} data_dir=${structured.data_dir}`);

    return { toolNames: names, status: structured };
  } catch (err) {
    log(`stderr from the server:\n${stderr.join("")}`);
    throw err;
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSmoke({ log: (line) => console.log(line) }).then(
    () => console.log("stdio smoke test passed"),
    (err) => {
      console.error(`stdio smoke test FAILED: ${err.message}`);
      process.exit(1);
    },
  );
}
