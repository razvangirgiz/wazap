/**
 * Everything an import run derives from the legacy files before it writes a
 * row: the linked owner, the snapshot as the service hydrates it, the lid
 * table rebuilt in the service's boot order, the barriers and the recorded
 * deadlines. It is rebuilt from the files on every run, so a resumed run makes
 * the same decisions as the run a crash interrupted.
 */
import { readLinkedAccount, type LinkedAccount } from "../auth-state.js";
import type { AccountPaths } from "../config.js";
import type { WAMessage } from "baileys";
import { LidRegistry, lidKey } from "../identity.js";
import { Store, type StoreSnapshot } from "../store.js";
import { base64Bytes, decodeRaw, noteDeadline, viewSidOf, type LegacyIdentity } from "./convert.js";
import { messageExpiry } from "../message-expiry.js";
import {
  historyFiles,
  legacyPaths,
  readHistoryFile,
  readNotes,
  readRetention,
  readSnapshot,
  type LegacyPaths,
  type NotesFileShape,
  type RetentionFile,
} from "./sources.js";

export interface ImportContext extends LegacyIdentity {
  paths: LegacyPaths;
  owner: LinkedAccount | null;
  snapshot: StoreSnapshot | null;
  snapshotUnreadable: boolean;
  /** The snapshot hydrated by the service's own Store: rings, stories, marks, transcripts. */
  store: Store;
  /** Pairings only the rings and history files state; see inferLids. */
  inferredLids: number;
  retention: RetentionFile;
  notes: NotesFileShape | null;
  notesUnreadable: boolean;
}

/**
 * The lid table as the service holds it after loadStoreSnapshot: the
 * snapshot's pairings, then each contact's, then every pairing learned again,
 * which is what rebuilds the number → lid direction.
 */
export function legacyLids(snapshot: StoreSnapshot | null): LidRegistry {
  const lids = new LidRegistry();
  if (snapshot === null) return lids;
  lids.hydrate(snapshot.lids ?? {});
  for (const contact of Object.values(snapshot.contacts ?? {})) {
    if (!contact?.lid) continue;
    if (contact.phoneNumber) lids.learn(contact.lid, contact.phoneNumber);
    else if (contact.id?.endsWith("@s.whatsapp.net")) lids.learn(contact.lid, contact.id);
  }
  for (const [lid, pn] of [...lids]) lids.learn(lid, pn);
  return lids;
}

/**
 * Pairings the legacy files state by where they filed a message, not in the
 * lid table: a message whose chat is a lid, sitting in a number's snapshot
 * ring or in that number's history file, was filed there because the service
 * knew the pairing when it arrived. A table written by an older wazap can lack
 * the pairing while the rings still carry it. Only a lid the table does not
 * pair and the files place under exactly one number is learned.
 */
export async function inferLids(lids: LidRegistry, store: Store, historyDir: string): Promise<Array<[lid: string, phone: string]>> {
  const evidence = new Map<string, Set<string>>();
  const note = (raw: WAMessage | null | undefined, phone: string): void => {
    const remote = raw?.key?.remoteJid;
    if (!remote || !(remote.endsWith("@lid") || remote.endsWith("@hosted.lid"))) return;
    const key = lidKey(remote);
    if (lids.phoneOf(key) !== undefined) return;
    const phones = evidence.get(key) ?? new Set<string>();
    phones.add(phone);
    evidence.set(key, phones);
  };
  for (const [jid, ring] of store.byChat) {
    if (!jid.endsWith("@s.whatsapp.net")) continue;
    for (const sid of ring) note(store.messages.get(sid), jid);
  }
  for (const name of historyFiles(historyDir)) {
    const jid = name.slice(0, -".jsonl".length);
    if (!/^\d+@s\.whatsapp\.net$/.test(jid)) continue;
    for (const record of readHistoryFile(historyDir, name)?.records ?? []) {
      if (!record.deleted && record.raw) note(decodeRaw(base64Bytes(record.raw)), jid);
    }
    await yieldLoop();
  }
  const inferred: Array<[string, string]> = [];
  for (const [lid, phones] of [...evidence].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (phones.size !== 1) continue;
    const phone = [...phones][0]!;
    lids.learn(lid, phone);
    inferred.push([lid, phone]);
  }
  return inferred;
}

/** Lets the event loop run between files: a large account's scans take a while. */
export function yieldLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function buildContext(options: {
  accountPaths: AccountPaths;
  now: number;
  enforceExpiry: boolean;
}): Promise<ImportContext> {
  const paths = legacyPaths(options.accountPaths);
  const owner = readLinkedAccount(paths.authDir);
  const { snapshot, unreadable } = readSnapshot(paths.storeFile);
  const store = new Store();
  if (snapshot !== null) store.hydrate(snapshot);
  const lids = legacyLids(snapshot);
  const inferredLids = (await inferLids(lids, store, paths.historyDir)).length;
  const retention = readRetention(paths.retentionFile);
  const notes = readNotes(paths.notesFile);
  const context: ImportContext = {
    paths,
    owner,
    snapshot,
    snapshotUnreadable: unreadable,
    store,
    inferredLids,
    retention,
    notes: notes.notes,
    notesUnreadable: notes.unreadable,
    lids,
    ownJid: owner?.id ?? "",
    now: options.now,
    enforceExpiry: options.enforceExpiry,
    deadlines: new Map(),
  };
  if (options.enforceExpiry) await collectDeadlines(context);
  return context;
}

/**
 * Every deadline the service would have noted by the end of its boot: the
 * retention file's, the snapshot's, and every version of every history line
 * — its recorded deadline and its own disappearing marker — so the earliest
 * wins whichever file or version carried it.
 */
async function collectDeadlines(context: ImportContext): Promise<void> {
  const note = (sid: string, at: number): void => {
    const view = viewSidOf(context, sid);
    if (view !== null) noteDeadline(context, view, at);
  };
  for (const [sid, , at] of context.retention.expires) note(sid, at);
  for (const [sid, at] of Object.entries(context.snapshot?.expires ?? {})) note(sid, at);
  for (const [sid, b64] of Object.entries(context.snapshot?.messages ?? {})) {
    const raw = decodeRaw(base64Bytes(b64));
    const at = raw === null ? undefined : messageExpiry(raw);
    if (at !== undefined) note(sid, at);
  }
  for (const name of historyFiles(context.paths.historyDir)) {
    const read = readHistoryFile(context.paths.historyDir, name);
    for (const record of read?.records ?? []) {
      if (record.expiresAt !== undefined) note(record.sid, record.expiresAt);
      if (!record.raw) continue;
      const raw = decodeRaw(base64Bytes(record.raw));
      const at = raw === null ? undefined : messageExpiry(raw);
      if (at !== undefined) note(record.sid, at);
    }
    await yieldLoop();
  }
}
