/** Synthetic capacity probe using the real manager, SQLite workers and aggregate MCP handler. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "baileys";
import { Accounts } from "../dist/accounts.js";
import { AccountManager } from "../dist/account-manager.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { parseCli } from "../dist/config.js";
import { registerTools } from "../dist/tools.js";
const root = mkdtempSync(join(tmpdir(), "wazap-multi-benchmark-"));
const registry = new Accounts(root);
const accounts = Array.from({ length: 3 }, (_, i) => {
  const a = registry.add(`Synthetic ${i + 1}`);
  registry.bind(a.id, `4070000000${i + 1}@s.whatsapp.net`);
  registry.enable(a.id, false);
  return a;
});
const config = parseCli(["serve", "--data-dir", root, "--read-only"]).config;
const runtimes = new Map();
const factory = (c) => {
  const svc = new WhatsAppService(c);
  runtimes.set(c.accountId, svc);
  return svc;
};
const manager = new AccountManager(config, factory);
const start = performance.now();
await manager.start();
const startupMs = performance.now() - start;
const ingest = performance.now();
const base = Math.floor((Date.now() - 100_010_000) / 1000) * 1000;
try {
  for (let offset = 0; offset < 100000; offset += 1000) {
    await Promise.all(
      accounts.map(async (a) => {
        const svc = runtimes.get(a.id),
          rows = [];
        for (let i = offset; i < offset + 1000; i++) {
          const jid = `40722222${String(i % 20).padStart(3, "0")}@s.whatsapp.net`,
            key = String(i).padStart(8, "0"),
            sid = `false_${jid}_${key}`;
          const text = `Synthetic message ${i}${i === 12345 ? " capacity needle" : ""}`;
          const raw = {
            key: { id: key, remoteJid: jid, fromMe: false },
            message: { conversation: text },
            messageTimestamp: (base + i * 1000) / 1000,
          };
          svc.store.putMessage(sid, jid, raw);
          rows.push({
            sid,
            jid,
            ts: base + i * 1000,
            sender: jid,
            type: "text",
            text,
            raw: Buffer.from(
              proto.WebMessageInfo.encode(raw).finish(),
            ).toString("base64"),
            extra: {},
          });
        }
        await svc.archive.call("batch", { rows });
      }),
    );
  }
  const ingestMs = performance.now() - ingest;
  const tools = new Map();
  registerTools(
    {
      registerTool(name, meta, handler) {
        tools.set(name, handler);
      },
    },
    manager,
    { allowWrite: false },
  );
  const search = performance.now();
  const found = await tools.get("search_messages")({
    all_accounts: true,
    query: "capacity needle",
    limit: 50,
  });
  const searchMs = performance.now() - search;
  assert.equal(
    found.structuredContent.messages.length,
    3,
    JSON.stringify(found.structuredContent),
  );
  const paging = performance.now();
  let cursor,
    pages = 0;
  const seen = new Set();
  do {
    const page = await tools.get("get_recent_messages")({
      all_accounts: true,
      hours: 168,
      filter: "all",
      include_system: false,
      limit: 500,
      cursor,
    });
    assert.ok(!page.isError, JSON.stringify(page));
    assert.equal(page.structuredContent.partial, false);
    for (const c of page.structuredContent.conversations)
      for (const m of c.messages) {
        const key = `${m.account_id}:${m.message_id}`;
        assert.ok(!seen.has(key), "Duplicate aggregate page result");
        seen.add(key);
      }
    cursor = page.structuredContent.next_cursor;
    pages++;
  } while (cursor);
  const pagingMs = performance.now() - paging;
  const cacheSizes = accounts.map(
    (a) => runtimes.get(a.id).store.messages.size,
  );
  assert.equal(seen.size, 300000);
  assert.ok(cacheSizes.reduce((n, v) => n + v, 0) <= 10000);
  const result = {
    accounts: 3,
    messages: seen.size,
    pages,
    cachedMessages: cacheSizes,
    startupMs,
    ingestMs,
    searchMs,
    pagingMs,
    rssMiB: process.memoryUsage().rss / 1048576,
  };
  await manager.stop();
  const reopen = performance.now();
  const cold = new AccountManager(config, factory);
  await cold.start();
  result.reopenMs = performance.now() - reopen;
  result.reopenedCounts = await Promise.all(
    accounts.map((a) =>
      runtimes
        .get(a.id)
        .archive.call("coverage")
        .then((c) => c.count),
    ),
  );
  assert.deepEqual(result.reopenedCounts, [100000, 100000, 100000]);
  await cold.stop();
  console.log(JSON.stringify(result, null, 2));
} finally {
  await manager.stop();
}
