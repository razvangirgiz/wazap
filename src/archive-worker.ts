import { splitMessageId } from "./ids.js";
import { proto } from "baileys";
import { parentPort } from "node:worker_threads";
import { DatabaseSync, type StatementSync } from "node:sqlite";
let db: DatabaseSync;
// Reuse bounded prepared statements instead of allocating one per archived message.
const statements = new Map<string, StatementSync>();
function prepare(sql: string): StatementSync {
  const existing = statements.get(sql);
  if (existing) return existing;
  const statement = db.prepare(sql);
  if (statements.size >= 128) statements.delete(statements.keys().next().value!);
  statements.set(sql, statement);
  return statement;
}
const port = parentPort!;
port.on("message", ({ id, op, args }) => {
  try {
    port.postMessage({ id, result: run(op, args) });
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
function stableId(sid: string, jid?: string): string {
  const alias = prepare("SELECT sid FROM message_aliases WHERE alias=?").get(sid) as any;
  if (alias) return alias.sid;
  const identity = splitMessageId(sid);
  const origin = identity.origin;
  const originalJid = jid || identity.jid;
  const mapped = prepare("SELECT jid FROM aliases WHERE alias=?").get(originalJid) as any;
  const found = prepare("SELECT sid FROM messages WHERE jid=? AND origin=? AND keyid=?").get(
    mapped?.jid ?? originalJid,
    origin,
    identity.key,
  ) as any;
  return found?.sid ?? sid;
}
function scrubQuote(r: any): void {
  const extra = typeof r.extra === "string" ? JSON.parse(r.extra) : { ...r.extra };
  delete extra.quoted;
  if (extra.view) delete extra.view.quoted;
  r.extra = JSON.stringify(extra);
  r.quoted = null;
  if (!r.raw) return;
  const raw = proto.WebMessageInfo.decode(Buffer.from(r.raw, "base64"));
  const scrub = (value: any): void => {
    if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return;
    delete value.quotedMessage;
    for (const child of Object.values(value)) scrub(child);
  };
  scrub(raw);
  r.raw = Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString("base64");
}
function run(op: string, a: any): any {
  if (op === "inspect") {
    db = new DatabaseSync(a.file, { readOnly: true });
    const meta = prepare("SELECT key,value FROM meta").all();
    const unknown = prepare(
      "SELECT count(*) count FROM outbox WHERE json_extract(value,'$.state') IN ('unknown','sending')",
    ).get();
    const result = {
      migrated: meta.some((r) => r.key === "migrated"),
      owner: meta.find((r) => r.key === "owner")?.value,
      unknown_sends: unknown?.count ?? 0,
    };
    db.close();
    return result;
  }
  if (op === "open") {
    db = new DatabaseSync(a.file);
    const version = prepare("PRAGMA user_version").get() as any;
    if (version.user_version > 1) throw Error("Unsupported archive schema version; use a compatible Wazap version.");
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(sid TEXT PRIMARY KEY,jid TEXT NOT NULL,ts INTEGER NOT NULL,sender TEXT NOT NULL,type TEXT NOT NULL,text TEXT NOT NULL,raw TEXT NOT NULL,extra TEXT NOT NULL DEFAULT '{}',deleted INTEGER NOT NULL DEFAULT 0,expires INTEGER,quoted TEXT,edited INTEGER NOT NULL DEFAULT 0,keyid TEXT NOT NULL DEFAULT '',origin TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS message_identity ON messages(jid,origin,keyid);
      CREATE INDEX IF NOT EXISTS chat_time ON messages(jid,ts,sid);
      CREATE INDEX IF NOT EXISTS sender_time ON messages(sender,ts,sid);
      CREATE INDEX IF NOT EXISTS message_time ON messages(ts,sid);
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(sid UNINDEXED,text,tokenize='trigram');
      CREATE TABLE IF NOT EXISTS media(sid TEXT,path TEXT,expires INTEGER,PRIMARY KEY(sid,path));
      CREATE TABLE IF NOT EXISTS message_aliases(alias TEXT PRIMARY KEY,sid TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS aliases(alias TEXT PRIMARY KEY,jid TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      PRAGMA user_version=1;`);
    const owner = prepare("SELECT value FROM meta WHERE key='owner'").get() as any;
    if (owner && owner.value !== a.owner)
      throw Error("ARCHIVE_ACCOUNT_MISMATCH: use another data directory for this account");
    prepare("INSERT OR IGNORE INTO meta VALUES('owner',?)").run(a.owner);
    return { migrated: !!prepare("SELECT value FROM meta WHERE key='migrated'").get() };
  }
  if (op === "close") {
    db.close();
    return;
  }
  if (op === "batch" || op === "migrate") {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of a.rows) put(r);
      if (op === "migrate") {
        const expected = new Set(a.rows.map((r: any) => stableId(r.sid, r.jid)));
        const count = prepare("SELECT count(*) count FROM messages").get() as any;
        if (count.count !== expected.size)
          throw Error(`Migration count mismatch: expected ${expected.size}, received ${count.count}`);
      }
      if (op === "migrate") prepare("INSERT OR REPLACE INTO meta VALUES('migrated','1')").run();
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
    return a.rows.length;
  }
  if (a.sid) a.sid = stableId(a.sid, a.jid);
  if (op === "get")
    return prepare("SELECT * FROM messages WHERE sid=COALESCE((SELECT sid FROM message_aliases WHERE alias=?),?)").get(
      a.sid,
      a.sid,
    );
  if (op === "mediaTrack") {
    prepare("INSERT OR IGNORE INTO media VALUES(?,?,?)").run(a.sid, a.path, a.expires ?? null);
    return;
  }
  if (op === "expiredMedia")
    return prepare("SELECT DISTINCT sid FROM media WHERE expires IS NOT NULL AND expires<=?")
      .all(a.now)
      .map((r) => r.sid);
  if (op === "mediaForget") {
    prepare("DELETE FROM media WHERE sid=?").run(a.sid);
    return;
  }
  if (op === "mediaPaths")
    return prepare("SELECT path FROM media WHERE sid=?")
      .all(a.sid)
      .map((r) => r.path);
  if (op === "alias") {
    const erased: string[] = [];
    db.exec("BEGIN IMMEDIATE");
    try {
      prepare("INSERT OR REPLACE INTO aliases VALUES(?,?)").run(a.alias, a.jid);
      prepare("UPDATE messages SET jid=? WHERE jid=?").run(a.jid, a.alias);
      prepare("UPDATE messages SET sender=? WHERE sender=?").run(a.jid, a.alias);
      const groups = prepare(
        "SELECT origin,keyid FROM messages WHERE jid=? GROUP BY origin,keyid HAVING count(*)>1",
      ).all(a.jid);
      for (const group of groups) {
        const rows = db
          .prepare("SELECT rowid,* FROM messages WHERE jid=? AND origin=? AND keyid=? ORDER BY rowid")
          .all(a.jid, group.origin, group.keyid) as any[];
        const keeper = rows[0];
        const preferred = [...rows].sort(
          (a, b) => b.deleted - a.deleted || b.edited - a.edited || b.rowid - a.rowid,
        )[0];
        put({ ...preferred, sid: keeper.sid });
        for (const duplicate of rows.slice(1)) {
          prepare("UPDATE message_aliases SET sid=? WHERE sid=?").run(keeper.sid, duplicate.sid);
          prepare("INSERT OR REPLACE INTO message_aliases VALUES(?,?)").run(duplicate.sid, keeper.sid);
          prepare("UPDATE messages SET quoted=? WHERE quoted=?").run(keeper.sid, duplicate.sid);
          prepare("INSERT OR IGNORE INTO media SELECT ?,path,expires FROM media WHERE sid=?").run(
            keeper.sid,
            duplicate.sid,
          );
          prepare("DELETE FROM media WHERE sid=?").run(duplicate.sid);
          prepare("DELETE FROM search WHERE rowid=?").run(duplicate.rowid);
          prepare("DELETE FROM messages WHERE sid=?").run(duplicate.sid);
        }
        if (preferred.deleted) erased.push(keeper.sid);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    for (const sid of erased) erase(sid);
    return erased;
  }
  if (op === "aliases") return prepare("SELECT * FROM aliases").all();
  if (op === "expire") {
    const rows = prepare("SELECT sid FROM messages WHERE deleted=0 AND expires IS NOT NULL AND expires<=?").all(a.now);
    for (const r of rows) erase(String(r.sid));
    return rows.map((r) => r.sid);
  }
  if (op === "erase") {
    erase(a.sid, a.jid, a.ts);
    return;
  }
  if (op === "edit") {
    const r = prepare("SELECT * FROM messages WHERE sid=?").get(a.sid) as any;
    if (r && !r.deleted) put({ ...r, ...a.row, sid: a.sid, jid: r.jid, ts: r.ts, expires: r.expires, edited: 1 });
    return;
  }
  if (op === "reaction") {
    const r = prepare("SELECT extra FROM messages WHERE sid=? AND deleted=0").get(a.sid) as any;
    if (r) {
      const extra = JSON.parse(r.extra);
      const reactions = (extra.reactions ?? []).filter((r: any) => r.sender !== a.author);
      if (a.emoji) reactions.push({ sender: a.author, emoji: a.emoji });
      extra.reactions = reactions;
      prepare("UPDATE messages SET extra=? WHERE sid=?").run(JSON.stringify(extra), a.sid);
    }
    return;
  }
  if (op === "extra") {
    const r = prepare("SELECT * FROM messages WHERE sid=?").get(a.sid) as any;
    if (r && !r.deleted)
      put({ ...r, extra: JSON.stringify({ ...JSON.parse(r.extra), ...a.extra }), text: a.text ?? r.text });
    return;
  }
  if (op === "watermark") return prepare("SELECT max(rowid) id FROM messages").get();
  if (op === "chats") return prepare("SELECT jid,max(ts) ts FROM messages GROUP BY jid").all();
  if (op === "remove") {
    prepare("DELETE FROM search WHERE rowid=(SELECT rowid FROM messages WHERE sid=?)").run(a.sid);
    prepare("DELETE FROM messages WHERE sid=?").run(a.sid);
    return;
  }
  if (op === "coverage")
    return prepare("SELECT min(ts) oldest,max(ts) newest,count(*) count FROM messages WHERE (? IS NULL OR jid=?)").get(
      a.jid ?? null,
      a.jid ?? null,
    );
  if (op === "query") {
    const where: string[] = ["1=1"];
    const params: any[] = [];
    const add = (s: string, ...v: any[]) => {
      where.push(s);
      params.push(...v);
    };
    if (a.watermark !== undefined) add("rowid<=?", a.watermark);
    if (a.jids) add(`jid IN (${a.jids.map(() => "?").join(",")})`, ...a.jids);
    if (a.excludeSystem) add("type NOT IN ('system','deleted')");
    if (a.group === true) add("jid LIKE '%@g.us'");
    if (a.group === false) add("jid NOT LIKE '%@g.us'");
    if (a.jid) add("jid=?", a.jid);
    if (a.from) add("sender=?", a.from);
    if (a.since !== undefined) add("ts>=?", a.since);
    if (a.until !== undefined) add("ts<=?", a.until);
    if (a.before) add("(ts<? OR (ts=? AND sid<?))", a.before.ts, a.before.ts, a.before.sid);
    if (a.types?.length) add(`type IN (${a.types.map(() => "?").join(",")})`, ...a.types);
    if (a.query) {
      const q = a.query.toLowerCase();
      add("deleted=0 AND instr(text,?)>0", q);
      if ([...q].length >= 3)
        add("sid IN (SELECT sid FROM search WHERE search MATCH ?)", '"' + q.replaceAll('"', '""') + '"');
    }
    return prepare(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY ts DESC,sid DESC LIMIT ?`).all(
      ...params,
      a.limit ?? 201,
    );
  }
  if (op === "outboxPut") {
    prepare("INSERT OR REPLACE INTO outbox VALUES(?,?)").run(a.id, JSON.stringify(a.value));
    return;
  }
  if (op === "outboxAll")
    return prepare("SELECT value FROM outbox")
      .all()
      .map((r) => JSON.parse(String(r.value)));
  throw Error(`Unknown archive operation ${op}`);
}
function put(r: any): void {
  r = { ...r };
  const mapped = prepare("SELECT jid FROM aliases WHERE alias=?").get(r.jid) as any;
  if (mapped) r.jid = mapped.jid;
  const { key, origin: prefix } = splitMessageId(r.sid);
  const existing = prepare("SELECT sid FROM messages WHERE jid=? AND origin=? AND keyid=? LIMIT 1").get(
    r.jid,
    prefix,
    key,
  ) as any;
  if (existing && existing.sid !== r.sid) {
    prepare("INSERT OR REPLACE INTO message_aliases VALUES(?,?)").run(r.sid, existing.sid);
    r.sid = existing.sid;
  }

  if (r.quoted) {
    r.quoted = stableId(r.quoted);
    const target = prepare("SELECT deleted FROM messages WHERE sid=?").get(r.quoted) as any;
    if (target?.deleted) scrubQuote(r);
  }
  const old = prepare("SELECT rowid,deleted,edited,extra,text,expires FROM messages WHERE sid=?").get(r.sid) as any;
  if (old?.deleted || (old?.edited && !r.edited)) return;
  if (old) {
    if (old.expires != null) r.expires = r.expires == null ? old.expires : Math.min(old.expires, r.expires);
    const prior = JSON.parse(old.extra);
    const extra = typeof r.extra === "string" ? JSON.parse(r.extra) : { ...r.extra };
    if (prior.transcript && !extra.transcript) {
      extra.transcript = prior.transcript;
      r.text = old.text;
    }
    if (prior.reactions?.length && !extra.reactions?.length) extra.reactions = prior.reactions;
    r.extra = extra;
  }
  if (old) prepare("DELETE FROM search WHERE rowid=?").run(old.rowid);
  const written = prepare(
    `INSERT OR REPLACE INTO messages(sid,jid,ts,sender,type,text,raw,extra,deleted,expires,quoted,edited,keyid,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    r.sid,
    r.jid,
    r.ts,
    r.sender,
    r.type,
    r.text.toLowerCase(),
    r.raw,
    typeof r.extra === "string" ? r.extra : JSON.stringify(r.extra ?? {}),
    r.deleted ?? 0,
    r.expires ?? null,
    r.quoted ?? null,
    r.edited ?? 0,
    key,
    prefix,
  );
  if (!r.deleted)
    prepare("INSERT INTO search(rowid,sid,text) VALUES(?,?,?)").run(
      written.lastInsertRowid,
      r.sid,
      r.text.toLowerCase(),
    );
}
function erase(sid: string, jid = "", ts = 0): void {
  sid = stableId(sid, jid);
  db.exec("BEGIN IMMEDIATE");
  try {
    prepare("INSERT OR IGNORE INTO messages(sid,jid,ts,sender,type,text,raw) VALUES(?,?,?,'','deleted','','')").run(
      sid,
      jid,
      ts,
    );
    prepare("UPDATE messages SET keyid=?,origin=? WHERE sid=?").run(
      splitMessageId(sid).key,
      splitMessageId(sid).origin,
      sid,
    );
    prepare("UPDATE messages SET type='deleted',text='',raw='',extra='{}',deleted=1 WHERE sid=?").run(sid);
    prepare("DELETE FROM search WHERE rowid=(SELECT rowid FROM messages WHERE sid=?)").run(sid);
    prepare(
      "UPDATE outbox SET value=json_set(value,'$.result.text','[deleted]') WHERE json_extract(value,'$.messageId')=? AND json_extract(value,'$.state')='sent'",
    ).run(splitMessageId(sid).key);
    // Quotes carry an embedded copy of the original. Remove it as well.
    const quotes = prepare("SELECT sid,extra FROM messages WHERE quoted=?").all(sid);
    for (const row of quotes) {
      const extra = JSON.parse(String(row.extra));
      delete extra.quoted;
      if (extra.view) delete extra.view.quoted;
      const quotedRow = prepare("SELECT raw FROM messages WHERE sid=?").get(row.sid) as any;
      if (quotedRow.raw) {
        const raw = proto.WebMessageInfo.decode(Buffer.from(quotedRow.raw, "base64"));
        const scrub = (value: any): void => {
          if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return;
          delete value.quotedMessage;
          for (const child of Object.values(value)) scrub(child);
        };
        scrub(raw);
        prepare("UPDATE messages SET raw=? WHERE sid=?").run(
          Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString("base64"),
          row.sid,
        );
      }
      prepare("UPDATE messages SET extra=?,quoted=NULL WHERE sid=?").run(JSON.stringify(extra), row.sid);
    }
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw e;
  }
}
