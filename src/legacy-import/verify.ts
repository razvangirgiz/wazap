/**
 * The import checked against the legacy service's own view of the same files:
 * per chat, the visible messages and the newest one; every deletion, clear and
 * deadline hidden; notes, fields and handled marks; reactions, votes and
 * receipts on each chat's newest messages; the named contacts.
 *
 * A difference the design expects — the database keeps what the legacy files
 * lost or capped — is counted as expected, by why; anything else is
 * unexpected, with the keys to investigate it by. Never message text.
 */
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { readLinkedAccount } from "../auth-state.js";
import type { AccountPaths } from "../config.js";
import { chatKindOf, contentHash, normalizeJid, parseSid, type AccountDb, type StoredMessage } from "../db/index.js";
import { buildContext } from "./context.js";
import { base64Bytes, decodeRaw, FUTURE_SLACK_MS, viewSidOf } from "./convert.js";
import { loadLegacyView, MARKS_SAMPLE, type LegacyMessage } from "./legacy-view.js";
import type { ExpectedDifference, UnexpectedDifference, VerificationReport } from "./report.js";
import { betaOwner, betaRows, findBetaArchive, historyFiles, isBetaExpiry, openBetaArchive, readHistoryFile, readRecallIndex, recallLine } from "./sources.js";

/** Keys kept per unexpected category: enough to investigate, never a dump. */
export const SAMPLE_KEYS = 20;
/** Lines the legacy reload keeps per history file, and messages per chat ring. */
const LEGACY_CAP = 2_000;

export interface VerifyArgs {
  dataDir: string;
  accountId: string;
  accountPaths: AccountPaths;
  db: AccountDb;
  options?: {
    retention?: boolean;
    workDir?: string;
    now?: () => number;
    betaArchive?: string | null;
  };
}

/** Where each key the database may hold came from, to explain a row the legacy view lacks. */
interface Provenance {
  history: Set<string>;
  fileCapped: Set<string>;
  beta: Set<string>;
  betaDeleted: Set<string>;
  recall: Set<string>;
}

class Tally {
  readonly expected: Partial<Record<ExpectedDifference, number>> = {};
  readonly unexpected: Partial<Record<UnexpectedDifference, number>> = {};
  readonly samples: Partial<Record<UnexpectedDifference, string[]>> = {};

  expect(kind: ExpectedDifference, n = 1): void {
    this.expected[kind] = (this.expected[kind] ?? 0) + n;
  }

  fail(kind: UnexpectedDifference, key: string): void {
    this.unexpected[kind] = (this.unexpected[kind] ?? 0) + 1;
    const keys = (this.samples[kind] ??= []);
    if (keys.length < SAMPLE_KEYS) keys.push(key);
  }
}

export async function verifyLegacyImport(args: VerifyArgs): Promise<VerificationReport> {
  const started = performance.now();
  const { db } = args;
  const options = args.options ?? {};
  const owner = readLinkedAccount(args.accountPaths.authDir);
  const legacy = await loadLegacyView({
    accountId: args.accountId,
    accountPaths: args.accountPaths,
    owner,
    retention: options.retention === true,
    workDir: options.workDir ?? dirname(db.path),
  });
  const now = (options.now ?? Date.now)();
  const context = buildContext({ accountPaths: args.accountPaths, now, enforceExpiry: false });
  const tally = new Tally();

  /** A chat's jid as the database files it; the key every comparison goes through. */
  const dbChat = (jid: string): string => db.identity.chat(jid)?.jid ?? (chatKindOf(normalizeJid(jid)) === "direct" ? db.identity.canonicalJid(jid) : normalizeJid(jid));
  const keyOf = (chat: string, fromMe: boolean, keyId: string): string => `${fromMe}_${dbChat(chat)}_${keyId}`;
  const keyOfSid = (sid: string): string | null => {
    const parsed = parseSid(sid);
    return parsed === null || parsed.fromMe === null ? null : keyOf(parsed.chatJid, parsed.fromMe, parsed.keyId);
  };

  const betaArchive = options.betaArchive === undefined ? findBetaArchive(args.dataDir, args.accountPaths) : options.betaArchive;
  const provenance = collectProvenance(context, keyOfSid, owner?.id ?? null, betaArchive, options.retention === true);

  const deletedKeys = new Set(legacy.deleted.flatMap((sid) => keyOfSid(sid) ?? []));

  // Messages, chat by chat.
  const legacyByChat = new Map<string, { visible: LegacyMessage[]; ringLength: number; last: LegacyMessage | null }>();
  for (const chat of legacy.chats) {
    const jid = dbChat(chat.jid);
    const entry = legacyByChat.get(jid) ?? { visible: [], ringLength: 0, last: null };
    entry.visible.push(...chat.visible);
    entry.ringLength = Math.max(entry.ringLength, chat.ringLength);
    const last = chat.visible[chat.visible.length - 1] ?? null;
    if (last !== null && (entry.last === null || last.ts >= entry.last.ts)) entry.last = last;
    legacyByChat.set(jid, entry);
  }
  const dbChats = new Set<string>();
  for (let before: { lastTs: number; id: number } | undefined; ; ) {
    const page = db.messages.listChats({ limit: 1000, ...(before === undefined ? {} : { before }) });
    for (const item of page.items) dbChats.add(item.chat.jid);
    if (page.next === null) break;
    before = page.next;
  }
  dbChats.delete("status@broadcast");

  let legacyVisible = 0;
  let dbVisible = 0;
  let matched = 0;
  const allChats = new Set([...legacyByChat.keys(), ...dbChats]);
  for (const jid of allChats) {
    const entry = legacyByChat.get(jid) ?? { visible: [], ringLength: 0, last: null };
    const stored = visibleMessages(db, jid);
    const storedKeys = new Map(stored.map((message) => [message.sid, message]));
    const legacyKeys = new Map<string, LegacyMessage>();
    for (const message of entry.visible) legacyKeys.set(keyOf(jid, message.fromMe, message.keyId), message);
    legacyVisible += legacyKeys.size;
    dbVisible += storedKeys.size;
    const extras = new Set<string>();
    const removed = new Set<string>();
    for (const [key, message] of legacyKeys) {
      const row = storedKeys.get(key);
      if (row !== undefined) {
        matched++;
        if (row.type !== message.type || contentHash(row.text, row.transcript) !== message.words) tally.fail("renderMismatch", key);
        continue;
      }
      const why: ExpectedDifference | null =
        message.ts > now + FUTURE_SLACK_MS
          ? "futureTimestamp"
          : provenance.betaDeleted.has(key)
            ? "betaDeleted"
            : deletedKeys.has(key) && db.messages.get(key, { includeHidden: true })?.deletedAt != null
              ? "deletedUnderAlias"
              : null;
      if (why === null) tally.fail("missingInDb", key);
      else {
        tally.expect(why);
        removed.add(key);
      }
    }
    const oldestLegacy = entry.visible.reduce((min, message) => Math.min(min, message.ts), Infinity);
    for (const [key, message] of storedKeys) {
      if (legacyKeys.has(key)) continue;
      const kind = explainExtra(key, message, provenance, entry.ringLength, oldestLegacy);
      if (kind === null) tally.fail("extraInDb", key);
      else {
        tally.expect(kind);
        extras.add(key);
      }
    }
    // The newest message: what list_chats shows as the chat's last word.
    const newest = stored[0] ?? null;
    const last = entry.last === null ? null : keyOf(jid, entry.last.fromMe, entry.last.keyId);
    if (newest?.sid !== last && !(newest === null && last === null)) {
      if (last !== null && removed.has(last)) tally.expect("newestRemoved");
      else if (newest !== null && extras.has(newest.sid)) tally.expect("newestIsExtra");
      else if (newest !== null && last !== null && sameSecond(storedKeys.get(last), newest)) tally.expect("newestSameSecond");
      else tally.fail("newestDiffers", jid);
    }
  }

  // Stories.
  for (const story of legacy.stories) {
    const key = keyOf("status@broadcast", story.fromMe, story.keyId);
    if (db.messages.get(key) === null) tally.fail("storiesMissing", key);
  }

  // Barriers.
  let deletedChecked = 0;
  for (const sid of legacy.deleted) {
    const key = keyOfSid(sid);
    if (key === null) continue;
    deletedChecked++;
    if (db.messages.get(key) !== null) tally.fail("deletedVisible", key);
  }
  for (const [jid, at] of legacy.cleared) {
    const oldest = db.messages.coverage(dbChat(jid)).oldest;
    if (oldest !== null && oldest.ts <= at) tally.fail("clearedVisible", dbChat(jid));
  }
  let expiredChecked = 0;
  if (options.retention === true) {
    for (const [sid, at] of legacy.expires) {
      const key = keyOfSid(sid);
      if (key === null) continue;
      expiredChecked++;
      const message = db.messages.get(key);
      if (message !== null && (at <= now || message.expiresAt === null || message.expiresAt > at)) tally.fail("expiredVisible", key);
    }
  }

  // Notes, fields, handled marks.
  let notesDb = 0;
  for (const [jid, note] of legacy.notes) {
    if (db.identity.notes(jid)?.note === note) notesDb++;
    else tally.fail("notesMismatch", jid);
  }
  let fieldsDb = 0;
  for (const [jid, tags, fields] of legacy.fields) {
    const stored = db.identity.notes(jid);
    const same =
      stored !== null &&
      JSON.stringify([...stored.tags].sort()) === JSON.stringify([...tags].sort()) &&
      JSON.stringify(sortKeys(stored.fields)) === JSON.stringify(sortKeys(fields));
    if (same) fieldsDb++;
    else tally.fail("fieldsMismatch", jid);
  }
  let handledDb = 0;
  let handledLegacy = 0;
  for (const [jid, askSid, askVisible] of legacy.handled) {
    if (!askVisible) {
      tally.expect("handledAskMissing");
      continue;
    }
    handledLegacy++;
    const stored = db.identity.handled(jid);
    if (stored?.askSid !== null && stored?.askSid !== undefined && stored.askSid === keyOfSid(askSid)) handledDb++;
    else tally.fail("handledMismatch", jid);
  }

  // Marks on each chat's newest messages.
  let sampled = 0;
  let reactions = 0;
  let votes = 0;
  let receipts = 0;
  for (const [sid, marks] of legacy.marks) {
    const key = keyOfSid(sid);
    if (key === null || db.messages.get(key) === null) continue;
    sampled++;
    const r = db.messages.reactions(key).length;
    const v = db.messages.votes(key).length;
    const c = db.messages.receipts(key).length;
    reactions += marks.reactions;
    votes += marks.votes;
    receipts += marks.receipts;
    if (r !== marks.reactions) tally.fail("reactionsMismatch", key);
    if (v !== marks.votes) tally.fail("votesMismatch", key);
    if (c !== marks.receipts) tally.fail("receiptsMismatch", key);
  }

  // Named contacts.
  const { realName } = await import("../whatsapp.js");
  let namedDb = 0;
  for (const [jid] of legacy.contactsNamed) {
    if (realName(db.identity.contact(jid)?.name)) namedDb++;
    else tally.fail("contactsNamedMismatch", jid);
  }

  const report: VerificationReport = {
    ok: Object.keys(tally.unexpected).length === 0,
    durationMs: Math.round(performance.now() - started),
    chats: { legacy: legacyByChat.size, db: dbChats.size, compared: allChats.size },
    messages: { legacyVisible, dbVisible, matched },
    barriers: { deleted: deletedChecked, cleared: legacy.cleared.length, expired: expiredChecked },
    notes: { legacy: legacy.notes.length, db: notesDb },
    fields: { legacy: legacy.fields.length, db: fieldsDb },
    handled: { legacy: handledLegacy, db: handledDb },
    marks: { sampled, reactions, votes, receipts },
    contactsNamed: { legacy: legacy.contactsNamed.length, db: namedDb },
    expected: tally.expected,
    unexpected: tally.unexpected,
    samples: tally.samples,
  };
  return report;
}

function sortKeys(record: Record<string, string>): Array<[string, string]> {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function sameSecond(a: StoredMessage | undefined, b: StoredMessage): boolean {
  return a !== undefined && Math.floor(a.ts / 1000) === Math.floor(b.ts / 1000);
}

/** Every visible message of a chat, newest first. */
function visibleMessages(db: AccountDb, jid: string): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (let before: number | undefined; ; ) {
    const page = db.messages.chatPage(jid, { limit: 1000, ...(before === undefined ? {} : { before }) });
    out.push(...page.items);
    if (page.nextBefore === null) break;
    before = page.nextBefore;
  }
  return out;
}

/** Why the database holds a message the legacy view does not show, or null when nothing explains it. */
function explainExtra(
  key: string,
  message: StoredMessage,
  provenance: Provenance,
  ringLength: number,
  oldestLegacy: number
): ExpectedDifference | null {
  if (provenance.history.has(key)) {
    if (provenance.fileCapped.has(key)) return "legacyFileCap";
    if (ringLength >= LEGACY_CAP && message.ts <= oldestLegacy) return "legacyRingCap";
    return null;
  }
  if (provenance.beta.has(key)) return "betaOnly";
  if (provenance.recall.has(key) && message.raw === null) return "indexOnly";
  return null;
}

/** The keys each legacy source holds, over the database's canonical chats. */
function collectProvenance(
  context: ReturnType<typeof buildContext>,
  keyOfSid: (sid: string) => string | null,
  owner: string | null,
  betaArchive: string | null,
  retention: boolean
): Provenance {
  const provenance: Provenance = {
    history: new Set(),
    fileCapped: new Set(),
    beta: new Set(),
    betaDeleted: new Set(),
    recall: new Set(),
  };
  const dir = context.paths.historyDir;
  for (const name of historyFiles(dir)) {
    const newest = new Map<string, { key: string; ts: number }>();
    for (const record of readHistoryFile(dir, name)?.records ?? []) {
      if (record.deleted || !record.raw) continue;
      const raw = decodeRaw(base64Bytes(record.raw));
      const key =
        raw?.key?.remoteJid && raw.key.id
          ? `${Boolean(raw.key.fromMe)}_${context.lids.canonical(raw.key.remoteJid)}_${raw.key.id}`
          : null;
      const resolved = key === null ? keyOfSid(record.sid) : keyOfSid(key);
      if (resolved !== null) newest.set(record.sid, { key: resolved, ts: record.ts });
    }
    const sorted = [...newest.values()].sort((a, b) => a.ts - b.ts);
    sorted.forEach((entry, i) => {
      provenance.history.add(entry.key);
      if (i < sorted.length - LEGACY_CAP) provenance.fileCapped.add(entry.key);
    });
  }
  const recall = readRecallIndex(context.paths.recallDir).index;
  for (const live of recall?.live ?? []) {
    try {
      const view = viewSidOf(context, recallLine(recall!, live).sid);
      const key = view === null ? null : keyOfSid(view);
      if (key !== null) provenance.recall.add(key);
    } catch {
      // a torn line was never imported either
    }
  }
  if (betaArchive && owner !== null) {
    let archive;
    try {
      archive = openBetaArchive(betaArchive);
    } catch {
      archive = null;
    }
    if (archive !== null) {
      try {
        if (betaOwner(archive) === owner) {
          for (let after = 0; ; ) {
            const rows = betaRows(archive, after, 1000);
            if (rows.length === 0) break;
            for (const row of rows) {
              const fromMe = row.origin === "true_" ? true : row.origin === "false_" ? false : null;
              const raw = row.raw ? decodeRaw(base64Bytes(row.raw)) : null;
              const chat = raw?.key?.remoteJid || row.jid;
              if (fromMe === null || !row.keyid || !chat) continue;
              const key = keyOfSid(`${fromMe}_${context.lids.canonical(chat)}_${row.keyid}`);
              if (key === null) continue;
              if (!row.deleted) provenance.beta.add(key);
              else if (retention || !isBetaExpiry(row, context.now)) provenance.betaDeleted.add(key);
            }
            after = rows[rows.length - 1]!.rowid;
          }
        }
      } finally {
        archive.close();
      }
    }
  }
  return provenance;
}

export { MARKS_SAMPLE };
