/**
 * The account database schema, as ordered migrations over `PRAGMA
 * user_version`. Version N is reached by running migrations 1..N in order,
 * each in its own transaction together with the version bump, so a crash
 * leaves the file at a whole version. A migration, once released, never
 * changes: a new shape is a new entry at the end.
 *
 * Units: every time column is epoch milliseconds. Message ids are
 * chronological (see ids.ts), and the CHECK on `messages` holds the id's
 * second to the timestamp's second, so an id range is a time range.
 *
 * Invariants the schema itself defends, whatever code writes to it:
 * - a message keeps its id, timestamp, key and direction forever, is unique by
 *   chat, direction and key, and its id is never handed out again;
 * - a tombstone (deleted_at set) holds no text, transcript or raw bytes, and
 *   stays a tombstone;
 * - the full-text index and the embeddings follow text and transcript, and a
 *   tombstone takes its embedding, reactions, votes and receipts with it;
 * - chats.last_* names the newest message a reader may see — not a tombstone,
 *   not under the clear barrier — after any insert, tombstone, delete or move;
 * - a file a removed media row pointed at is queued for unlinking in the same
 *   transaction, so a crash never loses it;
 * - a message of the account's own that goes for good leaves no words in the
 *   send that made it.
 */

export interface Migration {
  version: number;
  sql: string;
}

const V1 = `
CREATE TABLE meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- One row per person. phone_jid is the number once known; lid is the lid that
-- currently answers for that number (or the only id of a person whose number
-- is unknown). A row merging into another has both cleared and merged_into set
-- until its references have moved over; nothing resolves to it meanwhile.
CREATE TABLE contacts(
  id INTEGER PRIMARY KEY,
  phone_jid TEXT UNIQUE,
  lid TEXT UNIQUE,
  name TEXT,
  -- The name WhatsApp's contact sync gives (notify), and the one the person
  -- publishes on their own messages (push_name): both are searched, and a
  -- contact's notify is shown before a message's push name.
  notify TEXT,
  push_name TEXT,
  verified_name TEXT,
  is_business INTEGER,
  -- The order a contact event first named this person: the address book's
  -- order. NULL for someone known only from their messages or a group.
  listed INTEGER,
  updated_at INTEGER NOT NULL,
  merged_into INTEGER REFERENCES contacts(id)
) STRICT;
CREATE INDEX contacts_merging ON contacts(merged_into) WHERE merged_into IS NOT NULL;
-- The address book's next place is read off this, not counted over every person.
CREATE INDEX contacts_listed ON contacts(listed) WHERE listed IS NOT NULL;

-- Every lid -> number pairing learned, the table Baileys keeps: a lid answers
-- for the number it was last learned with, and an older lid of a number keeps
-- answering for it.
CREATE TABLE lid_phones(
  lid TEXT PRIMARY KEY,
  phone_jid TEXT NOT NULL,
  learned_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX lid_phones_phone ON lid_phones(phone_jid);

-- A direct chat lives under the canonical jid of its person: the number once
-- known. A lid chat folding into the number's chat keeps its row, with
-- merged_into set, until its messages have moved.
CREATE TABLE chats(
  id INTEGER PRIMARY KEY,
  jid TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  contact_id INTEGER REFERENCES contacts(id),
  name TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER,
  muted_until INTEGER,
  unread INTEGER NOT NULL DEFAULT 0,
  cleared_through_ts INTEGER,
  last_message_id INTEGER,
  last_ts INTEGER,
  last_from_me INTEGER,
  -- Visible messages filed under this row: not deleted, after the clear
  -- barrier. Kept by the triggers on messages, so coverage never counts rows.
  visible INTEGER NOT NULL DEFAULT 0,
  proto BLOB,
  merged_into INTEGER REFERENCES chats(id)
) STRICT;
CREATE INDEX chats_waiting ON chats(last_from_me, last_ts);
CREATE INDEX chats_recent ON chats(last_ts);
CREATE INDEX chats_contact ON chats(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX chats_merging ON chats(merged_into) WHERE merged_into IS NOT NULL;

-- Column order is deliberate: the small columns every filter reads come
-- first, the large ones last, so checking deleted_at or expires_at never
-- walks past a raw blob into its overflow pages.
CREATE TABLE messages(
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id),
  key_id TEXT NOT NULL,
  from_me INTEGER NOT NULL CHECK (from_me IN (0, 1)),
  sender_id INTEGER REFERENCES contacts(id),
  ts INTEGER NOT NULL CHECK (ts > 0),
  type TEXT NOT NULL,
  quoted_sid TEXT,
  quoted_from_me INTEGER,
  quoted_key_id TEXT,
  status INTEGER,
  edited_at INTEGER,
  expires_at INTEGER,
  deleted_at INTEGER,
  text TEXT,
  transcript TEXT,
  -- Who made the transcript and when, with its language and length when known: JSON.
  transcript_info TEXT,
  raw BLOB,
  CHECK ((id >> 20) = (ts / 1000)),
  CHECK (deleted_at IS NULL OR (text IS NULL AND transcript IS NULL AND transcript_info IS NULL AND raw IS NULL))
) STRICT;
-- A message is its chat, its direction and its WhatsApp key; every sid
-- spelling resolves to that through the chat, so no spelling is stored.
CREATE UNIQUE INDEX messages_key ON messages(chat_id, from_me, key_id);
CREATE INDEX messages_chat ON messages(chat_id, id);
CREATE INDEX messages_sender ON messages(sender_id, id) WHERE sender_id IS NOT NULL;
CREATE INDEX messages_expiry ON messages(expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
-- Quotes are matched by the quoted message's key, whatever address spelled it.
CREATE INDEX messages_quoted ON messages(quoted_key_id) WHERE quoted_key_id IS NOT NULL;
CREATE INDEX messages_tombstones ON messages(deleted_at) WHERE deleted_at IS NOT NULL;

-- Every message deleted, retracted or expired, by key and without content.
-- A purge removes the tombstone row but never this record, so a quote of the
-- message that arrives later is still scrubbed and the message stays gone.
-- The key is dead for good: sends (F1-e) must not reuse a pre-generated key
-- after a definite failure. The table only grows, a row per such message.
CREATE TABLE retracted(
  key_id TEXT NOT NULL,
  from_me INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (key_id, from_me, chat_id)
) STRICT, WITHOUT ROWID;

-- Reactions and votes remember the order they arrived in: a reader lists
-- them by time, and two left in the same instant in the order they came. A
-- rowid table keeps that order — a change of mind updates the row in place —
-- where a table keyed by message and person cannot.
CREATE TABLE reactions(
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  emoji TEXT NOT NULL,
  ts INTEGER NOT NULL,
  UNIQUE (message_id, contact_id)
) STRICT;
CREATE INDEX reactions_contact ON reactions(contact_id);

CREATE TABLE votes(
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  choice TEXT NOT NULL,
  ts INTEGER NOT NULL,
  UNIQUE (message_id, contact_id)
) STRICT;
CREATE INDEX votes_contact ON votes(contact_id);

CREATE TABLE receipts(
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  delivered_at INTEGER,
  read_at INTEGER,
  played_at INTEGER,
  PRIMARY KEY (message_id, contact_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX receipts_contact ON receipts(contact_id);

CREATE TABLE media(
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, kind)
) STRICT, WITHOUT ROWID;
CREATE INDEX media_path ON media(path);

-- content_hash names the words the vector was made from (see contentHash), so
-- a vector computed before an edit or a transcript is never stored as current.
CREATE TABLE embeddings(
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  vec BLOB NOT NULL
) STRICT;

-- Messages whose words the embedding feed has not looked at since they were
-- stored or changed, kept only while a model is fed (meta embed_model): the
-- triggers below queue a message stored with words, or whose words change,
-- and a delete takes it off. The feed takes a row off once it stored a vector,
-- or skipped the message for good (nothing to embed, words the server refuses).
-- A refill (meta embed_refill_before, a descending id cursor) queues what
-- already existed when a model started being fed.
CREATE TABLE embed_queue(
  message_id INTEGER PRIMARY KEY
) STRICT;

CREATE TABLE contact_notes(
  contact_id INTEGER PRIMARY KEY REFERENCES contacts(id),
  note TEXT,
  tags TEXT,
  fields TEXT,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE handled(
  chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  ask_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX handled_ask ON handled(ask_message_id) WHERE ask_message_id IS NOT NULL;

-- F1-d: the durable webhook outbox. Only the table exists until then. A
-- message deleted from under an event leaves message_id NULL: the outbox
-- treats that event as cancelled.
CREATE TABLE events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ready_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_status INTEGER,
  last_error TEXT
) STRICT;
CREATE INDEX events_due ON events(state, next_attempt_at);
CREATE INDEX events_message ON events(message_id) WHERE message_id IS NOT NULL;

-- F1-e: idempotent sends. Only the table exists until then. A key a
-- retraction or a tombstone used is dead (see retracted): retry a definitely
-- failed send with a fresh key, or keep its row.
CREATE TABLE sends(
  draft_id TEXT PRIMARY KEY,
  owner TEXT,
  chat_id INTEGER,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  key_id TEXT,
  state TEXT NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sends_key ON sends(key_id) WHERE key_id IS NOT NULL;

-- Substring search over text and transcript: trigrams, case- and
-- diacritic-insensitive. External content, kept in step by the triggers below.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  transcript,
  content = 'messages',
  content_rowid = 'id',
  tokenize = 'trigram remove_diacritics 1'
);
-- A delete removes the entry from the index at once instead of leaving it
-- for a later merge: deleted text must not stay readable in index pages.
INSERT INTO messages_fts(messages_fts, rank) VALUES ('secure-delete', 1);

CREATE TRIGGER messages_identity_fixed BEFORE UPDATE OF id, ts, key_id, from_me ON messages
WHEN old.id IS NOT new.id OR old.ts IS NOT new.ts OR old.key_id IS NOT new.key_id OR old.from_me IS NOT new.from_me
BEGIN
  SELECT RAISE(ABORT, 'a stored message keeps its id, timestamp, key and direction');
END;

CREATE TRIGGER messages_tombstone_final BEFORE UPDATE OF deleted_at ON messages
WHEN old.deleted_at IS NOT NULL AND new.deleted_at IS NOT old.deleted_at
BEGIN
  SELECT RAISE(ABORT, 'a deleted message stays deleted');
END;

-- Every row has exactly one index entry, an empty one for a row without
-- words, so the index and the table always agree row for row and the
-- external-content integrity check can prove it.
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
BEGIN
  INSERT INTO messages_fts(rowid, text, transcript) VALUES (new.id, new.text, new.transcript);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, transcript) VALUES ('delete', old.id, old.text, old.transcript);
END;

CREATE TRIGGER messages_content_update AFTER UPDATE OF text, transcript ON messages
WHEN old.text IS NOT new.text OR old.transcript IS NOT new.transcript
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, transcript) VALUES ('delete', old.id, old.text, old.transcript);
  INSERT INTO messages_fts(rowid, text, transcript) VALUES (new.id, new.text, new.transcript);
  -- A vector of words the message no longer says is stale; the backlog picks it up again.
  DELETE FROM embeddings WHERE message_id = new.id;
  -- NOT EXISTS, not OR IGNORE: the statement that fired the trigger overrides a trigger's conflict clause.
  INSERT INTO embed_queue(message_id)
    SELECT new.id WHERE (new.text IS NOT NULL OR new.transcript IS NOT NULL)
      AND EXISTS (SELECT 1 FROM meta WHERE key = 'embed_model')
      AND NOT EXISTS (SELECT 1 FROM embed_queue WHERE message_id = new.id);
END;

CREATE TRIGGER messages_embed_insert AFTER INSERT ON messages
WHEN (new.text IS NOT NULL OR new.transcript IS NOT NULL) AND EXISTS (SELECT 1 FROM meta WHERE key = 'embed_model')
BEGIN
  INSERT INTO embed_queue(message_id) SELECT new.id WHERE NOT EXISTS (SELECT 1 FROM embed_queue WHERE message_id = new.id);
END;

-- chats.visible follows every way a message becomes visible or stops being:
-- stored, tombstoned, physically deleted, moved to another chat, or hidden by
-- a raised clear barrier (recounted then, once per clear).
CREATE TRIGGER messages_visible_insert AFTER INSERT ON messages
WHEN new.deleted_at IS NULL
BEGIN
  UPDATE chats SET visible = visible + 1 WHERE id = new.chat_id AND new.ts > coalesce(cleared_through_ts, 0);
END;

CREATE TRIGGER messages_visible_tombstone AFTER UPDATE OF deleted_at ON messages
WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL
BEGIN
  UPDATE chats SET visible = visible - 1 WHERE id = new.chat_id AND new.ts > coalesce(cleared_through_ts, 0);
END;

CREATE TRIGGER messages_visible_delete AFTER DELETE ON messages
WHEN old.deleted_at IS NULL
BEGIN
  UPDATE chats SET visible = visible - 1 WHERE id = old.chat_id AND old.ts > coalesce(cleared_through_ts, 0);
END;

CREATE TRIGGER messages_visible_move AFTER UPDATE OF chat_id ON messages
WHEN old.chat_id IS NOT new.chat_id AND new.deleted_at IS NULL
BEGIN
  UPDATE chats SET visible = visible - 1 WHERE id = old.chat_id AND old.ts > coalesce(cleared_through_ts, 0);
  UPDATE chats SET visible = visible + 1 WHERE id = new.chat_id AND new.ts > coalesce(cleared_through_ts, 0);
END;

CREATE TRIGGER chats_visible_barrier AFTER UPDATE OF cleared_through_ts ON chats
WHEN new.cleared_through_ts IS NOT old.cleared_through_ts
BEGIN
  UPDATE chats SET visible = (
    SELECT count(*) FROM messages m
    WHERE m.chat_id = new.id AND m.deleted_at IS NULL AND m.ts > coalesce(new.cleared_through_ts, 0)
  ) WHERE id = new.id;
END;

CREATE TRIGGER messages_embed_delete AFTER DELETE ON messages
BEGIN
  DELETE FROM embed_queue WHERE message_id = old.id;
END;

-- The highest id a second has ever handed out, kept for seconds that lost
-- rows to a physical delete, so a freed id is never given to another message:
-- nothing that remembered the old id can land on a different one. It only
-- grows, a row per second that lost a row.
CREATE TABLE id_high(
  second INTEGER PRIMARY KEY,
  top INTEGER NOT NULL
) STRICT;

CREATE TRIGGER messages_id_high AFTER DELETE ON messages
BEGIN
  INSERT INTO id_high(second, top) VALUES (old.id >> 20, old.id)
  ON CONFLICT(second) DO UPDATE SET top = max(top, excluded.top);
END;

-- chats.last_* names the newest message a reader may see in the chat and in
-- every chat still folding into it: never a tombstone, never a row at or
-- before the clear barrier. A change in a folding chat updates the chat it
-- folds into as well.
CREATE TRIGGER messages_last_insert AFTER INSERT ON messages
WHEN new.deleted_at IS NULL
BEGIN
  UPDATE chats SET last_message_id = new.id, last_ts = new.ts, last_from_me = new.from_me
  WHERE (id = new.chat_id OR id = (SELECT merged_into FROM chats WHERE id = new.chat_id))
    AND new.ts > coalesce(cleared_through_ts, 0)
    AND (last_message_id IS NULL OR last_message_id < new.id);
END;

CREATE TRIGGER messages_tombstone AFTER UPDATE OF deleted_at ON messages
WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL
BEGIN
  DELETE FROM embeddings WHERE message_id = new.id;
  DELETE FROM embed_queue WHERE message_id = new.id;
  DELETE FROM reactions WHERE message_id = new.id;
  DELETE FROM votes WHERE message_id = new.id;
  DELETE FROM receipts WHERE message_id = new.id;
  UPDATE chats SET (last_message_id, last_ts, last_from_me) = (
    SELECT m.id, m.ts, m.from_me FROM messages m WHERE m.id = (
      SELECT max((
        SELECT x.id FROM messages x
        WHERE x.chat_id = k.id AND x.deleted_at IS NULL
          AND x.id >= (coalesce(k.cleared_through_ts, 0) / 1000) * 1048576
          AND x.ts > coalesce(k.cleared_through_ts, 0)
        ORDER BY x.id DESC LIMIT 1))
      FROM chats k WHERE k.id = chats.id OR k.merged_into = chats.id))
  WHERE (id = new.chat_id OR id = (SELECT merged_into FROM chats WHERE id = new.chat_id)) AND last_message_id = new.id;
END;

CREATE TRIGGER messages_last_delete AFTER DELETE ON messages
BEGIN
  UPDATE chats SET (last_message_id, last_ts, last_from_me) = (
    SELECT m.id, m.ts, m.from_me FROM messages m WHERE m.id = (
      SELECT max((
        SELECT x.id FROM messages x
        WHERE x.chat_id = k.id AND x.deleted_at IS NULL
          AND x.id >= (coalesce(k.cleared_through_ts, 0) / 1000) * 1048576
          AND x.ts > coalesce(k.cleared_through_ts, 0)
        ORDER BY x.id DESC LIMIT 1))
      FROM chats k WHERE k.id = chats.id OR k.merged_into = chats.id))
  WHERE (id = old.chat_id OR id = (SELECT merged_into FROM chats WHERE id = old.chat_id)) AND last_message_id = old.id;
END;

CREATE TRIGGER messages_last_move AFTER UPDATE OF chat_id ON messages
WHEN old.chat_id IS NOT new.chat_id
BEGIN
  UPDATE chats SET (last_message_id, last_ts, last_from_me) = (
    SELECT m.id, m.ts, m.from_me FROM messages m WHERE m.id = (
      SELECT max((
        SELECT x.id FROM messages x
        WHERE x.chat_id = k.id AND x.deleted_at IS NULL
          AND x.id >= (coalesce(k.cleared_through_ts, 0) / 1000) * 1048576
          AND x.ts > coalesce(k.cleared_through_ts, 0)
        ORDER BY x.id DESC LIMIT 1))
      FROM chats k WHERE k.id = chats.id OR k.merged_into = chats.id))
  WHERE (id = old.chat_id OR id = (SELECT merged_into FROM chats WHERE id = old.chat_id)) AND last_message_id = old.id;
  UPDATE chats SET last_message_id = new.id, last_ts = new.ts, last_from_me = new.from_me
  WHERE id = new.chat_id AND new.deleted_at IS NULL AND new.ts > coalesce(cleared_through_ts, 0)
    AND (last_message_id IS NULL OR last_message_id < new.id);
END;

-- Files a removed media row pointed at, queued in the same transaction that
-- removed it, until the service has unlinked them and says so. A path another
-- row still references is not queued; one recorded again leaves the queue.
-- claimed_at marks a path handed to the service to unlink; recording the path
-- again deletes the row, which cancels the claim.
CREATE TABLE pending_unlinks(
  path TEXT PRIMARY KEY,
  queued_at INTEGER NOT NULL,
  claimed_at INTEGER
) STRICT, WITHOUT ROWID;

CREATE TRIGGER media_released AFTER DELETE ON media
WHEN NOT EXISTS (SELECT 1 FROM media WHERE path = old.path)
BEGIN
  INSERT OR IGNORE INTO pending_unlinks(path, queued_at) VALUES (old.path, CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;

CREATE TRIGGER media_replaced AFTER UPDATE OF path ON media
WHEN old.path IS NOT new.path
BEGIN
  DELETE FROM pending_unlinks WHERE path = new.path;
  INSERT OR IGNORE INTO pending_unlinks(path, queued_at)
    SELECT old.path, CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE NOT EXISTS (SELECT 1 FROM media WHERE path = old.path);
END;

CREATE TRIGGER media_recorded AFTER INSERT ON media
BEGIN
  DELETE FROM pending_unlinks WHERE path = new.path;
END;
`;

/**
 * Idempotent sends (F1-e). 0.22 created `sends` and never wrote to it, so the
 * table is replaced, not altered. A draft carries the WhatsApp key it goes out
 * under from the moment it is made, so a send whose outcome is unknown is
 * recognised when WhatsApp echoes that key. A row leaves sending only for sent
 * or unknown, or back to draft when the key never reached the socket; a
 * dispatched key is never retried, since a retraction or a tombstone makes it
 * dead for good (see retracted). The chat is a jid: a draft to a number nobody
 * wrote to yet has no chats row, and must not create one. expires_at is when
 * the draft lapses while it is one, and when the row may go once it settled.
 */
const V2 = `
DROP TABLE sends;

CREATE TABLE sends(
  draft_id TEXT PRIMARY KEY,
  owner TEXT,
  chat_jid TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  key_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'sending', 'sent', 'unknown')),
  receipt TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX sends_key ON sends(key_id);
CREATE INDEX sends_owner ON sends(owner, state, created_at);
CREATE INDEX sends_expiry ON sends(expires_at);

-- A message of the account's own gone for good takes its words out of the
-- send that made it: the row stays, so a repeated confirm still sends nothing.
CREATE TRIGGER retracted_scrubs_send AFTER INSERT ON retracted
WHEN new.from_me = 1
BEGIN
  UPDATE sends SET payload = '{}', receipt = CASE WHEN receipt IS NULL THEN NULL ELSE json_set(receipt, '$.text', '') END
  WHERE key_id = new.key_id;
END;

-- A chat cleared or deleted through a barrier does the same for its sends,
-- in the transaction that stores the barrier: a send whose message the
-- barrier hides, and an unknown send drafted at or before it, to the chat's
-- jid or its person's other one. Every spelling of a chat raises its own
-- barrier, so each row matches its own messages.
CREATE TRIGGER chats_barrier_scrubs_sends AFTER UPDATE OF cleared_through_ts ON chats
WHEN new.cleared_through_ts IS NOT NULL AND new.cleared_through_ts IS NOT old.cleared_through_ts
BEGIN
  UPDATE sends SET payload = '{}', receipt = CASE WHEN receipt IS NULL THEN NULL ELSE json_set(receipt, '$.text', '') END
  WHERE state IN ('sent', 'unknown') AND (
    EXISTS (
      SELECT 1 FROM messages m
      WHERE m.chat_id = new.id AND m.from_me = 1 AND m.key_id = sends.key_id AND m.ts <= new.cleared_through_ts)
    OR (state = 'unknown' AND created_at <= new.cleared_through_ts AND (
      chat_jid = new.jid
      OR chat_jid IN (SELECT phone_jid FROM contacts WHERE id = new.contact_id AND phone_jid IS NOT NULL)
      OR chat_jid IN (SELECT lid FROM contacts WHERE id = new.contact_id AND lid IS NOT NULL))));
END;
`;

/** Every migration, in order. The schema version a build knows is the last one's. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: V1 },
  { version: 2, sql: V2 },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
