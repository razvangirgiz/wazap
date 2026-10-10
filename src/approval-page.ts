/**
 * The approval page, in drafts-only mode: `<public URL>/approve/<draft_id>`
 * shows a person the draft (recipient, exact words) and sends it when they
 * type the wazap password, the one the consent page asks. Only served where
 * sign-in is on, so it is always behind https and that password.
 *
 * What stops each way around it:
 *   - an agent: it has the link (it made the draft), never the password, which
 *     is typed into a browser on the consent page. Bearer tokens and OAuth
 *     grants open nothing here.
 *   - guessing: the consent page's lockout (five misses per caller, twenty
 *     from everywhere), and a draft id is 64 random bits.
 *   - a forged form on another site: the POST needs a one-time nonce from this
 *     page's GET and the password, and a cross-origin Origin is refused.
 *   - replay: the nonce is spent on the first POST, and the send itself goes
 *     through confirm_send's atomic claim; approving twice answers the receipt.
 *   - framing: the consent page's headers (no frames, no Referer, no cache).
 */
import { randomBytes } from "node:crypto";
import type { Express, Request, RequestHandler, Response } from "express";
import { APPROVE_PREFIX, parseDraftId, type DraftApprovals, type PendingApproval } from "./approvals.js";
import { asWazapError, WazapError } from "./errors.js";
import { log } from "./logger.js";
import { escapeHtml, page, sendPage, type WazapOAuthProvider } from "./oauth.js";


const NONCE_TTL_MS = 30 * 60 * 1000;
const MAX_NONCES = 512;

/** One-time form tokens, each for one draft. */
class Nonces {
  private readonly issued = new Map<string, { draftId: string; at: number }>();

  constructor(private readonly now: () => number) {}

  issue(draftId: string): string {
    this.prune();
    while (this.issued.size >= MAX_NONCES) {
      const oldest = this.issued.keys().next();
      if (oldest.done === true) break;
      this.issued.delete(oldest.value);
    }
    const nonce = randomBytes(24).toString("hex");
    this.issued.set(nonce, { draftId, at: this.now() });
    return nonce;
  }

  /** Spends the nonce; true only when it was issued for this draft and is fresh. */
  spend(nonce: unknown, draftId: string): boolean {
    if (typeof nonce !== "string") return false;
    const entry = this.issued.get(nonce);
    this.issued.delete(nonce);
    return entry !== undefined && entry.draftId === draftId && this.now() - entry.at < NONCE_TTL_MS;
  }

  private prune(): void {
    const now = this.now();
    for (const [nonce, entry] of this.issued) if (now - entry.at >= NONCE_TTL_MS) this.issued.delete(nonce);
  }
}

function messagePage(res: Response, status: number, heading: string, text: string): void {
  sendPage(res, status, page("wazap", `<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(text)}</p>`));
}

function draftPage(entry: PendingApproval, nonce: string, error?: string): string {
  const expires = new Date(entry.expires_at).toUTCString();
  return page(
    "Approve a message",
    `
<h1>Send this WhatsApp message?</h1>
<p>Your agent drafted it. Nothing is sent until you approve it here.</p>
<div class="preview">${escapeHtml(entry.preview)}</div>
<p>From account <strong>${escapeHtml(entry.account_id)}</strong>. This draft lapses ${escapeHtml(expires)}.</p>
${entry.unnamed_recipient === true ? "<p><strong>The recipient is not a saved contact:</strong> the name shown is their public WhatsApp name, or only their number.</p>" : ""}
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${APPROVE_PREFIX}${entry.draft_id}">
  <input type="hidden" name="nonce" value="${nonce}">
  <label class="field">wazap password
    <input type="password" name="password" autocomplete="current-password" autofocus required>
  </label>
  <div class="actions">
    <button type="submit" name="decision" value="send">Send it</button>
    <button type="submit" name="decision" value="discard" class="danger">Discard it</button>
  </div>
</form>`
  );
}

function draftIdOf(req: Request): string | null {
  try {
    return parseDraftId(req.params.draftId);
  } catch {
    return null;
  }
}

export function mountApprovalPage(
  app: Express,
  parts: { urlencoded: RequestHandler; limiter: RequestHandler },
  oauth: WazapOAuthProvider,
  approvals: DraftApprovals,
  now: () => number = Date.now
): void {
  const nonces = new Nonces(now);
  const origin = oauth.issuerUrl.origin;

  app.get(`${APPROVE_PREFIX}:draftId`, parts.limiter, (req: Request, res: Response) => {
    const id = draftIdOf(req);
    const entry = id === null ? null : approvals.find(id);
    if (entry === null) {
      messagePage(res, 404, "Nothing to approve", "No draft is waiting under this link: it was sent, discarded or has expired. Ask your agent to draft it again.");
      return;
    }
    sendPage(res, 200, draftPage(entry, nonces.issue(entry.draft_id)));
  });

  app.post(`${APPROVE_PREFIX}:draftId`, parts.limiter, parts.urlencoded, (req: Request, res: Response) => {
    void (async () => {
      // A browser always says where a form came from; only this origin's page may post here.
      if (req.headers.origin !== undefined && req.headers.origin !== origin) {
        messagePage(res, 403, "Refused", "This approval came from another site. Open the approval link again.");
        return;
      }
      const id = draftIdOf(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (id === null || !nonces.spend(body.nonce, id)) {
        messagePage(res, 400, "This page has expired", "Open the approval link again; nothing was sent.");
        return;
      }
      const entry = approvals.find(id);
      if (entry === null) {
        messagePage(res, 404, "Nothing to approve", "No draft is waiting under this link: it was sent, discarded or has expired.");
        return;
      }
      const checked = oauth.checkPassword(req, body.password);
      if (!checked.ok) {
        sendPage(res, checked.status, draftPage(entry, nonces.issue(id), checked.message));
        return;
      }
      if (body.decision === "discard") {
        approvals.discard(id);
        log(`approval: discarded ${id}`);
        messagePage(res, 200, "Discarded", "The draft is gone. Nothing was sent.");
        return;
      }
      if (body.decision !== "send") {
        messagePage(res, 400, "Nothing done", "Choose Send or Discard. Open the approval link again.");
        return;
      }
      try {
        const { receipt } = await approvals.approve(id);
        log(`approval: sent ${id}`);
        messagePage(
          res,
          200,
          receipt.already_sent === true ? "Already sent" : "Sent",
          receipt.already_sent === true
            ? `This message went out earlier (${receipt.timestamp}); nothing was sent again.`
            : `Sent at ${receipt.timestamp}.`
        );
      } catch (err) {
        const error: WazapError = asWazapError(err);
        log(`approval: ${id} failed (${error.code})`);
        const unknown = error.code === "SEND_OUTCOME_UNKNOWN";
        messagePage(
          res,
          409,
          unknown ? "Maybe sent" : "Not sent",
          unknown
            ? "WhatsApp took the message but did not confirm it arrived. Check the chat on your phone before sending it again."
            : `${error.message}${error.fix ? ` ${error.fix}.` : ""}`
        );
      }
    })().catch(() => {
      if (!res.headersSent) messagePage(res, 500, "Not sent", "Something went wrong; nothing was sent. Open the link again.");
    });
  });
}
