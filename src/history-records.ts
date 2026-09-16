import type { HistoryRecord } from "./store.js";

/** Observe every version before deduplication: a stripped edit must not hide
 * an older expiry deadline. Tombstones remain independent of record order. */
export function historyRecords(text: string, observe: (record: HistoryRecord) => void): {
  newest: Map<string, HistoryRecord>; tombstones: Map<string, HistoryRecord>;
} {
  const newest = new Map<string, HistoryRecord>();
  const tombstones = new Map<string, HistoryRecord>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as HistoryRecord;
      if (!record?.sid) continue;
      observe(record);
      if (record.deleted) tombstones.set(record.sid, record);
      else if (record.raw) newest.set(record.sid, record);
    } catch { /* Damaged cache lines are not replayed. */ }
  }
  return { newest, tombstones };
}
