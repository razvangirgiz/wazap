import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { singletonSource } from "../dist/account-hub.js";
import { AccountRegistry } from "../dist/accounts.js";
import { paths } from "../dist/config.js";
import { DraftStore } from "../dist/drafts.js";
import {
  assertSendable,
  draftTargetOf,
  forgetDraftTarget,
  hasSendRules,
  normalizeSendRule,
  noteDraftTarget,
  sendPolicyOf,
} from "../dist/send-guard.js";
import { registerTools } from "../dist/tools.js";
import { childEnv } from "./helpers.mjs";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function dataDir() {
  return mkdtempSync(join(tmpdir(), "wazap-send-guard-"), { mode: 0o700 });
}

function wazap(dir, args) {
  return run(process.execPath, [binary, ...args, "--data-dir", dir], { env: childEnv() });
}

const ANA = { chat_id: "40722123456@s.whatsapp.net", name: "Ana", number: "40722123456" };
const BLOC = { chat_id: "120363000000000001@g.us", name: "Bloc 12" };

test("normalizeSendRule keeps jids and reduces phone inputs to digits", () => {
  assert.equal(normalizeSendRule("+40 722 123 456"), "40722123456");
  assert.equal(normalizeSendRule("+1 (555) 010-0"), "15550100");
  assert.equal(normalizeSendRule("40722123456"), "40722123456");
  assert.equal(normalizeSendRule(" 120363000000000001@g.us "), "120363000000000001@g.us");
  assert.equal(normalizeSendRule("40722123456:9@s.whatsapp.net"), "40722123456@s.whatsapp.net");
  assert.equal(normalizeSendRule("40722123456@S.WHATSAPP.NET"), "40722123456@s.whatsapp.net");
});

test("normalizeSendRule refuses what is not an address", () => {
  for (const bad of ["Ana", "", "  ", "@g.us", "12", "call me maybe"]) {
    assert.throws(
      () => normalizeSendRule(bad),
      (err) => err.code === "INVALID_ID",
      bad
    );
  }
});

test("an open policy lets any target through", () => {
  assertSendable(sendPolicyOf(undefined), ANA, "default");
  assertSendable({ allow: null, deny: [] }, BLOC, "default");
});

test("a deny entry blocks by digits or by jid, and names the rule that fired", () => {
  for (const deny of [["+40 722 123 456"], ["40722123456@s.whatsapp.net"]]) {
    assert.throws(
      () => assertSendable({ allow: null, deny }, ANA, "default"),
      (err) => {
        assert.equal(err.code, "SEND_BLOCKED");
        assert.match(err.message, /account "default"/);
        assert.match(err.message, /denied by/);
        assert.match(err.fix, /wazap config send/);
        return true;
      }
    );
  }
});

test("a present allowlist refuses what it does not list", () => {
  assertSendable({ allow: ["40722123456"], deny: [] }, ANA, "default");
  assertSendable({ allow: ["40722123456@s.whatsapp.net"], deny: [] }, ANA, "default");
  assertSendable({ allow: ["120363000000000001@g.us"], deny: [] }, BLOC, "default");
  assert.throws(
    () => assertSendable({ allow: ["15550100"], deny: [] }, ANA, "default"),
    (err) => {
      assert.equal(err.code, "SEND_BLOCKED");
      assert.match(err.message, /not on the send allowlist/);
      assert.match(err.message, /"Ana" <40722123456@s\.whatsapp\.net>/);
      return true;
    }
  );
});

test("an empty allowlist is default-deny: nobody is sendable", () => {
  for (const to of [ANA, BLOC]) {
    assert.throws(() => assertSendable({ allow: [], deny: [] }, to, "default"), { code: "SEND_BLOCKED" });
  }
});

test("deny wins over allow", () => {
  assert.throws(
    () => assertSendable({ allow: ["40722123456"], deny: ["40722123456@s.whatsapp.net"] }, ANA, "default"),
    { code: "SEND_BLOCKED" }
  );
});

test("the number rides along when the chat_id cannot match, as with a @lid", () => {
  const lid = { chat_id: "100000000000001@lid", name: "Ana", number: "40722123456" };
  assertSendable({ allow: ["40722123456"], deny: [] }, lid, "default");
  assert.throws(() => assertSendable({ allow: null, deny: ["40722123456"] }, lid, "default"), {
    code: "SEND_BLOCKED",
  });
});

test("sendPolicyOf maps an absent allowlist to open and a present one to exhaustive", () => {
  assert.deepEqual(sendPolicyOf(undefined), { allow: null, deny: [] });
  assert.equal(hasSendRules(sendPolicyOf(undefined)), false);
  assert.equal(hasSendRules(sendPolicyOf({ send_deny: [] })), false);
  assert.equal(hasSendRules(sendPolicyOf({ send_allow: [] })), true);
  assert.equal(hasSendRules(sendPolicyOf({ send_deny: ["40722123456"] })), true);
});

test("noteDraftTarget records the resolved recipient so confirm can re-check it", () => {
  const store = new DraftStore();
  const view = store.view(store.put(ANA, { kind: "text", chatId: ANA.chat_id, text: "hi" }));
  noteDraftTarget(view, "default");
  const ref = draftTargetOf(view.draft_id);
  assert.equal(ref.accountId, "default");
  assert.equal(ref.target.chat_id, ANA.chat_id);
  forgetDraftTarget(view.draft_id);
  assert.equal(draftTargetOf(view.draft_id), undefined);
});

test("setSendRules normalizes, persists through a reload, and null drops a list", () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  registry.setSendRules("default", { allow: ["+40 722 123 456"], deny: ["120363000000000001@g.us"] });
  const loaded = AccountRegistry.load(dir).get("default");
  assert.deepEqual(loaded.send_allow, ["40722123456"]);
  assert.deepEqual(loaded.send_deny, ["120363000000000001@g.us"]);

  AccountRegistry.load(dir).setSendRules("default", { deny: null });
  const after = AccountRegistry.load(dir).get("default");
  assert.equal(after.send_deny, undefined);
  assert.deepEqual(after.send_allow, ["40722123456"]);
});

test("setSendRules refuses a non-address and persists nothing", () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  assert.throws(() => registry.setSendRules("default", { allow: ["Ana"] }), { code: "INVALID_ID" });
  assert.equal(AccountRegistry.load(dir).get("default").send_allow, undefined);
});

test("bad send rules in accounts.json are refused at load, naming the field", () => {
  for (const field of ["send_allow", "send_deny"]) {
    const dir = dataDir();
    writeFileSync(
      paths(dir).accountsFile,
      JSON.stringify({
        v: 2,
        default: "default",
        accounts: [{ id: "default", name: "default", enabled: true, owner: null, [field]: "40722123456" }],
      })
    );
    assert.throws(
      () => AccountRegistry.load(dir),
      (err) => {
        assert.equal(err.code, "INVALID_ID");
        assert.match(err.message, new RegExp(`Account "default".*${field}`));
        return true;
      }
    );
  }

  const dir = dataDir();
  writeFileSync(
    paths(dir).accountsFile,
    JSON.stringify({
      v: 2,
      default: "default",
      accounts: [{ id: "default", name: "default", enabled: true, owner: null, send_deny: ["Ana"] }],
    })
  );
  assert.throws(
    () => AccountRegistry.load(dir),
    (err) => {
      assert.equal(err.code, "INVALID_ID");
      assert.match(err.message, /send_deny entry/);
      assert.ok(!err.message.includes('"Ana"'), "invalid rule contents are not echoed");
      return true;
    }
  );
});

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

/**
 * A tool source whose account record is re-read on every call, the way
 * AccountHub re-reads accounts.json: `rules` is the object the test edits to
 * play the operator writing rules while a draft waits.
 */
function ruledSource(wa, rules) {
  const src = singletonSource(wa);
  const base = { id: "default", name: "default", enabled: true, owner: null };
  const current = () => ({ ...base, ...rules });
  src.record = (id) => (id === base.id ? current() : undefined);
  src.recordOnDisk = src.record;
  return src;
}

function draftApi(calls, confirm) {
  const store = new DraftStore();
  return {
    draft: async (payload) => {
      calls.drafts += 1;
      return store.view(store.put(ANA, payload));
    },
    confirm: async (id) => {
      calls.confirms += 1;
      const draft = store.take(id);
      if (confirm) return confirm(draft);
      const text = draft.payload.kind === "text" ? draft.payload.text : "";
      return { message_id: "mid", chat_id: draft.to.chat_id, text, timestamp: "now" };
    },
  };
}

test("an allowlisted send drafts and confirms", async () => {
  const server = fakeServer();
  const calls = { drafts: 0, confirms: 0 };
  const wa = draftApi(calls);
  registerTools(server, ruledSource(wa, { send_allow: ["+40 722 123 456"] }), { allowWrite: true });

  const drafted = await server.tools.get("send_message").handler({ chat_id: "+40722123456", text: "Joi la 10." });
  assert.equal(drafted.structuredContent.status, "draft");
  assert.equal(calls.drafts, 1);

  const confirmed = await server.tools.get("confirm_send").handler({ draft_id: drafted.structuredContent.draft_id });
  assert.equal(confirmed.structuredContent.message_id, "mid");
  assert.match(confirmed.content[0].text, /Sent to Ana \(\+40 722 123 456\)/);
});

test("a denied send fails at draft time, before the socket is asked", async () => {
  const server = fakeServer();
  const calls = { drafts: 0, confirms: 0 };
  const wa = draftApi(calls);
  registerTools(server, ruledSource(wa, { send_deny: ["40722123456"] }), { allowWrite: true });

  const result = await server.tools.get("send_message").handler({ chat_id: "+40722123456", text: "hi" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "SEND_BLOCKED");
  assert.match(result.structuredContent.message, /denied by "40722123456"/);
  assert.equal(calls.drafts, 0, "the draft must not be created");
});

test("an unlisted send under an allowlist fails at draft time", async () => {
  const server = fakeServer();
  const calls = { drafts: 0, confirms: 0 };
  const wa = draftApi(calls);
  registerTools(server, ruledSource(wa, { send_allow: ["15550100"] }), { allowWrite: true });

  const result = await server.tools.get("send_poll").handler({
    chat_id: "+40722123456",
    question: "Pizza?",
    options: ["da", "nu"],
  });
  assert.equal(result.structuredContent.error, "SEND_BLOCKED");
  assert.match(result.structuredContent.message, /not on the send allowlist/);
  assert.equal(calls.drafts, 0);
});

test("a rule written after drafting still blocks at confirm_send", async () => {
  const server = fakeServer();
  const calls = { drafts: 0, confirms: 0 };
  const rules = {};
  const wa = draftApi(calls);
  registerTools(server, ruledSource(wa, rules), { allowWrite: true });

  const drafted = await server.tools.get("send_message").handler({ chat_id: "+40722123456", text: "hi" });
  assert.equal(drafted.structuredContent.status, "draft");

  rules.send_allow = ["15550100"];
  const blocked = await server.tools.get("confirm_send").handler({ draft_id: drafted.structuredContent.draft_id });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.structuredContent.error, "SEND_BLOCKED");
  assert.match(blocked.structuredContent.message, /not on the send allowlist/);
  assert.equal(calls.confirms, 0, "the send must not reach the service");

  delete rules.send_allow;
  const sent = await server.tools.get("confirm_send").handler({ draft_id: drafted.structuredContent.draft_id });
  assert.equal(sent.structuredContent.message_id, "mid");
  assert.equal(calls.confirms, 1);
});

test("default-deny refuses an unlisted recipient and says how to lift it", async () => {
  const server = fakeServer();
  const calls = { drafts: 0, confirms: 0 };
  const wa = draftApi(calls);
  registerTools(server, ruledSource(wa, { send_allow: [] }), { allowWrite: true });

  const result = await server.tools.get("send_message").handler({ chat_id: "+15550100", text: "hi" });
  assert.equal(result.structuredContent.error, "SEND_BLOCKED");
  assert.match(result.structuredContent.message, /not on the send allowlist/);
  assert.match(result.structuredContent.fix, /wazap config send/);
  assert.equal(calls.drafts, 0);
});

test("with rules on, an unowned draft is rejected before policy lookup", async () => {
  const server = fakeServer();
  const calls = { drafts: 0, confirms: 0 };
  const wa = draftApi(calls);
  registerTools(server, ruledSource(wa, { send_allow: ["40722123456"] }), { allowWrite: true });

  const orphan = await wa.draft({ kind: "text", chatId: ANA.chat_id, text: "hi" });
  const result = await server.tools.get("confirm_send").handler({ draft_id: orphan.draft_id });
  assert.equal(result.structuredContent.error, "DRAFT_NOT_FOUND");
  assert.match(result.structuredContent.message, /this MCP session/);
  assert.equal(calls.confirms, 0);
});

test("config send prints open rules, then sets and clears them", async () => {
  const dir = dataDir();
  const open = await wazap(dir, ["config", "send"]);
  assert.match(open.stderr, /open — anyone may be messaged/);

  const set = await wazap(dir, ["config", "send", "allow", "+40 722 123 456,120363000000000001@g.us"]);
  assert.match(set.stderr, /allowlist: 40722123456, 120363000000000001@g\.us/);
  const file = JSON.parse(readFileSync(paths(dir).accountsFile, "utf8"));
  assert.deepEqual(file.accounts[0].send_allow, ["40722123456", "120363000000000001@g.us"]);

  const deny = await wazap(dir, ["config", "send", "deny", "15550100"]);
  assert.match(deny.stderr, /denylist: 15550100/);
  assert.deepEqual(JSON.parse(readFileSync(paths(dir).accountsFile, "utf8")).accounts[0].send_deny, ["15550100"]);

  const cleared = await wazap(dir, ["config", "send", "open"]);
  assert.match(cleared.stderr, /open — anyone may be messaged/);
  const after = JSON.parse(readFileSync(paths(dir).accountsFile, "utf8"));
  assert.equal(after.accounts[0].send_allow, undefined);
  assert.equal(after.accounts[0].send_deny, undefined);
});

test("config send allow none locks the account to nobody, and config lists the rules", async () => {
  const dir = dataDir();
  await wazap(dir, ["config", "send", "allow", "none"]);
  assert.deepEqual(JSON.parse(readFileSync(paths(dir).accountsFile, "utf8")).accounts[0].send_allow, []);
  assert.match((await wazap(dir, ["config", "send"])).stderr, /allowlist empty — nobody may be messaged/);
  assert.match((await wazap(dir, ["config"])).stderr, /send rules \(default\): allowlist empty/);
});

test("config send --account edits that account's rules, not the default's", async () => {
  const dir = dataDir();
  await wazap(dir, ["account", "add", "work"]);
  await wazap(dir, ["config", "send", "deny", "15550100", "--account", "work"]);
  const file = JSON.parse(readFileSync(paths(dir).accountsFile, "utf8"));
  assert.deepEqual(file.accounts.find((account) => account.id === "work").send_deny, ["15550100"]);
  assert.equal(file.accounts.find((account) => account.id === "default").send_deny, undefined);
});

test("config send refuses a non-address and a missing list, persisting nothing", async () => {
  const dir = dataDir();
  await assert.rejects(wazap(dir, ["config", "send", "allow", "Ana"]), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /not a chat id or a phone number/);
    return true;
  });
  await assert.rejects(wazap(dir, ["config", "send", "deny"]), (err) => {
    assert.match(err.stderr, /wazap config send/);
    return true;
  });
  assert.equal(existsSync(paths(dir).accountsFile), false);
});
