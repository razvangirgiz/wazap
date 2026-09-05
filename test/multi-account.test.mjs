import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Accounts } from "../dist/accounts.js";
import { AccountManager } from "../dist/account-manager.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { Archive } from "../dist/archive.js";
import { accessContext } from "../dist/access.js";
import { registerTools } from "../dist/tools.js";
import { startHttpEndpoint } from "../dist/server.js";
import { WazapOAuthProvider } from "../dist/oauth.js";
import { offlineConfig, fakeSocket, BINARY } from "./helpers.mjs";
const PEER = "40722222222@s.whatsapp.net";
const ctx = { principal: "test-owner", allowWrite: true, local: true };
const temp = () => mkdtempSync(join(tmpdir(), "wazap-multi-"));
const incoming = (id, text, time = Date.now()) => ({
  key: { id, remoteJid: PEER, fromMe: false },
  message: { conversation: text },
  messageTimestamp: Math.floor(time / 1000),
});
function toolsFor(manager, context = ctx) {
  const tools = new Map();
  registerTools(
    {
      registerTool(name, meta, handler) {
        tools.set(name, { meta, handler });
      },
    },
    manager,
    { allowWrite: context.allowWrite, context },
  );
  return async (name, args = {}) => tools.get(name).handler(args);
}
async function setup(t, { persist = false, factory, config: extra = {} } = {}) {
  const root = temp(),
    registry = new Accounts(root);
  const a = registry.add("Personal"),
    b = registry.add("Business");
  const owners = {
    [a.id]: "40700000001@s.whatsapp.net",
    [b.id]: "40700000002@s.whatsapp.net",
  };
  const runtimes = new Map(),
    sockets = new Map(),
    sends = [];
  const config = offlineConfig("wazap-multi-cfg-", {
    dataDir: root,
    readOnly: false,
    persistHistory: persist,
    rateLimitPerMinute: 0,
    ...extra,
  });
  const make = (c) => {
    const svc = new WhatsAppService(c),
      sock = fakeSocket();
    const owner = owners[c.accountId] ?? "40700000003@s.whatsapp.net";
    svc.start = async () => {
      c.validateAccount?.(owner);
      svc.account = {
        id: owner,
        name: c.accountId,
        number: owner.split("@")[0],
      };
      await svc.loadPersisted();
      svc.sockClient = c.offline ? null : sock;
      svc.status = c.offline ? "disconnected" : "connected";
      svc.initialSyncDone = !c.offline;
      svc.wireEvents(sock, ++svc.generation);
    };
    sock.onWhatsApp = async () => [{ exists: true }];
    sock.sendMessage = async (jid, content, options) => {
      sends.push({ account_id: c.accountId, jid, content, options });
      return {
        key: { id: options.messageId, fromMe: true, remoteJid: jid },
        message: { conversation: content.text },
        messageTimestamp: Math.floor(Date.now() / 1000),
      };
    };
    runtimes.set(c.accountId, svc);
    sockets.set(c.accountId, sock);
    return svc;
  };
  const manager = new AccountManager(config, factory ?? make);
  await manager.start();
  t.after(() => manager.stop());
  return {
    root,
    registry,
    a,
    b,
    manager,
    runtimes,
    sockets,
    sends,
    call: toolsFor(manager),
    config,
    make,
  };
}
async function seed(svc, id, text, time) {
  svc.sockClient.ev.emit("messages.upsert", {
    messages: [incoming(id, text, time)],
    type: "notify",
  });
  await svc.archiveBarrier();
}

test("new profiles have stable generated IDs and restrictive atomic registry", () => {
  const r = new Accounts(temp());
  const a = r.add("Personal");
  r.rename(a.id, "Private");
  assert.equal(new Accounts(r.root).get(a.id).name, "Private");
  assert.match(a.id, /^a_[a-f0-9]{32}$/);
  if (process.platform !== "win32")
    assert.equal(statSync(r.file).mode & 0o777, 0o600);
  assert.throws(() => r.add("private"), /distinct/);
  assert.throws(() => r.add("bad\nname"), /one line/);
});
test("legacy data is registered in place without changing original files", () => {
  const root = temp();
  mkdirSync(join(root, "auth"));
  writeFileSync(
    join(root, "auth", "creds.json"),
    '{"me":{"id":"40700000001:3@s.whatsapp.net"}}',
  );
  const original = readFileSync(join(root, "auth", "creds.json"));
  const r = new Accounts(root);
  r.initialize();
  r.initialize();
  r.add("Business");
  assert.equal(r.list()[0].id, "default");
  assert.equal(r.directory(r.list()[0]), root);
  assert.deepEqual(readFileSync(join(root, "auth", "creds.json")), original);
});
test("corrupt registry refuses startup instead of silently selecting another account", () => {
  const root = temp();
  writeFileSync(join(root, "accounts.json"), "{broken");
  assert.throws(() => new Accounts(root).list(), {
    code: "ACCOUNT_REGISTRY_ERROR",
  });
});
test("registry refuses traversal, duplicate identifiers and symlink directories", () => {
  const r = new Accounts(temp()),
    a = r.add("Personal");
  assert.throws(() => r.directory({ ...a, id: "../../auth" }), {
    code: "ACCOUNT_REGISTRY_ERROR",
  });
  mkdirSync(join(r.root, "accounts"));
  symlinkSync(
    temp(),
    join(r.root, "accounts", a.id),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => r.directory(a), { code: "ACCOUNT_REGISTRY_ERROR" });
});
test("owner binding survives rename and rejects replacement and duplicate identity", () => {
  const r = new Accounts(temp()),
    a = r.add("A"),
    b = r.add("B");
  r.bind(a.id, "40700000001:2@s.whatsapp.net");
  r.rename(a.id, "Personal");
  assert.throws(() => r.bind(a.id, "40700000002@s.whatsapp.net"), {
    code: "ACCOUNT_MISMATCH",
  });
  assert.throws(() => r.bind(b.id, "40700000001@s.whatsapp.net"), {
    code: "ACCOUNT_DUPLICATE",
  });
  assert.throws(() => r.checkPhone(b.id, "+40 700 000 001"), {
    code: "ACCOUNT_DUPLICATE",
  });
});
test("account environment is isolated and cannot relax global read-only or persistence-off", () => {
  const r = new Accounts(temp()),
    a = r.add("A"),
    b = r.add("B");
  mkdirSync(r.directory(a), { recursive: true });
  writeFileSync(
    join(r.directory(a), ".env"),
    "WAZAP_READ_ONLY=0\nWAZAP_PERSIST_HISTORY=1\nWAZAP_TRANSCRIBE_LANGUAGE=ro\n",
  );
  const base = offlineConfig("wazap-multi-env-", {
    dataDir: r.root,
    readOnly: true,
    persistHistory: false,
  });
  const ca = r.config(base, a),
    cb = r.config(base, b);
  assert.equal(ca.readOnly, true);
  assert.equal(ca.persistHistory, false);
  assert.equal(ca.accountEnv.WAZAP_TRANSCRIBE_LANGUAGE, "ro");
  assert.notEqual(cb.accountEnv.WAZAP_TRANSCRIBE_LANGUAGE, "ro");
});

test("account selection is explicit even when only one of two accounts is connected", async (t) => {
  const x = await setup(t);
  x.runtimes.get(x.b.id).status = "disconnected";
  const result = await x.call("get_status");
  assert.equal(result.structuredContent.error, "ACCOUNT_REQUIRED");
  assert.equal(
    (await x.call("get_status", { account_id: x.a.id })).structuredContent
      .account_id,
    x.a.id,
  );
  assert.equal(
    (await x.call("list_accounts")).structuredContent.accounts.length,
    2,
  );
});
test("identical message IDs in different accounts retain independent contents and notes", async (t) => {
  const x = await setup(t);
  await seed(x.runtimes.get(x.a.id), "SAME", "private appointment");
  await seed(x.runtimes.get(x.b.id), "SAME", "business invoice");
  const mid = `false_${PEER}_SAME`;
  for (const [a, expected, forbidden] of [
    [x.a, "private appointment", "business invoice"],
    [x.b, "business invoice", "private appointment"],
  ]) {
    const r = await x.call("get_message", {
      account_id: a.id,
      message_id: mid,
    });
    assert.equal(r.structuredContent.text, expected);
    assert.equal(r.structuredContent.account_id, a.id);
    assert.ok(!JSON.stringify(r).includes(forbidden));
  }
  await x.call("set_contact_note", {
    account_id: x.a.id,
    contact_id: PEER,
    note: "Personal only",
  });
  assert.equal(x.runtimes.get(x.a.id).notes.noteFor(PEER), "Personal only");
  assert.equal(x.runtimes.get(x.b.id).notes.noteFor(PEER), undefined);
});

const routing = [
  ["get_status", "getStatus", {}],
  ["list_chats", "listChats", { filter: "all", limit: 20 }],
  ["read_messages", "readMessages", { chat_id: PEER, limit: 20 }],
  [
    "get_recent_messages",
    "getRecentMessages",
    { hours: 24, filter: "all", limit: 20 },
  ],
  [
    "get_unanswered",
    "getUnanswered",
    { min_age_hours: 0, max_age_hours: 336, limit: 20 },
  ],
  ["get_stories", "getStories", { hours: 24 }],
  [
    "set_contact_note",
    "setContactNote",
    { contact_id: PEER, note: "Personal note" },
  ],
  ["mark_handled", "markHandled", { chat_id: PEER }],
  [
    "wait_for_messages",
    "waitForMessages",
    { timeout_seconds: 1, addressed_to_me: false },
  ],
  ["search_messages", "searchMessages", { query: "invoice", limit: 20 }],
  ["get_message", "getMessage", { message_id: `false_${PEER}_SAME` }],
  ["search_contacts", "searchContacts", { query: "Peer", limit: 20 }],
  ["sync_contacts", "syncContacts", {}],
  ["get_contact", "getContact", { contact_id: PEER }],
  ["get_group_info", "getGroupInfo", { group_id: "12@g.us" }],
  ["download_media", "downloadMedia", { message_id: `false_${PEER}_SAME` }],
  ["transcribe_audio", "transcribeAudio", { message_id: `false_${PEER}_SAME` }],
  ["send_message", "draft", { chat_id: PEER, text: "Approved content" }],
  ["send_media", "draft", { chat_id: PEER, file_path: "/synthetic/file" }],
  [
    "send_poll",
    "draft",
    { chat_id: PEER, question: "Go?", options: ["Yes", "No"] },
  ],
  ["send_location", "draft", { chat_id: PEER, latitude: 1, longitude: 2 }],
  [
    "edit_message",
    "editMessage",
    { message_id: `true_${PEER}_SAME`, text: "Corrected" },
  ],
  [
    "react_to_message",
    "reactToMessage",
    { message_id: `false_${PEER}_SAME`, emoji: "👍" },
  ],
  [
    "forward_message",
    "draft",
    { message_id: `false_${PEER}_SAME`, to_chat_id: PEER },
  ],
  [
    "delete_message",
    "deleteMessage",
    { message_id: `true_${PEER}_SAME`, for_everyone: true },
  ],
  ["manage_chat", "manageChat", { chat_id: PEER, action: "mark_read" }],
  ["create_group", "createGroup", { name: "Test", participant_ids: [PEER] }],
  ["manage_group", "manageGroup", { group_id: "12@g.us", action: "leave" }],
];
for (const [tool, method, args] of routing)
  test(`product routing: ${tool} uses the selected account and never the other`, async (t) => {
    const x = await setup(t);
    const hits = [];
    for (const a of [x.a, x.b])
      x.runtimes.get(a.id)[method] = () => {
        hits.push(a.id);
        throw Error("Synthetic stop before external work");
      };
    await x.call(tool, { ...args, account_id: x.a.id });
    assert.deepEqual(hits, [x.a.id]);
    hits.length = 0;
    const missing = await x.call(tool, args);
    assert.equal(missing.structuredContent.error, "ACCOUNT_REQUIRED");
    assert.deepEqual(hits, []);
  });

test("drafts show their account and simultaneous confirmations send exactly once from its original account", async (t) => {
  const x = await setup(t, { persist: true });
  const d = await x.call("send_message", {
    account_id: x.a.id,
    chat_id: PEER,
    text: "Personal outgoing",
  });
  assert.equal(d.structuredContent.account_id, x.a.id);
  assert.match(d.structuredContent.draft_id, new RegExp(`^${x.a.id}:d_`));
  assert.ok(d.content.some((c) => c.text?.includes("Personal")));
  const wrong = await x.call("confirm_send", {
    draft_id: d.structuredContent.draft_id,
    account_id: x.b.id,
  });
  assert.equal(wrong.structuredContent.error, "ACCOUNT_MISMATCH");
  assert.equal(x.sends.length, 0);
  x.registry.rename(x.a.id, "Renamed");
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      x.call("confirm_send", { draft_id: d.structuredContent.draft_id }),
    ),
  );
  assert.equal(x.sends.length, 1);
  assert.equal(x.sends[0].account_id, x.a.id);
  assert.ok(
    results.every(
      (r) => !r.isError && r.structuredContent.account_id === x.a.id,
    ),
  );
  await x.manager.stop();
  const restarted = new AccountManager(x.config, x.make);
  await restarted.start();
  t.after(() => restarted.stop());
  const result = await toolsFor(restarted)("confirm_send", {
    draft_id: d.structuredContent.draft_id,
  });
  assert.equal(result.isError, undefined);
  assert.equal(x.sends.length, 1);
});
test("a draft prepared by another client cannot be confirmed", async (t) => {
  const x = await setup(t);
  const d = await x.call("send_message", {
    account_id: x.a.id,
    chat_id: PEER,
    text: "Draft",
  });
  const result = await toolsFor(x.manager, { ...ctx, principal: "other" })(
    "confirm_send",
    { draft_id: d.structuredContent.draft_id },
  );
  assert.equal(result.structuredContent.error, "DRAFT_NOT_FOUND");
  assert.equal(x.sends.length, 0);
});
test("per-account read-only and disable refuse writes without affecting the other account", async (t) => {
  const x = await setup(t);
  writeFileSync(join(x.registry.directory(x.a), ".env"), "WAZAP_READ_ONLY=1\n");
  assert.equal(
    (
      await x.call("send_message", {
        account_id: x.a.id,
        chat_id: PEER,
        text: "No",
      })
    ).structuredContent.error,
    "READ_ONLY",
  );
  assert.equal(
    (
      await x.call("send_message", {
        account_id: x.b.id,
        chat_id: PEER,
        text: "Yes",
      })
    ).structuredContent.status,
    "draft",
  );
  x.registry.enable(x.b.id, false);
  assert.equal(
    (
      await x.call("send_message", {
        account_id: x.b.id,
        chat_id: PEER,
        text: "No",
      })
    ).structuredContent.error,
    "ACCOUNT_DISABLED",
  );
});
test("disabled accounts expose their local archive after restart, without connecting", async (t) => {
  const x = await setup(t, { persist: true });
  await seed(x.runtimes.get(x.a.id), "OFFLINE", "retained locally");
  await x.manager.stop();
  x.registry.enable(x.a.id, false);
  // Use the real startup implementation: owner is known, credentials deliberately absent.
  const svc = new WhatsAppService(
    x.registry.config(x.config, x.registry.get(x.a.id)),
  );
  await svc.start();
  t.after(() => svc.stop());
  const r = await svc.searchMessages("retained", undefined, 20);
  assert.equal(r.data.length, 1);
  assert.equal(svc.sockClient, null);
  assert.notEqual(r.sync, "done");
});
test("multi-account media policy protects every account directory", async (t) => {
  const x = await setup(t, { config: { exportDir: undefined } });
  const file = join(x.registry.directory(x.b), "secret.txt");
  writeFileSync(file, "PRIVATE");
  writeFileSync(
    join(x.registry.directory(x.a), ".env"),
    `WAZAP_EXPORT_DIR=${x.root}\n`,
  );
  const r = await toolsFor(x.manager, { ...ctx, local: false })("send_media", {
    account_id: x.a.id,
    chat_id: PEER,
    file_path: file,
  });
  assert.equal(r.structuredContent.error, "MEDIA_ACCESS_DENIED");
  assert.equal(x.sends.length, 0);
});

test("aggregate search pages stable equal timestamps without loss, duplicates or new arrivals", async (t) => {
  const x = await setup(t);
  const time = Date.now() - 10_000;
  for (const a of [x.a, x.b])
    for (let i = 0; i < 31; i++)
      await seed(
        x.runtimes.get(a.id),
        `T${String(i).padStart(3, "0")}`,
        "invoice old",
        time,
      );
  let before;
  const seen = [];
  do {
    const r = await x.call("search_messages", {
      all_accounts: true,
      query: "invoice",
      limit: 7,
      before,
    });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    for (const m of r.structuredContent.messages)
      seen.push(`${m.account_id}:${m.message_id}`);
    before = r.structuredContent.next_before;
    if (seen.length === 7)
      await seed(x.runtimes.get(x.a.id), "LATE", "invoice late backfill", time);
  } while (before);
  assert.equal(seen.length, 62);
  assert.equal(new Set(seen).size, 62);
  assert.ok(!seen.some((id) => id.endsWith("LATE")));
});
test("aggregate recent pages preserve account-tagged conversations and compact lines", async (t) => {
  const x = await setup(t);
  const time = Date.now() - 10_000;
  for (const a of [x.a, x.b])
    for (let i = 0; i < 8; i++)
      await seed(x.runtimes.get(a.id), `R${i}`, "appointment", time + i * 1000);
  let cursor;
  const seen = [];
  do {
    const r = await x.call("get_recent_messages", {
      all_accounts: true,
      hours: 24,
      filter: "all",
      limit: 3,
      cursor,
    });
    for (const c of r.structuredContent.conversations)
      for (const m of c.messages) {
        assert.equal(m.account_id, c.account_id);
        seen.push(`${m.account_id}:${m.message_id}`);
      }
    cursor = r.structuredContent.next_cursor;
  } while (cursor);
  assert.equal(seen.length, 16);
  assert.equal(new Set(seen).size, 16);
  const compact = await x.call("get_recent_messages", {
    all_accounts: true,
    hours: 24,
    filter: "all",
    limit: 10,
    compact: true,
  });
  for (const c of compact.structuredContent.conversations) {
    assert.ok(c.account_id);
    assert.ok(c.lines.every((l) => l.account_id === c.account_id));
  }
});
test("aggregate cursors reject changed filters, account selection, and principals", async (t) => {
  const x = await setup(t);
  for (let i = 0; i < 3; i++)
    await seed(x.runtimes.get(x.a.id), `F${i}`, "invoice");
  const first = await x.call("search_messages", {
    all_accounts: true,
    query: "invoice",
    limit: 1,
  });
  const before = first.structuredContent.next_before;
  assert.ok(before);
  assert.equal(
    (
      await x.call("search_messages", {
        all_accounts: true,
        query: "different",
        limit: 1,
        before,
      })
    ).structuredContent.error,
    "INVALID_ID",
  );
  assert.equal(
    (
      await x.call("search_messages", {
        account_ids: [x.a.id],
        query: "invoice",
        limit: 1,
        before,
      })
    ).structuredContent.error,
    "INVALID_ID",
  );
  assert.equal(
    (
      await toolsFor(x.manager, { ...ctx, principal: "other" })(
        "search_messages",
        { all_accounts: true, query: "invoice", limit: 1, before },
      )
    ).structuredContent.error,
    "INVALID_ID",
  );
});
test("per-account recent cursors cannot transfer to another account", async (t) => {
  const x = await setup(t);
  for (let i = 0; i < 3; i++)
    await seed(x.runtimes.get(x.a.id), `P${i}`, "appointment");
  const first = await x.call("get_recent_messages", {
    account_id: x.a.id,
    hours: 24,
    filter: "all",
    limit: 1,
  });
  const cursor = first.structuredContent.next_cursor;
  assert.ok(cursor);
  const result = await x.call("get_recent_messages", {
    account_id: x.b.id,
    hours: 24,
    filter: "all",
    limit: 1,
    cursor,
  });
  assert.equal(result.structuredContent.error, "ACCOUNT_MISMATCH");
});
test("unavailable account produces partial results and never a cursor that silently skips it", async (t) => {
  const x = await setup(t);
  await seed(x.runtimes.get(x.a.id), "GOOD", "invoice");
  x.runtimes.get(x.b.id).captureReadSnapshot = async () => {
    throw Error("synthetic unavailable");
  };
  const r = await x.call("search_messages", {
    all_accounts: true,
    query: "invoice",
    limit: 1,
  });
  assert.equal(r.structuredContent.partial, true);
  assert.equal(r.structuredContent.next_before, null);
  assert.equal(r.structuredContent.messages.length, 1);
  assert.ok(r.structuredContent.accounts.some((a) => a.error));
});
test("triage keeps identical candidates in different accounts and labels them as candidates", async (t) => {
  const x = await setup(t);
  for (const a of [x.a, x.b])
    await seed(
      x.runtimes.get(a.id),
      "ASK",
      "Poți confirma întâlnirea?",
      Date.now() - 60_000,
    );
  const r = await x.call("get_unanswered", {
    all_accounts: true,
    min_age_hours: 0,
    max_age_hours: 336,
    limit: 20,
  });
  assert.equal(r.structuredContent.chats.length, 2);
  assert.equal(r.structuredContent.basis, "heuristic_candidates");
  assert.equal(
    new Set(r.structuredContent.chats.map((c) => c.account_id)).size,
    2,
  );
});
test("mixed selectors and cross-account contact filters are rejected", async (t) => {
  const x = await setup(t);
  assert.equal(
    (
      await x.call("search_messages", {
        account_id: x.a.id,
        all_accounts: true,
        query: "x",
      })
    ).structuredContent.error,
    "INVALID_ID",
  );
  assert.equal(
    (
      await x.call("search_messages", {
        all_accounts: true,
        query: "x",
        from: PEER,
      })
    ).structuredContent.error,
    "ACCOUNT_REQUIRED",
  );
});

test("limited clients cannot discover or access the other account", async (t) => {
  const x = await setup(t);
  const restricted = toolsFor(x.manager, {
    ...ctx,
    accountAccess: x.manager.access([x.a.id]),
  });
  const list = await restricted("list_accounts");
  assert.deepEqual(
    list.structuredContent.accounts.map((a) => a.account_id),
    [x.a.id],
  );
  assert.equal(
    (await restricted("get_status", { account_id: x.b.id })).structuredContent
      .error,
    "ACCOUNT_NOT_FOUND",
  );
  assert.equal(
    (await restricted("get_status")).structuredContent.error,
    "ACCOUNT_REQUIRED",
  );
});
test("changing account permissions invalidates the existing tool context", async (t) => {
  const x = await setup(t);
  const restricted = toolsFor(x.manager, {
    ...ctx,
    accountAccess: x.manager.access(),
  });
  x.registry.enable(x.a.id, false);
  assert.equal(
    (await restricted("list_accounts")).structuredContent.error,
    "ACCOUNT_ACCESS_CHANGED",
  );
});
test("HTTP sessions reject account-set changes on POST, GET and DELETE", async (t) => {
  const x = await setup(t),
    stop = new AbortController();
  t.after(() => stop.abort());
  const port = await startHttpEndpoint(x.manager, x.config, {
    host: "127.0.0.1",
    port: 0,
    credentials: [{ token: "test", write: true }],
    openRead: false,
    signal: stop.signal,
  });
  const request = (method, sid, body) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method,
      headers: {
        Authorization: "Bearer test",
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(sid ? { "mcp-session-id": sid } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const r = await request("POST", undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  const sid = r.headers.get("mcp-session-id");
  await r.text();
  assert.ok(sid);
  x.registry.add("Third");
  for (const method of ["POST", "GET", "DELETE"]) {
    const r = await request(
      method,
      sid,
      method === "POST"
        ? { jsonrpc: "2.0", id: 2, method: "tools/list" }
        : undefined,
    );
    assert.equal(r.status, 403);
    await r.text();
  }
});

test("OAuth requires password before showing accounts and grants only selected accounts across refresh", async (t) => {
  const x = await setup(t);
  const oauth = new WazapOAuthProvider({
    publicUrl: new URL("http://127.0.0.1:12345"),
    password: "test-password",
    stateFile: join(x.root, "oauth.json"),
    accounts: () => x.registry.list().map((a) => ({ id: a.id, name: a.name })),
  });
  const client = await oauth.clientsStore.registerClient({
    redirect_uris: ["http://127.0.0.1:23456/callback"],
    client_name: "Test",
  });
  function response() {
    const r = {
      status(n) {
        r.code = n;
        return r;
      },
      type() {
        return r;
      },
      setHeader() {},
      send(s) {
        r.body = s;
        return r;
      },
      redirect(s) {
        r.location = s;
        return r;
      },
    };
    return r;
  }
  const page = response();
  await oauth.authorize(
    client,
    {
      redirectUri: client.redirect_uris[0],
      codeChallenge: "challenge",
      scopes: ["read"],
    },
    page,
  );
  assert.ok(!page.body.includes("Business"));
  const request = /name="request" value="([^"]+)"/.exec(page.body)[1];
  const step = response();
  oauth.approve(
    {
      ip: "test",
      body: { request, decision: "allow", password: "test-password" },
    },
    step,
  );
  assert.ok(step.body.includes("Business"));
  const consent_token = /name="consent_token" value="([^"]+)"/.exec(
    step.body,
  )[1];
  const empty = response();
  oauth.approve(
    { ip: "test", body: { request, decision: "allow", consent_token } },
    empty,
  );
  assert.equal(empty.code, 400);
  const allowed = response();
  oauth.approve(
    {
      ip: "test",
      body: {
        request,
        decision: "allow",
        consent_token,
        accounts: x.a.id,
        access: "read",
      },
    },
    allowed,
  );
  const code = new URL(allowed.location).searchParams.get("code");
  const tokens = await oauth.exchangeAuthorizationCode(client, code);
  assert.deepEqual(
    (await oauth.verifyAccessToken(tokens.access_token)).extra.accountIds,
    [x.a.id],
  );
  x.registry.add("Third");
  const refreshed = await oauth.exchangeRefreshToken(
    client,
    tokens.refresh_token,
  );
  assert.deepEqual(
    (await oauth.verifyAccessToken(refreshed.access_token)).extra.accountIds,
    [x.a.id],
  );
  assert.equal(
    (await oauth.verifyAccessToken(tokens.access_token)).extra.grantId,
    (await oauth.verifyAccessToken(refreshed.access_token)).extra.grantId,
  );
});

test("CLI profile creation, rename, disable and JSON status persist without any WhatsApp connection", () => {
  const root = temp();
  const run = (...args) =>
    spawnSync(process.execPath, [BINARY, ...args, "--data-dir", root], {
      encoding: "utf8",
      env: { ...process.env, WAZAP_NO_UPDATE_CHECK: "1" },
    });
  assert.equal(run("accounts", "add", "--name", "Personal").status, 0);
  const id = new Accounts(root).list()[0].id;
  assert.equal(run("accounts", "rename", id, "--name", "Private").status, 0);
  assert.equal(run("accounts", "disable", id).status, 0);
  const list = run("accounts", "list", "--json");
  assert.equal(list.status, 0, list.stderr);
  const account = JSON.parse(list.stdout).accounts[0];
  assert.equal(account.account_name, "Private");
  assert.equal(account.enabled, false);
  assert.equal(run("login", "--account", id).status, 1);
  assert.ok(!existsSync(join(root, "archive.sqlite")));
});

test("one slow startup does not block another account that is ready", async (t) => {
  let unblock;
  const gate = new Promise((r) => (unblock = r)),
    root = temp(),
    registry = new Accounts(root),
    a = registry.add("A"),
    b = registry.add("B");
  const config = offlineConfig("wazap-multi-slow-", { dataDir: root });
  const manager = new AccountManager(config, (c) => ({
    start: async () => {
      if (c.accountId === a.id) await gate;
    },
    stop: async () => {},
    getStatus: () => ({
      status: "connected",
      status_since: new Date().toISOString(),
    }),
  }));
  t.after(async () => {
    unblock();
    await manager.stop();
  });
  const starting = manager.start();
  const r = await Promise.race([
    toolsFor(manager)("get_status", { account_id: b.id }),
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("Other account blocked")), 1000).unref(),
    ),
  ]);
  assert.equal(r.structuredContent.status, "connected");
  unblock();
  await starting;
});
test("failed account initialization keeps the other account usable and health contains no identities", async (t) => {
  let first = true;
  const x = await setup(t, {
    factory: (c) => ({
      start: async () => {
        if (first) {
          first = false;
          throw Error("synthetic persistence failure");
        }
      },
      stop: async () => {},
      getStatus: () => ({
        status: "connected",
        status_since: new Date().toISOString(),
      }),
    }),
  });
  assert.equal(
    (await x.call("get_status", { account_id: x.b.id })).structuredContent
      .status,
    "connected",
  );
  assert.equal(
    (await x.call("get_status", { account_id: x.a.id })).structuredContent
      .error,
    "ARCHIVE_UNAVAILABLE",
  );
  assert.deepEqual(x.manager.health(), { ok: false, status: "degraded" });
});
test("reconnect exhaustion replaces only the affected runtime", async (t) => {
  const x = await setup(t);
  const first = x.runtimes.get(x.a.id),
    other = x.runtimes.get(x.b.id);
  first.onGiveUp();
  await x.manager.refresh();
  await x.call("get_status", { account_id: x.a.id });
  assert.notEqual(x.runtimes.get(x.a.id), first);
  assert.equal(x.runtimes.get(x.b.id), other);
});
test("runtime cache limits share a process budget and shrink when an account is added", async (t) => {
  const x = await setup(t);
  const fill = (svc, n) => {
    for (let i = 0; i < n; i++)
      svc.store.putMessage(
        `false_${PEER}_${i}`,
        `${i % 20}@s.whatsapp.net`,
        incoming(String(i), "cache"),
      );
  };
  fill(x.runtimes.get(x.a.id), 6000);
  fill(x.runtimes.get(x.b.id), 6000);
  assert.equal(
    [...x.runtimes.values()].reduce((n, s) => n + s.store.messages.size, 0),
    10000,
  );
  const c = x.registry.add("Third");
  await x.call("get_status", { account_id: c.id });
  assert.ok(
    [...x.runtimes.values()].reduce((n, s) => n + s.store.messages.size, 0) <=
      10000,
  );
});
test("runtime shutdown releases waiters before waiting for persistence", async (t) => {
  const x = await setup(t);
  const waiting = x.call("wait_for_messages", {
    account_id: x.a.id,
    timeout_seconds: 55,
    addressed_to_me: false,
  });
  await new Promise((r) => setTimeout(r, 20));
  await Promise.race([
    x.manager.stop(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(Error("Shutdown waited for idle caller")),
        1500,
      ).unref(),
    ),
  ]);
  await waiting;
});
test("loss of one archive worker leaves another archive readable", async (t) => {
  const x = await setup(t);
  await seed(x.runtimes.get(x.b.id), "B", "business survives");
  await x.runtimes.get(x.a.id).archive.worker.terminate();
  const r = await x.call("search_messages", {
    account_id: x.b.id,
    query: "survives",
    limit: 10,
  });
  assert.equal(r.structuredContent.messages.length, 1);
  // A persistence failure must be reported on shutdown; explicitly verify it here.
  await assert.rejects(x.manager.stop(), { code: "ARCHIVE_UNAVAILABLE" });
});
test("static credentials and private bridge headers can narrow account access", async (t) => {
  const x = await setup(t),
    stop = new AbortController();
  t.after(() => stop.abort());
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const port = await startHttpEndpoint(x.manager, x.config, {
    host: "127.0.0.1",
    port: 0,
    credentials: [{ token: "bridge", write: true, accountIds: [x.a.id] }],
    local: true,
    openRead: false,
    signal: stop.signal,
  });
  const client = new Client({ name: "test", version: "1" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer bridge",
          "x-wazap-accounts": `${x.a.id},${x.b.id}`,
          "x-wazap-read-only": "1",
        },
      },
    }),
  );
  const r = await client.callTool({ name: "list_accounts", arguments: {} });
  assert.deepEqual(
    r.structuredContent.accounts.map((a) => a.account_id),
    [x.a.id],
  );
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(!names.includes("send_message"));
});
test("OAuth does not accept an account added after the selection page was shown", async (t) => {
  const x = await setup(t);
  const oauth = new WazapOAuthProvider({
    publicUrl: new URL("http://127.0.0.1:12345"),
    password: "test-password",
    stateFile: join(x.root, "oauth.json"),
    accounts: () => x.registry.list().map((a) => ({ id: a.id, name: a.name })),
  });
  const client = await oauth.clientsStore.registerClient({
    redirect_uris: ["http://127.0.0.1:23456/callback"],
  });
  const response = () => ({
    status(n) {
      this.code = n;
      return this;
    },
    type() {
      return this;
    },
    setHeader() {},
    send(s) {
      this.body = s;
      return this;
    },
    redirect(s) {
      this.location = s;
    },
  });
  const page = response();
  await oauth.authorize(
    client,
    { redirectUri: client.redirect_uris[0], codeChallenge: "x" },
    page,
  );
  const request = /name="request" value="([^"]+)"/.exec(page.body)[1];
  const step = response();
  oauth.approve(
    {
      ip: "test",
      body: { request, decision: "allow", password: "test-password" },
    },
    step,
  );
  const consent_token = /name="consent_token" value="([^"]+)"/.exec(
    step.body,
  )[1];
  const c = x.registry.add("New");
  const invalid = response();
  oauth.approve(
    {
      ip: "test",
      body: { request, decision: "allow", consent_token, accounts: c.id },
    },
    invalid,
  );
  assert.equal(invalid.code, 400);
  assert.equal(invalid.location, undefined);
});

test("permission changes during a slow startup are checked again before dispatch", async (t) => {
  const root = temp(),
    registry = new Accounts(root),
    a = registry.add("A");
  let unblock, reached;
  const gate = new Promise((r) => (unblock = r)),
    entered = new Promise((r) => (reached = r));
  const manager = new AccountManager(
    offlineConfig("wazap-startup-acl-", { dataDir: root, readOnly: false }),
    () => ({
      start: async () => {
        reached();
        await gate;
      },
      stop: async () => {},
      getStatus: () => ({ status: "connected" }),
    }),
  );
  t.after(async () => {
    unblock();
    await manager.stop();
  });
  let calls = 0;
  const request = accessContext.run(ctx, () =>
    manager.withAccount(a.id, true, async () => {
      calls++;
    }),
  );
  await entered;
  writeFileSync(join(registry.directory(a), ".env"), "WAZAP_READ_ONLY=1\n");
  unblock();
  await assert.rejects(request, { code: "ACCOUNT_ACCESS_CHANGED" });
  assert.equal(calls, 0);
});

test("archive rows without optional reaction metadata remain readable", async (t) => {
  const x = await setup(t);
  await seed(x.runtimes.get(x.a.id), "OLD", "old import");
  const svc = x.runtimes.get(x.a.id),
    sid = `false_${PEER}_OLD`;
  const row = await svc.archive.call("get", { sid });
  row.extra = {};
  await svc.archive.call("batch", { rows: [row] });
  const r = await x.call("get_message", {
    account_id: x.a.id,
    message_id: sid,
  });
  assert.equal(r.structuredContent.text, "old import");
});

test("CLI login pairs through the existing private daemon and keeps the other account alive", async (t) => {
  const { loginThroughDaemon } = await import("../dist/accounts-cli.js");
  const { writeDaemon, removeDaemon } = await import("../dist/daemon.js");
  const { writeLock, releaseLock } = await import("../dist/lock.js");
  const { paths } = await import("../dist/config.js");
  const x = await setup(t),
    stop = new AbortController(),
    p = paths(x.root);
  t.after(() => {
    stop.abort();
    removeDaemon(p.daemonFile);
    releaseLock(p.lockFile);
  });
  assert.equal(writeLock(p.lockFile), true);
  const port = await startHttpEndpoint(x.manager, x.config, {
    host: "127.0.0.1",
    port: 0,
    credentials: [{ token: "synthetic-login", write: true }],
    local: true,
    openRead: false,
    signal: stop.signal,
  });
  writeDaemon(p.daemonFile, {
    pid: process.pid,
    port,
    token: "synthetic-login",
    version: "0.15.0",
  });
  const svc = x.runtimes.get(x.a.id);
  svc.status = "not_linked";
  let called = 0;
  svc.link = async (phone) => {
    called++;
    assert.equal(phone, "+40700000001");
    svc.status = "linking";
    setTimeout(() => {
      svc.status = "connected";
    }, 10);
    return {
      code: "TEST-CODE",
      phone_masked: "…0001",
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };
  };
  assert.equal(
    await loginThroughDaemon(
      x.registry.config(x.config, x.registry.get(x.a.id)),
      async () => "+40700000001",
    ),
    true,
  );
  assert.equal(called, 1);
  assert.equal(x.runtimes.get(x.b.id).status, "connected");
  assert.equal(x.sends.length, 0);
});
