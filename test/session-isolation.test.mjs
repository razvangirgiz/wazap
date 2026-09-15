import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { startHttpEndpoint } from "../dist/server.js";
import { offlineConfig, stubAccountSource } from "./helpers.mjs";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "isolation", version: "1" } },
};
const ping = { jsonrpc: "2.0", id: 2, method: "ping" };

async function boot(t, openRead = false) {
  const config = offlineConfig("wazap-isolation-", { readOnly: false });
  const stop = new AbortController();
  t.after(() => {
    stop.abort();
    rmSync(config.dataDir, { recursive: true, force: true });
  });
  const port = await startHttpEndpoint(
    stubAccountSource({
      getStatus: () => ({ status: "connected", status_since: new Date().toISOString() }),
    }),
    config,
    {
      host: "127.0.0.1",
      port: 0,
      openRead,
      signal: stop.signal,
      credentials: [
        { token: "reader", write: false },
        { token: "writer-a", write: true },
        { token: "writer-b", write: true },
      ],
    }
  );
  async function call(token, sid, method = "POST", body = ping) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method,
      headers: {
        accept: "application/json, text/event-stream",
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(sid ? { "mcp-session-id": sid } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(3000),
    });
    // GET opens an SSE stream when access is incorrectly allowed; cancel it.
    const text = method === "GET" && res.status === 200 ? (await res.body.cancel(), "") : await res.text();
    return { status: res.status, sid: res.headers.get("mcp-session-id"), text };
  }
  return call;
}

for (const method of ["POST", "GET", "DELETE"]) {
  for (const attacker of ["reader", "writer-b", undefined]) {
    test(`${method}: ${attacker ?? "anonymous"} cannot use writer-a's session`, async (t) => {
      const call = await boot(t, true);
      const owner = await call("writer-a", undefined, "POST", initialize);
      assert.equal(owner.status, 200);
      assert.ok(owner.sid);
      const foreign = await call(attacker, owner.sid, method);
      assert.equal(foreign.status, 404);
      assert.equal((await call("writer-a", owner.sid)).status, 200, "owner session survives");
    });
  }
}

test("a different credential cannot reinitialize an existing session", async (t) => {
  const call = await boot(t);
  const owner = await call("writer-a", undefined, "POST", initialize);
  assert.equal((await call("reader", owner.sid, "POST", initialize)).status, 404);
  assert.equal((await call("writer-a", owner.sid)).status, 200);
});

test("independent clients retain their own tool permissions", async (t) => {
  const call = await boot(t);
  for (const token of ["reader", "writer-a", "writer-b"]) {
    const session = await call(token, undefined, "POST", initialize);
    const tools = await call(token, session.sid, "POST", { jsonrpc: "2.0", id: 3, method: "tools/list" });
    assert.equal(tools.status, 200);
    assert.equal(tools.text.includes('"name":"send_message"'), token !== "reader");
  }
});
