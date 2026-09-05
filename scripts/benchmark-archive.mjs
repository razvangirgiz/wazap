import { proto } from "baileys";
import { Store } from "../dist/store.js";
import { Archive } from "../dist/archive.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = await mkdtemp(join(tmpdir(), "wazap-benchmark-"));
const file = join(dir, "archive.sqlite");
const a = new Archive();
await a.open(file, "synthetic");
const cache = new Store();
const start = performance.now();
for (let offset = 0; offset < 100000; offset += 1000) {
  for (let i = 0; i < 1000; i++) {
    const n = offset + i;
    cache.putMessage(`false_chat_${n}`, "chat", {
      key: { id: String(n), remoteJid: "chat", fromMe: false },
      message: { conversation: `factură septembrie ${n}` },
      messageTimestamp: n,
    });
  }
  await a.call("batch", {
    rows: Array.from({ length: 1000 }, (_, i) => {
      const n = offset + i;
      return {
        sid: `false_chat_${String(n).padStart(8, "0")}`,
        jid: "chat",
        sender: "peer",
        ts: n,
        type: "text",
        text: `factură septembrie ${n}`,
        raw: Buffer.from(
          proto.WebMessageInfo.encode({
            key: { id: String(n), remoteJid: "chat", fromMe: false },
            message: { conversation: `factură septembrie ${n}` },
            messageTimestamp: n,
          }).finish(),
        ).toString("base64"),
        extra: {},
      };
    }),
  });
}
const ingestMs = performance.now() - start;
const searchStart = performance.now();
const hits = await a.call("query", { query: "factură septembrie 12345", limit: 50 });
const searchMs = performance.now() - searchStart;
let before;
let count = 0;
const seen = new Set();
const pagingStart = performance.now();
for (;;) {
  const rows = await a.call("query", { limit: 500, before });
  if (!rows.length) break;
  for (const r of rows) {
    if (seen.has(r.sid)) throw Error("Duplicate page result");
    seen.add(r.sid);
  }
  count += rows.length;
  before = rows.at(-1);
}
if (count !== 100000 || hits.length !== 1 || cache.messages.size > 1000) throw Error("Archive benchmark lost messages");
console.log(
  JSON.stringify(
    {
      messages: count,
      cachedMessages: cache.messages.size,
      ingestMs,
      searchMs,
      pagingMs: performance.now() - pagingStart,
      rssMiB: process.memoryUsage().rss / 1048576,
      file,
    },
    null,
    2,
  ),
);
await a.close();
const cold = performance.now();
const b = new Archive();
await b.open(file, "synthetic");
console.log(JSON.stringify({ reopenMs: performance.now() - cold, count: (await b.call("coverage")).count }));
await b.close();
