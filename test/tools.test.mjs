import { test } from "node:test";
import assert from "node:assert/strict";

import { registerTools, toolError, TOOL_NAMES } from "../dist/tools.js";
import { WazapError, ERROR_GUIDE } from "../dist/errors.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { asToolSource, connectedService, draftStub, READ_TOOL_COUNT, TOOL_COUNT } from "./helpers.mjs";

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
  "search",
  "get_message",
  "find_contact",
  "get_group_info",
  "get_media",
  "catch_up",
  "wait_for_messages",
  "remember",
];

const WRITE_TOOLS = [
  "send_message",
  "edit_message",
  "react_to_message",
  "confirm_send",
  "delete_message",
  "manage_chat",
  "manage_group",
];

test("the registry is exactly the 20 documented tools, 13 of them in a session without writes", () => {
  assert.deepEqual([...TOOL_NAMES].sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
  assert.equal(TOOL_NAMES.length, 20);
  assert.equal(TOOL_COUNT, 20);
  assert.equal(READ_TOOLS.length, 13);
  assert.equal(READ_TOOL_COUNT, 13);
});

test("read-only registration exposes no write tool at all", () => {
  const server = fakeServer();
  registerTools(server, asToolSource({}), { allowWrite: false });
  assert.deepEqual([...server.tools.keys()].sort(), [...READ_TOOLS].sort());
});

test("every tool declares a description and an input schema", () => {
  const server = fakeServer();
  registerTools(server, asToolSource({}), { allowWrite: true });
  assert.equal(server.tools.size, READ_TOOLS.length + WRITE_TOOLS.length);
  for (const [name, { meta }] of server.tools) {
    assert.ok(meta.description?.length > 40, `${name} needs a description an agent can act on`);
    assert.ok(meta.inputSchema, `${name} needs an input schema`);
    assert.ok(meta.inputSchema.account_id, `${name} needs optional account_id`);
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
  registerTools(server, asToolSource(wa), { allowWrite: true });
  const result = await server.tools.get("get_status").handler({});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "WHATSAPP_ERROR");
  assert.equal(result.structuredContent.message, "something internal broke");
});

function draftApi(confirm) {
  const store = draftStub();
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
  registerTools(server, asToolSource(wa), { allowWrite: true });

  const drafted = await server.tools.get("send_message").handler({ chat_id: "+40722123456", text: "Joi la 10." });
  assert.equal(sent.length, 0);
  assert.match(drafted.content[0].text, /Not sent/);
  assert.match(drafted.content[0].text, /To: Ana \(\+40 722 123 456\)/);
  assert.match(drafted.content[0].text, /confirm_send/);
  assert.match(drafted.structuredContent.next, /preview.*confirm_send.*only after their yes/, "a client that reads structured content only still gets the step after a draft");

  const poll = await server.tools.get("send_message").handler({
    chat_id: "+40722123456",
    text: "Pizza?",
    options: ["da", "nu"],
  });
  assert.equal(poll.structuredContent.status, "draft");

  const confirmed = await server.tools.get("confirm_send").handler({ draft_id: drafted.structuredContent.draft_id });
  assert.deepEqual(sent, [{ chatId: "40722123456@s.whatsapp.net", text: "Joi la 10." }]);
  assert.match(confirmed.content[0].text, /Sent to/);
  assert.equal(confirmed.structuredContent.message_id, "mid");
});

test("a media draft surfaces FILE_NOT_FOUND from draft", async () => {
  const server = fakeServer();
  const wa = {
    draft: async () => {
      throw new WazapError("FILE_NOT_FOUND", `No file at "/no/such/wazap-media.bin" on the machine running wazap.`);
    },
  };
  registerTools(server, asToolSource(wa), { allowWrite: true });
  const result = await server.tools.get("send_message").handler({
    chat_id: "1",
    text: "",
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
  registerTools(server, asToolSource(wa), { allowWrite: true });
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
  registerTools(server, asToolSource(wa), { allowWrite: true });

  const result = await server.tools
    .get("read_messages")
    .handler({ chat_id: "4072@s.whatsapp.net", limit: 20, types: ["call"] });
  assert.deepEqual(calls[0], ["4072@s.whatsapp.net", 20, undefined, ["call"]]);
  assert.deepEqual(result.structuredContent.types, ["call"]);

  await server.tools.get("read_messages").handler({ chat_id: "4072@s.whatsapp.net", limit: 20 });
  assert.deepEqual(calls[1], ["4072@s.whatsapp.net", 20, undefined, undefined], "no types means every type");
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
  registerTools(server, asToolSource(wa), { allowWrite: false });

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
  registerTools(server, asToolSource(wa), { allowWrite: true });

  const result = await server.tools.get("link_account").handler({ phone: "+15550100" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "ALREADY_LINKED");
  assert.equal(wa.getStatus().status, "connected", "the tool must not have touched the session");
});

test("get_status says write tools are missing and how to enable them", async () => {
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-status-writes-",
    id: "40700000001@s.whatsapp.net",
    name: "Răzvan",
    config: { readOnly: true, transport: "http", publicUrl: "https://wazap.example" },
  });
  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: false });
  const result = await server.tools.get("get_status").handler({});
  assert.equal(result.structuredContent.write_tools, false);
  assert.equal(result.structuredContent.read_only, true);
  assert.match(result.content[0].text, /write tools.*not registered/i);
  assert.match(result.structuredContent.hint, /wazap config writes on/);
  assert.doesNotMatch(result.structuredContent.hint, /token/i);
});

test("get_status on a write-enabled server hides write tools from a read-token session", async () => {
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-status-read-token-",
    id: "40700000001@s.whatsapp.net",
    name: "Răzvan",
    config: { readOnly: false },
  });
  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: false });
  const result = await server.tools.get("get_status").handler({});
  assert.equal(result.structuredContent.read_only, false);
  assert.equal(result.structuredContent.write_tools, false);
  assert.match(result.content[0].text, /read token/);
});

test("get_status on a remote write session tells the agent nothing about bearer tokens", async () => {
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-status-remote-",
    id: "40700000001@s.whatsapp.net",
    name: "Răzvan",
    config: { readOnly: false, transport: "http", publicUrl: "https://wazap.example" },
  });
  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: true });
  const result = await server.tools.get("get_status").handler({});
  assert.equal(result.structuredContent.write_tools, true);
  assert.match(result.content[0].text, /write tools.*registered/i);
  assert.equal(result.structuredContent.hint, undefined);
});

test("learn documents every error code an agent can receive, within 2,000 tokens and as text only", async () => {
  const server = fakeServer();
  registerTools(server, asToolSource({}), { allowWrite: true });
  const guide = (await server.tools.get("learn").handler({})).content[0].text;
  for (const code of Object.keys(ERROR_GUIDE)) {
    assert.ok(guide.includes(code), `learn must tell the agent what to do about ${code}`);
  }
  assert.ok(Buffer.byteLength(guide) / 4 <= 2000, `${Math.round(Buffer.byteLength(guide) / 4)} tokens`);
  assert.equal((await server.tools.get("learn").handler({})).structuredContent, undefined, "the guide is not repeated as structured content");
});

test("send_message drafts one kind at a time and refuses what does not belong to it", async () => {
  const server = fakeServer();
  const drafted = [];
  const wa = { ...draftApi(), draft: async (payload) => (drafted.push(payload), draftApi().draft(payload)) };
  registerTools(server, asToolSource(wa), { allowWrite: true });
  const send = (args) => server.tools.get("send_message").handler({ chat_id: "+40722123456", ...args });
  const refused = async (args, pattern) => {
    const result = await send(args);
    assert.equal(result.structuredContent.error, "INVALID_ID", JSON.stringify(args));
    assert.match(result.structuredContent.message, pattern);
  };

  await refused({ text: "", options: ["da", "nu"], latitude: 44, longitude: 26 }, /a poll \(options\) and a location/);
  await refused({ text: "hai", multi_select: true }, /multi_select does not apply/);
  await refused({ text: "uite", file_path: "/tmp/a.jpg", reply_to: "false_1@s.whatsapp.net_X" }, /reply_to does not apply/);
  await refused({ text: "citește", forward: "false_1@s.whatsapp.net_X" }, /cannot carry text/);
  await refused({ text: "" }, /empty/);
  await refused({ text: "", options: ["da", "nu"] }, /question in text/);
  await refused({ text: "", latitude: 44 }, /both latitude and longitude/);
  assert.equal(drafted.length, 0, "nothing refused reached a draft");

  assert.equal((await send({ text: "", file_path: "/tmp/a.gif", as: "gif" })).structuredContent.status, "draft");
  assert.deepEqual(drafted.at(-1), {
    kind: "media",
    chatId: "+40722123456",
    source: { file_path: "/tmp/a.gif", url: undefined },
    asDocument: false,
    asVoice: false,
    asGif: true,
  });
  await send({ text: "Notar", latitude: 44.4, longitude: 26.1 });
  assert.deepEqual(drafted.at(-1), { kind: "location", chatId: "+40722123456", latitude: 44.4, longitude: 26.1, name: "Notar" });
  await send({ text: "", forward: "false_1@s.whatsapp.net_X" });
  assert.deepEqual(drafted.at(-1), { kind: "forward", chatId: "+40722123456", messageId: "false_1@s.whatsapp.net_X" });
  await send({ text: "Joi la 10.", reply_to: "false_1@s.whatsapp.net_X" });
  assert.deepEqual(drafted.at(-1), { kind: "text", chatId: "+40722123456", text: "Joi la 10.", replyTo: "false_1@s.whatsapp.net_X", mentionIds: undefined });
});

test("a voice note or an audio file drafted with text is refused: WhatsApp shows no caption on it", async () => {
  const server = fakeServer();
  const drafted = [];
  const wa = { ...draftApi(), draft: async (payload) => (drafted.push(payload), draftApi().draft(payload)) };
  registerTools(server, asToolSource(wa), { allowWrite: true });
  const send = (args) => server.tools.get("send_message").handler({ chat_id: "+40722123456", ...args });
  const words = "Ascultă până la capăt, e despre contract";
  for (const args of [
    { text: words, file_path: "/tmp/nota.ogg", as: "voice" },
    { text: words, file_path: "/tmp/nota.m4a", as: "voice" },
    { text: words, file_path: "/tmp/nota.ogg" },
    { text: words, file_path: "/tmp/interviu.MP3" },
    { text: words, url: "https://example.com/audio/nota.opus?x=1" },
  ]) {
    const result = await send(args);
    assert.equal(result.structuredContent.error, "INVALID_ID", JSON.stringify(args));
    assert.match(result.structuredContent.message, /no caption/);
    assert.match(result.structuredContent.fix, /own send_message/);
  }
  assert.equal(drafted.length, 0, "nothing refused reached a draft");

  // Without text, or as a document (which keeps its caption), the recording drafts.
  assert.equal((await send({ text: "", file_path: "/tmp/nota.ogg", as: "voice" })).structuredContent.status, "draft");
  assert.equal((await send({ text: "", file_path: "/tmp/nota.mp3" })).structuredContent.status, "draft");
  assert.equal((await send({ text: "înregistrarea", file_path: "/tmp/nota.mp3", as: "document" })).structuredContent.status, "draft");
  assert.equal(drafted.at(-1).caption, "înregistrarea");
});

test("remember and learn state the #private rule the reads keep: no words unless a call names the person", async () => {
  const server = fakeServer();
  registerTools(server, asToolSource({}), { allowWrite: true });
  const described = server.tools.get("remember").meta.description;
  // Every read that does not name the person leaves their words out (src/private-contacts.ts); one that names them shows them.
  assert.match(described, /#private keeps their words out of what you did not ask about them by name/);
  assert.doesNotMatch(described, /out of answers|out of catch_up and find_contact's draft context/);
  const guide = (await server.tools.get("learn").handler({})).content[0].text;
  assert.match(guide, /#private: a person's words come only when a call names them: their chat_id,\s+a message_id of theirs, search's from; a group's chat_id reads whole\. Elsewhere\s+their entries say private, with no words, and search counts private_omitted\./);
});

test("each tool's annotations are true of its most far-reaching action: get_media reads, remember does not", () => {
  const server = fakeServer();
  registerTools(server, asToolSource({}), { allowWrite: true });
  const hints = Object.fromEntries(
    [...server.tools].map(([name, { meta }]) => {
      const a = meta.annotations;
      return [name, [a.readOnlyHint, a.destructiveHint, a.idempotentHint, a.openWorldHint].map((h) => (h ? 1 : 0)).join("")];
    })
  );
  // readOnly, destructive, idempotent, openWorld
  assert.deepEqual(hints, {
    learn: "1010",
    get_status: "1010",
    link_account: "0001",
    list_chats: "1011",
    read_messages: "1011",
    catch_up: "1001",
    remember: "0010",
    wait_for_messages: "1011",
    search: "1011",
    get_message: "1011",
    find_contact: "1011",
    get_group_info: "1011",
    get_media: "1001",
    send_message: "0001",
    confirm_send: "0011",
    edit_message: "0111",
    delete_message: "0111",
    react_to_message: "0011",
    manage_chat: "0101",
    manage_group: "0101",
  });
});
