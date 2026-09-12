/**
 * Phase 3: account_id resolution on every tool. Given id, single account,
 * unique chat/message, write vs read on an unknown chat, list_accounts,
 * get_status shape, per-account writes gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AccountHub } from "../dist/account-hub.js";
import { AccountRegistry } from "../dist/accounts.js";
import { ERROR_GUIDE } from "../dist/errors.js";
import { anyAccountAllowsWrites, registerTools } from "../dist/tools.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { asToolSource, connectedService, fakeSocket, offlineConfig } from "./helpers.mjs";

const HOME = "40700000001@s.whatsapp.net";
const WORK = "40700000002@s.whatsapp.net";
const ANA = "40700000003@s.whatsapp.net";
const DAN = "40700000004@s.whatsapp.net";
const STRANGER = "40700000099@s.whatsapp.net";

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, meta, handler) {
      tools.set(name, { meta, handler });
    },
  };
}

function connect(svc, { id, name }) {
  const sock = fakeSocket();
  svc.sockClient = sock;
  svc.wireEvents(sock, ++svc.generation);
  svc.account = { id, name, number: id.split("@")[0] };
  svc.status = "connected";
  svc.initialSyncDone = true;
  return sock;
}

function twoAccountHub({ workWrites, disableWork, defaultWrites } = {}) {
  const config = offlineConfig("wazap-resolve-", { readOnly: false, rateLimitPerMinute: 20 });
  const registry = AccountRegistry.load(config.dataDir);
  registry.add("work", "Work");
  if (defaultWrites === false) registry.setWrites("default", false);
  if (workWrites === false) registry.setWrites("work", false);
  if (disableWork) registry.disable("work");
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  const home = hub.get("default");
  const work = hub.get("work");
  const homeSock = home ? connect(home, { id: HOME, name: "Home" }) : null;
  const workSock = work ? connect(work, { id: WORK, name: "Work" }) : null;
  return { hub, home, work, homeSock, workSock, config };
}

function message(chat, text, { id = "M1", fromMe = false } = {}) {
  return {
    key: { remoteJid: chat, fromMe, id },
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

function toolsOf(source, allowWrite = true) {
  const hub = asToolSource(source);
  const server = fakeServer();
  registerTools(server, hub, { allowWrite: allowWrite && anyAccountAllowsWrites(hub) });
  return server.tools;
}

test("given account_id uses that account", async () => {
  const { hub, homeSock, workSock } = twoAccountHub();
  homeSock.ev.emit("chats.upsert", [{ id: ANA, conversationTimestamp: Math.floor(Date.now() / 1000) }]);
  workSock.ev.emit("chats.upsert", [{ id: DAN, conversationTimestamp: Math.floor(Date.now() / 1000) }]);
  const tools = toolsOf(hub);
  const home = await tools.get("read_messages").handler({ chat_id: ANA, limit: 20, account_id: "default" });
  const work = await tools.get("read_messages").handler({ chat_id: DAN, limit: 20, account_id: "work" });
  assert.equal(home.structuredContent.account_id, "default");
  assert.equal(work.structuredContent.account_id, "work");
});

test("unknown account_id is ACCOUNT_NOT_FOUND; disabled is ACCOUNT_DISABLED", async () => {
  const { hub } = twoAccountHub({ disableWork: true });
  const tools = toolsOf(hub);
  const missing = await tools.get("read_messages").handler({ chat_id: ANA, limit: 20, account_id: "ghost" });
  assert.equal(missing.structuredContent.error, "ACCOUNT_NOT_FOUND");
  assert.equal(missing.structuredContent.account_id, "ghost");
  const disabled = await tools.get("read_messages").handler({ chat_id: ANA, limit: 20, account_id: "work" });
  assert.equal(disabled.structuredContent.error, "ACCOUNT_DISABLED");
  assert.match(disabled.structuredContent.message, /work/);
});

test("link_account on an unknown id tells the user to run wazap account add", async () => {
  const { hub } = twoAccountHub();
  const tools = toolsOf(hub);
  const result = await tools.get("link_account").handler({ phone: "+15550100", account_id: "sales" });
  assert.equal(result.structuredContent.error, "ACCOUNT_NOT_FOUND");
  assert.match(result.structuredContent.fix, /wazap account add/);
});

test("an account added after the hub started asks for a restart, not another add", async () => {
  const config = offlineConfig("wazap-resolve-late-", { readOnly: false });
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  // The hub snapshotted one account; this one lands on disk afterwards.
  AccountRegistry.load(config.dataDir).add("work");
  const tools = toolsOf(hub);
  const result = await tools.get("link_account").handler({ phone: "+15550100", account_id: "work" });
  assert.equal(result.structuredContent.error, "ACCOUNT_NOT_FOUND");
  assert.match(result.structuredContent.message, /added after this server started/);
  assert.match(result.structuredContent.fix, /[Rr]estart/);
});

test("an account added disabled after the hub started asks to enable, then restart", async () => {
  const config = offlineConfig("wazap-resolve-late-off-", { readOnly: false });
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  const fresh = AccountRegistry.load(config.dataDir);
  fresh.add("work");
  fresh.disable("work");
  const tools = toolsOf(hub);
  // read_messages, not link_account: the link tool's process-wide rate bucket
  // is spent by the tests above.
  const result = await tools.get("read_messages").handler({ chat_id: ANA, limit: 20, account_id: "work" });
  assert.equal(result.structuredContent.error, "ACCOUNT_NOT_FOUND");
  assert.match(result.structuredContent.fix, /account enable work/);
  assert.match(result.structuredContent.fix, /restart/);
});

test("a link settles the owner on the record, on disk and in the snapshot", async () => {
  const config = offlineConfig("wazap-resolve-owner-");
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  const jid = "40700000001:12@s.whatsapp.net";
  // What adoptLink fires once the pairing socket resolves.
  hub.get("default").onLinked({ id: jid, name: "Home", number: "40700000001" });
  assert.equal(AccountRegistry.load(config.dataDir).get("default").owner, jid);
  assert.equal(hub.record("default").owner, jid);
});

test("a single enabled account is used even without account_id", async () => {
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-resolve-one-",
    id: HOME,
    name: "Răzvan",
    config: { readOnly: false },
  });
  const tools = toolsOf(svc);
  const result = await tools.get("list_chats").handler({ filter: "all", limit: 20 });
  assert.equal(result.structuredContent.account_id, "default");
});

test("a chat or message only one account knows selects that account", async () => {
  const { hub, homeSock, workSock } = twoAccountHub();
  homeSock.ev.emit("chats.upsert", [{ id: ANA, conversationTimestamp: Math.floor(Date.now() / 1000) }]);
  workSock.ev.emit("chats.upsert", [{ id: DAN, conversationTimestamp: Math.floor(Date.now() / 1000) }]);
  homeSock.ev.emit("messages.upsert", { type: "notify", messages: [message(ANA, "from home", { id: "H1" })] });
  workSock.ev.emit("messages.upsert", { type: "notify", messages: [message(DAN, "from work", { id: "W1" })] });
  const tools = toolsOf(hub);

  const ana = await tools.get("read_messages").handler({ chat_id: ANA, limit: 20 });
  assert.equal(ana.structuredContent.account_id, "default");
  const dan = await tools.get("read_messages").handler({ chat_id: DAN, limit: 20 });
  assert.equal(dan.structuredContent.account_id, "work");

  const homeMsg = await tools.get("get_message").handler({ message_id: `false_${ANA}_H1` });
  assert.equal(homeMsg.structuredContent.account_id, "default");
  const workMsg = await tools.get("get_message").handler({ message_id: `false_${DAN}_W1` });
  assert.equal(workMsg.structuredContent.account_id, "work");
});

test("a chat both accounts know is AMBIGUOUS_ACCOUNT naming them", async () => {
  const { hub, homeSock, workSock } = twoAccountHub();
  homeSock.ev.emit("chats.upsert", [{ id: ANA, conversationTimestamp: Math.floor(Date.now() / 1000) }]);
  workSock.ev.emit("chats.upsert", [{ id: ANA, conversationTimestamp: Math.floor(Date.now() / 1000) }]);
  const tools = toolsOf(hub);
  const result = await tools.get("read_messages").handler({ chat_id: ANA, limit: 20 });
  assert.equal(result.structuredContent.error, "AMBIGUOUS_ACCOUNT");
  assert.match(result.structuredContent.message, /default/);
  assert.match(result.structuredContent.message, /work/);
  assert.match(result.structuredContent.fix, /account_id/);
});

test("an unknown chat with two accounts: writes AMBIGUOUS, reads use default", async () => {
  const { hub } = twoAccountHub();
  const tools = toolsOf(hub);
  const sent = await tools.get("send_message").handler({ chat_id: STRANGER, text: "hi" });
  assert.equal(sent.structuredContent.error, "AMBIGUOUS_ACCOUNT");
  assert.match(sent.structuredContent.fix, /account_id/);

  const read = await tools.get("read_messages").handler({ chat_id: STRANGER, limit: 20 });
  assert.equal(read.isError, undefined);
  assert.equal(read.structuredContent.account_id, "default");
});

test("list_accounts lists every configured account", async () => {
  const { hub } = twoAccountHub({ workWrites: false });
  const tools = toolsOf(hub);
  const result = await tools.get("list_accounts").handler({});
  assert.equal(result.structuredContent.count, 2);
  assert.equal(result.structuredContent.default, "default");
  assert.deepEqual(
    result.structuredContent.accounts.map((row) => row.id),
    ["default", "work"],
  );
  assert.equal(result.structuredContent.accounts[0].write_tools, true);
  assert.equal(result.structuredContent.accounts[1].write_tools, false);
  assert.equal(result.structuredContent.account_id, "default");
  assert.match(result.content[0].text, /default/);
  assert.match(result.content[0].text, /work/);
});

test("get_status keeps today's top-level fields on a single account and adds accounts[]", async () => {
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-resolve-status-",
    id: HOME,
    name: "Răzvan",
    config: { readOnly: false },
  });
  const tools = toolsOf(svc, true);
  const result = await tools.get("get_status").handler({});
  const body = result.structuredContent;
  assert.equal(body.status, "connected");
  assert.equal(body.account_id, "default");
  assert.equal(body.write_tools, true);
  assert.equal(body.read_only, false);
  assert.ok(body.status_since);
  assert.ok("sync" in body);
  assert.ok("contacts_named" in body);
  assert.ok("data_dir" in body);
  assert.ok(Array.isArray(body.accounts));
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].id, "default");
  assert.equal(body.accounts[0].status, "connected");
  assert.equal(typeof body.accounts[0].phone_masked, "string");
  assert.equal(body.accounts[0].owner_name, "Răzvan");
  assert.ok(!result.content[0].text.includes("**accounts**:"), "single-account text stays as today");
});

test("get_status on two accounts keeps the default on top and lists both", async () => {
  const { hub } = twoAccountHub({ workWrites: false });
  const tools = toolsOf(hub);
  const result = await tools.get("get_status").handler({});
  assert.equal(result.structuredContent.account_id, "default");
  assert.equal(result.structuredContent.write_tools, true, "session write tools, not work's policy");
  assert.deepEqual(
    result.structuredContent.accounts.map((row) => row.id),
    ["default", "work"],
  );
  assert.equal(result.structuredContent.accounts[1].write_tools, false);
  assert.match(result.content[0].text, /accounts.*default, work/);
});

test("list_chats without a locator uses the default account", async () => {
  const { hub } = twoAccountHub();
  const tools = toolsOf(hub);
  const result = await tools.get("list_chats").handler({ filter: "all", limit: 20 });
  assert.equal(result.structuredContent.account_id, "default");
});

test("contact_id and group_id unique to work select work", async () => {
  const { hub, workSock } = twoAccountHub();
  const group = "120363000000000001@g.us";
  workSock.ev.emit("chats.upsert", [
    { id: ANA, conversationTimestamp: Math.floor(Date.now() / 1000) },
    { id: group, conversationTimestamp: Math.floor(Date.now() / 1000) },
  ]);
  const tools = toolsOf(hub);
  const contact = await tools.get("get_contact").handler({ contact_id: ANA });
  assert.equal(contact.structuredContent.account_id, "work");
  const info = await tools.get("get_group_info").handler({ group_id: group });
  assert.equal(info.structuredContent.account_id, "work");
});

test("confirm_send finds a draft stored on work", async () => {
  const { hub, workSock } = twoAccountHub();
  workSock.ev.emit("chats.upsert", [{ id: DAN, conversationTimestamp: Math.floor(Date.now() / 1000) }]);
  workSock.ev.emit("contacts.upsert", [{ id: DAN, name: "Dan" }]);
  workSock.sendMessage = async () => undefined;
  const tools = toolsOf(hub);
  const drafted = await tools.get("send_message").handler({ chat_id: DAN, text: "hi" });
  assert.equal(drafted.structuredContent.account_id, "work");
  const draftId = drafted.structuredContent.draft_id;
  assert.equal(typeof draftId, "string");
  const sent = await tools.get("confirm_send").handler({ draft_id: draftId });
  assert.equal(sent.isError, undefined);
  assert.equal(sent.structuredContent.account_id, "work");
});

test("list_accounts ignores a bad account_id and still lists a disabled row", async () => {
  const { hub } = twoAccountHub({ disableWork: true });
  const tools = toolsOf(hub);
  const result = await tools.get("list_accounts").handler({ account_id: "ghost" });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.count, 2);
  assert.deepEqual(
    result.structuredContent.accounts.map((row) => row.id),
    ["default", "work"],
  );
  assert.equal(result.structuredContent.accounts[1].status, "disabled");
  assert.equal(result.structuredContent.accounts[1].enabled, false);
  assert.equal(result.structuredContent.account_id, "default");
});

test("list_accounts shows the persisted owner of an account with no live socket, masked", async () => {
  const config = offlineConfig("wazap-resolve-listed-");
  const registry = AccountRegistry.load(config.dataDir);
  registry.add("work", "Work");
  registry.setOwner("work", "40700000002:9@s.whatsapp.net");
  registry.disable("work");
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  const tools = toolsOf(hub);
  const result = await tools.get("list_accounts").handler({});
  const work = result.structuredContent.accounts[1];
  assert.equal(work.enabled, false);
  assert.equal(work.phone_masked, "+40 7xx xxx xxx");
  assert.match(result.content[0].text, /\+40 7xx xxx xxx/);
});

test("write tools stay unregistered when every enabled account is read-only", () => {
  const { hub } = twoAccountHub({ workWrites: false, defaultWrites: false });
  assert.equal(anyAccountAllowsWrites(hub), false);
  const tools = toolsOf(hub);
  assert.equal(tools.has("send_message"), false);
  assert.ok(tools.has("list_accounts"));
});

test("ACCOUNT_NOT_CONNECTED is not an error code", () => {
  assert.equal("ACCOUNT_NOT_CONNECTED" in ERROR_GUIDE, false);
});

test("write tools register when any account allows writes; beginWrite names the read-only one", async () => {
  const { hub } = twoAccountHub({ workWrites: false });
  assert.equal(anyAccountAllowsWrites(hub), true);
  const tools = toolsOf(hub);
  assert.ok(tools.has("send_message"));
  assert.ok(tools.has("manage_chat"));
  const refused = await tools.get("manage_chat").handler({ chat_id: DAN, action: "pin", account_id: "work" });
  assert.equal(refused.structuredContent.error, "READ_ONLY");
  assert.match(refused.structuredContent.message, /work/);
  assert.equal(refused.structuredContent.account_id, "work");
});
