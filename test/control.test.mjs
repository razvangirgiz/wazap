/**
 * The control line: how `wazap account …` and `wazap logout` reach a running
 * server. Who may use it (only the token in control.json, on loopback), what it
 * is not (the MCP listener, an MCP tool, the bridge token), and the CLI verbs
 * working against a running process, the real binary's and an in-process hub
 * holding a linked account over a fake socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";

import { AccountHub } from "../dist/account-hub.js";
import { AccountRegistry } from "../dist/accounts.js";
import { accountPaths, paths } from "../dist/config.js";
import { CONTROL_ROUTES, startControlEndpoint } from "../dist/control.js";
import { readDaemon, writeDaemon } from "../dist/daemon.js";
import { socketFactory } from "../dist/pairing.js";
import { fakeSocket, mcpClient, offlineConfig, spawnWazap, waitFor } from "./helpers.mjs";

const TOKEN = "c".repeat(64);
const WRITE_TOKEN = "control-test-write-token";
const WORK = "40700000002@s.whatsapp.net";
const HOME = "40700000001@s.whatsapp.net";
const STARTUP_MS = 30_000;
/** Tools an agent must never be handed: the roster and the session are the CLI's. */
const CONTROL_TOOL = /logout|unlink|reload|remove_account|account_(add|remove|enable|disable|default)/;

function stubTarget() {
  const calls = [];
  return {
    calls,
    reload: () => (calls.push(["reload"]), { added: [], removed: [], kept: [] }),
    settled: async () => {},
    logout: async (id) => (calls.push(["logout", id]), "logged_out"),
    remove: async (id) => void calls.push(["remove", id]),
  };
}

async function controlLine(t, target = stubTarget()) {
  const stop = new AbortController();
  t.after(() => stop.abort());
  const port = await startControlEndpoint(target, TOKEN, stop.signal);
  return { port, target };
}

/** Raw node:http, since fetch will not send a Host of the caller's choosing. */
function rawPost(port, path, { headers = {}, body = "{}", method = "POST" } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          // Express answers an unknown route with HTML, which is part of what the tests check.
          let body;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = { raw: text };
          }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

function cli(dataDir, args) {
  const { child, stderr } = spawnWazap({ dataDir, args });
  child.stdin.end();
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr: stderr.join("") }));
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A real `wazap serve` child against a fresh data dir, killed when the test ends. */
async function served(t, { args = [], env = {}, setup } = {}) {
  const config = offlineConfig("wazap-control-serve-");
  const dataDir = config.dataDir;
  if (setup) await setup(dataDir);
  const { child, stderr } = spawnWazap({ dataDir, args: ["serve", ...args], env });
  const exited = once(child, "exit");
  t.after(async () => {
    child.kill("SIGKILL");
    await exited;
    rmSync(dataDir, { recursive: true, force: true });
  });
  const p = paths(dataDir);
  const control = await waitFor(
    () => {
      const info = readDaemon(p.controlFile);
      return info?.pid === child.pid ? info : null;
    },
    STARTUP_MS,
    `control.json to appear; stderr: ${stderr.join("")}`
  );
  // The control line is published before the MCP transport and daemon.json exist.
  if (!("WAZAP_NO_SHARE" in env)) {
    await waitFor(() => readDaemon(p.daemonFile)?.pid === child.pid, STARTUP_MS, "daemon.json to appear");
  }
  return { dataDir, child, stderr, control, p };
}

async function mcpSession(child) {
  const mcp = mcpClient(child);
  const init = await mcp.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "wazap-control-test", version: "0" },
  });
  assert.equal(init.error, undefined, JSON.stringify(init.error));
  mcp.notify("notifications/initialized", {});
  const call = async (name, args = {}) =>
    (await mcp.request("tools/call", { name, arguments: args })).result.structuredContent;
  return { ...mcp, call };
}

// ---------------------------------------------------------------------------
// Who may use the line.
// ---------------------------------------------------------------------------

test("only the control token opens the line; anonymous callers, static tokens and the bridge token do nothing", async (t) => {
  const { port, target } = await controlLine(t);
  const body = JSON.stringify({ account_id: "default" });
  for (const [label, headers] of [
    ["anonymous", {}],
    ["the static write token", { authorization: `Bearer ${WRITE_TOKEN}` }],
    ["a bridge token from daemon.json", { authorization: `Bearer ${"d".repeat(64)}` }],
    ["the token without Bearer", { authorization: TOKEN }],
    ["a prefix of the token", { authorization: `Bearer ${TOKEN.slice(0, 63)}` }],
  ]) {
    for (const route of Object.values(CONTROL_ROUTES)) {
      const res = await rawPost(port, route, { headers, body });
      assert.equal(res.status, 401, `${label} on ${route}`);
      assert.equal(JSON.stringify(res.body).includes(TOKEN), false);
    }
  }
  assert.deepEqual(target.calls, [], "a refused caller reached the roster");

  const ok = await rawPost(port, CONTROL_ROUTES.logout, { headers: { authorization: `Bearer ${TOKEN}` }, body });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true, account_id: "default", outcome: "logged_out" });
  assert.deepEqual(target.calls, [["logout", "default"]]);
});

test("a browser page or a rebound host name is refused even with the token", async (t) => {
  const { port, target } = await controlLine(t);
  const auth = { authorization: `Bearer ${TOKEN}` };
  for (const headers of [
    { ...auth, origin: `http://127.0.0.1:${port}` },
    { ...auth, origin: "https://evil.example" },
    { ...auth, host: `evil.example:${port}` },
    { ...auth, host: "127.0.0.1.nip.io" },
  ]) {
    const res = await rawPost(port, CONTROL_ROUTES.reload, { headers });
    assert.equal(res.status, 403, JSON.stringify(headers));
  }
  assert.deepEqual(target.calls, []);
  for (const host of [`localhost:${port}`, `[::1]:${port}`]) {
    assert.equal((await rawPost(port, CONTROL_ROUTES.reload, { headers: { ...auth, host } })).status, 200, host);
  }
});

test("wrong method, unknown route, non-JSON and a bad account id are refused before the roster is touched", async (t) => {
  const { port, target } = await controlLine(t);
  const auth = { authorization: `Bearer ${TOKEN}` };
  assert.equal((await rawPost(port, CONTROL_ROUTES.logout, { headers: auth, method: "GET", body: "" })).status, 405);
  assert.equal((await rawPost(port, "/mcp", { headers: auth })).status, 404);
  assert.equal((await rawPost(port, `${CONTROL_ROUTES.logout}?x=1`, { headers: auth })).status, 404);
  assert.equal(
    (await rawPost(port, CONTROL_ROUTES.logout, { headers: { ...auth, "content-type": "text/plain" } })).status,
    415
  );
  for (const body of ["{not json", "[]", JSON.stringify({}), JSON.stringify({ account_id: "../default" }), "x".repeat(8_000)]) {
    const res = await rawPost(port, CONTROL_ROUTES.logout, { headers: auth, body });
    assert.equal(res.status, 409, `${body.slice(0, 20)}: ${res.status}`);
    assert.equal(res.body.error, "INVALID_ID");
  }
  assert.deepEqual(target.calls, []);
});

test("the MCP listener has no control routes, the control line takes no static token, and no tool reaches either", async (t) => {
  const port = await freePort();
  const { control, child, dataDir } = await served(t, {
    args: ["--http", "--host", "127.0.0.1", "--port", String(port)],
    env: { WAZAP_WRITE_TOKEN: WRITE_TOKEN, WAZAP_READ_TOKEN: "control-test-read-token" },
  });
  assert.notEqual(control.port, port, "the control line is its own listener");
  assert.equal(statSync(paths(dataDir).controlFile).mode & 0o777, 0o600);
  assert.notEqual(control.token, readDaemon(paths(dataDir).daemonFile)?.token, "not the bridge token");

  const body = JSON.stringify({ account_id: "default" });
  for (const route of Object.values(CONTROL_ROUTES)) {
    const publicAnswer = await rawPost(port, route, { headers: { authorization: `Bearer ${WRITE_TOKEN}` }, body });
    assert.equal(publicAnswer.status, 404, `the public listener answered ${route}`);
    assert.equal((await rawPost(control.port, route, { headers: { authorization: `Bearer ${WRITE_TOKEN}` }, body })).status, 401);
    assert.equal((await rawPost(control.port, route, { body })).status, 401);
  }
  // The daemon token opens MCP, never the control line; the control token never opens MCP.
  const bridge = readDaemon(paths(dataDir).daemonFile);
  assert.equal((await rawPost(control.port, CONTROL_ROUTES.reload, { headers: { authorization: `Bearer ${bridge.token}` } })).status, 401);
  const mcpWithControlToken = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${control.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  await mcpWithControlToken.body?.cancel();
  assert.equal(mcpWithControlToken.status, 401);

  // Nothing above changed the account: the server still serves default, and no tool is a control verb.
  const session = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
  const sessionId = session.headers.get("mcp-session-id");
  await session.text();
  const listed = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${WRITE_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const line = (await listed.text()).split("\n").find((entry) => entry.startsWith("data:"));
  const names = JSON.parse(line.slice(5)).result.tools.map((tool) => tool.name);
  assert.ok(names.includes("link_account"), names.join(", "));
  assert.deepEqual(names.filter((name) => CONTROL_TOOL.test(name)), []);
  assert.equal(child.exitCode, null);
});

test("a stdio server publishes the control line whether or not it shares its session", async (t) => {
  for (const env of [{}, { WAZAP_NO_SHARE: "1" }]) {
    const { control, child, p } = await served(t, { env });
    assert.equal(control.pid, child.pid);
    assert.match(control.token, /^[0-9a-f]{64}$/);
    assert.equal(statSync(p.controlFile).mode & 0o777, 0o600);
    const shared = readDaemon(p.daemonFile);
    if (env.WAZAP_NO_SHARE) assert.equal(shared, null, "no share, no daemon.json");
    else assert.notEqual(shared.token, control.token);
    const mcp = await mcpSession(child);
    const { result } = await mcp.request("tools/list", {});
    assert.deepEqual(result.tools.map((tool) => tool.name).filter((name) => CONTROL_TOOL.test(name)), []);
  }
});

// ---------------------------------------------------------------------------
// The CLI against the real binary.
// ---------------------------------------------------------------------------

test("account add, disable, enable, default and remove reach a running server, with no restart", async (t) => {
  const { dataDir, child, stderr } = await served(t, { env: { WAZAP_NO_SHARE: "1" } });
  const mcp = await mcpSession(child);
  const accounts = async () => await mcp.call("list_accounts");
  const row = async (id) => (await accounts()).accounts.find((entry) => entry.id === id);

  assert.equal(await row("work"), undefined);
  const added = await cli(dataDir, ["account", "add", "work"]);
  assert.equal(added.code, 0, added.stderr);
  assert.doesNotMatch(added.stderr, /restart/i);
  // list_accounts reads the roster, never disk: a live row is the reload, not a lookup.
  assert.equal((await row("work"))?.status, "not_linked");

  const disabled = await cli(dataDir, ["account", "disable", "work"]);
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.doesNotMatch(disabled.stderr, /restart/i);
  assert.equal((await row("work")).status, "disabled");
  assert.equal((await mcp.call("get_status", { account_id: "work" })).error, "ACCOUNT_DISABLED");

  assert.equal((await cli(dataDir, ["account", "enable", "work"])).code, 0);
  assert.equal((await row("work")).status, "not_linked");
  assert.equal((await mcp.call("get_status", { account_id: "work" })).status, "not_linked");

  const moved = await cli(dataDir, ["account", "default", "work"]);
  assert.equal(moved.code, 0, moved.stderr);
  assert.doesNotMatch(moved.stderr, /restart/i);
  assert.equal((await accounts()).default, "work");

  const removed = await cli(dataDir, ["account", "remove", "work", "--yes"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stderr, /Account "work" removed/);
  assert.equal(existsSync(accountPaths(dataDir, "work").root), false);
  assert.equal(AccountRegistry.load(dataDir).get("work"), undefined);
  assert.equal((await accounts()).count, 1);
  assert.equal((await accounts()).default, "default");
  assert.equal((await mcp.call("get_status", { account_id: "work" })).error, "ACCOUNT_NOT_FOUND");

  // The server logged each change, and never a token.
  const log = stderr.join("");
  assert.match(log, /accounts: \+work/);
  assert.match(log, /accounts: -work/);
  assert.equal(log.includes(readDaemon(paths(dataDir).controlFile)?.token ?? "no-token"), false);
});

test("disabling the only served account keeps it running and says so", async (t) => {
  const { dataDir, child } = await served(t, { env: { WAZAP_NO_SHARE: "1" } });
  const out = await cli(dataDir, ["account", "disable", "default"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /keeps serving default/);
  const mcp = await mcpSession(child);
  assert.equal((await mcp.call("get_status", { account_id: "default" })).error, "ACCOUNT_DISABLED");
  const refused = await cli(dataDir, ["account", "remove", "default", "--yes"]);
  assert.notEqual(refused.code, 0);
});

test("logout without --account reaches the running server for the default account", async (t) => {
  const { dataDir } = await served(t, { env: { WAZAP_NO_SHARE: "1" } });
  const out = await cli(dataDir, ["logout"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /Not linked\./);
  assert.doesNotMatch(out.stderr, /is running/);
  const unknown = await cli(dataDir, ["logout", "--account", "ghost"]);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /No account/);
});

test("account add with no server running says nothing about one", async () => {
  const { dataDir } = offlineConfig("wazap-control-idle-");
  const out = await cli(dataDir, ["account", "add", "work"]);
  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stderr, /server|restart/i);
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The CLI against an in-process server holding a linked account.
// ---------------------------------------------------------------------------

function connect(svc, { id, name }) {
  const sock = fakeSocket();
  svc.sockClient = sock;
  svc.wireEvents(sock, ++svc.generation);
  svc.account = { id, name, number: id.split("@")[0] };
  svc.status = "connected";
  svc.initialSyncDone = true;
  return sock;
}

function seedCreds(dataDir, id, jid) {
  const storage = accountPaths(dataDir, id);
  mkdirSync(storage.authDir, { recursive: true });
  writeFileSync(join(storage.authDir, "creds.json"), JSON.stringify({ me: { id: jid.replace("@", ":7@") } }));
  writeFileSync(storage.storeFile, '{"v":1,"chats":{}}');
  AccountRegistry.load(dataDir).setOwner(id, jid);
  return storage;
}

/**
 * This process plays the running server: it holds the lock under its own pid,
 * serves `default` and `work` connected over fake sockets, and publishes a
 * control line. The logout's own socket is a fake too.
 */
async function inProcessServer(t, { unlink = "ok" } = {}) {
  const config = offlineConfig("wazap-control-hub-", { readOnly: false });
  const { dataDir } = config;
  AccountRegistry.load(dataDir).add("work", "Work");
  const work = seedCreds(dataDir, "work", WORK);
  const home = seedCreds(dataDir, "default", HOME);
  const hub = new AccountHub(config, AccountRegistry.load(dataDir));
  hub.started = true;
  const sockets = { default: connect(hub.get("default"), { id: HOME, name: "Home" }), work: connect(hub.get("work"), { id: WORK, name: "Work" }) };

  const unlinked = [];
  const original = socketFactory.open;
  socketFactory.open = () => {
    const sock = fakeSocket();
    sock.logout = async () => {
      unlinked.push(sock);
      if (unlink === "gone") throw { output: { statusCode: 401 } };
      sock.end();
    };
    setImmediate(() => sock.ev.emit("connection.update", { connection: "open" }));
    return sock;
  };

  const p = paths(dataDir);
  writeFileSync(p.lockFile, `${process.pid}\n`, { mode: 0o600 });
  const stop = new AbortController();
  const port = await startControlEndpoint(hub, TOKEN, stop.signal);
  writeDaemon(p.controlFile, { pid: process.pid, port, token: TOKEN, version: "0.0.0-test" });
  t.after(async () => {
    stop.abort();
    socketFactory.open = original;
    await hub.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, hub, sockets, unlinked, storage: { work, default: home } };
}

test("logout --account of a linked account through a running server unlinks it and prints the offline lines", async (t) => {
  const s = await inProcessServer(t);
  const out = await cli(s.dataDir, ["logout", "--account", "work"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /Logged out\. Local credentials deleted\./);
  assert.doesNotMatch(out.stderr, /is running|Stopping the wazap service/);
  assert.equal(s.unlinked.length, 1, "WhatsApp was told");
  assert.equal(s.sockets.work.ended, true);
  assert.equal(existsSync(s.storage.work.authDir), false);
  // The fresh service's boot may have moved it aside meanwhile; the logout deleted nothing.
  const legacyStore = join(s.storage.work.root, "legacy", "store.json");
  assert.equal(existsSync(s.storage.work.storeFile) || existsSync(legacyStore), true, "a legacy file is not the logout's to delete");
  assert.equal(AccountRegistry.load(s.dataDir).get("work").owner, null);
  await waitFor(() => s.hub.get("work").getStatus().status === "not_linked", 5_000, "work to be not_linked");
  assert.equal(s.hub.get("default").getStatus().status, "connected");
  assert.equal(existsSync(s.storage.default.authDir), true, "the other account kept its credentials");
});

test("logout with no --account logs the default account out through the running server", async (t) => {
  const s = await inProcessServer(t);
  const out = await cli(s.dataDir, ["logout"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /Logged out\. Local credentials deleted\./);
  assert.equal(existsSync(s.storage.default.authDir), false);
  assert.equal(existsSync(s.storage.work.authDir), true);
  assert.equal(s.hub.get("work").getStatus().status, "connected");
});

test("a phone that already removed the device prints the same two lines as offline", async (t) => {
  const s = await inProcessServer(t, { unlink: "gone" });
  const out = await cli(s.dataDir, ["logout", "--account", "work"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /WhatsApp had already unlinked this device\.\n.*Logged out\. Local credentials deleted\./);
  assert.equal(existsSync(s.storage.work.authDir), false);
});

test("account remove --yes of a connected account through a running server", async (t) => {
  const s = await inProcessServer(t);
  const out = await cli(s.dataDir, ["account", "remove", "work", "--yes"]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(s.sockets.work.ended, true);
  assert.equal(existsSync(accountPaths(s.dataDir, "work").root), false);
  assert.equal(s.hub.get("work"), undefined);
  assert.equal(AccountRegistry.load(s.dataDir).get("work"), undefined);
});

test("a control.json another pid left behind is not trusted: logout and remove keep today's refusal", async (t) => {
  const s = await inProcessServer(t);
  const p = paths(s.dataDir);
  const info = readDaemon(p.controlFile);
  writeDaemon(p.controlFile, { ...info, pid: 2147483646 });
  const out = await cli(s.dataDir, ["logout", "--account", "work"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, new RegExp(`wazap is running \\(pid ${process.pid}\\)`));
  const removed = await cli(s.dataDir, ["account", "remove", "work", "--yes"]);
  assert.notEqual(removed.code, 0);
  assert.match(removed.stderr, new RegExp(`stop it first: kill ${process.pid}`));
  const added = await cli(s.dataDir, ["account", "add", "late"]);
  assert.equal(added.code, 0);
  assert.match(added.stderr, /restart it for this to apply/);
  assert.equal(existsSync(s.storage.work.authDir), true, "nothing was logged out");
});
