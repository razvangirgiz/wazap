/**
 * Tools that declare an outputSchema, through the SDK's own Client: the client
 * checks structured content against the schema on every answer, errors
 * included, so an error from such a tool carries its `{ error, message, fix }`
 * as text only. A tool without an outputSchema keeps its structured error.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AccountHub } from "../dist/account-hub.js";
import { AccountRegistry } from "../dist/accounts.js";
import { registerTools } from "../dist/tools.js";
import { asToolSource, fakeSocket, offlineConfig } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40722001111@s.whatsapp.net";

let hub;
let home;
let client;
let tools;

before(async () => {
  const config = offlineConfig("wazap-output-schema-", { readOnly: false });
  hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  home = hub.get("default");
  const sock = fakeSocket();
  home.sockClient = sock;
  home.wireEvents(sock, ++home.generation);
  home.account = { id: ME, name: "Andrei", number: "40700000001" };
  home.status = "connected";
  home.initialSyncDone = true;
  home.db.identity.upsertContact({ jid: ANA, name: "Ana Pop", listed: true });
  home.db.identity.upsertContact({ jid: "40722002222@s.whatsapp.net", name: "Ana Ionescu", listed: true });
  home.db.messages.upsert({ chatJid: ANA, keyId: "K1", fromMe: false, ts: Date.now() - 60_000, type: "text", text: "Salut" });
  home.db.messages.upsert({ chatJid: ANA, keyId: "K2", fromMe: true, ts: Date.now() - 30_000, type: "text", text: "hai ca vin" });
  home.db.messages.upsert({ chatJid: "40722002222@s.whatsapp.net", keyId: "K3", fromMe: true, ts: Date.now() - 20_000, type: "text", text: "vă trimit factura" });

  const server = new McpServer({ name: "wazap-test", version: "1" });
  registerTools(server, asToolSource(hub), { allowWrite: true });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "sdk-client", version: "1" });
  await client.connect(clientSide);
  tools = (await client.listTools()).tools;
});

after(async () => {
  await client?.close();
  await hub?.stop();
});

test("every answer find_contact gives passes the SDK client's schema check, the draft context included", async () => {
  const resolved = await client.callTool({ name: "find_contact", arguments: { name: "Ana Pop" } });
  assert.equal(resolved.structuredContent.status, "resolved");
  assert.ok(resolved.structuredContent.context.recent.length > 0);
  const ambiguous = await client.callTool({ name: "find_contact", arguments: { name: "Ana" } });
  assert.equal(ambiguous.structuredContent.status, "ambiguous");
  const missing = await client.callTool({ name: "find_contact", arguments: { name: "Xyzzy" } });
  assert.equal(missing.structuredContent.status, "not_found");
});

test("a find_contact error reaches an SDK client as an error result, not a schema failure", async () => {
  home.storageState = "preparing";
  try {
    const result = await client.callTool({ name: "find_contact", arguments: { name: "Ana" } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined, "no structured content to check against the schema");
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.error, "NOT_CONNECTED");
    assert.ok(body.message && body.fix);
  } finally {
    home.storageState = "ready";
  }
});

test("a tool without an outputSchema keeps its structured error", async () => {
  home.status = "disconnected";
  try {
    const result = await client.callTool({ name: "manage_chat", arguments: { chat_id: ANA, action: "mark_read" } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error, "NOT_CONNECTED");
    assert.equal(result.structuredContent.account_id, "default");
  } finally {
    home.status = "connected";
  }
});

test("the five tools Calfa calls declare no outputSchema", () => {
  // Calfa (test/calfa-contract.test.mjs) reads structuredContent.error on these
  // tools' failures. A tool with an outputSchema answers errors as text only, so
  // giving any of them one would break Calfa's error handling: change Calfa first.
  for (const name of ["send_message", "confirm_send", "manage_chat", "link_account", "get_status"]) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, `${name} is registered`);
    assert.equal(tool.outputSchema, undefined, `${name} must not declare an outputSchema`);
  }
});
