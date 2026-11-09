/**
 * Write-ahead log checkpoints off the commit path: commits stop checkpointing
 * below a ~40 MB backstop, and a passive checkpoint from a timer moves the log
 * into the database file once writes go quiet (or at least every 15 s under a
 * steady trickle, which a test cannot wait for).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { AccountDb } from "../dist/db/index.js";
import { sqlite } from "../dist/db/sqlite.js";
import { PEER, T0, openTemp, textMessage } from "./db-fixtures.mjs";
import { waitFor } from "./helpers.mjs";

/** The messages the database file itself holds, the log left unread. */
function inFile(path) {
  const reader = new (sqlite().DatabaseSync)(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
  try {
    return reader.prepare("SELECT count(*) AS n FROM messages").get().n;
  } finally {
    reader.close();
  }
}

const pragma = (db, name) => Object.values(db.connection.db.prepare(`PRAGMA ${name}`).get())[0];

test("writes gone quiet are checkpointed into the database file by a timer, not by a commit", async () => {
  const { db, path } = openTemp({ idleCheckpointMs: 30 });
  try {
    assert.equal(pragma(db, "wal_autocheckpoint"), 10_000, "commits only checkpoint past the backstop");
    // A new file's schema is itself still in the log.
    db.checkpoint();
    db.messages.upsert(textMessage(PEER, "A", T0, "salut"));
    db.messages.upsert(textMessage(PEER, "B", T0 + 1000, "ce faci"));
    assert.equal(inFile(path), 0, "the commits left their pages in the log");
    await waitFor(() => inFile(path) === 2, 3000, "the idle checkpoint");
    // Reads still see everything, and later writes arm the timer again.
    db.messages.upsert(textMessage(PEER, "C", T0 + 2000, "bine"));
    await waitFor(() => inFile(path) === 3, 3000, "the next idle checkpoint");
    assert.equal(db.messages.chatPage(PEER, { limit: 10 }).items.length, 3);
  } finally {
    db.close();
  }
});

test("idleCheckpointMs 0 leaves checkpoints to SQLite, inside the commit, as before", () => {
  const { db } = openTemp({ idleCheckpointMs: 0 });
  try {
    assert.equal(pragma(db, "wal_autocheckpoint"), 1000);
    assert.equal(pragma(db, "journal_size_limit"), -1);
  } finally {
    db.close();
  }
});

test("a read-only open sets none of it", () => {
  const { db, path } = openTemp();
  db.messages.upsert(textMessage(PEER, "A", T0, "salut"));
  db.close();
  const ro = AccountDb.open(path, { readOnly: true });
  try {
    assert.equal(pragma(ro, "wal_autocheckpoint"), 1000);
    assert.equal(ro.messages.chatPage(PEER, { limit: 10 }).items.length, 1);
  } finally {
    ro.close();
  }
});
