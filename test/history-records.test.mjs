import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyRecords } from "../dist/history-records.js";
import { MessageRetention } from "../dist/message-retention.js";

test("history observes every version before keeping the latest, with independent tombstones", () => {
  const versions = [{ sid: "a", ts: 1, raw: "old", expiresAt: 10 }, { sid: "a", ts: 2, deleted: true, raw: "" }, { sid: "a", ts: 3, raw: "edited" }];
  const seen = [];
  const { newest, tombstones } = historyRecords(versions.map(JSON.stringify).join("\n"), row => seen.push(row));
  assert.deepEqual(seen, versions);
  assert.deepEqual(newest.get("a"), versions[2]);
  assert.deepEqual(tombstones.get("a"), versions[1]);
});
test("damaged history and rejected observations are not replayed", () => {
  const { newest, tombstones } = historyRecords('\nnull\n{broken\n{}\n{"sid":"a","raw":"bad"}', () => { throw Error("synthetic"); });
  assert.equal(newest.size, 0); assert.equal(tombstones.size, 0);
});
test("history cleanup groups barriers once and does not rewrite unchanged tombstone files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wazap-history-cost-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const retention = new MessageRetention();
  const file = jid => join(dir, `${jid}.jsonl`);
  for (let i = 0; i < 20; i++) {
    const rows = [];
    for (let j = 0; j < 10; j++) {
      const sid = `false_${i}@g.us_${j}`;
      retention.deleted.set(sid, `${i}@g.us`);
      rows.push({ sid, ts: 1, raw: "", deleted: true });
    }
    await writeFile(file(`${i}@g.us`), rows.map(JSON.stringify).join("\n") + "\n");
  }
  const before = await stat(file("0@g.us"));
  let mapped = 0;
  await retention.purgeHistory(dir, jid => { mapped++; return file(jid); }, () => false);
  assert.equal(mapped, 200, "linear mapping, not all barriers per file");
  assert.equal((await stat(file("0@g.us"))).ino, before.ino, "no rename for identical content");
  assert.equal(JSON.parse((await readFile(file("0@g.us"), "utf8")).split("\n")[0]).ts, 1);
});
test("invalid internal deadlines fail closed instead of causing an endless timer", () => {
  for (const deadline of [NaN, Infinity, -1, 0.5]) {
    const retention = new MessageRetention(); retention.noteExpiry("a", "chat", deadline);
    assert.equal(retention.nextExpiry(), 0);
    assert.equal(retention.allows("a", "chat", 1), false);
    assert.deepEqual(retention.expire(), ["a"]);
  }
});
