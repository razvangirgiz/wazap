/**
 * Shutting down (SIGTERM, SIGINT, `wazap update`) drains HTTP first: nothing
 * new is taken, a wait answers at once with what it has, other calls under
 * way get their answers for up to ten seconds, and only then does the
 * listener close. A restart no longer cuts a tool call off mid-answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { request } from "node:http";
import { drainHttpEndpoints, HTTP_DRAIN_MS, startHttpEndpoint } from "../dist/server.js";
import { asToolSource, offlineConfig } from "./helpers.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CHAT = "40722123456@s.whatsapp.net";

async function boot(t, wa) {
  const config = offlineConfig("wazap-drain-", { readOnly: false });
  const stop = new AbortController();
  t.after(() => {
    stop.abort();
    rmSync(config.dataDir, { recursive: true, force: true });
  });
  const port = await startHttpEndpoint(asToolSource({ getStatus: () => ({ status: "connected", status_since: new Date().toISOString(), read_only: false }), ...wa }), config, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    credentials: [{ token: "w", write: true }],
    signal: stop.signal,
  });
  const post = (body, sid) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: "Bearer w",
            ...(sid ? { "mcp-session-id": sid } : {}),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode, sid: res.headers["mcp-session-id"], text, at: Date.now() }));
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  const session = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "drain", version: "1" } } });
  const tool = (id, name, args) => post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, session.sid);
  return { port, tool, post, sid: session.sid };
}

test("a drain lets the call under way answer, ends a wait at once, refuses new work, then closes", { timeout: 20_000 }, async (t) => {
  let downloadFinished = null;
  const { port, tool, post, sid } = await boot(t, {
    downloadMedia: async () => {
      await sleep(600);
      downloadFinished = Date.now();
      return { path: "/tmp/x.txt", mime: "text/plain", size: 4, filename: "x.txt", inline_base64: null, source: "kept" };
    },
    waitForMessages: (opts) =>
      new Promise((resolve) => {
        const end = () => resolve({ messages: [], cursor: "boot:0", timed_out: true, cursor_reset: false });
        const timer = setTimeout(end, opts.timeoutMs);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          end();
        });
      }),
  });
  const download = tool(2, "get_media", { message_id: `false_${CHAT}_M1` });
  const wait = tool(3, "wait_for_messages", { timeout_seconds: 30 });
  await sleep(100);
  const drainStarted = Date.now();
  const drained = drainHttpEndpoints();
  const refused = await post({ jsonrpc: "2.0", id: 4, method: "ping" }, sid).catch((err) => ({ status: err.code }));
  assert.ok([503, "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(refused.status), `a new request during the drain: ${refused.status}`);

  const waited = await wait;
  assert.equal(waited.status, 200);
  assert.match(waited.text, /"timed_out":true/);
  assert.ok(waited.at - drainStarted < 500, "the wait answered at once, with what it had");

  const downloaded = await download;
  assert.equal(downloaded.status, 200, "the call under way was answered, not cut off");
  assert.match(downloaded.text, /x\.txt/);
  await drained;
  assert.ok(Date.now() >= downloadFinished, "the drain waited for it");
  assert.ok(Date.now() - drainStarted < HTTP_DRAIN_MS);
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) }),
    "the listener is closed afterwards"
  );
});

test("a call that outlasts the drain's bound is closed when the bound runs out", { timeout: 20_000 }, async (t) => {
  const { tool } = await boot(t, { downloadMedia: () => new Promise(() => {}) });
  const stuck = tool(2, "get_media", { message_id: `false_${CHAT}_M1` }).catch((err) => ({ error: err.code }));
  await sleep(100);
  const started = Date.now();
  await drainHttpEndpoints(300);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 280 && elapsed < 2_000, `closed after ${elapsed} ms`);
  const outcome = await stuck;
  assert.ok(outcome.error !== undefined || outcome.status !== undefined);
});

test("a drain with nothing under way closes at once", async (t) => {
  await boot(t, {});
  const started = Date.now();
  await drainHttpEndpoints();
  assert.ok(Date.now() - started < 500);
});

test("the warm-up after the bind runs a handshake through a session nobody can reach", async (t) => {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk, encoding, callback) {
    lines.push(String(chunk));
    const done = typeof encoding === "function" ? encoding : callback;
    done?.();
    return true;
  };
  let booted;
  try {
    booted = await boot(t, {});
    await sleep(300);
  } finally {
    process.stderr.write = original;
  }
  assert.doesNotMatch(lines.join(""), /warm-up failed/);
  const reached = await booted.post({ jsonrpc: "2.0", id: 9, method: "ping" }, "warm-up");
  assert.equal(reached.status, 404);
  assert.equal((await booted.post({ jsonrpc: "2.0", id: 10, method: "ping" }, booted.sid)).status, 200);
});
