/**
 * What the legacy service shows for an account, read through the service's
 * own boot path: a WhatsAppService with no socket and recall off replays a
 * private copy of the legacy files (loadPersisted rewrites what it loads, so
 * never the originals), and the rings, barriers, notes and marks are read off
 * it afterwards. This is the oracle the import is verified against, which is
 * why it runs main's code instead of re-deriving main's rules.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WAMessage } from "baileys";
import { accountPaths, type AccountPaths, type Config } from "../config.js";
import { isNoiseJid, STATUS_JID } from "../ids.js";
import { contentHash } from "../db/index.js";
import { messageIdFor, messageText, messageTimestampMs, messageType } from "../messages.js";
import type { MessageRetention } from "../message-retention.js";
import type { Notes } from "../notes.js";
import type { Store } from "../store.js";
import { STORY_TTL_MS } from "./convert.js";

/** The private members of WhatsAppService this reads; the service keeps them private, the oracle needs them. */
interface ServiceInternals {
  store: Store;
  retention: MessageRetention;
  notes: Notes;
  account: { id: string; name: string; number: string } | null;
  recallEnv: unknown;
  loadPersisted(): Promise<void>;
  retentionIdle(): Promise<void>;
  hasMessage(sid: string): boolean;
  canonical(jid: string): string;
  isMe(jid: string): boolean;
  namedContacts(): number;
  stop(): Promise<void>;
}

export interface LegacyMessage {
  /** The id a view reports: direction, the ring's chat, key. */
  sid: string;
  fromMe: boolean;
  keyId: string;
  ts: number;
  /** contentHash of the rendered text and the transcript a view shows: compared, never kept as words. */
  words: string;
  type: string;
}

export interface LegacyChat {
  jid: string;
  /** Ring members the store holds, visible or not. */
  ringLength: number;
  /** What read_messages returns, oldest first. */
  visible: LegacyMessage[];
}

export interface LegacyMarks {
  reactions: number;
  votes: number;
  receipts: number;
}

export interface LegacyView {
  chats: LegacyChat[];
  /** Stories get_stories would list for the last day. */
  stories: LegacyMessage[];
  /** Retention after the boot: every spelling of every deleted, revoked or expired message. */
  deleted: string[];
  cleared: Array<[jid: string, at: number]>;
  expires: Array<[sid: string, at: number]>;
  notes: Array<[jid: string, note: string]>;
  fields: Array<[jid: string, tags: string[], fields: Record<string, string>]>;
  /** Handled marks, with whether the ask they name is still visible (a mark on a gone ask never matches). */
  handled: Array<[jid: string, askSid: string, askVisible: boolean]>;
  /** Marks on the newest MARKS_SAMPLE visible messages of each chat. */
  marks: Map<string, LegacyMarks>;
  contactsNamed: Array<[jid: string]>;
  canonical: (jid: string) => string;
}

export const MARKS_SAMPLE = 20;
/** The private copy the replay runs on, beside the database. */
const VERIFY_PREFIX = ".legacy-verify-";

/** Copies what the boot replay reads: the snapshot, the history logs, the barriers and the notes. */
function copyLegacyFiles(from: AccountPaths, to: AccountPaths): void {
  mkdirSync(to.root, { recursive: true, mode: 0o700 });
  for (const [source, target] of [
    [from.storeFile, to.storeFile],
    [join(from.root, "retention.json"), join(to.root, "retention.json")],
    [from.notesFile, to.notesFile],
  ] as const) {
    if (existsSync(source)) cpSync(source, target);
  }
  mkdirSync(to.historyDir, { recursive: true, mode: 0o700 });
  if (existsSync(from.historyDir)) {
    for (const name of readdirSync(from.historyDir)) {
      if (name.endsWith(".jsonl")) cpSync(join(from.historyDir, name), join(to.historyDir, name));
    }
  }
}

export async function loadLegacyView(options: {
  accountId: string;
  accountPaths: AccountPaths;
  owner: { id: string; name: string; number: string } | null;
  retention: boolean;
  workDir: string;
}): Promise<LegacyView> {
  mkdirSync(options.workDir, { recursive: true, mode: 0o700 });
  // A copy a crashed verification left behind holds message text: it goes first.
  for (const name of readdirSync(options.workDir)) {
    if (name.startsWith(VERIFY_PREFIX)) rmSync(join(options.workDir, name), { recursive: true, force: true });
  }
  const temp = mkdtempSync(join(options.workDir, VERIFY_PREFIX));
  try {
    const paths = accountPaths(temp, options.accountId);
    copyLegacyFiles(options.accountPaths, paths);
    const { WhatsAppService, realName } = await import("../whatsapp.js");
    const config = {
      dataDir: temp,
      readOnly: true,
      syncFullHistory: false,
      persistHistory: true,
      retention: options.retention,
      transport: "stdio",
      httpHost: "127.0.0.1",
      httpPort: 0,
      readToken: null,
      writeToken: null,
      publicUrl: null,
      oauthPassword: null,
      share: false,
      rateLimitPerMinute: 0,
      command: "serve",
    } as unknown as Config;
    const account = { id: options.accountId, name: options.accountId, enabled: true, owner: null };
    const service = new WhatsAppService(config, account, paths);
    const svc = service as unknown as ServiceInternals;
    // Recall off: the oracle must not open an index or start an embedding sidecar.
    svc.recallEnv = { enabled: false, model: "embeddinggemma-300m", embedBin: null, embedUrl: null, modelsDir: temp, embedIdleMs: 0, maxRows: 100, minSimilarity: 0 };
    svc.account = options.owner;
    try {
      await svc.loadPersisted();
      await svc.retentionIdle();
      return readView(svc, realName);
    } finally {
      await svc.stop();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function readView(svc: ServiceInternals, realName: (value: string | null | undefined) => string): LegacyView {
  const store = svc.store;
  const message = (sid: string, chatJid: string, raw: WAMessage): LegacyMessage => {
    const type = messageType(raw);
    const transcript = store.transcripts.get(sid)?.text;
    const spoken = transcript && (type === "voice" || type === "audio") ? transcript : null;
    return {
      sid: messageIdFor(raw.key, chatJid),
      fromMe: Boolean(raw.key.fromMe),
      keyId: raw.key.id ?? "",
      ts: messageTimestampMs(raw),
      words: contentHash(messageText(raw), spoken),
      type,
    };
  };
  const chats: LegacyChat[] = [];
  const marks = new Map<string, LegacyMarks>();
  for (const [jid, ring] of store.byChat) {
    if (isNoiseJid(jid)) continue;
    const visible: LegacyMessage[] = [];
    let ringLength = 0;
    for (const sid of ring) {
      const raw = store.messages.get(sid);
      if (raw === undefined) continue;
      ringLength++;
      if (svc.hasMessage(sid)) visible.push(message(sid, jid, raw));
    }
    chats.push({ jid, ringLength, visible });
    const ringVisible = ring.filter((sid) => store.messages.has(sid) && svc.hasMessage(sid));
    for (const sid of ringVisible.slice(-MARKS_SAMPLE)) {
      const raw = store.messages.get(sid)!;
      const receipt = store.receiptFor(sid, (id) => svc.canonical(id), (id) => svc.isMe(id));
      marks.set(messageIdFor(raw.key, jid), {
        reactions: store.reactionsFor(sid).length,
        votes: store.votesFor(sid).length,
        receipts: Object.keys(receipt?.users ?? {}).length,
      });
    }
  }
  const cutoff = Date.now() - STORY_TTL_MS;
  const stories: LegacyMessage[] = [];
  for (const sid of store.stories) {
    const raw = store.messages.get(sid);
    if (raw === undefined || messageTimestampMs(raw) < cutoff || !svc.hasMessage(sid)) continue;
    stories.push(message(sid, STATUS_JID, raw));
  }
  const handled: LegacyView["handled"] = [];
  for (const [jid, mark] of svc.notes.handled) {
    handled.push([jid, mark.ask_id, svc.hasMessage(mark.ask_id)]);
  }
  const named: Array<[string]> = [];
  for (const [jid, contact] of store.contacts) if (!jid.endsWith("@g.us") && realName(contact.name)) named.push([jid]);
  return {
    chats,
    stories,
    deleted: [...svc.retention.deleted.keys()],
    cleared: [...svc.retention.cleared],
    expires: [...svc.retention.expires].map(([sid, entry]) => [sid, entry.at]),
    notes: [...svc.notes.contacts].map(([jid, entry]) => [jid, entry.note]),
    fields: [...svc.notes.fields].map(([jid, entry]) => [jid, entry.tags ?? [], entry.fields ?? {}]),
    handled,
    marks,
    contactsNamed: named,
    canonical: (jid) => svc.canonical(jid),
  };
}
