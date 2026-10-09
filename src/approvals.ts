/**
 * Drafts-only mode's other half: a person approving what the agent drafted.
 * The agent's session has no tool that sends (tools.ts registers send_message
 * alone among the writes), so a draft leaves only through here, and only two
 * doors lead here:
 *
 *   - the approval page on the public URL (approval-page.ts), which asks the
 *     wazap password the person typed on the consent page and the agent never
 *     saw, and
 *   - `wazap drafts approve` on the machine wazap runs on, over the private
 *     control line (control.ts), whose token only a local file holds.
 *
 * A bearer token or an OAuth grant opens neither. The draft is confirmed as
 * the owner that made it, through the same atomic claim confirm_send takes,
 * so two approvals of one draft send it once. The send rules and the writes
 * switches are read again first, as confirm_send reads them.
 */
import type { AccountSource } from "./account-hub.js";
import type { Config } from "./config.js";
import type { DraftView } from "./drafts.js";
import { WazapError } from "./errors.js";
import { assertSendable, sendPolicyOf } from "./send-guard.js";
import type { SentMessage, WhatsAppApi } from "./wa-types.js";

/** Where the approval page lives on the public URL (approval-page.ts). */
export const APPROVE_PREFIX = "/approve/";

/** The link a draft is approved at. */
export function approveUrl(publicUrl: string, draftId: string): string {
  return new URL(`${APPROVE_PREFIX}${draftId}`, publicUrl).href;
}

export interface PendingApproval extends DraftView {
  account_id: string;
}

export interface Approved {
  account_id: string;
  receipt: SentMessage;
}

/** What the CLI and the approval page ask of the running server. */
export interface DraftApprovals {
  list(): PendingApproval[];
  find(draftId: string): PendingApproval | null;
  approve(draftId: string): Promise<Approved>;
  discard(draftId: string): { account_id: string };
}

function noDraft(draftId: string): WazapError {
  return new WazapError(
    "DRAFT_NOT_FOUND",
    `No draft ${draftId} is waiting for approval.`,
    "It was sent, discarded or expired. Run `wazap drafts` to see what waits; the agent can draft it again"
  );
}

/** A draft id as the store makes them; anything else is refused before any lookup. */
export function parseDraftId(value: unknown): string {
  if (typeof value !== "string" || !/^d_[0-9a-f]{16}$/.test(value)) {
    throw new WazapError("INVALID_ID", "That is not a draft id.", "Draft ids look like d_0123456789abcdef; run `wazap drafts`");
  }
  return value;
}

export class Approvals implements DraftApprovals {
  constructor(
    private readonly hub: AccountSource,
    private readonly config: Pick<Config, "readOnly">
  ) {}

  list(): PendingApproval[] {
    const found: PendingApproval[] = [];
    for (const binding of this.hub.bindings()) {
      for (const view of binding.wa.pendingDrafts?.() ?? []) found.push({ ...view, account_id: binding.id });
    }
    return found.sort((a, b) => a.expires_at.localeCompare(b.expires_at));
  }

  find(draftId: string): PendingApproval | null {
    const id = parseDraftId(draftId);
    return this.list().find((entry) => entry.draft_id === id) ?? null;
  }

  async approve(draftId: string): Promise<Approved> {
    const id = parseDraftId(draftId);
    const binding = this.hub.findByDraft(id)[0];
    if (binding === undefined || typeof binding.wa.approveDraft !== "function") throw noDraft(id);
    this.assertWritable(binding.id);
    const waiting = binding.wa.pendingDrafts?.().find((view) => view.draft_id === id);
    // Rules written while the draft waited still apply to it.
    if (waiting !== undefined) assertSendable(sendPolicyOf(this.hub.recordOnDisk(binding.id)), waiting.to, binding.id);
    const receipt = await binding.wa.approveDraft(id);
    return { account_id: binding.id, receipt };
  }

  discard(draftId: string): { account_id: string } {
    const id = parseDraftId(draftId);
    for (const binding of this.hub.findByDraft(id)) {
      if (binding.wa.discardDraft?.(id) === true) return { account_id: binding.id };
    }
    throw noDraft(id);
  }

  /** The switches confirm_send honours: global read-only, a missing, disabled or read-only account. */
  private assertWritable(accountId: string): void {
    const record = this.hub.recordOnDisk(accountId);
    const wa: WhatsAppApi | undefined = this.hub.binding(accountId)?.wa;
    if (this.config.readOnly || record === undefined || !record.enabled || record.writes === false || wa?.getStatus().read_only === true) {
      throw new WazapError(
        "READ_ONLY",
        `Account "${accountId}" cannot send right now (writes are off, or the account is disabled); nothing was sent.`,
        "Turn writes back on with `wazap config writes drafts`, restart the server, and approve again"
      );
    }
  }
}
