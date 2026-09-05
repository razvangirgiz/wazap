import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../dist/archive.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, offlineConfig } from "./helpers.mjs";
import { startHttpEndpoint } from "../dist/server.js";
import { accessContext } from "../dist/access.js";
import { publicAddress, readAllowedFile, publicMedia } from "../dist/safe-media.js";
const ME = "40700000000@s.whatsapp.net",
  PEER = "40722222222@s.whatsapp.net";
const raw = (id, text, ts = Date.now()) => ({
  key: { id, remoteJid: PEER, fromMe: false },
  message: { conversation: text },
  messageTimestamp: Math.floor(ts / 1000),
});
function service(t, config = {}) {
  const ctx = connectedService(WhatsAppService, { prefix: "wazap-consolidation-", id: ME, name: "Test", config });
  t.after(() => ctx.svc.stop());
  return ctx;
}
async function archive(t, file = ":memory:", owner = ME) {
  const a = new Archive();
  await a.open(file, owner);
  t.after(() => a.close());
  return a;
}
const row = (id, ts, text) => ({ sid: id, jid: PEER, ts, sender: PEER, type: "text", text, raw: "", extra: {} });

test("read credential cannot call, stream or delete a write session", async (t) => {
  const stop = new AbortController();
  t.after(() => stop.abort());
  let calls = 0;
  const port = await startHttpEndpoint(
    {
      getStatus: () => ({ status: "connected", status_since: new Date().toISOString() }),
      confirm: async () => {
        calls++;
        return {};
      },
    },
    offlineConfig("wazap-acl-", { readOnly: false }),
    {
      host: "127.0.0.1",
      port: 0,
      credentials: [
        { token: "read", write: false },
        { token: "write", write: true },
      ],
      openRead: false,
      signal: stop.signal,
    },
  );
  const rpc = async (token, method = "POST", sid, body) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(sid ? { "mcp-session-id": sid } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const init = await rpc("write", "POST", undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "audit", version: "1" } },
  });
  const sid = init.headers.get("mcp-session-id");
  await init.text();
  assert.ok(sid);
  for (const method of ["POST", "GET", "DELETE"]) {
    const r = await rpc(
      "read",
      method,
      sid,
      method === "POST"
        ? {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "confirm_send", arguments: { draft_id: "fake" } },
          }
        : undefined,
    );
    assert.equal(r.status, 403);
    await r.text();
  }
  assert.equal(calls, 0);
  const r = await rpc("invalid", "GET", sid);
  assert.equal(r.status, 401);
  await r.text();
});

test("archive holds and pages more than 2000 records with equal timestamps", async (t) => {
  const a = await archive(t);
  const rows = Array.from({ length: 2505 }, (_, i) => row("m" + String(i).padStart(5, "0"), 1, "factură " + i));
  await a.call("batch", { rows });
  let before;
  const ids = [];
  for (;;) {
    const page = await a.call("query", { limit: 200, before });
    if (!page.length) break;
    ids.push(...page.map((r) => r.sid));
    before = page.at(-1);
  }
  assert.equal(ids.length, 2505);
  assert.equal(new Set(ids).size, 2505);
  assert.equal((await a.call("query", { query: "factură 0" }))[0].sid, "m00000");
});
test("retraction precedes ingestion and cannot be resurrected by replay", async (t) => {
  const a = await archive(t);
  await a.call("erase", { sid: "deleted", jid: PEER, ts: 1 });
  await a.call("batch", { rows: [row("deleted", 1, "secret")] });
  assert.equal((await a.call("get", { sid: "deleted" })).deleted, 1);
  assert.deepEqual(await a.call("query", { query: "secret" }), []);
});
test("archive transaction rolls back an invalid batch", async (t) => {
  const a = await archive(t);
  await assert.rejects(a.call("migrate", { rows: [row("good", 1, "good"), { sid: "bad" }] }));
  assert.equal((await a.call("coverage", {})).count, 0);
});
test("owner mismatch never exposes another account", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wazap-owner-"));
  const a = new Archive();
  await a.open(join(dir, "a.sqlite"), ME);
  await a.close();
  const b = new Archive();
  t.after(() => b.close());
  await assert.rejects(b.open(join(dir, "a.sqlite"), PEER), /ACCOUNT_MISMATCH/);
});
test("retraction removes text from normal service reads", async (t) => {
  const { svc, sock } = service(t);
  const m = raw("delete-me", "secret");
  sock.ev.emit("messages.upsert", { messages: [m], type: "notify" });
  const sid = (await svc.readMessages(PEER, 20)).data[0].message_id;
  sock.ev.emit("messages.update", [{ key: m.key, update: { message: null } }]);
  assert.equal((await svc.getMessage(sid)).text, "[deleted]");
  assert.deepEqual((await svc.searchMessages("secret", PEER, 20)).data, []);
});
test("read pagination survives a full hot cache", async (t) => {
  const { svc, sock } = service(t);
  const t0 = Date.now() - 4000000;
  sock.ev.emit("messaging-history.set", {
    chats: [],
    contacts: [],
    messages: Array.from({ length: 2200 }, (_, i) => raw("m" + i, "msg" + i, t0 + i * 1000)),
    isLatest: true,
  });
  const page = await svc.readMessages(PEER, 200);
  const next = await svc.readMessages(PEER, 200, page.data[0].message_id);
  assert.equal(next.data.length, 200);
  assert.ok(svc.store.messages.size <= 1000);
  assert.equal((await svc.searchMessages("msg0", PEER, 20)).data[0].text, "msg0");
});
test("catch-up cursor is stable and bound to filters", async (t) => {
  const { svc, sock } = service(t);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: Array.from({ length: 9 }, (_, i) => raw("p" + i, "page " + i, Date.now() - i * 1000)),
  });
  const a = await svc.getRecentMessages(24, "all", false, undefined, 4);
  assert.ok(a.next_cursor);
  const b = await svc.getRecentMessages(24, "all", false, undefined, 4, a.next_cursor);
  const ids = [...a.data.flatMap((c) => c.messages), ...b.data.flatMap((c) => c.messages)].map((m) => m.message_id);
  assert.equal(new Set(ids).size, 8);
  await assert.rejects(svc.getRecentMessages(12, "all", false, undefined, 4, a.next_cursor), { code: "INVALID_ID" });
});
test("a successful draft is sent only once across repeated concurrent confirmations", async (t) => {
  const { svc, sock } = service(t, { readOnly: false });
  sock.onWhatsApp = async () => [{ exists: true }];
  let calls = 0;
  sock.sendMessage = async (jid, content, opts) => {
    calls++;
    return {
      key: { remoteJid: jid, id: opts.messageId, fromMe: true },
      message: { conversation: content.text },
      messageTimestamp: Math.floor(Date.now() / 1000),
    };
  };
  const d = await svc.draft({ kind: "text", chatId: PEER, text: "once" });
  const results = await Promise.all([svc.confirm(d.draft_id), svc.confirm(d.draft_id)]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(await svc.confirm(d.draft_id), results[0]);
});
test("ambiguous sending is not retried", async (t) => {
  const { svc, sock } = service(t, { readOnly: false });
  sock.onWhatsApp = async () => [{ exists: true }];
  let calls = 0;
  sock.sendMessage = async () => {
    calls++;
    throw Error("ack lost");
  };
  const d = await svc.draft({ kind: "text", chatId: PEER, text: "maybe sent" });
  for (let i = 0; i < 2; i++) await assert.rejects(svc.confirm(d.draft_id), { code: "SEND_OUTCOME_UNKNOWN" });
  assert.equal(calls, 1);
});
test("drafts belong to their principal", async (t) => {
  const { svc, sock } = service(t, { readOnly: false });
  sock.onWhatsApp = async () => [{ exists: true }];
  const d = await accessContext.run({ principal: "a", allowWrite: true, local: true }, () =>
    svc.draft({ kind: "text", chatId: PEER, text: "private draft" }),
  );
  await assert.rejects(
    accessContext.run({ principal: "b", allowWrite: true, local: true }, () => svc.confirm(d.draft_id)),
    { code: "DRAFT_NOT_FOUND" },
  );
});
test("remote media paths reject symlink escapes and internal data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wazap-export-"));
  const root = join(dir, "export");
  await mkdir(root);
  const data = join(dir, "private");
  await mkdir(data);
  await writeFile(join(data, "secret"), "secret");
  await writeFile(join(root, "good"), "good");
  await symlink(join(data, "secret"), join(root, "link"));
  assert.equal((await readAllowedFile(join(root, "good"), { exportDir: root, dataDir: data })).toString(), "good");
  await assert.rejects(readAllowedFile(join(root, "link"), { exportDir: root, dataDir: data }), {
    code: "MEDIA_ACCESS_DENIED",
  });
  await assert.rejects(readAllowedFile(join(root, "good"), { dataDir: data }), { code: "MEDIA_ACCESS_DENIED" });
});
for (const ip of [
  "127.0.0.1",
  "10.0.0.1",
  "172.16.0.1",
  "169.254.169.254",
  "192.168.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "fc00::1",
  "fe80::1",
])
  test(`media blocks ${ip}`, () => assert.equal(publicAddress(ip), false));
test("public media refuses a loopback URL before issuing a request", async () =>
  await assert.rejects(publicMedia("http://127.0.0.1:1/private"), { code: "MEDIA_ACCESS_DENIED" }));

// Product fixtures: required and forbidden results rather than implementation shapes.
const asks = [
  "Poți trimite factura?",
  "Te rog confirmă ora",
  "Unde ne vedem?",
  "Can you send the contract?",
  "Please call me",
  "Când ajungi?",
  "Ai putea verifica documentul?",
  "Spune-mi adresa",
  "How much does it cost?",
  "Need your reply",
  "Confirmi mâine?",
  "Trimite contractul",
  "Vă rog răspundeți",
  "Let me know the date",
  "Urgent: confirmă programarea",
];
const noise = [
  "Mersi",
  "Ok, am rezolvat",
  "Bună dimineața",
  "La mulți ani",
  "Am ajuns acasă",
  "Pachetul a fost livrat",
  "Ședința s-a terminat",
  "Mulțumesc pentru ajutor",
  "https://example.com/?q=invoice",
  "👍",
  "Bine",
  "Notat",
  "O seară frumoasă",
  "Factura a fost plătită",
  "Perfect",
];
for (const [text, expected] of [...asks.map((t) => [t, true]), ...noise.map((t) => [t, false])])
  test(`triage fixture: ${text}`, async (t) => {
    const { svc, sock } = service(t);
    sock.ev.emit("messages.upsert", { type: "notify", messages: [raw("ask", text, Date.now() - 3600000)] });
    const result = await svc.getUnanswered(0, 72, 20);
    assert.equal(result.data.length, expected ? 1 : 0);
    if (expected) assert.equal(result.data[0].ask.text, text);
  });

test("edited historical content survives restart and stale replay", async (t) => {
  const { svc, sock } = service(t, { persistHistory: true });
  const message = raw("edit", "old words");
  sock.ev.emit("messages.upsert", { type: "notify", messages: [message] });
  const sid = (await svc.readMessages(PEER, 20)).data[0].message_id;
  sock.ev.emit("messages.update", [
    { key: message.key, update: { message: { editedMessage: { message: { conversation: "new words" } } } } },
  ]);
  assert.equal((await svc.getMessage(sid)).text, "new words");
  sock.ev.emit("messages.upsert", { type: "append", messages: [message] });
  assert.equal((await svc.getMessage(sid)).text, "new words");
  await svc.stop();
  const revived = new WhatsAppService(svc.config);
  revived.account = svc.account;
  revived.status = "connected";
  revived.sockClient = {};
  revived.initialSyncDone = true;
  t.after(() => revived.stop());
  await revived.loadPersisted();
  assert.equal((await revived.getMessage(sid)).text, "new words");
  assert.equal((await revived.getMessage(sid)).edited, true);
});
test("expiring a message removes its search entry", async (t) => {
  const a = await archive(t);
  await a.call("batch", { rows: [{ ...row("expired", 1, "temporary secret"), expires: 2 }] });
  assert.deepEqual(await a.call("expire", { now: 3 }), ["expired"]);
  assert.deepEqual(await a.call("query", { query: "secret" }), []);
});
test("media draft freezes file bytes before confirmation", async (t) => {
  const { svc, sock } = service(t, { readOnly: false });
  sock.onWhatsApp = async () => [{ exists: true }];
  const dir = await mkdtemp(join(tmpdir(), "wazap-frozen-"));
  const file = join(dir, "message.txt");
  await writeFile(file, "approved");
  let sent;
  sock.sendMessage = async (jid, content, opts) => {
    sent = content.document;
    return {
      key: { remoteJid: jid, id: opts.messageId, fromMe: true },
      message: { documentMessage: { fileName: "message.txt" } },
      messageTimestamp: Math.floor(Date.now() / 1000),
    };
  };
  const d = await svc.draft({
    kind: "media",
    chatId: PEER,
    source: { file_path: file },
    asDocument: true,
    asVoice: false,
    asGif: false,
  });
  await writeFile(file, "changed");
  await svc.confirm(d.draft_id);
  assert.equal(sent.toString(), "approved");
});
test("successful receipt survives a process restart", async (t) => {
  const { svc, sock } = service(t, { readOnly: false, persistHistory: true });
  sock.onWhatsApp = async () => [{ exists: true }];
  sock.sendMessage = async (jid, content, opts) => ({
    key: { remoteJid: jid, id: opts.messageId, fromMe: true },
    message: { conversation: content.text },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });
  const d = await svc.draft({ kind: "text", chatId: PEER, text: "receipt" });
  const receipt = await svc.confirm(d.draft_id);
  await svc.stop();
  const revived = new WhatsAppService(svc.config);
  revived.account = svc.account;
  t.after(() => revived.stop());
  assert.deepEqual(await revived.confirm(d.draft_id), receipt);
});
test("migration leaves source files byte-for-byte unchanged", async (t) => {
  const { svc } = service(t, { persistHistory: true });
  const { proto } = await import("baileys");
  const message = raw("legacy", "legacy message");
  const file = join(svc.config.dataDir, "history");
  await mkdir(file);
  const source =
    JSON.stringify({
      sid: `false_${PEER}_legacy`,
      ts: Number(message.messageTimestamp),
      raw: Buffer.from(proto.WebMessageInfo.encode(message).finish()).toString("base64"),
    }) + "\n";
  const path = join(file, PEER + ".jsonl");
  await writeFile(path, source);
  await svc.loadPersisted();
  assert.equal(await readFile(path, "utf8"), source);
  assert.equal((await svc.searchMessages("legacy", PEER, 20)).data.length, 1);
});
test("read context refuses cloud transcription before provider execution", async (t) => {
  const { svc, sock } = service(t, { readOnly: false });
  svc.transcribe = { provider: "openai" };
  let calls = 0;
  svc.transcriber = async () => {
    calls++;
    return { text: "never" };
  };
  const message = { ...raw("voice", ""), message: { audioMessage: { ptt: true, mimetype: "audio/ogg" } } };
  sock.ev.emit("messages.upsert", { type: "append", messages: [message] });
  await assert.rejects(
    accessContext.run({ principal: "read", allowWrite: false, local: false }, () =>
      svc.transcribeAudio(`false_${PEER}_voice`),
    ),
    { code: "READ_ONLY" },
  );
  assert.equal(calls, 0);
});

test("LID retraction resolves a previously returned stable ID, including before replay", async (t) => {
  const a = await archive(t);
  const lid = "123@lid";
  const old = `false_${lid}_key`;
  await a.call("batch", { rows: [{ ...row(old, 1, "private"), jid: lid }] });
  await a.call("alias", { alias: lid, jid: PEER });
  await a.call("erase", { sid: `false_${PEER}_key`, jid: PEER });
  await a.call("batch", { rows: [row(`false_${PEER}_key`, 1, "private")] });
  assert.equal((await a.call("get", { sid: old })).deleted, 1);
  assert.deepEqual(await a.call("query", { query: "private" }), []);
});

import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
function mockNetwork(responses, overrides = {}) {
  let calls = 0;
  const seen = [];
  const request = (url, opts, callback) => {
    const request = new EventEmitter();
    request.end = () => {
      queueMicrotask(() => {
        if (opts.signal.aborted) {
          request.emit("error", Error("aborted"));
          return;
        }
        const fixture = responses[calls++] ?? {};
        opts.lookup(url.hostname, { all: true }, (err, result) => seen.push(result));
        const response =
          fixture.body instanceof Readable
            ? fixture.body
            : Readable.from(fixture.body ?? [Buffer.from("public bytes")]);
        response.socket = { remoteAddress: fixture.address ?? "93.184.216.34" };
        response.statusCode = fixture.status ?? 200;
        response.headers = fixture.headers ?? {};
        opts.signal.addEventListener("abort", () => response.destroy(Error("aborted")), { once: true });
        callback(response);
      });
    };
    return request;
  };
  return {
    io: {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request,
      requestTls: request,
      timeoutMs: 1000,
      maxBytes: 100,
      ...overrides,
    },
    seen,
  };
}
test("public download pins validated DNS and supports the Node all-address lookup callback", async () => {
  const { io, seen } = mockNetwork([{}]);
  assert.equal((await publicMedia("https://public.example/a", io)).buffer.toString(), "public bytes");
  assert.deepEqual(seen, [[{ address: "93.184.216.34", family: 4 }]]);
});
test("redirect is revalidated and an internal destination is never requested", async () => {
  const { io, seen } = mockNetwork([{ status: 302, headers: { location: "http://127.0.0.1/private" } }]);
  await assert.rejects(publicMedia("https://public.example/a", io), { code: "MEDIA_ACCESS_DENIED" });
  assert.equal(seen.length, 1);
});
test("effective socket address is validated independently of DNS", async () => {
  const { io } = mockNetwork([{ address: "10.0.0.1" }]);
  await assert.rejects(publicMedia("https://public.example/a", io), { code: "MEDIA_ACCESS_DENIED" });
});
test("unknown-length download stops while crossing the byte limit", async () => {
  let chunks = 0;
  async function* body() {
    for (let i = 0; i < 100; i++) {
      chunks++;
      yield Buffer.alloc(30);
    }
  }
  const { io } = mockNetwork([{ body: body() }]);
  await assert.rejects(publicMedia("https://public.example/a", io), { code: "FILE_TOO_LARGE" });
  assert.ok(chunks < 100);
});
test("DNS resolution shares the whole-transfer deadline", async () => {
  const { io } = mockNetwork([], { resolve: () => new Promise(() => {}), timeoutMs: 20 });
  await assert.rejects(publicMedia("https://public.example/a", io), /timed out/);
});
test("redirect count is bounded", async () => {
  const { io, seen } = mockNetwork(Array.from({ length: 7 }, () => ({ status: 302, headers: { location: "/again" } })));
  await assert.rejects(publicMedia("https://public.example/a", io), /5 redirects/);
  assert.equal(seen.length, 6);
});
test("body streaming shares the transfer timeout", async () => {
  const body = new Readable({ read() {} });
  const { io } = mockNetwork([{ body }], { timeoutMs: 20 });
  await assert.rejects(publicMedia("https://public.example/a", io));
  assert.equal(body.destroyed, true);
});

test("HTTP session limits hold during concurrent initialization and idle sessions expire", async (t) => {
  const stop = new AbortController();
  t.after(() => stop.abort());
  const port = await startHttpEndpoint(
    { getStatus: () => ({ status: "connected", status_since: new Date().toISOString() }) },
    offlineConfig("wazap-cap-"),
    {
      host: "127.0.0.1",
      port: 0,
      credentials: [{ token: "read", write: false }],
      openRead: false,
      signal: stop.signal,
      sessionIdleMs: 150,
    },
  );
  const headers = {
    Authorization: "Bearer read",
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  const init = () =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "caps", version: "1" } },
      }),
    });
  const results = await Promise.all(Array.from({ length: 20 }, init));
  const accepted = results.filter((r) => r.status === 200);
  assert.equal(accepted.length, 8);
  assert.equal(results.filter((r) => r.status === 429).length, 12);
  await Promise.all(results.map((r) => r.text()));
  await new Promise((r) => setTimeout(r, 200));
  const expired = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { ...headers, "mcp-session-id": accepted[0].headers.get("mcp-session-id") },
  });
  assert.equal(expired.status, 404);
  await expired.text();
  const next = await init();
  assert.equal(next.status, 200);
  await next.text();
});
test("startup converts an interrupted send to unknown and refuses automatic retransmission", async (t) => {
  const { svc } = service(t, { readOnly: false, persistHistory: true });
  await svc.ensureArchive();
  const entry = {
    draft: {
      id: "interrupted",
      expiresAt: Date.now() + 60000,
      payload: { kind: "text", chatId: PEER, text: "must not resend" },
    },
    principal: "local",
    state: "sending",
    messageId: "durable-id",
  };
  await svc.archive.call("outboxPut", { id: entry.draft.id, value: entry });
  await svc.stop();
  const revived = new WhatsAppService(svc.config);
  revived.account = svc.account;
  t.after(() => revived.stop());
  await assert.rejects(revived.confirm("interrupted"), { code: "SEND_OUTCOME_UNKNOWN" });
  assert.equal(revived.getStatus().archive.unknown_sends, 1);
});
test("startup expires old drafts and removes their private attachment", async (t) => {
  const { svc } = service(t, { readOnly: false, persistHistory: true });
  await svc.ensureArchive();
  const file = join(svc.config.dataDir, "prepared.txt");
  await writeFile(file, "expired");
  const entry = {
    draft: {
      id: "old-draft",
      expiresAt: 1,
      payload: { kind: "media", chatId: PEER, source: { file_path: file }, prepared: true },
    },
    principal: "local",
    state: "draft",
    messageId: "expired-id",
  };
  await svc.archive.call("outboxPut", { id: entry.draft.id, value: entry });
  await svc.stop();
  const revived = new WhatsAppService(svc.config);
  revived.account = svc.account;
  t.after(() => revived.stop());
  await revived.loadOutbox();
  await assert.rejects(readFile(file), { code: "ENOENT" });
  assert.equal(revived.outbox.get("old-draft").state, "expired");
});
test("corrupt migration is refused and keeps source input", async (t) => {
  const { svc } = service(t, { persistHistory: true });
  await mkdir(join(svc.config.dataDir, "history"));
  const file = join(svc.config.dataDir, "history", "broken.jsonl");
  await writeFile(file, "{broken}\n");
  await assert.rejects(svc.loadPersisted(), /broken.jsonl:1/);
  assert.equal(await readFile(file, "utf8"), "{broken}\n");
  assert.equal(svc.archive.migrated, false);
  svc.archive.error = null;
});
test("ownerless import remains deferred", async (t) => {
  const { svc } = service(t, { persistHistory: true });
  svc.account = null;
  await assert.rejects(svc.ensureArchive(), /owner is known/);
  await assert.rejects(readFile(join(svc.config.dataDir, "archive.sqlite")), { code: "ENOENT" });
  svc.archive.error = null;
});
test("persistence disabled never imports or writes message history", async (t) => {
  const { svc, sock } = service(t, { persistHistory: false });
  await mkdir(join(svc.config.dataDir, "history"));
  await writeFile(join(svc.config.dataDir, "history", "bad.jsonl"), "malformed");
  sock.ev.emit("messages.upsert", { type: "notify", messages: [raw("memory", "ephemeral in-memory message")] });
  assert.equal((await svc.searchMessages("in-memory", PEER, 10)).data.length, 1);
  await assert.rejects(readFile(join(svc.config.dataDir, "archive.sqlite")), { code: "ENOENT" });
});

test("retraction erases embedded quotes and transcript text; stale quotes do not restore it", async (t) => {
  const { svc, sock } = service(t);
  const source = raw("source", "private phrase");
  const quote = {
    ...raw("quote", ""),
    message: {
      extendedTextMessage: {
        text: "reply",
        contextInfo: { stanzaId: "source", participant: PEER, quotedMessage: { conversation: "private phrase" } },
      },
    },
  };
  sock.ev.emit("messages.upsert", { type: "notify", messages: [source, quote] });
  const sid = `false_${PEER}_source`,
    qid = `false_${PEER}_quote`;
  assert.equal((await svc.getMessage(qid)).quoted.text, "private phrase");
  await svc.archive.call("extra", {
    sid,
    extra: { transcript: { text: "private transcription" } },
    text: "private transcription",
  });
  sock.ev.emit("messages.update", [{ key: source.key, update: { message: null } }]);
  assert.equal((await svc.getMessage(qid)).quoted, undefined);
  assert.deepEqual((await svc.searchMessages("private", PEER, 20)).data, []);
  sock.ev.emit("messages.upsert", { type: "append", messages: [quote, source] });
  assert.equal((await svc.getMessage(qid)).quoted, undefined);
  assert.equal((await svc.getMessage(sid)).text, "[deleted]");
});
test("offline expiry is applied on reopening and active snapshots do not duplicate chat content", async (t) => {
  const { svc, sock } = service(t, { persistHistory: true });
  const expired = {
    ...raw("expiry", ""),
    message: { extendedTextMessage: { text: "offline secret", contextInfo: { expiration: 1 } } },
    ephemeralStartTimestamp: Math.floor(Date.now() / 1000) - 10,
  };
  sock.ev.emit("messages.upsert", { type: "append", messages: [expired] });
  await svc.archiveBarrier();
  svc.markStoreDirty();
  await svc.flushStore();
  const snapshot = await readFile(join(svc.config.dataDir, "state.json"), "utf8");
  assert.ok(!snapshot.includes("offline secret"));
  await svc.stop();
  const revived = new WhatsAppService(svc.config);
  revived.account = svc.account;
  revived.status = "connected";
  revived.sockClient = {};
  revived.initialSyncDone = true;
  t.after(() => revived.stop());
  await revived.loadPersisted();
  assert.equal((await revived.getMessage(`false_${PEER}_expiry`)).text, "[deleted]");
});
test("message cache has a global bound across many conversations", async () => {
  const { Store } = await import("../dist/store.js");
  const cache = new Store();
  for (let i = 0; i < 12000; i++) cache.putMessage("m" + i, "chat" + i, raw("m" + i, "content"));
  assert.equal(cache.messages.size, 10000);
});

test("HTTP export rejects a hard link to an internal file", async () => {
  const { link } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "wazap-hardlink-"));
  const data = join(root, "internal"),
    exports = join(root, "exports");
  await mkdir(data);
  await mkdir(exports);
  const secret = join(data, "credentials.json");
  await writeFile(secret, "synthetic credentials");
  const offered = join(exports, "offered.txt");
  await link(secret, offered);
  await assert.rejects(readAllowedFile(offered, { dataDir: data, exportDir: exports }), {
    code: "MEDIA_ACCESS_DENIED",
  });
});
test("an unexpected archive worker exit fails later operations promptly", async (t) => {
  const a = await archive(t);
  await a.worker.terminate();
  await assert.rejects(a.call("query"), { code: "ARCHIVE_UNAVAILABLE" });
  assert.match(a.error, /stopped unexpectedly/);
});
test("a pending transcription is persisted before shutdown closes its archive", async (t) => {
  const { svc, sock } = service(t, { readOnly: false, persistHistory: true });
  svc.transcribe = { provider: "local", language: "auto" };
  const message = { ...raw("voice-stop", ""), message: { audioMessage: { ptt: true, mimetype: "audio/ogg" } } };
  sock.ev.emit("messages.upsert", { type: "append", messages: [message] });
  await svc.archiveBarrier();
  const sid = `false_${PEER}_voice-stop`;
  let finish;
  const waiting = new Promise((r) => (finish = r));
  const work = svc.guarded(async () => {
    await waiting;
    svc.store.transcripts.set(sid, { text: "saved during shutdown", provider: "local", at: Date.now() });
    await svc.appendHistory([message]);
  });
  const closing = svc.stop();
  finish();
  await work;
  await closing;
  const archive = new Archive();
  await archive.open(join(svc.config.dataDir, "archive.sqlite"), ME);
  t.after(() => archive.close());
  assert.equal((await archive.call("query", { query: "saved during shutdown" })).length, 1);
});

test("a sync deadline yields partial until the real completion signal", async (t) => {
  const { svc, sock } = service(t);
  await svc.ensureArchive();
  svc.initialSyncDone = false;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  svc.armSyncDeadline();
  t.mock.timers.tick(10000);
  assert.equal(svc.getStatus().sync, "partial");
  const page = await svc.readMessages(PEER, 20);
  assert.equal(page.sync, "partial");
  assert.equal(page.coverage.phone_history, "unknown");
  sock.ev.emit("messaging-history.set", { messages: [], chats: [], contacts: [], isLatest: true });
  assert.equal(svc.getStatus().sync, "done");
  t.mock.timers.reset();
});

test("message keys containing underscores remain distinct", async (t) => {
  const a = await archive(t);
  const one = `false_${PEER}_first_suffix`,
    two = `false_${PEER}_second_suffix`;
  await a.call("batch", { rows: [row(one, 1, "one"), row(two, 2, "two")] });
  assert.equal((await a.call("coverage")).count, 2);
  await a.call("erase", { sid: one, jid: PEER });
  assert.equal((await a.call("get", { sid: two })).text, "two");
});

test("a late LID mapping merges duplicate deliveries and both returned IDs remain usable", async (t) => {
  const a = await archive(t);
  const lid = "321@lid",
    old = `false_${lid}_duplicate`,
    pn = `false_${PEER}_duplicate`;
  await a.call("batch", { rows: [{ ...row(old, 1, "same"), jid: lid }, row(pn, 1, "same")] });
  await a.call("alias", { alias: lid, jid: PEER });
  assert.equal((await a.call("query", { jid: PEER })).length, 1);
  assert.equal((await a.call("get", { sid: old })).sid, old);
  assert.equal((await a.call("get", { sid: pn })).sid, old);
  await a.call("erase", { sid: pn, jid: PEER });
  assert.equal((await a.call("get", { sid: old })).deleted, 1);
});

test("termination during migration rolls back and a later import succeeds", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wazap-interrupted-import-")),
    file = join(dir, "archive.sqlite");
  const a = await archive(t, file);
  const pending = a
    .call("migrate", { rows: Array.from({ length: 10000 }, (_, i) => row("large" + i, i, "synthetic ".repeat(100))) })
    .catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await a.worker.terminate();
  assert.ok((await pending) instanceof Error);
  const reopened = await archive(t, file);
  assert.equal(reopened.migrated, false);
  assert.equal((await reopened.call("coverage")).count, 0);
  await reopened.call("migrate", { rows: [row("retry", 1, "retry worked")] });
  assert.equal((await reopened.call("coverage")).count, 1);
});

test("idle expiry does not interrupt an active tool call", async (t) => {
  const stop = new AbortController();
  t.after(() => stop.abort());
  let entered, release;
  const began = new Promise((r) => (entered = r)),
    waiting = new Promise((r) => (release = r));
  const wa = {
    getStatus: () => ({ status: "connected", status_since: new Date().toISOString() }),
    readMessages: async () => {
      entered();
      await waiting;
      return { data: [], sync: "done" };
    },
  };
  const port = await startHttpEndpoint(wa, offlineConfig("wazap-active-"), {
    host: "127.0.0.1",
    port: 0,
    credentials: [{ token: "active", write: false }],
    openRead: false,
    signal: stop.signal,
    sessionIdleMs: 50,
  });
  let sid;
  const request = (body) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer active",
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(sid ? { "mcp-session-id": sid } : {}),
      },
      body: JSON.stringify(body),
    });
  const init = await request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "active", version: "1" } },
  });
  sid = init.headers.get("mcp-session-id");
  await init.text();
  const notified = await request({ jsonrpc: "2.0", method: "notifications/initialized" });
  await notified.text();
  const running = request({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "read_messages", arguments: { chat_id: PEER, include_previews: false } },
  });
  await began;
  await new Promise((r) => setTimeout(r, 100));
  const list = await request({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.equal(list.status, 200);
  await list.text();
  release();
  const result = await running;
  assert.equal(result.status, 200);
  assert.ok(!(await result.text()).includes('isError":true'));
});

test('hosted clients can make more than eight sequential sessions without evicting in-flight calls', {timeout:15000}, async(t)=>{
 const stop=new AbortController();t.after(()=>stop.abort());
 const waiting=[]; let ready;const allWaiting=new Promise(r=>ready=r);
 const port=await startHttpEndpoint({waitForMessages:()=>new Promise(resolve=>{waiting.push(resolve);if(waiting.length===8)ready();})},offlineConfig('wazap-recycle-'),{host:'127.0.0.1',port:0,credentials:[{token:'recycle-caller',write:false}],openRead:false,signal:stop.signal});
 const headers={Authorization:'Bearer recycle-caller',Accept:'application/json, text/event-stream','Content-Type':'application/json'};
 const post=(body,sid)=>fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{...headers,...(sid?{'mcp-session-id':sid}:{})},body:JSON.stringify(body)});
 const init=()=>post({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'hosted-client',version:'1'}}});
 const ids=[];
 for(let i=0;i<20;i++){
  const r=await init();assert.equal(r.status,200,await r.clone().text());ids.push(r.headers.get('mcp-session-id'));await r.text();
  const listed=await post({jsonrpc:'2.0',id:2,method:'tools/list',params:{}},ids.at(-1));assert.equal(listed.status,200);await listed.text();
 }
 const evicted=await post({jsonrpc:'2.0',id:3,method:'tools/list',params:{}},ids[0]);assert.equal(evicted.status,404);await evicted.text();
 const active=ids.slice(-8).map(sid=>post({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'wait_for_messages',arguments:{timeout_seconds:5}}},sid).then(async r=>({status:r.status,body:await r.text()})));
 await allWaiting;
 const refused=await init();assert.equal(refused.status,429);await refused.text();
 for(const release of waiting)release({messages:[],cursor:'fixture',timed_out:true});
 const results=await Promise.all(active);assert.ok(results.every(r=>r.status===200));
 const resumed=await init();assert.equal(resumed.status,200);await resumed.text();
});
