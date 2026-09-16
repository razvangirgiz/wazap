import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { request } from "node:http";
import { setImmediate as turn } from "node:timers/promises";
import { startHttpEndpoint } from "../dist/server.js";
import { createToolRegistrar } from "../dist/tool-runtime.js";
import { httpPostBudget } from "../dist/http-budget.js";
import { HttpSessions } from "../dist/http-sessions.js";
import { offlineConfig, stubAccountSource } from "./helpers.mjs";
test("one credential cannot fill the whole HTTP session registry", () => {
  const sessions = new HttpSessions(128);
  let closed = 0;
  const transport = { close: async () => { closed++; } };
  sessions.add("owner", transport, "owner");
  for (let i = 0; i < 150; i++) sessions.add(`reader-${i}`, transport, "reader");
  assert.equal(sessions.get("owner", "owner"), transport);
  assert.equal(closed, 118);
  assert.equal(sessions.get("reader-149", "reader"), transport);
  sessions.close();
});

test("HTTP windows expire and the credential bookkeeping has a hard cap", () => {
  let now = 1000;
  const middleware = httpPostBudget(req => req.owner, () => now, 120);
  function call(owner, method = "POST") {
    let status = 200;
    const res = { setHeader() {}, status(value) { status = value; return this; }, json() {} };
    middleware({ owner, method }, res, () => {});
    return status;
  }
  for (let i = 0; i < 1024; i++) assert.equal(call(`owner-${i}`), 200);
  assert.equal(call("overflow"), 503);
  assert.equal(call("overflow", "GET"), 200);
  now += 60_000;
  assert.equal(call("overflow"), 200);
  for (let i = 1; i < 120; i++) assert.equal(call("overflow"), 200);
  assert.equal(call("overflow"), 429);
  now += 60_000;
  assert.equal(call("overflow"), 200);
});

const wa = { getStatus: () => ({ status: "connected", status_since: new Date().toISOString() }) };
async function boot(t, openRead = false, overrides = {}) {
  const config = offlineConfig("wazap-budget-", overrides); const stop = new AbortController();
  t.after(() => { stop.abort(); rmSync(config.dataDir, { recursive: true, force: true }); });
  const port = await startHttpEndpoint(stubAccountSource(wa), config, { host: "127.0.0.1", port: 0, openRead,
    credentials: [{ token: "a", write: false }, { token: "b", write: false }], signal: stop.signal });
  return (token = "a", body = "{}", headers = {}) => new Promise((resolve, reject) => {
    // Raw HTTP deliberately preserves Host: fetch may replace it with the URL authority.
    const req = request(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers,
    } }, res => {
      res.resume(); res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode,
        headers: new Headers(Object.entries(res.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])),
      }));
    });
    req.on("error", reject); req.end(body);
  });
}
for (const headers of [{ origin: "https://attacker.example" }, { host: "attacker.example" }]) test("anonymous MCP refuses browser cross-origin/rebinding requests", async (t) => {
  const call = await boot(t, true);
  const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "synthetic", version: "1" },
  } });
  assert.equal((await call("foreign", initialize, headers)).status, 403);
  assert.equal((await call("foreign", initialize)).status, 200, "ordinary loopback clients still work");
  assert.equal((await call("a", initialize, headers)).status, 200, "explicit bearer authentication is not ambient browser authority");
});

test("MCP authentication precedes JSON parsing", async (t) => {
  const call = await boot(t);
  assert.equal((await call("foreign", "{SYNTHETIC-SECRET")).status, 401);
});
test("compressed MCP bodies are refused rather than inflated", async (t) => {
  const call = await boot(t);
  assert.equal((await call("a", gzipSync("{}"), { "content-encoding": "gzip" })).status, 415);
});
test("POST admission is bounded per credential, independently of session resets", async (t) => {
  const call = await boot(t, false, { httpPostBudget: 120 });
  for (let i = 0; i < 120; i++) assert.equal((await call()).status, 400);
  const refused = await call(); assert.equal(refused.status, 429); assert.ok(refused.headers.get("retry-after"));
  assert.equal((await call("b")).status, 400);
});

for (const scope of ["session", "process"]) test(`tool work is bounded per ${scope}, and completion releases capacity`, async () => {
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const register = createToolRegistrar([{ name: "synthetic", title: "Synthetic", description: "Synthetic", schema: {}, write: false,
    handler: async () => { await gate; return { content: [] }; } }]);
  const session = () => { let call; register({ registerTool(_name, _meta, handler) { call = handler; } }, stubAccountSource(wa), { allowWrite: false, maxInFlight: 4, maxInFlightTotal: 16 }); return call; };
  const calls = Array.from({ length: scope === "session" ? 1 : 4 }, session);
  const pending = calls.flatMap(call => Array.from({ length: 4 }, () => call({})));
  const overflow = (scope === "session" ? calls[0] : session())({});
  await turn(); finish();
  const refused = await overflow; await Promise.all(pending);
  assert.equal(refused.structuredContent?.error, "RATE_LIMITED");
  assert.equal((await calls[0]({})).isError, undefined);
});

test("by default one session runs a burst of eight tool calls, and the ninth waits its turn", async () => {
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const register = createToolRegistrar([{ name: "synthetic", title: "Synthetic", description: "Synthetic", schema: {}, write: false,
    handler: async () => { await gate; return { content: [] }; } }]);
  let call; register({ registerTool(_name, _meta, handler) { call = handler; } }, stubAccountSource(wa), { allowWrite: false });
  const burst = Array.from({ length: 8 }, () => call({}));
  const ninth = call({});
  await turn(); finish();
  for (const result of await Promise.all(burst)) assert.equal(result.isError, undefined);
  assert.equal((await ninth).structuredContent?.error, "RATE_LIMITED");
});
