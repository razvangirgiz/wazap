import { Archive } from "../dist/archive.js";
import assert from "node:assert/strict";
const a = new Archive();
await a.open("/scratch/archive.sqlite", "fixture");
try {
  await assert.rejects(
    a.call("migrate", {
      rows: Array.from({ length: 100 }, (_, i) => ({
        sid: "m" + i,
        jid: "chat",
        ts: i,
        sender: "p",
        type: "text",
        text: "a".repeat(50000),
        raw: "",
        extra: {},
      })),
    }),
    /full/i,
  );
  assert.equal((await a.call("coverage")).count, 0);
  console.log("Disk full: import refused, transaction rolled back, archive count=0");
} finally {
  await a.close();
}
