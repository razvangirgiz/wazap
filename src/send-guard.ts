/**
 * Per-account send rules: who this account may address. The rules live in
 * accounts.json (`send_allow`, `send_deny` on the account record) and the tools
 * re-read them at draft time and again at confirm_send, so a rule an operator
 * adds while a draft sits waiting still applies to it.
 *
 * Nothing here touches WhatsApp or the network: a refused send fails before
 * the socket ever sees it, with SEND_BLOCKED naming the rule that fired.
 */
import { DRAFT_TTL_MS, type DraftView } from "./drafts.js";
import { WazapError } from "./errors.js";
import type { AccountRecord } from "./accounts.js";
import type { OutgoingTarget } from "./wa-types.js";

/** What a rule or a recipient can be matched on; `number` rides along when known. */
export interface SendTarget {
  chat_id: string;
  name?: string;
  number?: string;
}

/**
 * A record's rules as the account file wrote them: `allow` absent means open,
 * present — even empty — means only the listed recipients may be sent to.
 * `deny` blocks its entries no matter what `allow` says.
 */
export interface SendPolicy {
  allow: string[] | null;
  deny: string[];
}

export function sendPolicyOf(record: Pick<AccountRecord, "send_allow" | "send_deny"> | undefined): SendPolicy {
  return { allow: record?.send_allow ?? null, deny: record?.send_deny ?? [] };
}

export function hasSendRules(policy: SendPolicy): boolean {
  return policy.allow !== null || policy.deny.length > 0;
}

/** A rule typed by a person, reduced to the two forms a recipient resolves to. */
function matchForms(input: string): { jid?: string; digits?: string } {
  const trimmed = input.trim();
  const at = trimmed.lastIndexOf("@");
  if (at !== -1) {
    const user = trimmed.slice(0, at).split(":")[0] ?? "";
    const domain = trimmed.slice(at + 1).toLowerCase();
    if (user === "" || domain === "") return {};
    const jid = `${user}@${domain}`;
    return /^\d+$/.test(user) ? { jid, digits: user } : { jid };
  }
  const digits = trimmed.replace(/^\+/, "").replace(/[\s\-().]/g, "");
  return /^\d+$/.test(digits) ? { digits } : {};
}

/**
 * A rule entry as it lands in accounts.json, so matching never re-parses and a
 * bad entry fails the write instead of being stored. `120363@g.us` keeps its
 * domain; `+40 722 123 456` keeps only digits. Anything else is not an address.
 */
export function normalizeSendRule(entry: string): string {
  const trimmed = entry.trim();
  const at = trimmed.lastIndexOf("@");
  if (at !== -1) {
    const user = trimmed.slice(0, at).split(":")[0] ?? "";
    const domain = trimmed.slice(at + 1).toLowerCase();
    if (user !== "" && domain !== "") return `${user}@${domain}`;
  }
  const digits = trimmed.replace(/^\+/, "").replace(/[\s\-().]/g, "");
  if (/^\d{3,}$/.test(digits)) return digits;
  throw new WazapError(
    "INVALID_ID",
    `"${trimmed}" is not a chat id or a phone number.`,
    'Use a full chat id like "120363000000000001@g.us" or an international number like "+15550100"'
  );
}

function ruleMatches(entry: string, target: SendTarget): boolean {
  const rule = matchForms(entry);
  const candidates = target.number === undefined ? [target.chat_id] : [target.chat_id, target.number];
  return candidates.some((candidate) => {
    const form = matchForms(candidate);
    return (
      (rule.jid !== undefined && form.jid === rule.jid) || (rule.digits !== undefined && form.digits === rule.digits)
    );
  });
}

function describeTarget(target: SendTarget): string {
  const name = target.name?.trim();
  if (name) return `"${name}" <${target.chat_id}>`;
  return target.number !== undefined ? `${target.number} <${target.chat_id}>` : `<${target.chat_id}>`;
}

const SEND_RULES_FIX =
  "Tell the user the send rules refuse it; they can change them with `wazap config send` — do not retry or route around them.";

/**
 * Fail closed, naming the rule that fired: a deny hit is refused, and a present
 * allowlist refuses anything it does not list. An absent allowlist lets through
 * whatever deny did not catch.
 */
export function assertSendable(policy: SendPolicy, target: SendTarget, accountId: string): void {
  const denied = policy.deny.find((entry) => ruleMatches(entry, target));
  if (denied !== undefined) {
    throw new WazapError(
      "SEND_BLOCKED",
      `Blocked by the send rules of account "${accountId}": ${describeTarget(target)} is denied by "${denied}".`,
      SEND_RULES_FIX
    );
  }
  if (policy.allow !== null && !policy.allow.some((entry) => ruleMatches(entry, target))) {
    throw new WazapError(
      "SEND_BLOCKED",
      `Blocked by the send rules of account "${accountId}": ${describeTarget(target)} is not on the send allowlist.`,
      SEND_RULES_FIX
    );
  }
}

/**
 * draft_id → the resolved recipient and the account it was drafted under. Every
 * draft is born in a send tool, so this is what confirm_send re-checks the live
 * rules against — a draft taken through any other path would have no entry.
 * Entries age out with the drafts themselves.
 */
interface DraftRef {
  accountId: string;
  target: OutgoingTarget;
  at: number;
  /** Opaque identity of the MCP server that created this draft; never supplied by a caller. */
  owner?: symbol;
}

const draftTargets = new Map<string, DraftRef>();
const DRAFT_TARGETS_CAP = 500;

export function noteDraftTarget(view: DraftView, accountId: string, owner?: symbol): void {
  const now = Date.now();
  for (const [id, ref] of draftTargets) {
    if (ref.at + DRAFT_TTL_MS <= now) draftTargets.delete(id);
  }
  while (draftTargets.size >= DRAFT_TARGETS_CAP) {
    const oldest = draftTargets.keys().next().value;
    if (oldest === undefined) break;
    draftTargets.delete(oldest);
  }
  draftTargets.set(view.draft_id, { accountId, target: view.to, at: now, owner });
}

export function draftTargetOf(draftId: string): DraftRef | undefined {
  return draftTargets.get(draftId);
}

/** Unknown and foreign drafts are indistinguishable, before account lookup or policy checks. */
export function requireDraftOwner(draftId: string, owner: symbol, accountId?: string): DraftRef {
  const ref = draftTargets.get(draftId);
  if (ref === undefined || ref.owner !== owner || (accountId !== undefined && ref.accountId !== accountId)) {
    throw new WazapError(
      "DRAFT_NOT_FOUND",
      "No draft available in this MCP session.",
      "Call send_message (or another send tool) again in this session, show the new preview and ask the user to confirm before calling confirm_send"
    );
  }
  return ref;
}

export function forgetDraftTarget(draftId: string): void {
  draftTargets.delete(draftId);
}
