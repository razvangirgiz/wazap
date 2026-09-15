import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registerTools } from "../dist/tools.js";
import { createToolRegistrar } from "../dist/tool-runtime.js";
import { WazapError } from "../dist/errors.js";
import { DraftStore } from "../dist/drafts.js";
import { writeDaemon } from "../dist/daemon.js";
import { startHttpEndpoint } from "../dist/server.js";
import { asToolSource, childEnv, mcpClient, offlineConfig } from "./helpers.mjs";

const CHAT = "40722123456@s.whatsapp.net";
const CASES = [
  ["send_message", { chat_id: CHAT, text: "hello" }],
  ["send_media", { chat_id: CHAT, file_path: "/unused/stub.png" }],
  ["send_poll", { chat_id: CHAT, question: "Lunch?", options: ["yes", "no"] }],
  ["send_location", { chat_id: CHAT, latitude: 44, longitude: 26 }],
  ["forward_message", { to_chat_id: CHAT, message_id: `false_${CHAT}_message` }],
];

function fixture({ now, beforeConfirm } = {}) {
  const store = new DraftStore(now);
  let confirms = 0;
  const wa = {
    getStatus: () => ({ status: "connected", status_since: new Date().toISOString(), read_only: false }),
    draft: async (payload) => store.view(store.put({ chat_id: CHAT, name: "Test" }, payload)),
    confirm: async (id) => {
      confirms++;
      await beforeConfirm?.();
      const draft = store.take(id);
      return { chat_id: CHAT, message_id: "sent", text: draft.preview, timestamp: "now" };
    },
  };
  const hub = asToolSource(wa);
  function client() {
    const tools = new Map();
    registerTools({ registerTool: (name, _meta, handler) => tools.set(name, handler) }, hub, { allowWrite: true });
    return (name, args) => tools.get(name)(args);
  }
  return { hub, wa, client, confirms: () => confirms };
}

for (const [name, args] of CASES) {
  test(`${name}: another registration cannot confirm or consume the owner's draft`, async () => {
    const f = fixture();
    const owner = f.client();
    const other = f.client();
    const draft = await owner(name, args);
    assert.equal(draft.structuredContent.status, "draft");
    const id = draft.structuredContent.draft_id;
    for (const extra of [{}, { account_id: "default" }, { account_id: "nonexistent" }]) {
      const denied = await other("confirm_send", { draft_id: id, ...extra });
      assert.equal(denied.structuredContent.error, "DRAFT_NOT_FOUND");
      assert.equal(f.confirms(), 0);
    }
    assert.equal((await owner("confirm_send", { draft_id: id })).structuredContent.message_id, "sent");
    assert.equal(f.confirms(), 1);
    assert.equal((await owner("confirm_send", { draft_id: id })).structuredContent.error, "DRAFT_NOT_FOUND");
    assert.equal(f.confirms(), 1, "replay does not reach the service");
  });
}

test("an unowned service draft fails closed even without send rules", async () => {
  const f = fixture();
  const draft = await f.wa.draft({ kind: "text", chatId: CHAT, text: "orphan" });
  assert.equal(
    (await f.client()("confirm_send", { draft_id: draft.draft_id })).structuredContent.error,
    "DRAFT_NOT_FOUND"
  );
  assert.equal(f.confirms(), 0);
});

test("wrong account cannot redirect an owned draft, and failure preserves it", async () => {
  const f = fixture();
  const owner = f.client();
  const draft = await owner(...CASES[0]);
  const args = { draft_id: draft.structuredContent.draft_id };
  assert.equal(
    (await owner("confirm_send", { ...args, account_id: "work" })).structuredContent.error,
    "DRAFT_NOT_FOUND"
  );
  assert.equal(f.confirms(), 0);
  assert.equal((await owner("confirm_send", args)).structuredContent.message_id, "sent");
});

test("a failed confirm remains retryable only by its owner", async () => {
  let fail = true;
  const f = fixture({
    beforeConfirm: () => {
      if (fail) throw new WazapError("NOT_CONNECTED", "offline");
    },
  });
  const owner = f.client();
  const draft = await owner(...CASES[0]);
  const args = { draft_id: draft.structuredContent.draft_id };
  assert.equal((await owner("confirm_send", args)).structuredContent.error, "NOT_CONNECTED");
  assert.equal((await f.client()("confirm_send", args)).structuredContent.error, "DRAFT_NOT_FOUND");
  assert.equal(f.confirms(), 1);
  fail = false;
  assert.equal((await owner("confirm_send", args)).structuredContent.message_id, "sent");
});

test("owned expired drafts still report DRAFT_EXPIRED; foreign ones reveal nothing", async () => {
  let now = Date.now();
  const f = fixture({ now: () => now });
  const owner = f.client();
  const draft = await owner(...CASES[0]);
  now += 16 * 60_000;
  const args = { draft_id: draft.structuredContent.draft_id };
  assert.equal((await f.client()("confirm_send", args)).structuredContent.error, "DRAFT_NOT_FOUND");
  assert.equal((await owner("confirm_send", args)).structuredContent.error, "DRAFT_EXPIRED");
});

test("tool-runtime keeps rated tool budgets across registrations", async () => {
  const register = createToolRegistrar([
    {
      name: "test_rate",
      title: "Test",
      description: "Test",
      schema: {},
      write: false,
      rate: 1,
      handler: async () => ({ content: [], structuredContent: { ok: true } }),
    },
  ]);
  function client() {
    let call;
    register(
      {
        registerTool: (_name, _meta, handler) => {
          call = handler;
        },
      },
      fixture().hub,
      { allowWrite: false }
    );
    return call;
  }
  assert.equal((await client()({})).structuredContent.ok, true);
  assert.equal((await client()({})).structuredContent.error, "RATE_LIMITED");
});

async function endpoint(t) {
  const f = fixture();
  const config = offlineConfig("wazap-draft-isolation-", { readOnly: false });
  const stop = new AbortController();
  t.after(() => {
    stop.abort();
    rmSync(config.dataDir, { recursive: true, force: true });
  });
  const port = await startHttpEndpoint(f.hub, config, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    signal: stop.signal,
    credentials: [
      { token: "shared-test-token", write: true },
      { token: "other-test-token", write: true },
    ],
  });
  return { ...f, config, port };
}

async function httpClient(t, port, token = "shared-test-token") {
  const client = new Client({ name: "draft-isolation", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
  );
  t.after(() => client.close());
  return client;
}

for (const token of ["shared-test-token", "other-test-token"]) {
  test(`HTTP: independent sessions using ${token} cannot exchange draft ids`, async (t) => {
    const f = await endpoint(t);
    const owner = await httpClient(t, f.port);
    const other = await httpClient(t, f.port, token);
    const draft = await owner.callTool({ name: "send_message", arguments: CASES[0][1] });
    const args = { draft_id: draft.structuredContent.draft_id };
    assert.equal(
      (await other.callTool({ name: "confirm_send", arguments: args })).structuredContent.error,
      "DRAFT_NOT_FOUND"
    );
    assert.equal(f.confirms(), 0);
    assert.equal(
      (await owner.callTool({ name: "confirm_send", arguments: args })).structuredContent.message_id,
      "sent"
    );
  });
}

test("HTTP: resuming the same authenticated session preserves its drafts", async (t) => {
  const f = await endpoint(t);
  const owner = new Client({ name: "resuming", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${f.port}/mcp`), {
    requestInit: { headers: { authorization: "Bearer shared-test-token" } },
  });
  await owner.connect(transport);
  t.after(() => owner.close());
  const draft = await owner.callTool({ name: "send_message", arguments: CASES[0][1] });
  const sid = transport.sessionId;
  assert.ok(sid);
  await owner.close();
  const response = await fetch(`http://127.0.0.1:${f.port}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer shared-test-token",
      "mcp-session-id": sid,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: {
        name: "confirm_send",
        arguments: { draft_id: draft.structuredContent.draft_id },
      },
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /"message_id":"sent"/);
  assert.equal(f.confirms(), 1);
});

test("HTTP: reinitializing requires drafting again, even with the same token", async (t) => {
  const f = await endpoint(t);
  const old = await httpClient(t, f.port);
  const draft = await old.callTool({ name: "send_message", arguments: CASES[0][1] });
  await old.close();
  const fresh = await httpClient(t, f.port);
  assert.equal(
    (await fresh.callTool({ name: "confirm_send", arguments: { draft_id: draft.structuredContent.draft_id } }))
      .structuredContent.error,
    "DRAFT_NOT_FOUND"
  );
  const redraft = await fresh.callTool({ name: "send_message", arguments: CASES[0][1] });
  assert.equal(
    (await fresh.callTool({ name: "confirm_send", arguments: { draft_id: redraft.structuredContent.draft_id } }))
      .structuredContent.message_id,
    "sent"
  );
  assert.equal(f.confirms(), 1);
});

test("two real stdio bridges sharing a daemon cannot confirm each other's drafts", async (t) => {
  const f = await endpoint(t);
  const file = join(f.config.dataDir, "daemon.json");
  const daemon = { pid: process.pid, port: f.port, token: "shared-test-token", version: "test" };
  writeDaemon(file, daemon);
  async function bridge() {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { runBridge } from ${JSON.stringify(new URL("../dist/bridge.js", import.meta.url).href)};
       import { readDaemon } from ${JSON.stringify(new URL("../dist/daemon.js", import.meta.url).href)};
       await runBridge(readDaemon(process.argv[1]), process.argv[1]);`,
        file,
      ],
      { env: childEnv(), stdio: ["pipe", "pipe", "pipe"] }
    );
    child.stderr.resume();
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = once(child, "exit");
      child.kill();
      await ended;
    });
    const rpc = mcpClient(child);
    await rpc.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    rpc.notify("notifications/initialized");
    return async (name, args) => (await rpc.request("tools/call", { name, arguments: args })).result;
  }
  const owner = await bridge();
  const other = await bridge();
  const draft = await owner("send_message", CASES[0][1]);
  const args = { draft_id: draft.structuredContent.draft_id };
  assert.equal((await other("confirm_send", args)).structuredContent.error, "DRAFT_NOT_FOUND");
  assert.equal(f.confirms(), 0);
  assert.equal((await owner("confirm_send", args)).structuredContent.message_id, "sent");
});
