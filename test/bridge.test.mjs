/**
 * The bridge: a second `wazap serve` on a data dir another one already owns
 * serves its own client from the running session instead of refusing. Every case
 * runs against a throwaway data dir, never the real ~/.wazap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDaemon } from "../dist/daemon.js";
import { mcpClient, spawnWazap, waitFor } from "./helpers.mjs";

const CHILD_ENV = { WAZAP_READ_TOKEN: "", WAZAP_WRITE_TOKEN: "", WAZAP_NO_UPDATE_CHECK: "1" };

/** A data dir and the children started against it, all killed when the case ends. */
function scene() {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-bridge-"));
  const started = [];

  const start = (args = [], env = {}) => {
    const { child, stderr } = spawnWazap({ dataDir, args, env: { ...CHILD_ENV, ...env } });
    const wazap = { child, stderr, code: undefined };
    const exited = new Promise((resolve) => {
      child.once("exit", (code) => {
        wazap.code = code;
        resolve(code);
      });
    });
    wazap.exited = exited;
    wazap.hasExited = () => wazap.code !== undefined;
    started.push(wazap);
    return wazap;
  };

  const close = async () => {
    for (const wazap of started) wazap.child.kill("SIGKILL");
    await Promise.all(started.map((wazap) => wazap.exited));
    rmSync(dataDir, { recursive: true, force: true });
  };

  return {
    dataDir,
    start,
    close,
    daemonFile: join(dataDir, "daemon.json"),
    lockFile: join(dataDir, "server.lock"),
  };
}

/** One MCP session over a child's stdio, initialized and ready for requests. */
async function session(child) {
  const { request, notify } = mcpClient(child);
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "wazap-bridge-test", version: "0" },
  });
  assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
  notify("notifications/initialized");
  return { info: init.result.serverInfo, request };
}

async function toolShape(mcp) {
  const list = await mcp.request("tools/list", {});
  return list.result.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }));
}

function stderrLines(wazap) {
  return wazap.stderr
    .join("")
    .split("\n")
    .filter((line) => line !== "");
}

test("a second serve answers out of the session the first one holds", async () => {
  const s = scene();
  try {
    const a = s.start();
    const info = await waitFor(() => readDaemon(s.daemonFile), 15_000, "daemon.json to appear");
    assert.equal(info.pid, a.child.pid);

    const b = s.start();
    const daemon = await session(a.child);
    const bridge = await session(b.child);
    assert.equal(bridge.info.name, "wazap");
    assert.deepEqual(await toolShape(bridge), await toolShape(daemon), "the bridge must offer the daemon's own tools");

    const status = await bridge.request("tools/call", { name: "get_status", arguments: {} });
    assert.equal(status.result.structuredContent.status, "not_linked");

    const bad = await bridge.request("tools/call", { name: "read_messages", arguments: { chat_id: "not-a-chat" } });
    assert.equal(bad.result.isError, true);
    assert.deepEqual(Object.keys(bad.result.structuredContent).sort(), ["error", "fix", "message"]);

    assert.equal(readDaemon(s.daemonFile).pid, a.child.pid, "the bridge published itself over the daemon");
    assert.equal(readFileSync(s.lockFile, "utf8").trim(), String(a.child.pid), "the bridge took the lock");
  } finally {
    await s.close();
  }
});

test("the bridge says whose session it is sharing, and never the token", async () => {
  const s = scene();
  try {
    const a = s.start();
    const info = await waitFor(() => readDaemon(s.daemonFile), 15_000, "daemon.json to appear");

    const b = s.start();
    const line = `[wazap] sharing the WhatsApp session held by pid ${a.child.pid}`;
    await waitFor(() => stderrLines(b).includes(line), 15_000, `the bridge to announce: ${line}`);
    assert.deepEqual(stderrLines(b), [line]);
    assert.ok(!b.stderr.join("").includes(info.token), "the token must never reach a log line");
  } finally {
    await s.close();
  }
});

test("the bridge exits when the session holder dies, and the next start owns the session", async () => {
  const s = scene();
  try {
    const a = s.start();
    await waitFor(() => readDaemon(s.daemonFile), 15_000, "daemon.json to appear");

    const b = s.start();
    await waitFor(() => stderrLines(b).length > 0, 15_000, "the bridge to announce itself");

    a.child.kill("SIGKILL");
    await a.exited;
    await waitFor(b.hasExited, 3_000, "the bridge to notice the holder is gone");
    assert.equal(b.code, 1, "the bridge must exit 1 so its client restarts it");

    const c = s.start();
    const info = await waitFor(() => {
      const current = readDaemon(s.daemonFile);
      return current !== null && current.pid === c.child.pid ? current : null;
    }, 15_000, "the restart to publish itself");
    assert.equal(info.pid, c.child.pid);
  } finally {
    await s.close();
  }
});

test("a lock with no sidecar behind it is refused rather than waited on forever", async () => {
  const s = scene();
  try {
    // The test runner is alive, so this lock looks held by a server too old to share.
    writeFileSync(s.lockFile, `${process.pid}\n`);
    const b = s.start();
    await waitFor(b.hasExited, 15_000, "the refusal");
    assert.equal(b.code, 2);
    assert.match(
      b.stderr.join(""),
      new RegExp(`wazap is running \\(pid ${process.pid}\\) but is not sharing its session \\(older version\\?\\)`),
    );
  } finally {
    await s.close();
  }
});

test("WAZAP_NO_SHARE asks for a session of its own, so it is refused", async () => {
  const s = scene();
  try {
    const a = s.start();
    await waitFor(() => readDaemon(s.daemonFile), 15_000, "daemon.json to appear");

    const b = s.start([], { WAZAP_NO_SHARE: "1" });
    await waitFor(b.hasExited, 15_000, "the refusal");
    assert.equal(b.code, 2);
    assert.ok(
      b.stderr
        .join("")
        .includes(
          `wazap is already running (pid ${a.child.pid}) using ${s.dataDir}. Stop it first or use --data-dir.`,
        ),
      b.stderr.join(""),
    );
  } finally {
    await s.close();
  }
});

test("--http asks for an HTTP server, not a bridge, so it is refused", async () => {
  const s = scene();
  try {
    const a = s.start();
    await waitFor(() => readDaemon(s.daemonFile), 15_000, "daemon.json to appear");

    const b = s.start(["serve", "--http", "--port", "0"]);
    await waitFor(b.hasExited, 15_000, "the refusal");
    assert.equal(b.code, 2);
    assert.ok(
      b.stderr
        .join("")
        .includes(
          `wazap is already running (pid ${a.child.pid}) using ${s.dataDir}. Stop it first or use --data-dir.`,
        ),
      b.stderr.join(""),
    );
  } finally {
    await s.close();
  }
});

test("a bridge serves what the owner exposes, so --read-only reaches every client", async () => {
  const s = scene();
  try {
    s.start(["serve", "--read-only"]);
    await waitFor(() => readDaemon(s.daemonFile), 15_000, "daemon.json to appear");

    // Started without --read-only of its own: the owner's setting is the one that counts.
    const b = s.start();
    const mcp = await session(b.child);
    const names = (await toolShape(mcp)).map((tool) => tool.name);
    assert.equal(names.length, 13);
    assert.ok(!names.includes("send_message"), names.join(", "));

    const status = await mcp.request("tools/call", { name: "get_status", arguments: {} });
    assert.equal(status.result.structuredContent.read_only, true);
  } finally {
    await s.close();
  }
});
