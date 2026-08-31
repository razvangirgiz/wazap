import { randomUUID } from "node:crypto";
import { WazapError } from "./errors.js";
import { isoWithOffset } from "./messages.js";
import type { MediaSource, OutgoingTarget } from "./wa-types.js";

export const DRAFT_TTL_MS = 15 * 60_000;
export const DRAFT_CAP = 20;

export type DraftKind = "text" | "media" | "poll" | "location" | "forward";

export type { OutgoingTarget };

export type DraftPayload =
  | { kind: "text"; chatId: string; text: string; replyTo?: string; mentionIds?: string[] }
  | {
      kind: "media";
      chatId: string;
      source: MediaSource;
      caption?: string;
      asDocument: boolean;
      asVoice: boolean;
    }
  | { kind: "poll"; chatId: string; question: string; options: string[]; multiSelect: boolean }
  | {
      kind: "location";
      chatId: string;
      latitude: number;
      longitude: number;
      name?: string;
      address?: string;
    }
  | { kind: "forward"; chatId: string; messageId: string; text?: string };

export interface Draft {
  id: string;
  to: OutgoingTarget;
  preview: string;
  expiresAt: number;
  payload: DraftPayload;
}

export interface DraftView {
  status: "draft";
  draft_id: string;
  to: OutgoingTarget;
  preview: string;
  expires_at: string;
  kind: DraftKind;
}

export class DraftStore {
  private readonly drafts = new Map<string, Draft>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DRAFT_TTL_MS,
    private readonly cap: number = DRAFT_CAP,
  ) {}

  get size(): number {
    return this.drafts.size;
  }

  put(to: OutgoingTarget, payload: DraftPayload): Draft {
    this.sweep();
    if (this.drafts.size >= this.cap) this.evictOldest();
    const id = `d_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const expiresAt = this.now() + this.ttlMs;
    const draft: Draft = { id, to, preview: formatDraftPreview(to, payload), expiresAt, payload };
    this.drafts.set(id, draft);
    return draft;
  }

  /** Consume a live draft. Missing and expired are different errors so the agent knows which. */
  take(id: string): Draft {
    const draft = this.drafts.get(id);
    if (draft === undefined) {
      throw new WazapError("DRAFT_NOT_FOUND", `No draft ${id}.`, "Call send_message (or send_media / send_poll / send_location / forward_message) again to draft, then confirm_send");
    }
    this.drafts.delete(id);
    if (draft.expiresAt <= this.now()) {
      throw new WazapError("DRAFT_EXPIRED", `Draft ${id} expired.`, "Call the send tool again to draft, show the new preview, then confirm_send");
    }
    return draft;
  }

  /** Return a draft that `take` already consumed, so a failed send can be retried. */
  putBack(draft: Draft): void {
    this.drafts.set(draft.id, draft);
  }

  view(draft: Draft): DraftView {
    return {
      status: "draft",
      draft_id: draft.id,
      to: draft.to,
      preview: draft.preview,
      expires_at: isoWithOffset(draft.expiresAt),
      kind: draft.payload.kind,
    };
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, draft] of this.drafts) {
      if (draft.expiresAt <= now) this.drafts.delete(id);
    }
  }

  private evictOldest(): void {
    let oldest: Draft | undefined;
    for (const draft of this.drafts.values()) {
      if (oldest === undefined || draft.expiresAt < oldest.expiresAt) oldest = draft;
    }
    if (oldest) this.drafts.delete(oldest.id);
  }
}

export function formatToLine(to: OutgoingTarget): string {
  if (to.number) return `To: ${to.name} (${formatNumber(to.number)})`;
  if (to.chat_id.endsWith("@g.us")) return `To: ${to.name} (group)`;
  return `To: ${to.name}`;
}

export function formatDraftPreview(to: OutgoingTarget, payload: DraftPayload): string {
  return `${formatToLine(to)}\n${formatBody(payload)}`;
}

export function renderDraft(view: DraftView): string {
  return [
    `Draft ${view.draft_id}. Not sent.`,
    "",
    view.preview,
    "",
    "Show this to the user. After they say yes, call confirm_send with this draft_id.",
  ].join("\n");
}

function formatBody(payload: DraftPayload): string {
  switch (payload.kind) {
    case "text":
      return `"${payload.text}"`;
    case "media":
      return mediaBody(payload);
    case "poll":
      return `[poll] ${payload.question}\n${payload.options.join(" / ")}`;
    case "location": {
      const label = payload.name ?? `${payload.latitude}, ${payload.longitude}`;
      const extra = payload.address ? `\n${payload.address}` : "";
      return `[location] ${label}${extra}`;
    }
    case "forward":
      return `Forward: "${payload.text ?? ""}"`;
    default: {
      const _exhaustive: never = payload;
      return _exhaustive;
    }
  }
}

function mediaBody(payload: Extract<DraftPayload, { kind: "media" }>): string {
  const name = mediaLabel(payload);
  const tag = payload.asVoice ? "voice" : payload.asDocument ? "document" : "media";
  const line = `[${tag}] ${name}`;
  return payload.caption ? `${line}\n"${payload.caption}"` : line;
}

function mediaLabel(payload: Extract<DraftPayload, { kind: "media" }>): string {
  const path = payload.source.file_path;
  if (path) return path.split(/[/\\]/).pop() || path;
  const url = payload.source.url;
  if (url) {
    try {
      const last = new URL(url).pathname.split("/").filter(Boolean).pop();
      if (last) return decodeURIComponent(last);
    } catch {
      return url;
    }
    return url;
  }
  return "file";
}

/** +40 722 123 456 from stored digits, so the preview matches the send skill. */
function formatNumber(digits: string): string {
  const raw = digits.startsWith("+") ? digits.slice(1) : digits;
  if (!/^\d+$/.test(raw) || raw.length < 4) return digits.startsWith("+") ? digits : `+${digits}`;
  const rest = raw.slice(2).match(/.{1,3}/g)?.join(" ") ?? raw.slice(2);
  return `+${raw.slice(0, 2)} ${rest}`;
}
