/**
 * The daemon.json sidecar: the record a bridge reads to find the loopback MCP
 * endpoint of a running `wazap serve`. Every case runs against a throwaway data
 * dir, never the real ~/.wazap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { paths } from "../dist/config.js";
import { daemonHealthy, decideRole, readDaemon, removeDaemon, writeDaemon } from "../dist/daemon.js";
import { startHttpEndpoint } from "../dist/server.js";
import { BINARY, mcpClient, offlineConfig, spawnWazap, waitFor } from "./helpers.mjs";

const CHILD_ENV = { WAZAP_READ_TOKEN: "", WAZAP_WRITE_TOKEN: "", WAZAP_NO_UPDATE_CHECK: "1" };
const SAMPLE = { pid: 4242, port: 51515, token: "deadbeef", version: "9.9.9" };

function tempDir() {
  return mkdtempSync(join(tmpdir(), "wazap-daemon-"));
}

function mode(file) {
  return statSync(file).mode & 0o777;
}

const run = promisify(execFile);

/** The binary's own `status` against a data dir: human lines on stderr, `--json` on stdout. */
function status(dataDir, args = []) {
  return run(process.execPath, [BINARY, "status", "--data-dir", dataDir, ...args], {
    env: { ...process.env, WAZAP_NO_UPDATE_CHECK: "1" },
  });
}

/** Run `fn` against a live `wazap serve` child, then make sure it is gone. */
async function withDaemon(env, fn, args = []) {
  const dataDir = tempDir();
  const { child, stderr } = spawnWazap({ dataDir, args, env: { ...CHILD_ENV, ...env } });
  let alive = true;
  const exited = new Promise((resolve) => {
    child.once("exit", (code) => {
      alive = false;
      resolve(code);
    });
  });
  try {
    return await fn({
      child,
      stderr,
      dataDir,
      hasExited: () => !alive,
      daemonFile: join(dataDir, "daemon.json"),
      lockFile: join(dataDir, "server.lock"),
    });
  } finally {
    child.kill("SIGKILL");
    await exited;
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function mcpPost(port, token, id = 1) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "wazap-daemon-test", version: "0" } },
    }),
    signal: AbortSignal.timeout(5_000),
  });
}

/** A port nobody is listening on, so a health probe has to fail. */
async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}


/** One Streamable HTTP MCP session: initialize, then ask what tools it was given. */
async function httpToolCount(port, token) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  let sessionId = null;
  const post = async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: sessionId === null ? headers : { ...headers, "mcp-session-id": sessionId },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    sessionId ??= res.headers.get("mcp-session-id");
    const text = await res.text();
    // The transport answers over SSE, so the payload arrives as data: lines.
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return line === undefined ? null : JSON.parse(line.slice(6));
  };

  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "wazap-daemon-test", version: "0" } },
  });
  assert.equal(init.result.serverInfo.name, "wazap");
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  return list.result.tools.length;
}

test("a sidecar round-trips and is readable only by its owner", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "nested", "daemon.json");
    writeDaemon(file, SAMPLE);
    assert.deepEqual(readDaemon(file), SAMPLE);
    assert.equal(mode(file), 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rewriting over a world-readable sidecar tightens it back to 0600", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "daemon.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    writeDaemon(file, SAMPLE);
    assert.equal(mode(file), 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing, unparsable or mis-shaped sidecar reads as null", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "daemon.json");
    assert.equal(readDaemon(file), null, "missing");

    writeFileSync(file, "{not json");
    assert.equal(readDaemon(file), null, "garbage");

    for (const bad of [
      null,
      [SAMPLE],
      { ...SAMPLE, pid: "4242" },
      { ...SAMPLE, pid: 0 },
      { ...SAMPLE, port: 1.5 },
      { ...SAMPLE, token: "" },
      { ...SAMPLE, version: 9 },
      { pid: 1, port: 2 },
    ]) {
      writeFileSync(file, JSON.stringify(bad));
      assert.equal(readDaemon(file), null, `wrong shape: ${JSON.stringify(bad)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remove takes our own sidecar and is idempotent", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "daemon.json");
    writeDaemon(file, { ...SAMPLE, pid: process.pid });
    removeDaemon(file);
    assert.equal(existsSync(file), false);
    removeDaemon(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remove leaves another process's sidecar alone", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "daemon.json");
    writeDaemon(file, SAMPLE);
    removeDaemon(file);
    assert.equal(existsSync(file), true, "we must never delete a sidecar we do not own");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a served session publishes a loopback endpoint only its token opens", async () => {
  await withDaemon({}, async ({ child, stderr, daemonFile }) => {
    const info = await waitFor(() => readDaemon(daemonFile), 10_000, "daemon.json to appear");
    assert.equal(info.pid, child.pid);
    assert.ok(info.port > 0, `port ${info.port}`);
    assert.match(info.token, /^[0-9a-f]{64}$/);
    assert.equal(mode(daemonFile), 0o600);

    const health = await fetch(`http://127.0.0.1:${info.port}/healthz`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    assert.equal(await daemonHealthy(info.port, 5_000), true, "the live port is healthy");
    assert.equal(await daemonHealthy(await closedPort(), 2_000), false, "nothing is listening there");

    assert.equal((await mcpPost(info.port, null)).status, 401, "no bearer token");
    assert.equal((await mcpPost(info.port, "0".repeat(64))).status, 401, "wrong bearer token");

    const authed = await mcpPost(info.port, info.token, 2);
    assert.equal(authed.status, 200);
    // The transport answers an initialize as SSE, so read the payload as text.
    assert.match(await authed.text(), /"serverInfo":\{"name":"wazap"/);

    assert.ok(!stderr.join("").includes(info.token), "the token must never reach a log line");
  });
});

test("--http publishes its own port and takes the internal token as a full-access bearer", async () => {
  await withDaemon({}, async ({ daemonFile }) => {
    const info = await waitFor(() => readDaemon(daemonFile), 10_000, "daemon.json to appear");
    assert.ok(info.port > 0, `port ${info.port}`);

    const health = await fetch(`http://127.0.0.1:${info.port}/healthz`, { signal: AbortSignal.timeout(5_000) });
    assert.equal((await health.json()).ok, true);

    // No read token, so the endpoint is open; the internal token is what unlocks writes.
    assert.equal(await httpToolCount(info.port, null), 14, "an anonymous session gets the read tools");
    assert.equal(await httpToolCount(info.port, info.token), 26, "the internal token gets everything");
  }, ["serve", "--http", "--port", "0"]);
});

test("SIGTERM clears the sidecar and the lock", async () => {
  await withDaemon({}, async ({ child, hasExited, daemonFile, lockFile }) => {
    await waitFor(() => readDaemon(daemonFile), 10_000, "daemon.json to appear");
    child.kill("SIGTERM");
    await waitFor(hasExited, 3_000, "the daemon to exit");
    assert.equal(existsSync(daemonFile), false, "daemon.json outlived the daemon");
    assert.equal(existsSync(lockFile), false, "server.lock outlived the daemon");
  });
});

test("closing the client's stdin ends the daemon rather than leaving it listening", async () => {
  await withDaemon({}, async ({ child, hasExited, daemonFile, lockFile }) => {
    await waitFor(() => readDaemon(daemonFile), 10_000, "daemon.json to appear");
    child.stdin.end();
    await waitFor(hasExited, 3_000, "the daemon to exit");
    assert.equal(existsSync(daemonFile), false, "daemon.json outlived the daemon");
    assert.equal(existsSync(lockFile), false, "server.lock outlived the daemon");
  });
});

test("status names the endpoint a served session is shared on, and never its token", async () => {
  await withDaemon({}, async ({ child, dataDir, daemonFile }) => {
    const info = await waitFor(() => readDaemon(daemonFile), 10_000, "daemon.json to appear");

    const human = await status(dataDir);
    assert.equal(
      human.stderr.split("\n").find((line) => line.startsWith("server:")),
      `server: running (pid ${child.pid}, sharing on 127.0.0.1:${info.port})`,
    );

    const { stdout } = await status(dataDir, ["--json"]);
    const report = JSON.parse(stdout);
    assert.equal(report.daemon.pid, child.pid);
    assert.equal(report.daemon.port, info.port);
    assert.ok(!stdout.includes(info.token), "the token must never reach the report");
  });
});

test("status leaves the sharing suffix off a session that is not shared", async () => {
  await withDaemon({ WAZAP_NO_SHARE: "1" }, async ({ child, dataDir, lockFile }) => {
    await waitFor(() => existsSync(lockFile), 10_000, "server.lock to appear");
    const { stderr } = await status(dataDir);
    assert.equal(
      stderr.split("\n").find((line) => line.startsWith("server:")),
      `server: running (pid ${child.pid})`,
    );
  });
});

test("WAZAP_NO_SHARE serves stdio with no sidecar at all", async () => {
  await withDaemon({ WAZAP_NO_SHARE: "1" }, async ({ child, daemonFile, lockFile }) => {
    await waitFor(() => existsSync(lockFile), 10_000, "server.lock to appear");
    const { request } = mcpClient(child);
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "wazap-daemon-test", version: "0" },
    });
    assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
    assert.equal(existsSync(daemonFile), false, "sharing was off, so nothing may be published");
  });
});

/** A server whose only job is to answer /healthz from a status we dictate. */
async function withHealth(status, sinceMsAgo, fn) {
  const port = await closedPort();
  const stop = new AbortController();
  const wa = {
    getStatus: () => ({ status, status_since: new Date(Date.now() - sinceMsAgo).toISOString() }),
  };
  await startHttpEndpoint(wa, offlineConfig("wazap-health-"), {
    host: "127.0.0.1",
    port,
    credentials: [],
    openRead: false,
    signal: stop.signal,
  });
  try {
    return await fn(port);
  } finally {
    stop.abort();
  }
}

async function healthOf(status, sinceMsAgo) {
  return withHealth(status, sinceMsAgo, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5_000) });
    return { code: res.status, body: await res.json() };
  });
}

const MINUTE = 60_000;

test("a connected socket is healthy however long it has been connected", async () => {
  const { code, body } = await healthOf("connected", 30 * MINUTE);
  assert.equal(code, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, "connected");
});

test("a reconnect in progress is not yet an outage", async () => {
  const { code, body } = await healthOf("disconnected", MINUTE);
  assert.equal(code, 200, "a monitor must not page on a socket that is coming back");
  assert.equal(body.ok, true);
});

test("two minutes off the air answers 503, with the status and since a monitor can read", async () => {
  const { code, body } = await healthOf("disconnected", 3 * MINUTE);
  assert.equal(code, 503);
  assert.equal(body.ok, false);
  assert.equal(body.status, "disconnected");
  assert.ok(Date.now() - Date.parse(body.since) >= 3 * MINUTE, `since: ${body.since}`);
});

test("a not_linked owner that has been up for minutes is still a bridge, not an older version", async () => {
  await withHealth("not_linked", 3 * MINUTE, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5_000) });
    const body = await res.json();
    assert.equal(res.status, 503, "a monitor still sees the outage");
    assert.equal(body.ok, false);
    assert.equal(body.status, "not_linked");
    assert.equal(await daemonHealthy(port, 2_000), true, "the sidecar is reachable");

    const dataDir = tempDir();
    const p = paths(dataDir);
    writeFileSync(p.lockFile, `${process.pid}\n`, { mode: 0o600 });
    writeDaemon(p.daemonFile, { pid: process.pid, port, token: "ab", version: "0.11.0" });
    const role = await decideRole({ ...offlineConfig("wazap-role-"), dataDir, share: true, transport: "stdio" }, p);
    assert.equal(role.kind, "bridge");
    if (role.kind === "bridge") assert.equal(role.daemon.port, port);
  });
});
