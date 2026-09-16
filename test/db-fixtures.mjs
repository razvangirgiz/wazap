/**
 * Shared plumbing for the account database tests: a throwaway file, a clock
 * the test moves, and message builders that spell sids the way the service does.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountDb, contentHash } from "../dist/db/index.js";

export const ME = "40700000001@s.whatsapp.net";
export const PEER = "40700000002@s.whatsapp.net";
export const PEER_LID = "123456789012345@lid";
export const GROUP = "120363000000000001@g.us";
/** 1 Sept 2026, 10:00:00 UTC — a whole second, so `T0 + n * 1000` stays on second boundaries. */
export const T0 = Date.UTC(2026, 8, 1, 10, 0, 0);

export function tempDir(prefix = "wazap-db-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A database in a fresh account directory, with a clock the test controls. */
export function openTemp(options = {}) {
  const dir = tempDir();
  const path = join(dir, "accounts", "default", "wazap.sqlite");
  const clock = { now: T0 + 3_600_000 };
  const db = AccountDb.open(path, { now: () => clock.now, checkpointDelayMs: 0, ...options });
  return { db, dir, path, clock };
}

export function sid(fromMe, chat, key) {
  return `${fromMe}_${chat}_${key}`;
}

/** An incoming text message; `extra` overrides any field. */
export function textMessage(chat, key, ts, text, extra = {}) {
  const fromMe = extra.fromMe ?? false;
  return {
    sid: sid(fromMe, chat, key),
    chatJid: chat,
    keyId: key,
    fromMe,
    ts,
    type: "text",
    text,
    raw: new Uint8Array([0x0a, key.length, ...Buffer.from(key)]),
    ...extra,
  };
}

/** Ids of a page, for comparisons that should not care about the rest of the row. */
export function sids(items) {
  return items.map((item) => item.sid ?? item.message.sid);
}

/** The contentHash of what a message says now: what the backlog would hand an embedder. */
export function wordsOf(db, messageSid) {
  const message = db.messages.get(messageSid, { includeHidden: true });
  return message === null ? "unknown" : contentHash(message.text, message.transcript);
}
