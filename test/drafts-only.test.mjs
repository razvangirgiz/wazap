/**
 * Drafts-only mode: the agent drafts, and a send happens only on a person's
 * approval, which no tool of the agent's session can give. The account here is
 * a real service over a fake socket: "sent" means handed to the fake relay,
 * and nothing reaches WhatsApp.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { singletonSource } from "../dist/account-hub.js";
import { Approvals, approveUrl, parseDraftId } from "../dist/approvals.js";
import { draftsOnlySetting, parseCli } from "../dist/config.js";
import { CONTROL_ROUTES, startControlEndpoint } from "../dist/control.js";
import { APPROVAL_TTL_MS, sendYourselfUrl } from "../dist/drafts.js";
import { skillInstructions } from "../dist/skills.js";
import { registerTools } from "../dist/tools.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { BINARY, childEnv, connectedService, mcpClient, spawnWazap } from "./helpers.mjs";

const run = promisify(execFile);
const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const PUBLIC = "https://wazap.example";

function serviceOn(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-drafts-only-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const connected = connectedService(WhatsAppService, {
    prefix: "wazap-drafts-only-",
    id: ME,
    name: "Răzvan",
    config: { dataDir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0 },
  });
  t.after(() => connected.svc.stop());
  connected.sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
  connected.sent = [];
  connected.sock.relayMessage = async (jid, message, options) => {
    connected.sent.push({ jid, message });
    return options.messageId;
  };
  return connected;
}

/** The svc as an account source whose record on disk the test can change. */
function hubOf(svc, record = {}) {
  const hub = singletonSource(svc);
  const base = hub.recordOnDisk(hub.defaultBinding().id);
  const live = { ...base, ...record };
  hub.recordOnDisk = () => live;
  hub.record = () => live;
  return { hub, live };
}

function toolsOf(hub, opts) {
  const tools = new Map();
  registerTools({ registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) }, hub, opts);
  return tools;
}

test("a drafts-only session has send_message and no tool that sends, edits, deletes or changes a chat", (t) => {
  const { svc } = serviceOn(t);
  const { hub } = hubOf(svc);
  const writer = [...toolsOf(hub, { allowWrite: true }).keys()];
  const drafter = [...toolsOf(hub, { allowWrite: true, approval: { publicUrl: PUBLIC } }).keys()];
  assert.ok(drafter.includes("send_message"));
  for (const name of ["confirm_send", "edit_message", "delete_message", "react_to_message", "manage_chat", "manage_group"]) {
    assert.ok(writer.includes(name), name);
    assert.ok(!drafter.includes(name), `${name} acts without the person`);
  }
  assert.deepEqual(
    drafter.filter((name) => !writer.includes(name)),
    [],
    "drafts-only only takes tools away"
  );
});

test("a drafts-only draft says it is not sent, links the approval page, the CLI and wa.me, and lives a day", async (t) => {
  const { svc, sent } = serviceOn(t);
  const { hub } = hubOf(svc);
  const tools = toolsOf(hub, { allowWrite: true, approval: { publicUrl: PUBLIC } });
  const before = Date.now();
  const result = await tools.get("send_message").handler({ chat_id: PEER, text: "Ne vedem joi & vineri?" });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const view = result.structuredContent;
  assert.equal(view.approval_required, true);
  assert.equal(view.approve_url, approveUrl(PUBLIC, view.draft_id));
  assert.equal(view.approve_command, `wazap drafts approve ${view.draft_id}`);
  assert.equal(view.send_yourself_url, `https://wa.me/40700000002?text=${encodeURIComponent("Ne vedem joi & vineri?")}`);
  assert.ok(Date.parse(view.expires_at) >= before + APPROVAL_TTL_MS - 5_000);
  assert.match(result.content[0].text, /Not sent, and this connection cannot send it/);
  assert.match(view.next, /never ask for the wazap password/);
  assert.deepEqual(sent, [], "a draft sends nothing");
});

test("without sign-in there is no approval page to link, and the other two ways remain", async (t) => {
  const { svc } = serviceOn(t);
  const { hub } = hubOf(svc);
  const result = await toolsOf(hub, { allowWrite: true, approval: { publicUrl: null } }).get("send_message").handler({ chat_id: PEER, text: "Salut" });
  assert.equal(result.structuredContent.approve_url, undefined);
  assert.match(result.content[0].text, /wazap drafts approve d_/);
  assert.match(result.content[0].text, /wa\.me/);
});

test("a person's approval sends the draft once; a second approval answers the receipt and sends nothing", async (t) => {
  const { svc, sent } = serviceOn(t);
  const { hub } = hubOf(svc);
  const tools = toolsOf(hub, { allowWrite: true, approval: { publicUrl: PUBLIC } });
  const draftId = (await tools.get("send_message").handler({ chat_id: PEER, text: "Joi la 10." })).structuredContent.draft_id;
  const approvals = new Approvals(hub, { readOnly: false });
  assert.deepEqual(approvals.list().map((entry) => entry.draft_id), [draftId]);

  const [first, second] = await Promise.all([approvals.approve(draftId), approvals.approve(draftId)]);
  assert.equal(sent.length, 1, "two approvals at once, one send");
  assert.equal(first.receipt.message_id, second.receipt.message_id);
  const third = await approvals.approve(draftId);
  assert.equal(third.receipt.already_sent, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(approvals.list(), [], "nothing waits once it is sent");
});

test("send rules written while a draft waits refuse its approval; so does writes turned off", async (t) => {
  const { svc, sent } = serviceOn(t);
  const { hub, live } = hubOf(svc);
  const tools = toolsOf(hub, { allowWrite: true, approval: { publicUrl: null } });
  const draftId = (await tools.get("send_message").handler({ chat_id: PEER, text: "Salut" })).structuredContent.draft_id;

  live.send_deny = ["40700000002"];
  await assert.rejects(new Approvals(hub, { readOnly: false }).approve(draftId), (err) => err.code === "SEND_BLOCKED");
  delete live.send_deny;
  await assert.rejects(new Approvals(hub, { readOnly: true }).approve(draftId), (err) => err.code === "READ_ONLY");
  live.writes = false;
  await assert.rejects(new Approvals(hub, { readOnly: false }).approve(draftId), (err) => err.code === "READ_ONLY");
  assert.deepEqual(sent, []);
});

test("a discarded draft is gone for good: approving it afterwards sends nothing", async (t) => {
  const { svc, sent } = serviceOn(t);
  const { hub } = hubOf(svc);
  const draftId = (await toolsOf(hub, { allowWrite: true, approval: { publicUrl: null } }).get("send_message").handler({ chat_id: PEER, text: "x" })).structuredContent.draft_id;
  const approvals = new Approvals(hub, { readOnly: false });
  approvals.discard(draftId);
  await assert.rejects(approvals.approve(draftId), (err) => err.code === "DRAFT_NOT_FOUND");
  assert.deepEqual(sent, []);
});

test("only well-formed draft ids reach a lookup", () => {
  assert.equal(parseDraftId("d_0123456789abcdef"), "d_0123456789abcdef");
  for (const bad of ["d_0123", "../x", "D_0123456789ABCDEF", 42, undefined]) assert.throws(() => parseDraftId(bad), /not a draft id/);
});

test("wa.me links: a direct chat by its number, a group through the chat picker, nothing for media", () => {
  const text = { kind: "text", chatId: PEER, text: "a b?" };
  assert.equal(sendYourselfUrl({ chat_id: PEER, name: "x", number: "+40700000002" }, text), "https://wa.me/40700000002?text=a%20b%3F");
  assert.equal(sendYourselfUrl({ chat_id: "1203@g.us", name: "g" }, text), "https://wa.me/?text=a%20b%3F");
  assert.equal(sendYourselfUrl({ chat_id: PEER, name: "x" }, { kind: "poll", chatId: PEER, question: "q", options: ["a", "b"], multiSelect: false }), null);
});

test("the control line approves only with its token, and only drafts it was given", async (t) => {
  const token = randomBytes(32).toString("hex");
  const calls = [];
  const approvals = {
    list: () => [],
    find: () => null,
    approve: async (id) => {
      calls.push(id);
      return { account_id: "default", receipt: { message_id: "m", chat_id: PEER, text: "x", timestamp: "t" } };
    },
    discard: () => ({ account_id: "default" }),
  };
  const stop = new AbortController();
  t.after(() => stop.abort());
  const port = await startControlEndpoint({}, token, stop.signal, approvals);
  const post = (body, auth = token) =>
    fetch(`http://127.0.0.1:${port}${CONTROL_ROUTES.approve}`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ draft_id: "d_0123456789abcdef" }, "wrong")).status, 401);
  assert.equal((await post({ draft_id: "../../x" })).status, 409);
  const ok = await post({ draft_id: "d_0123456789abcdef" });
  assert.equal(ok.status, 200);
  assert.deepEqual(calls, ["d_0123456789abcdef"]);
});

test("the setting: --drafts-only, WAZAP_DRAFTS_ONLY, and nothing guessed from a typo", () => {
  assert.equal(draftsOnlySetting(undefined), false);
  assert.equal(draftsOnlySetting("1"), true);
  assert.equal(draftsOnlySetting("off"), false);
  assert.throws(() => draftsOnlySetting("maybe"), /WAZAP_DRAFTS_ONLY must be a boolean/);
  const dir = mkdtempSync(join(tmpdir(), "wazap-drafts-cli-"));
  const { config } = parseCli(["serve", "--drafts-only", "--data-dir", dir]);
  assert.equal(config.draftsOnly, true);
  const login = parseCli(["login", "--drafts-only", "--data-dir", dir]).config;
  assert.equal(login.writesAnswer, "drafts");
});

test("the instructions a drafts-only session reads say it cannot send", () => {
  const text = skillInstructions([], { allowWrite: true, draftsOnly: true });
  assert.match(text, /drafts only/);
  assert.match(text, /Never ask for the wazap password/);
  assert.doesNotMatch(skillInstructions([], { allowWrite: true }), /drafts only/);
});

test("`wazap config writes drafts` stores it, `writes on` clears it, and `config` says which", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-drafts-config-"));
  const wazap = (...args) => run(process.execPath, [BINARY, ...args, "--data-dir", dataDir], { env: childEnv() });
  const set = await wazap("config", "writes", "drafts");
  assert.match(set.stderr, /writes: drafts only/);
  const env = readFileSync(join(dataDir, ".env"), "utf8");
  assert.match(env, /^WAZAP_DRAFTS_ONLY=1$/m);
  assert.match(env, /^WAZAP_READ_ONLY=0$/m);
  assert.match((await wazap("config")).stderr, /writes: drafts only \(a person approves each send\) \(\.env\)/);
  await wazap("config", "writes", "on");
  assert.doesNotMatch(readFileSync(join(dataDir, ".env"), "utf8"), /WAZAP_DRAFTS_ONLY/);
  assert.match((await wazap("config")).stderr, /writes: on/);
});

test("`wazap drafts` with no server running says what to start, and sends nothing", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-drafts-none-"));
  await assert.rejects(
    run(process.execPath, [BINARY, "drafts", "approve", "d_0123456789abcdef", "--yes", "--data-dir", dataDir], { env: childEnv() }),
    (err) => {
      assert.match(err.stderr, /No wazap server is running/);
      assert.match(err.stderr, /wazap service start/);
      return true;
    }
  );
});

test("WAZAP_DRAFTS_ONLY=1 reaches the stdio server an MCP client launches: send_message, and no confirm_send", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-drafts-stdio-"));
  const { child } = spawnWazap({ dataDir, args: ["serve"], env: { WAZAP_DRAFTS_ONLY: "1", WAZAP_NO_SHARE: "1" } });
  t.after(() => child.kill("SIGKILL"));
  const { request, notify } = mcpClient(child);
  const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.match(init.result.instructions, /drafts only/);
  notify("notifications/initialized");
  const names = (await request("tools/list", {})).result.tools.map((tool) => tool.name);
  assert.ok(names.includes("send_message"));
  assert.ok(!names.includes("confirm_send"));
  assert.ok(!names.includes("manage_chat"));
});

test("a drafts-only session cannot draft what the approval page cannot show in full: files and forwards", async (t) => {
  const { svc, sent } = serviceOn(t);
  const { hub } = hubOf(svc);
  const send = toolsOf(hub, { allowWrite: true, approval: { publicUrl: PUBLIC } }).get("send_message").handler;
  const file = await send({ chat_id: PEER, text: "", url: "https://example.com/cat.jpg" });
  assert.equal(file.isError, true);
  assert.match(file.content[0].text, /cannot be shown in full/);
  const forward = await send({ chat_id: PEER, text: "", forward: "m_0123" });
  assert.equal(forward.isError, true);
  assert.match(forward.content[0].text, /forward cannot be shown in full/);
  const poll = await send({ chat_id: PEER, text: "Pizza?", options: ["da", "nu"] });
  assert.equal(poll.structuredContent.approval_required, true, "a poll is shown whole, so it is drafted");
  assert.deepEqual(sent, []);
});
