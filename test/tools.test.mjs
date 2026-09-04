import { test } from "node:test";
import assert from "node:assert/strict";

import { registerTools, toolError, TOOL_NAMES } from "../dist/tools.js";
import { DraftStore } from "../dist/drafts.js";
import { WazapError, ERROR_GUIDE } from "../dist/errors.js";

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
  "get_unanswered",
  "wait_for_messages",
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

test("the registry is exactly the 28 documented tools", () => {
  assert.deepEqual([...TOOL_NAMES].sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
  assert.equal(TOOL_NAMES.length, 28);
});

test("read-only registration exposes no write tool at all", () => {
  const server = fakeServer();
  registerTools(server, {}, { allowWrite: false });
  assert.deepEqual([...server.tools.keys()].sort(), [...READ_TOOLS].sort());
});

test("every tool declares a description and an input schema", () => {
  const server = fakeServer();
  registerTools(server, {}, { allowWrite: true });
  assert.equal(server.tools.size, 28);
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
  registerTools(server, wa, { allowWrite: true });
  const result = await server.tools.get("get_status").handler({});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "WHATSAPP_ERROR");
  assert.equal(result.structuredContent.message, "something internal broke");
});

function draftApi(confirm) {
  const store = new DraftStore();
  const to = { chat_id: "40722123456@s.whatsapp.net", name: "Ana", number: "40722123456" };
  return {
    draft: async (payload) => store.view(store.put(to, payload)),
    confirm: async (id) => {
      const draft = store.take(id);
      if (confirm) return confirm(draft);
      const text = draft.payload.kind === "text" ? draft.payload.text : "";
      return { message_id: "mid", chat_id: draft.to.chat_id, text, timestamp: "now" };
    },
  };
}

test("send_message drafts through the session and confirm_send is the only send", async () => {
  const server = fakeServer();
  const sent = [];
  const wa = draftApi((draft) => {
    sent.push({ chatId: draft.to.chat_id, text: draft.payload.text });
    return { message_id: "mid", chat_id: draft.to.chat_id, text: draft.payload.text, timestamp: "now" };
  });
  registerTools(server, wa, { allowWrite: true });

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

test("send_media surfaces FILE_NOT_FOUND from draft", async () => {
  const server = fakeServer();
  const wa = {
    draft: async () => {
      throw new WazapError("FILE_NOT_FOUND", `No file at "/no/such/wazap-media.bin" on the machine running wazap.`);
    },
  };
  registerTools(server, wa, { allowWrite: true });
  const result = await server.tools.get("send_media").handler({
    chat_id: "1",
    file_path: "/no/such/wazap-media.bin",
  });
  assert.equal(result.structuredContent.error, "FILE_NOT_FOUND");
});

test("confirm_send surfaces the service error", async () => {
  const server = fakeServer();
  const wa = {
    ...draftApi(),
    confirm: async () => {
      throw new WazapError("NOT_CONNECTED", "still connecting");
    },
  };
  registerTools(server, wa, { allowWrite: true });
  const drafted = await server.tools.get("send_message").handler({ chat_id: "1", text: "hi" });
  const failed = await server.tools.get("confirm_send").handler({ draft_id: drafted.structuredContent.draft_id });
  assert.equal(failed.structuredContent.error, "NOT_CONNECTED");
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
  registerTools(server, wa, { allowWrite: true });

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
  registerTools(server, wa, { allowWrite: true });

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
  registerTools(server, wa, { allowWrite: false });

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
  registerTools(server, wa, { allowWrite: true });

  const result = await server.tools.get("link_account").handler({ phone: "+15550100" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "ALREADY_LINKED");
  assert.equal(wa.getStatus().status, "connected", "the tool must not have touched the session");
});

test("learn documents every error code an agent can receive", async () => {
  const server = fakeServer();
  registerTools(server, {}, { allowWrite: true });
  const guide = (await server.tools.get("learn").handler({})).structuredContent.guide;
  for (const code of Object.keys(ERROR_GUIDE)) {
    assert.ok(guide.includes(code), `learn must tell the agent what to do about ${code}`);
  }
});
