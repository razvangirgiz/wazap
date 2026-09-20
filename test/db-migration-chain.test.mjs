/**
 * The upgrade path a user really walks: a file written by any released schema
 * version reaches the current one, whole. Every fixture here is built through
 * the released migration SQL and plain inserts — never through today's
 * writers, which would put today's shape into a file that is meant to be old.
 *
 * What is proven, from every historical version: the schema ends up the one a
 * new file gets, object for object; every row the file held is still there and
 * still says the same thing; the trigram index answers after the upgrade;
 * SQLite's own integrity_check and foreign_key_check pass; and a second open
 * changes nothing.
 *
 * db-v5.test.mjs asserts what v5 works out from an older file (flags,
 * last_own_id, catch-up marks). This file asserts the chain itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { AccountDb, SCHEMA_VERSION, contentHash } from "../dist/db/index.js";
import { MIGRATIONS } from "../dist/db/schema.js";
import { sqlite } from "../dist/db/sqlite.js";
import { GROUP, ME, PEER, PEER_LID, T0, sid, tempDir, textMessage } from "./db-fixtures.mjs";

/** Every version a released wazap ever wrote. Each one must reach SCHEMA_VERSION. */
const RELEASED = MIGRATIONS.map((migration) => migration.version);
const SEQ = 1048576;
const DAY = 86_400_000;
const DIMS = 768;
const MODEL = "embeddinggemma-300m";
const PEER2 = "40700000003@s.whatsapp.net";

/** A message id: the second it belongs to, then a place inside it (ids.ts). */
const idAt = (ts, seq) => (ts / 1000) * SEQ + seq;
const sorted = (items) => items.map((item) => item.sid).sort();

/** A quantized vector, the shape the recall index stores. */
function vector(i) {
  const out = new Int8Array(DIMS);
  for (let d = 0; d < DIMS; d++) out[d] = ((d * 31 + i * 17) % 200) - 100;
  return out;
}
/**
 * A file at `version`, holding what an account of that version held: contacts
 * and their lid pairings, four chats (one folding into another, one cleared
 * through a barrier), messages both ways with a tombstone, a voice note with
 * its transcript and one still waiting for it, media, reactions, votes,
 * receipts, notes, a handled mark, embeddings and the queue beside them, and —
 * from the version that first had them — sends, the transcription queue and
 * outbox events. Written through the released migration SQL only.
 *
 * `wal` leaves the file in write-ahead logging and the connection open, so a
 * caller can copy the file and its log the way a crash leaves them. `data`
 * off writes the schema alone: an account that had not stored anything yet.
 */
function releasedFile(version, { dir = join(tempDir("wazap-chain-"), "account"), wal = false, data = true } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "wazap.sqlite");
  const db = new (sqlite().DatabaseSync)(path);
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.exec(migration.sql);
    db.exec(`PRAGMA user_version = ${migration.version}`);
  }
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const ids = {};
  if (!data) {
    db.exec("COMMIT");
    if (wal) return { path, dir, ids, db };
    db.close();
    return { path, dir, ids, db: null };
  }

  run("INSERT INTO meta(key, value) VALUES ('owner', ?)", ME);
  run("INSERT INTO meta(key, value) VALUES ('created_at', ?)", String(T0 - DAY));
  // A model is being fed, so every message stored queues for it: the state a
  // recall-enabled account is in when it upgrades.
  run("INSERT INTO meta(key, value) VALUES ('embed_model', ?)", MODEL);

  run("INSERT INTO contacts(id, phone_jid, name, notify, listed, updated_at) VALUES (1, ?, 'Ana Pop', 'Ana', 1, ?)", PEER, T0);
  run("INSERT INTO contacts(id, lid, push_name, updated_at) VALUES (2, ?, 'Ana', ?)", PEER_LID, T0);
  run("INSERT INTO contacts(id, phone_jid, push_name, updated_at) VALUES (3, ?, 'Bogdan', ?)", PEER2, T0);
  run("INSERT INTO lid_phones(lid, phone_jid, learned_at) VALUES (?, ?, ?)", PEER_LID, PEER, T0);

  run("INSERT INTO chats(id, jid, kind, contact_id, unread) VALUES (1, ?, 'direct', 1, 2)", PEER);
  run("INSERT INTO chats(id, jid, kind, name) VALUES (2, ?, 'group', 'Fotbal marți')", GROUP);
  // A lid chat a fold had not finished moving when the file was last closed.
  run("INSERT INTO chats(id, jid, kind, contact_id, merged_into) VALUES (3, ?, 'direct', 2, 1)", PEER_LID);
  run("INSERT INTO chats(id, jid, kind, contact_id) VALUES (4, ?, 'direct', 3)", PEER2);

  let seq = 0;
  const message = (name, chatId, keyId, fromMe, ts, fields = {}) => {
    const id = idAt(ts, seq++);
    run(
      `INSERT INTO messages(id, chat_id, key_id, from_me, sender_id, ts, type, text, transcript, transcript_info, status, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      chatId,
      keyId,
      fromMe ? 1 : 0,
      fromMe ? null : chatId === 1 ? 1 : 3,
      ts,
      fields.type ?? "text",
      fields.text ?? null,
      fields.transcript ?? null,
      fields.transcriptInfo ?? null,
      fields.status ?? null,
      new Uint8Array([0x0a, keyId.length, ...Buffer.from(keyId)])
    );
    ids[name] = id;
    return id;
  };

  message("ana1", 1, "A1", false, T0 + 1_000, { text: "Salut, ajungem la sase?" });
  message("ana2", 1, "A2", true, T0 + 2_000, { text: "Da, ajung la sase fix" });
  message("anaGone", 1, "A3", false, T0 + 3_000, { text: "un mesaj care dispare" });
  message("voice", 1, "V1", false, T0 + 4_000, { type: "audio", transcript: "transcrierea notei vocale", transcriptInfo: '{"by":"local"}' });
  message("waiting", 1, "V2", false, T0 + 5_000, { type: "audio" });
  message("lid", 3, "L1", true, T0 + 6_000, { text: "trimis pe lid, inainte de fold" });
  message("group1", 2, "G1", false, T0 + 7_000, { text: "Cine vine marti?" });
  message("group2", 2, "G2", true, T0 + 8_000, { text: "Vin si eu", status: 3 });
  message("hidden", 4, "H1", false, T0 + 9_000, { text: "sub bariera" });
  message("shown", 4, "H2", true, T0 + 11_000, { text: "dupa bariera" });

  // The barrier goes up after its messages, the way a clear really happens.
  run("UPDATE chats SET cleared_through_ts = ? WHERE id = 4", T0 + 10_000);

  // A message deleted for good: a tombstone, its record, and no words left.
  run("UPDATE messages SET text = NULL, transcript = NULL, transcript_info = NULL, raw = NULL, deleted_at = ? WHERE id = ?", T0 + 20_000, ids.anaGone);
  run("INSERT INTO retracted(key_id, from_me, chat_id, at) VALUES ('A3', 0, 1, ?)", T0 + 20_000);

  run("INSERT INTO reactions(message_id, contact_id, emoji, ts) VALUES (?, 1, '👍', ?)", ids.ana2, T0 + 2_500);
  run("INSERT INTO reactions(message_id, contact_id, emoji, ts) VALUES (?, 3, '🎉', ?)", ids.group2, T0 + 8_500);
  run("INSERT INTO votes(message_id, contact_id, choice, ts) VALUES (?, 3, ?, ?)", ids.group1, '["marti"]', T0 + 7_500);
  run("INSERT INTO receipts(message_id, contact_id, delivered_at, read_at) VALUES (?, 1, ?, ?)", ids.ana2, T0 + 2_100, T0 + 2_200);
  run("INSERT INTO receipts(message_id, contact_id, delivered_at, read_at, played_at) VALUES (?, 3, ?, ?, ?)", ids.group2, T0 + 8_100, T0 + 8_200, T0 + 8_300);

  run("INSERT INTO media(message_id, kind, path, created_at) VALUES (?, 'audio', 'media/v1.ogg', ?)", ids.voice, T0 + 4_100);
  run("INSERT INTO media(message_id, kind, path, created_at) VALUES (?, 'audio', 'media/v2.ogg', ?)", ids.waiting, T0 + 5_100);
  // A file a removed media row left behind, still waiting for the service to unlink it.
  run("INSERT INTO pending_unlinks(path, queued_at) VALUES ('media/gone.jpg', ?)", T0 + 15_000);
  // A second that lost a row to a physical delete keeps the id it handed out.
  run("INSERT INTO id_high(second, top) VALUES (?, ?)", (T0 + 12_000) / 1000, idAt(T0 + 12_000, 3));

  run("INSERT INTO contact_notes(contact_id, note, tags, fields, updated_at) VALUES (1, 'contabila', ?, ?, ?)", '["lucru"]', '{"oras":"Cluj"}', T0);
  run("INSERT INTO handled(chat_id, ask_message_id, at) VALUES (1, ?, ?)", ids.ana1, T0 + 30_000);

  // Two messages the feed has already embedded; the rest are still queued.
  const embed = (id, text, i) => run("INSERT INTO embeddings(message_id, model, content_hash, vec) VALUES (?, ?, ?, ?)", id, MODEL, contentHash(text, null), vector(i));
  embed(ids.ana1, "Salut, ajungem la sase?", 1);
  embed(ids.group1, "Cine vine marti?", 2);
  run("DELETE FROM embed_queue WHERE message_id IN (?, ?)", ids.ana1, ids.group1);

  if (version >= 2) {
    const send = (draftId, chatJid, keyId, state, updatedAt) =>
      run(
        `INSERT INTO sends(draft_id, owner, chat_jid, kind, payload, key_id, state, created_at, expires_at, updated_at)
         VALUES (?, 'session', ?, 'text', ?, ?, ?, ?, ?, ?)`,
        draftId,
        chatJid,
        '{"text":"Vin si eu"}',
        keyId,
        state,
        T0,
        T0 + DAY,
        updatedAt
      );
    send("d-sent", GROUP, "G2", "sent", T0 + 8_000);
    send("d-unknown", PEER_LID, "L1", "unknown", T0 + 6_000);
    send("d-draft", PEER, "D1", "draft", T0);
  }
  if (version >= 3) {
    run("INSERT INTO transcribe_queue(message_id, provider_class, queued_at, attempts, next_at) VALUES (?, 'local', ?, 1, ?)", ids.waiting, T0 + 5_200, T0 + 6_200);
  }
  if (version >= 4) {
    // Only v4 gave the outbox a table it writes to: v1's placeholder was never
    // written by any released build, and v4 replaces it rather than altering it.
    run(
      `INSERT INTO events(kind, lane, message_id, payload, created_at, ready_at, state, updated_at)
       VALUES ('message_received', 'chat:2', ?, '{}', ?, ?, 'pending', ?)`,
      ids.group1,
      T0 + 7_000,
      T0 + 7_000,
      T0 + 7_000
    );
  }
  db.exec("COMMIT");
  if (wal) return { path, dir, ids, db };
  db.close();
  return { path, dir, ids, db: null };
}

/** Every object in the schema, in a stable order: what two files must agree on. */
function schemaOf(path) {
  const reader = new (sqlite().DatabaseSync)(path, { readOnly: true });
  try {
    return reader.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name").all();
  } finally {
    reader.close();
  }
}

/** Every row of every table, as sorted JSON: what an open that changes nothing must leave alone. */
function dumpOf(path) {
  const reader = new (sqlite().DatabaseSync)(path, { readOnly: true });
  try {
    const out = { user_version: reader.prepare("PRAGMA user_version").get().user_version };
    for (const { name } of reader.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      out[name] = reader
        .prepare(`SELECT * FROM "${name}"`)
        .all()
        .map((row) => JSON.stringify(row, (_key, value) => (value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value)))
        .sort();
    }
    return out;
  } finally {
    reader.close();
  }
}

/** SQLite's own verdicts, which the product's quick_check does not cover. */
function sqliteChecks(path) {
  const reader = new (sqlite().DatabaseSync)(path, { readOnly: true });
  try {
    return {
      integrity: reader
        .prepare("PRAGMA integrity_check")
        .all()
        .map((row) => row.integrity_check),
      foreignKeys: reader.prepare("PRAGMA foreign_key_check").all(),
      indexedRows: reader.prepare("SELECT count(*) AS n FROM messages_fts").get().n,
      messageRows: reader.prepare("SELECT count(*) AS n FROM messages").get().n,
    };
  } finally {
    reader.close();
  }
}

const upgrade = (path, options = {}) => AccountDb.open(path, { checkpointDelayMs: 0, now: () => T0 + DAY, ...options });

// ------------------------------------------------------- the schema itself

test("every released version is named here, so a new migration cannot ship without a chain test", () => {
  assert.deepEqual(RELEASED, [1, 2, 3, 4, 5]);
  assert.equal(SCHEMA_VERSION, RELEASED[RELEASED.length - 1]);
});

for (const from of RELEASED) {
  test(`a version ${from} file upgrades to the schema a new file gets, object for object`, () => {
    const { path } = releasedFile(from);
    const db = upgrade(path);
    assert.equal(db.schemaVersion, SCHEMA_VERSION);
    db.close();

    const fresh = join(tempDir("wazap-chain-fresh-"), "wazap.sqlite");
    AccountDb.open(fresh, { checkpointDelayMs: 0 }).close();
    assert.deepEqual(schemaOf(path), schemaOf(fresh), `a v${from} file ends up with a different schema than a new one`);
  });

  test(`a version ${from} file keeps every row it held, and SQLite finds nothing wrong afterwards`, () => {
    const { path, ids } = releasedFile(from);
    const before = dumpOf(path);
    const db = upgrade(path);

    // Counts first: nothing silently lost.
    assert.deepEqual(db.counts(), { messages: 8, tombstones: 1, chats: 3, contacts: 3, embeddings: 2 });

    // Then the rows themselves, word for word.
    assert.equal(db.messages.get(sid(false, PEER, "A1")).text, "Salut, ajungem la sase?");
    assert.equal(db.messages.get(sid(true, PEER, "A2")).text, "Da, ajung la sase fix");
    assert.equal(db.messages.get(sid(false, PEER, "A3")), null, "a tombstone stays one");
    assert.equal(db.messages.get(sid(false, PEER, "A3"), { includeHidden: true }).deletedAt, T0 + 20_000);
    assert.equal(db.messages.get(sid(false, PEER, "V1")).transcript, "transcrierea notei vocale");
    assert.equal(db.messages.get(sid(true, PEER, "L1")).text, "trimis pe lid, inainte de fold", "a folding chat's row answers under the number");
    assert.equal(db.messages.get(sid(false, PEER2, "H1")), null, "still under its barrier");
    assert.equal(db.messages.get(sid(true, PEER2, "H2")).text, "dupa bariera");
    assert.deepEqual(
      db.messages.reactions(sid(true, PEER, "A2")).map((row) => row.emoji),
      ["👍"]
    );
    assert.deepEqual(
      db.messages.votes(sid(false, GROUP, "G1")).map((row) => row.choice),
      ['["marti"]']
    );
    assert.equal(db.identity.notes(PEER).note, "contabila");
    assert.equal(db.identity.chat(GROUP).name, "Fotbal marți");
    assert.equal(db.identity.chat(PEER).unread, 2);
    assert.equal(db.getMeta("owner"), ME);
    assert.equal(db.getMeta("created_at"), String(T0 - DAY), "the day the account was created is not restamped");
    assert.deepEqual(db.vectors.get(sid(false, PEER, "A1")).vector, vector(1), "a stored vector is the same bytes after the upgrade");
    assert.equal(db.vectors.count(MODEL), 2);
    if (from >= 2) assert.equal(db.sends.wasSent("G2"), true, "a confirmed send's key is kept past its row");
    if (from >= 4) assert.equal(db.events.get(1).messageId, ids.group1, "the outbox keeps the event it had not posted");
    db.close();

    // And the tables that only carry over, row for row against the file as it
    // was before it was opened. `events` and `sends` are left out on purpose:
    // v4 replaces the placeholder events table and v2 the placeholder sends
    // table, neither of which a released build ever wrote to.
    const after = dumpOf(path);
    for (const table of ["contacts", "lid_phones", "retracted", "reactions", "votes", "receipts", "media", "embeddings", "contact_notes", "handled", "id_high", "pending_unlinks"]) {
      assert.deepEqual(after[table], before[table], `${table} changed while upgrading from v${from}`);
    }
    if (from >= 3) assert.deepEqual(after.transcribe_queue, before.transcribe_queue, "a voice note waiting to be transcribed keeps its place");
    assert.deepEqual(after.embed_queue, before.embed_queue, "the embedding backlog is neither emptied nor refilled");

    const checks = sqliteChecks(path);
    assert.deepEqual(checks.integrity, ["ok"]);
    assert.deepEqual(checks.foreignKeys, [], "no row points at one that is gone");
    assert.equal(checks.indexedRows, checks.messageRows, "the trigram index has one entry per row, no more and no less");
  });

  test(`a version ${from} file's trigram index still answers after the upgrade`, () => {
    const { path } = releasedFile(from);
    const db = upgrade(path);
    // Substring and mid-word: what the trigram tokenizer promises.
    assert.deepEqual(sorted(db.search.text({ query: "ajung", limit: 10 }).items), [sid(false, PEER, "A1"), sid(true, PEER, "A2")].sort());
    assert.deepEqual(sorted(db.search.text({ query: "notei vocale", limit: 10 }).items), [sid(false, PEER, "V1")], "a transcript is searchable too");
    assert.deepEqual(sorted(db.search.text({ query: "bariera", limit: 10 }).items), [sid(true, PEER2, "H2")], "and nothing under a barrier comes back");
    assert.deepEqual(db.search.text({ query: "dispare", limit: 10 }).items, [], "a tombstone's words left the index when it was made");
    assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] }, "the index agrees with the rows it indexes");

    // And it keeps working for what is stored after the upgrade.
    db.messages.upsert(textMessage(PEER, "NEW", T0 + DAY, "ceva nou de cautat"));
    assert.deepEqual(sorted(db.search.text({ query: "cautat", limit: 10 }).items), [sid(false, PEER, "NEW")]);
    db.close();
  });

  test(`a version ${from} file opened a second time is left exactly as the upgrade left it`, () => {
    const { path } = releasedFile(from);
    const first = upgrade(path);
    const stamps = Object.fromEntries(RELEASED.map((version) => [version, first.getMeta(`migrated_v${version}`)]));
    first.close();
    const after = dumpOf(path);

    const second = AccountDb.open(path, { checkpointDelayMs: 0, now: () => T0 + 30 * DAY });
    assert.equal(second.schemaVersion, SCHEMA_VERSION);
    for (const version of RELEASED) assert.equal(second.getMeta(`migrated_v${version}`), stamps[version], `migrated_v${version} was stamped a second time`);
    second.close();
    assert.deepEqual(dumpOf(path), after, "a second open is not a second migration");
  });
}
