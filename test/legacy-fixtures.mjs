/**
 * A legacy account written by main's own persistence code: a WhatsAppService
 * with a fake socket is fed events (messages, a history sync, edits, a delete
 * for me, a revoke, a cleared chat, a lid that pairs with a number, reactions,
 * a vote, receipts, a transcript, a story, calls, notes and a handled mark),
 * then stopped so store.json, history/, retention.json and notes.json are what
 * a real account leaves. The recall index and the beta archive are synthesized
 * in their on-disk formats, and a few damaged lines are appended.
 */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "baileys";

import { WhatsAppService } from "../dist/whatsapp.js";
import { searchableText } from "../dist/messages.js";
import { sqlite } from "../dist/db/sqlite.js";
import { connectedService } from "./helpers.mjs";

export const ME = "40700000001@s.whatsapp.net";
export const ANA = "40700000002@s.whatsapp.net";
export const BOGDAN = "40700000003@s.whatsapp.net";
export const BOGDAN_LID = "111111111111111@lid";
export const CRISTI = "40700000004@s.whatsapp.net";
export const DANA = "40700000005@s.whatsapp.net";
export const GHOST_LID = "222222222222222@lid";
export const GROUP = "120363000000000009@g.us";
export const DIMS = 768;
export const MODEL = "embeddinggemma-300m";

const ENV = ["WAZAP_RECALL", "WAZAP_RETENTION", "WAZAP_TRANSCRIBE", "WAZAP_WEBHOOK_URL", "WAZAP_EMBED_URL"];

export const sid = (fromMe, chat, id) => `${fromMe}_${chat}_${id}`;

/** The sids a test asserts on, by role. */
export function roles() {
  return {
    a1: sid(false, ANA, "A1"),
    a2: sid(true, ANA, "A2"),
    a3: sid(false, ANA, "A3"),
    a4: sid(false, ANA, "A4"),
    voice: sid(false, ANA, "V1"),
    callPlaceholder: sid(false, ANA, "C1"),
    callLog: sid(false, ANA, "C2"),
    synced: sid(false, ANA, "S1"),
    future: sid(false, ANA, "F1"),
    b1: sid(false, BOGDAN, "B1"),
    b1Lid: sid(false, BOGDAN_LID, "B1"),
    b2: sid(false, BOGDAN, "B2"),
    b3: sid(true, BOGDAN, "B3"),
    g1: sid(false, GROUP, "G1"),
    g2: sid(false, GROUP, "G2"),
    g3: sid(true, GROUP, "G3"),
    g4: sid(false, GROUP, "G4"),
    revoke: sid(false, GROUP, "REV1"),
    poll: sid(true, GROUP, "P1"),
    orphanVote: sid(false, GROUP, "V9"),
    k1: sid(false, CRISTI, "K1"),
    ghost: sid(false, GHOST_LID, "H1"),
    ephemeral: sid(false, DANA, "E1"),
    expired: sid(false, DANA, "E2"),
    story: sid(false, "status@broadcast", "ST1"),
    indexOnly: sid(false, ANA, "IDX1"),
    dropped: sid(false, ANA, "DROP1"),
    beta1: sid(false, ANA, "BETA1"),
    beta2: sid(false, GROUP, "BETA2"),
    betaViewOnce: sid(false, ANA, "VO1"),
    betaGone: sid(false, ANA, "GONE1"),
  };
}

function upsert(sock, messages, type = "notify") {
  sock.ev.emit("messages.upsert", { type, messages });
}

function msg({ chat, id, fromMe = false, participant, ts, message, pushName, stub }) {
  return {
    key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) },
    messageTimestamp: ts,
    ...(message ? { message } : {}),
    ...(pushName ? { pushName } : {}),
    ...(stub === undefined ? {} : { messageStubType: stub }),
  };
}

function b64(raw) {
  return Buffer.from(proto.WebMessageInfo.encode(proto.WebMessageInfo.fromObject(raw)).finish()).toString("base64");
}

/** A deterministic unit-ish int8 row per index. */
export function vectorRow(i) {
  const row = new Int8Array(DIMS);
  for (let d = 0; d < DIMS; d++) row[d] = ((d * 31 + i * 17) % 200) - 100;
  return row;
}

/**
 * Builds the account and returns its data dir and the times it used.
 * `retention` runs the service with WAZAP_RETENTION on; `beta` writes an
 * archive owned by `betaOwner`; `linked` writes the credentials that name ME.
 */
export async function buildLegacyAccount({ retention = false, beta = true, betaOwner = ME, linked = true } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-legacy-"));
  const saved = ENV.map((key) => [key, process.env[key]]);
  for (const key of ENV) delete process.env[key];
  let connected;
  try {
    connected = connectedService(WhatsAppService, {
      prefix: "wazap-legacy-",
      id: ME,
      name: "Răzvan",
      config: { dataDir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0, retention },
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const { svc, sock } = connected;
  sock.chatModify = async () => {};
  const now = Date.now();
  const T = Math.floor(now / 1000) - 3 * 86_400;
  const r = roles();

  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Ana Pop" },
    { id: BOGDAN, name: "Bogdan Ionescu" },
    { id: DANA, notify: "Dana" },
  ]);
  sock.ev.emit("chats.upsert", [
    { id: ANA, unreadCount: 1, conversationTimestamp: T + 100 },
    { id: GROUP, name: "Echipa", unreadCount: 3, archived: false },
    { id: CRISTI, unreadCount: 0 },
  ]);

  // A history sync: older messages the phone sent over.
  sock.ev.emit("messaging-history.set", {
    chats: [],
    contacts: [],
    messages: [msg({ chat: ANA, id: "S1", ts: T - 100, message: { conversation: "Mesaj vechi sincronizat din telefon" } })],
    isLatest: false,
    progress: 50,
  });

  // Ana: a direct chat with an edit, a delete for me, an ask, a voice note and a call.
  upsert(sock, [msg({ chat: ANA, id: "A1", ts: T + 10, message: { conversation: "Salut, ce mai faci azi?" }, pushName: "Ana" })]);
  upsert(sock, [msg({ chat: ANA, id: "A2", fromMe: true, ts: T + 20, message: { conversation: "Bine, mulțumesc frumos" } })]);
  upsert(sock, [msg({ chat: ANA, id: "A3", ts: T + 30, message: { conversation: "Mesaj pe care îl șterg doar la mine" } })]);
  upsert(sock, [msg({ chat: ANA, id: "A4", ts: T + 40, message: { conversation: "Ai timp mâine dimineață?" } })]);
  svc.store.setTranscript(r.voice, { text: "Te sun mai târziu", provider: "local", at: now });
  upsert(sock, [msg({ chat: ANA, id: "V1", ts: T + 50, message: { audioMessage: { ptt: true, seconds: 42, mimetype: "audio/ogg" } } })]);
  upsert(sock, [msg({ chat: ANA, id: "C1", ts: T + 60, message: { call: { callKey: Buffer.from("key") } } })]);
  upsert(sock, [msg({ chat: ANA, id: "C2", ts: T + 90, message: { callLogMesssage: { isVideo: false, callOutcome: 0, durationSecs: 42 } } })]);
  sock.ev.emit("messages.update", [
    {
      key: { remoteJid: ANA, fromMe: true, id: "A2" },
      update: { message: { editedMessage: { message: { conversation: "Bine, mulțumesc frumos, tu?" } } }, messageTimestamp: T + 100 },
    },
  ]);
  sock.ev.emit("messages.update", [{ key: { remoteJid: ANA, fromMe: true, id: "A2" }, update: { status: 4 } }]);

  // Bogdan: first known by a lid, then paired with his number.
  upsert(sock, [msg({ chat: BOGDAN_LID, id: "B1", ts: T + 200, message: { conversation: "Salutare de pe lid, sunt Bogdan" } })]);
  await svc.setContactNote(BOGDAN_LID, "Bogdan de la depozit");
  sock.ev.emit("lid-mapping.update", { lid: BOGDAN_LID, pn: BOGDAN });
  upsert(sock, [msg({ chat: BOGDAN, id: "B2", ts: T + 300, message: { conversation: "Acum scriu de pe număr" } })]);
  upsert(sock, [msg({ chat: BOGDAN_LID, id: "B3", fromMe: true, ts: T + 310, message: { conversation: "Răspuns trimis spre lid" } })]);
  await svc.updateContactDetails(BOGDAN, { addTags: ["furnizor"], fields: { oras: "Cluj" } });

  // The group: a reply, a reaction, receipts, a revoke of the quoted message, a poll with a vote.
  upsert(sock, [msg({ chat: GROUP, id: "G1", participant: DANA, ts: T + 400, message: { conversation: "Ședința e la ora zece" } })]);
  upsert(sock, [msg({ chat: GROUP, id: "G2", participant: ANA, ts: T + 410, message: { conversation: "Confirm prezența la ședință" } })]);
  upsert(sock, [msg({ chat: GROUP, id: "G3", fromMe: true, ts: T + 420, message: { conversation: "Vin și eu cu raportul" } })]);
  sock.ev.emit("message-receipt.update", [
    { key: { remoteJid: GROUP, fromMe: true, id: "G3" }, receipt: { userJid: DANA, readTimestamp: T + 425, receiptTimestamp: T + 421 } },
    { key: { remoteJid: GROUP, fromMe: true, id: "G3" }, receipt: { userJid: ANA, receiptTimestamp: T + 422 } },
  ]);
  upsert(sock, [
    msg({
      chat: GROUP,
      id: "G4",
      participant: DANA,
      ts: T + 430,
      message: {
        extendedTextMessage: {
          text: "Perfect, mulțumesc Ana",
          contextInfo: { stanzaId: "G2", participant: ANA, quotedMessage: { conversation: "Confirm prezența la ședință" } },
        },
      },
    }),
  ]);
  upsert(sock, [
    msg({ chat: GROUP, id: "R1", participant: ANA, ts: T + 440, message: { reactionMessage: { key: { remoteJid: GROUP, fromMe: false, id: "G1", participant: DANA }, text: "👍" } } }),
  ]);
  upsert(sock, [
    msg({
      chat: GROUP,
      id: "REV1",
      participant: ANA,
      ts: T + 450,
      message: { protocolMessage: { type: 0, key: { remoteJid: GROUP, fromMe: false, id: "G2", participant: ANA } } },
    }),
  ]);
  upsert(sock, [
    msg({
      chat: GROUP,
      id: "P1",
      fromMe: true,
      ts: T + 460,
      message: {
        messageContextInfo: { messageSecret: Buffer.alloc(32, 7) },
        pollCreationMessage: { name: "Unde mergem?", options: [{ optionName: "Cluj" }, { optionName: "Iași" }], selectableOptionsCount: 1 },
      },
    }),
  ]);
  svc.store.vote(r.poll, DANA, ["Cluj"], (T + 470) * 1000);
  upsert(sock, [
    msg({
      chat: GROUP,
      id: "V9",
      participant: DANA,
      ts: T + 480,
      message: {
        pollUpdateMessage: {
          pollCreationMessageKey: { remoteJid: GROUP, fromMe: false, id: "NOPOLL" },
          vote: { encPayload: Buffer.alloc(16, 1), encIv: Buffer.alloc(12, 2) },
          senderTimestampMs: (T + 480) * 1000,
        },
      },
    }),
  ]);

  // Cristi: a chat cleared on the phone.
  upsert(sock, [msg({ chat: CRISTI, id: "K1", ts: T + 500, message: { conversation: "Mesaj care va fi golit" } })]);
  upsert(sock, [msg({ chat: CRISTI, id: "K2", ts: T + 510, message: { conversation: "Încă unul golit" } })]);
  await svc.retentionIdle();
  sock.ev.emit("messages.delete", { jid: CRISTI, all: true });

  // A lid nobody paired, and a story from the last hours.
  upsert(sock, [msg({ chat: GHOST_LID, id: "H1", ts: T + 600, message: { conversation: "Cineva necunoscut scrie" } })]);
  upsert(sock, [
    msg({
      chat: "status@broadcast",
      id: "ST1",
      participant: DANA,
      ts: Math.floor(now / 1000) - 7_200,
      message: { imageMessage: { caption: "Priveliște frumoasă", mimetype: "image/jpeg" } },
    }),
  ]);

  // Dana: disappearing messages, one still inside its timer and one past it.
  const nowSeconds = Math.floor(now / 1000);
  upsert(sock, [
    msg({ chat: DANA, id: "E1", ts: nowSeconds - 3_600, message: { extendedTextMessage: { text: "Mesaj care dispare într-o săptămână", contextInfo: { expiration: 7 * 86_400 } } } }),
  ]);
  upsert(sock, [
    msg({ chat: DANA, id: "E2", ts: nowSeconds - 7_200, message: { extendedTextMessage: { text: "Mesaj care a dispărut deja", contextInfo: { expiration: 3_600 } } } }),
  ]);

  await svc.retentionIdle();
  await svc.deleteMessage(r.a3, false);
  await svc.setContactNote(ANA, "Colegă de proiect");
  await svc.markHandled(ANA);
  await svc.retentionIdle();
  svc.markStoreDirty();
  await svc.stop();

  const paths = svc.paths;
  if (linked) {
    mkdirSync(paths.authDir, { recursive: true });
    writeFileSync(join(paths.authDir, "creds.json"), JSON.stringify({ me: { id: "40700000001:3@s.whatsapp.net", name: "Răzvan" } }));
  }

  // Damage and a clock gone wrong, the way a crash or a bad device leaves them.
  appendFileSync(join(paths.historyDir, `${ANA}.jsonl`), `${JSON.stringify({ sid: r.future, ts: Math.floor(now / 1000) + 10 * 86_400, raw: b64(msg({ chat: ANA, id: "F1", ts: Math.floor(now / 1000) + 10 * 86_400, message: { conversation: "Mesaj din viitor" } })) })}\n`);
  appendFileSync(join(paths.historyDir, `${BOGDAN}.jsonl`), "{not json at all\n");
  appendFileSync(join(paths.historyDir, `${GROUP}.jsonl`), `{"sid":"false_${GROUP}_TORN","ts":${T + 700},"raw":"CgsKCTEyMzQ1`);

  writeRecall(paths.root, { T, now });
  if (beta) writeBeta(join(dataDir, "archive.sqlite"), { T, now, owner: betaOwner });
  return { dataDir, paths, now, T };
}

function writeRecall(root, { T }) {
  const r = roles();
  const dir = join(root, "recall");
  mkdirSync(dir, { recursive: true });
  const raw = (fields) => proto.WebMessageInfo.fromObject(msg(fields));
  const rows = [
    { sid: r.a1, jid: ANA, ts: (T + 10) * 1000, sender: ANA, type: "text", text: "Salut, ce mai faci azi?" },
    // Embedded before the edit: the words no longer match.
    { sid: r.a2, jid: ANA, ts: (T + 20) * 1000, sender: ME, type: "text", text: "Bine, mulțumesc frumos" },
    { sid: r.g1, jid: GROUP, ts: (T + 400) * 1000, sender: DANA, type: "text", text: "Ședința e la ora zece" },
    { sid: r.indexOnly, jid: ANA, ts: (T - 5_000) * 1000, sender: ANA, type: "text", text: "Mesaj vechi rămas doar în index" },
    { sid: r.a3, jid: ANA, ts: (T + 30) * 1000, sender: ANA, type: "text", text: "Mesaj pe care îl șterg doar la mine" },
    { sid: r.k1, jid: CRISTI, ts: (T + 500) * 1000, sender: CRISTI, type: "text", text: "Mesaj care va fi golit" },
    { sid: r.g2, jid: GROUP, ts: (T + 410) * 1000, sender: ANA, type: "text", text: "Confirm prezența la ședință" },
    { sid: r.dropped, jid: ANA, ts: (T - 4_000) * 1000, sender: ANA, type: "text", text: "Rând șters din index" },
    {
      sid: r.voice,
      jid: ANA,
      ts: (T + 50) * 1000,
      sender: ANA,
      type: "voice",
      text: searchableText(raw({ chat: ANA, id: "V1", ts: T + 50, message: { audioMessage: { ptt: true, seconds: 42 } } }), { text: "Te sun mai târziu" }),
    },
    { sid: r.b1Lid, jid: BOGDAN, ts: (T + 200) * 1000, sender: BOGDAN, type: "text", text: "Salutare de pe lid, sunt Bogdan" },
  ];
  const lines = rows.map((row, i) => JSON.stringify({ op: "put", ...row, model: MODEL, row: i }));
  lines.splice(8, 0, JSON.stringify({ op: "del", sid: r.dropped }));
  lines.push("garbage that is not json");
  writeFileSync(join(dir, "meta.jsonl"), `${lines.join("\n")}\n`);
  const bytes = Buffer.alloc(rows.length * DIMS);
  rows.forEach((_, i) => Buffer.from(vectorRow(i).buffer).copy(bytes, i * DIMS));
  writeFileSync(join(dir, "vectors.bin"), bytes);
  writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 3, model: MODEL, dims: DIMS, quant: "int8", offsets: {} }));
}

/** The 0.15-beta archive schema, the tables the import reads. */
function writeBeta(path, { T, now, owner }) {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE messages(sid TEXT PRIMARY KEY,jid TEXT NOT NULL,ts INTEGER NOT NULL,sender TEXT NOT NULL,type TEXT NOT NULL,text TEXT NOT NULL,raw TEXT NOT NULL,extra TEXT NOT NULL DEFAULT '{}',deleted INTEGER NOT NULL DEFAULT 0,expires INTEGER,quoted TEXT,edited INTEGER NOT NULL DEFAULT 0,keyid TEXT NOT NULL DEFAULT '',origin TEXT NOT NULL DEFAULT '');
    CREATE TABLE message_aliases(alias TEXT PRIMARY KEY,sid TEXT NOT NULL);
    CREATE TABLE aliases(alias TEXT PRIMARY KEY,jid TEXT NOT NULL);
    PRAGMA user_version=1;`);
  db.prepare("INSERT INTO meta VALUES('owner', ?)").run(owner);
  db.prepare("INSERT INTO meta VALUES('migrated', '1')").run();
  const insert = db.prepare(
    "INSERT INTO messages(sid,jid,ts,sender,type,text,raw,extra,deleted,expires,keyid,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  const row = ({ fromMe = false, chat, id, ts, sender, type = "text", text = "", raw = "", extra = {}, deleted = 0, expires = null }) =>
    insert.run(`${fromMe}_${chat}_${id}`, chat, ts, sender, type, text.toLowerCase(), raw, JSON.stringify(extra), deleted, expires, id, `${fromMe}_`);
  // Already in the legacy files.
  row({ chat: ANA, id: "A1", ts: (T + 10) * 1000, sender: ANA, text: "Salut, ce mai faci azi?", raw: b64(msg({ chat: ANA, id: "A1", ts: T + 10, message: { conversation: "Salut, ce mai faci azi?" } })) });
  // Only the beta still has these.
  row({ chat: ANA, id: "BETA1", ts: (T - 500) * 1000, sender: ANA, text: "Mesaj din arhiva beta", raw: b64(msg({ chat: ANA, id: "BETA1", ts: T - 500, message: { conversation: "Mesaj din arhiva beta" } })) });
  row({
    chat: GROUP,
    id: "BETA2",
    ts: (T - 400) * 1000,
    sender: DANA,
    text: "Poza de la munte",
    raw: b64(msg({ chat: GROUP, id: "BETA2", participant: DANA, ts: T - 400, message: { conversation: "Poza de la munte" } })),
    extra: { reactions: [{ sender: ANA, emoji: "❤️" }] },
  });
  row({ chat: ANA, id: "VO1", ts: (T - 300) * 1000, sender: ANA, type: "view_once", text: "[view-once photo]" });
  // Deleted in the legacy files: the beta's live copy must not bring it back.
  row({ chat: ANA, id: "A3", ts: (T + 30) * 1000, sender: ANA, text: "Mesaj pe care îl șterg doar la mine", raw: b64(msg({ chat: ANA, id: "A3", ts: T + 30, message: { conversation: "Mesaj pe care îl șterg doar la mine" } })) });
  row({ chat: GROUP, id: "G2", ts: (T + 410) * 1000, sender: ANA, type: "deleted", deleted: 1 });
  // Deleted in the beta: a message the legacy files still show, and one nobody else has.
  row({ chat: BOGDAN, id: "B2", ts: (T + 300) * 1000, sender: BOGDAN, type: "deleted", deleted: 1 });
  row({ chat: ANA, id: "GONE1", ts: (T - 600) * 1000, sender: ANA, type: "deleted", deleted: 1 });
  // Expired by the beta's unconditional expiry: not a deletion while retention is off.
  row({ chat: GHOST_LID, id: "H1", ts: (T + 600) * 1000, sender: GHOST_LID, type: "deleted", deleted: 1, expires: now - 86_400_000 });
  db.close();
}
