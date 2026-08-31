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
  "confirm_send",
  "delete_message",
  "manage_chat",
  "create_group",
  "manage_group",
];

test("the registry is exactly the 26 documented tools", () => {
  assert.deepEqual([...TOOL_NAMES].sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
  assert.equal(TOOL_NAMES.length, 26);
});

test("read-only registration exposes no write tool at all", () => {
  const server = fakeServer();
  registerTools(server, {}, { allowWrite: false, limiter: new RateLimiter(20) });
  assert.deepEqual([...server.tools.keys()].sort(), [...READ_TOOLS].sort());
});

test("every tool declares a description and an input schema", () => {
  const server = fakeServer();
  registerTools(server, {}, { allowWrite: true, limiter: new RateLimiter(20) });
  assert.equal(server.tools.size, 26);
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
  const sent = [];
  const wa = {
    getStatus: () => ({ status: "connected", sync: "done", account: null }),
    resolveOutgoing: async (chatId) => ({ chat_id: chatId, name: "Ana", number: "40722123456" }),
    sendMessage: async (...args) => {
      sent.push(args);
      return { message_id: "x", chat_id: "y", text: "hi", timestamp: "now" };
    },
  };
  registerTools(server, wa, { allowWrite: true, limiter: new RateLimiter(2) });
  const send = server.tools.get("send_message").handler;
  const confirm = server.tools.get("confirm_send").handler;

  const first = await send({ chat_id: "1", text: "hi" });
  assert.equal(first.structuredContent.status, "draft");
  assert.equal(sent.length, 0, "drafting must not reach WhatsApp");
  assert.equal((await confirm({ draft_id: first.structuredContent.draft_id })).isError, undefined);

  const second = await send({ chat_id: "1", text: "hi" });
  assert.equal((await confirm({ draft_id: second.structuredContent.draft_id })).isError, undefined);

  const third = await send({ chat_id: "1", text: "hi" });
  assert.equal(third.structuredContent.status, "draft", "drafting does not spend the write bucket");
  const limited = await confirm({ draft_id: third.structuredContent.draft_id });
  assert.equal(limited.structuredContent.error, "RATE_LIMITED");
  assert.match(limited.structuredContent.fix, /^Wait \d+ seconds$/);
  assert.equal(sent.length, 2);

  const status = await server.tools.get("get_status").handler({});
  assert.equal(status.isError, undefined, "reads must not consume the write budget");
});

test("send_media refuses a missing local file before it drafts", async () => {
  const server = fakeServer();
  let resolved = 0;
  const wa = {
    resolveOutgoing: async () => {
      resolved += 1;
      return { chat_id: "1", name: "Ana" };
    },
  };
  registerTools(server, wa, { allowWrite: true, limiter: new RateLimiter(20) });
  const result = await server.tools.get("send_media").handler({
    chat_id: "1",
    file_path: "/no/such/wazap-media.bin",
  });
  assert.equal(result.structuredContent.error, "FILE_NOT_FOUND");
  assert.equal(resolved, 0);
});

test("confirm_send is the only call that invokes sendMessage", async () => {
  const server = fakeServer();
  const sent = [];
  const wa = {
    resolveOutgoing: async () => ({ chat_id: "40722123456@s.whatsapp.net", name: "Ana", number: "40722123456" }),
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text });
      return { message_id: "mid", chat_id: chatId, text, timestamp: "now" };
    },
    sendPoll: async () => {
      throw new Error("poll must not send at draft time");
    },
    sendLocation: async () => {
      throw new Error("location must not send at draft time");
    },
    forwardMessage: async () => {
      throw new Error("forward must not send at draft time");
    },
    getMessage: async () => ({ text: "factura" }),
  };
  registerTools(server, wa, { allowWrite: true, limiter: new RateLimiter(20) });

  const drafted = await server.tools.get("send_message").handler({ chat_id: "+40722123456", text: "Joi la 10." });
  assert.equal(sent.length, 0);
  assert.match(drafted.content[0].text, /Not sent/);
  assert.match(drafted.content[0].text, /To: Ana \(\+40 722 123 456\)/);
  assert.match(drafted.content[0].text, /confirm_send/);

  const poll = await server.tools.get("send_poll").handler({
    chat_id: "+40722123456",
    question: "Pizza?",
    options: ["da", "nu"],
  });
  assert.equal(poll.structuredContent.status, "draft");

  const confirmed = await server.tools.get("confirm_send").handler({ draft_id: drafted.structuredContent.draft_id });
  assert.deepEqual(sent, [{ chatId: "40722123456@s.whatsapp.net", text: "Joi la 10." }]);
  assert.match(confirmed.content[0].text, /Sent to/);
  assert.equal(confirmed.structuredContent.message_id, "mid");
});

test("a failed confirm_send puts the draft back", async () => {
  const server = fakeServer();
  let blows = true;
  const wa = {
    resolveOutgoing: async (chatId) => ({ chat_id: chatId, name: "Ana", number: "40722123456" }),
    sendMessage: async (chatId, text) => {
      if (blows) throw new WazapError("NOT_CONNECTED", "still connecting");
      return { message_id: "mid", chat_id: chatId, text, timestamp: "now" };
    },
  };
  registerTools(server, wa, { allowWrite: true, limiter: new RateLimiter(20) });
  const drafted = await server.tools.get("send_message").handler({ chat_id: "1", text: "hi" });
  const id = drafted.structuredContent.draft_id;

  const failed = await server.tools.get("confirm_send").handler({ draft_id: id });
  assert.equal(failed.structuredContent.error, "NOT_CONNECTED");

  blows = false;
  const retry = await server.tools.get("confirm_send").handler({ draft_id: id });
  assert.equal(retry.structuredContent.message_id, "mid");
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
