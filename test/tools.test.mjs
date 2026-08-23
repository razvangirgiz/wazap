import { test } from "node:test";
import assert from "node:assert/strict";

import { registerTools, toolError, TOOL_NAMES } from "../dist/tools.js";
import { WazapError, ERROR_GUIDE } from "../dist/errors.js";
import { RateLimiter } from "../dist/ratelimit.js";

/** Stand-in for McpServer: records what got registered and lets us call it. */
function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, meta, handler) {
      tools.set(name, { meta, handler });
    },
  };
}

const READ_TOOLS = [
  "learn",
  "get_status",
  "link_account",
  "list_chats",
  "read_messages",
  "get_recent_messages",
  "search_messages",
  "get_message",
  "search_contacts",
  "sync_contacts",
  "get_contact",
  "get_group_info",
  "download_media",
  "transcribe_audio",
];

const WRITE_TOOLS = [
  "send_message",
  "send_media",
  "send_poll",
  "send_location",
  "edit_message",
  "react_to_message",
  "forward_message",
  "delete_message",
  "manage_chat",
  "create_group",
  "manage_group",
];

test("the registry is exactly the 25 documented tools", () => {
  assert.deepEqual([...TOOL_NAMES].sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
  assert.equal(TOOL_NAMES.length, 25);
});

test("read-only registration exposes no write tool at all", () => {
  const server = fakeServer();
  registerTools(server, {}, { allowWrite: false, limiter: new RateLimiter(20) });
  assert.deepEqual([...server.tools.keys()].sort(), [...READ_TOOLS].sort());
});

test("every tool declares a description and an input schema", () => {
  const server = fakeServer();
  registerTools(server, {}, { allowWrite: true, limiter: new RateLimiter(20) });
  assert.equal(server.tools.size, 25);
  for (const [name, { meta }] of server.tools) {
    assert.ok(meta.description?.length > 40, `${name} needs a description an agent can act on`);
    assert.ok(meta.inputSchema, `${name} needs an input schema`);
    assert.ok(meta.annotations, `${name} needs annotations`);
  }
});

test("a WazapError becomes an MCP error result carrying code, message and fix", () => {
  const result = toolError(new WazapError("NOT_LINKED", "No account is linked.", "Run `npx wazap-mcp login`"));
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: "NOT_LINKED",
    message: "No account is linked.",
    fix: "Run `npx wazap-mcp login`",
  });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test("an error without a fix omits the field instead of emitting null", () => {
  const result = toolError(new WazapError("WHATSAPP_ERROR", "boom"));
  assert.deepEqual(result.structuredContent, { error: "WHATSAPP_ERROR", message: "boom" });
});

test("a handler that throws a raw error is reported as WHATSAPP_ERROR, never as a crash", async () => {
  const server = fakeServer();
  const wa = {
    getStatus() {
      throw new TypeError("something internal broke");
    },
  };
  registerTools(server, wa, { allowWrite: true, limiter: new RateLimiter(20) });
  const result = await server.tools.get("get_status").handler({});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "WHATSAPP_ERROR");
  assert.equal(result.structuredContent.message, "something internal broke");
});

test("write tools are rate limited and read tools are not", async () => {
  const server = fakeServer();
  const wa = {
    getStatus: () => ({ status: "connected", sync: "done", account: null }),
    sendMessage: async () => ({ message_id: "x", chat_id: "y", text: "hi", timestamp: "now" }),
  };
  registerTools(server, wa, { allowWrite: true, limiter: new RateLimiter(2) });
  const send = server.tools.get("send_message").handler;

  assert.equal((await send({ chat_id: "1", text: "hi" })).isError, undefined);
  assert.equal((await send({ chat_id: "1", text: "hi" })).isError, undefined);
  const limited = await send({ chat_id: "1", text: "hi" });
  assert.equal(limited.structuredContent.error, "RATE_LIMITED");
  assert.match(limited.structuredContent.fix, /^Wait \d+ seconds$/);

  const status = await server.tools.get("get_status").handler({});
  assert.equal(status.isError, undefined, "reads must not consume the write budget");
});

test("read_messages passes types through to the service and echoes it back", async () => {
  const server = fakeServer();
  const calls = [];
  const wa = {
    readMessages: async (...args) => {
      calls.push(args);
      return { data: [], sync: "done" };
    },
  };
  registerTools(server, wa, { allowWrite: true, limiter: new RateLimiter(20) });

  const result = await server.tools.get("read_messages").handler({ chat_id: "4072@s.whatsapp.net", limit: 20, types: ["call"] });
  assert.deepEqual(calls[0], ["4072@s.whatsapp.net", 20, undefined, ["call"]]);
  assert.deepEqual(result.structuredContent.types, ["call"]);

  await server.tools.get("read_messages").handler({ chat_id: "4072@s.whatsapp.net", limit: 20 });
  assert.deepEqual(calls[1], ["4072@s.whatsapp.net", 20, undefined, undefined], "no types means every type");
});

test("get_recent_messages passes types through to the service and echoes it back", async () => {
  const server = fakeServer();
  const calls = [];
  const wa = {
    getRecentMessages: async (...args) => {
      calls.push(args);
      return { data: [], sync: "done" };
    },
  };
  registerTools(server, wa, { allowWrite: true, limiter: new RateLimiter(20) });

  const result = await server.tools
    .get("get_recent_messages")
    .handler({ hours: 24, filter: "all", include_system: false, types: ["call", "voice"] });
  assert.deepEqual(calls[0], [24, "all", false, ["call", "voice"]]);
  assert.deepEqual(result.structuredContent.types, ["call", "voice"]);
});

/**
 * link_account carries its own bucket of 2/minute, so this file may call it
 * twice. The service-level cases live in link.test.mjs, in their own process.
 */
test("link_account hands back the code and the steps that go with it", async () => {
  const server = fakeServer();
  const asked = [];
  const wa = {
    link: async (phone) => {
      asked.push(phone);
      return { code: "ABCD-1234", phone_masked: "+15 5xx xxx", expires_at: "2026-08-23T12:00:00+03:00" };
    },
  };
  registerTools(server, wa, { allowWrite: false, limiter: new RateLimiter(20) });

  const result = await server.tools.get("link_account").handler({ phone: "+15550100" });
  assert.deepEqual(asked, ["+15550100"]);
  assert.equal(result.structuredContent.code, "ABCD-1234");
  assert.match(result.content[0].text, /ABCD-1234/);
  assert.match(result.content[0].text, /Linked devices/);
  assert.match(result.structuredContent.next, /get_status/);
});

test("link_account on a linked account reports ALREADY_LINKED instead of pairing again", async () => {
  const server = fakeServer();
  const wa = {
    getStatus: () => ({ status: "connected" }),
    link: async () => {
      throw new WazapError("ALREADY_LINKED", "The account is connected.", "Call get_status");
    },
  };
  registerTools(server, wa, { allowWrite: true, limiter: new RateLimiter(20) });

  const result = await server.tools.get("link_account").handler({ phone: "+15550100" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "ALREADY_LINKED");
  assert.equal(wa.getStatus().status, "connected", "the tool must not have touched the session");
});

test("learn documents every error code an agent can receive", async () => {
  const server = fakeServer();
  registerTools(server, {}, { allowWrite: true, limiter: new RateLimiter(20) });
  const guide = (await server.tools.get("learn").handler({})).structuredContent.guide;
  for (const code of Object.keys(ERROR_GUIDE)) {
    assert.ok(guide.includes(code), `learn must tell the agent what to do about ${code}`);
  }
});
