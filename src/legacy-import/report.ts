/**
 * What an import of one account's legacy files reports: counts per phase, the
 * reasons entries were left out, the recall vectors carried over, and the
 * verification against what the legacy service would show. Counts and keys
 * only — a report never carries message text.
 */
import type { Counts } from "../db/index.js";

/** The phases, in the order they run. */
export const IMPORT_PHASES = [
  "lids",
  "barriers",
  "history",
  "snapshot",
  "notes",
  "beta",
  "marks",
  "recall",
  "optimize",
] as const;

export type ImportPhase = (typeof IMPORT_PHASES)[number];

/** Why a source entry did not become a row, or did not change one. */
export type SkipReason =
  /** Unparsable JSON, a record without a sid, a protobuf that does not decode, a key without an id. */
  | "malformed"
  /** A tombstone, a clear barrier or a passed deadline refused it. */
  | "barrier"
  /** The key is already stored (beta rows, recall rows). */
  | "duplicate"
  /** More than a day in the future: see FUTURE_SLACK_MS. */
  | "futureTs"
  /** A beta archive that belongs to another account, or to an account nobody linked. */
  | "ownerMismatch"
  /** A jid that addresses nobody: the `0@` notices, malformed ids. */
  | "noise"
  /** Device-to-device machinery, and payload-less lines the service never shows. */
  | "control"
  /** A story already past its day. */
  | "expired"
  /** A call the service folds into a more detailed record of the same call. */
  | "callDuplicate"
  /** A reaction, vote or handled mark whose message is not stored. */
  | "missingTarget"
  /** The index row's vector was made from other words than the stored message says now. */
  | "vectorMismatch"
  /** The index row's message is a tombstone, cleared or expired. */
  | "hidden"
  /** An index whose model, geometry or files do not match. */
  | "unusable"
  /**
   * A beta archive erasure of a disappearing message past its deadline while
   * WAZAP_RETENTION is off: the beta expired messages unconditionally, the
   * service keeps them readable, so it is not a deletion to carry over.
   */
  | "retentionOff";

export interface PhaseReport {
  /** Source entries read: lines, pairs, barriers, snapshot entries, archive rows, index rows. */
  read: number;
  /** Rows or marks written for the first time. */
  imported: number;
  /** Stored rows that took a newer version. */
  updated: number;
  skipped: Partial<Record<SkipReason, number>>;
  /** Phase-specific counters; each phase documents its own. */
  details: Record<string, number>;
  /** Wall time across every run that worked on the phase. */
  durationMs: number;
}

export interface MalformedFile {
  /** The history file's name: `<chat jid>.jsonl`. Mask it before printing. */
  file: string;
  lines: number;
  /** The last line had no newline and did not parse: a write the service was still making. */
  partialTail: boolean;
}

export interface ImportReport {
  /** "done": imported and verified; "imported": imported, verification off or failed. */
  state: "done" | "imported";
  /** True when this call found the import already done and changed nothing. */
  alreadyDone: boolean;
  owner: string | null;
  startedAt: number;
  finishedAt: number;
  /** How many runs it took: more than one after a crash or a close. */
  runs: number;
  phases: Record<ImportPhase, PhaseReport>;
  malformedFiles: MalformedFile[];
  totals: Counts & { dbBytes: number };
  verification: VerificationReport | null;
}

/** A difference the design expects: the database keeps what the legacy files could not. */
export type ExpectedDifference =
  /** A message only the beta archive still has. */
  | "betaOnly"
  /** A message only the recall index still has, now a text-only row. */
  | "indexOnly"
  /** In a history file, but past the 2,000 newest lines the legacy reload keeps per file. */
  | "legacyFileCap"
  /** In the history, but pushed out of the legacy 2,000-message ring of its chat. */
  | "legacyRingCap"
  /** A message the beta archive deleted, which the legacy files still show. */
  | "betaDeleted"
  /**
   * A message the legacy files deleted under another spelling of its chat (a
   * lid), which the legacy view still shows because its lid table lacked the
   * pairing the rings imply; the database knows the pairing and honours the deletion.
   */
  | "deletedUnderAlias"
  /** The database's newest message is one of the rows the legacy view lacks. */
  | "newestIsExtra"
  /** The two newest messages share their second; the order inside it is arbitrary. */
  | "newestSameSecond"
  /** A handled mark whose ask the legacy store no longer holds: it never matched anything. */
  | "handledAskMissing";

/** A difference nothing explains: the import is not trusted until it is zero. */
export type UnexpectedDifference =
  | "missingInDb"
  /** Stored, but its type, text or transcript is not what the legacy view renders for it. */
  | "renderMismatch"
  | "extraInDb"
  | "newestDiffers"
  | "deletedVisible"
  | "clearedVisible"
  | "expiredVisible"
  | "storiesMissing"
  | "notesMismatch"
  | "fieldsMismatch"
  | "handledMismatch"
  | "reactionsMismatch"
  | "votesMismatch"
  | "receiptsMismatch"
  | "contactsNamedMismatch";

export interface VerificationReport {
  /** No unexpected difference. */
  ok: boolean;
  durationMs: number;
  chats: { legacy: number; db: number; compared: number };
  messages: { legacyVisible: number; dbVisible: number; matched: number };
  barriers: { deleted: number; cleared: number; expired: number };
  notes: { legacy: number; db: number };
  fields: { legacy: number; db: number };
  handled: { legacy: number; db: number };
  marks: { sampled: number; reactions: number; votes: number; receipts: number };
  contactsNamed: { legacy: number; db: number };
  expected: Partial<Record<ExpectedDifference, number>>;
  unexpected: Partial<Record<UnexpectedDifference, number>>;
  /** Up to SAMPLE_KEYS sids or jids per unexpected category, to investigate by key. Mask before printing. */
  samples: Partial<Record<UnexpectedDifference, string[]>>;
}

export function emptyPhase(): PhaseReport {
  return { read: 0, imported: 0, updated: 0, skipped: {}, details: {}, durationMs: 0 };
}

export function emptyPhases(): Record<ImportPhase, PhaseReport> {
  return Object.fromEntries(IMPORT_PHASES.map((phase) => [phase, emptyPhase()])) as Record<ImportPhase, PhaseReport>;
}

export function skip(phase: PhaseReport, reason: SkipReason, n = 1): void {
  phase.skipped[reason] = (phase.skipped[reason] ?? 0) + n;
}

export function detail(phase: PhaseReport, name: string, n = 1): void {
  phase.details[name] = (phase.details[name] ?? 0) + n;
}
