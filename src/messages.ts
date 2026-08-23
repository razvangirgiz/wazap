/**
 * Message shaping. Pure: no socket, no store, no I/O — everything the store
 * knows (display names, lid→pn) arrives through MessageViewContext.
 */

import { getContentType, proto, type WAMessage, type WAMessageContent, type WAMessageKey } from "baileys";
import type { MessageType, MessageView } from "./wa-types.js";

/** protobuf 64-bit fields arrive as a number or a Long. */
type ProtoLong = number | { toNumber?: () => number } | null | undefined;

export function protoNumber(value: ProtoLong): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value;
  return typeof value.toNumber === "function" ? value.toNumber() : undefined;
}

export function messageTimestampMs(raw: WAMessage): number {
  const seconds = protoNumber(raw.messageTimestamp);
  return seconds === undefined ? Date.now() : seconds * 1000;
}

/** Stable across restarts, and stable under lid→pn remapping of the chat. */
export function messageIdFor(key: WAMessageKey, chatId: string): string {
  return `${key.fromMe ? "true" : "false"}_${chatId}_${key.id ?? ""}`;
}

interface Rule {
  type: MessageType | ((m: WAMessageContent) => MessageType);
  tag: string | ((m: WAMessageContent) => string);
  /** Real text, which replaces the tag entirely. */
  text?: (m: WAMessageContent) => string | null | undefined;
  /** A caption, which follows the tag. */
  caption?: (m: WAMessageContent) => string | null | undefined;
  /** Shown after the tag only when there is no caption. */
  detail?: (m: WAMessageContent) => string | null | undefined;
}

function coords(lat: ProtoLong, lng: ProtoLong): string | undefined {
  const a = protoNumber(lat);
  const b = protoNumber(lng);
  return a === undefined || b === undefined ? undefined : `${a.toFixed(2)}, ${b.toFixed(2)}`;
}

function pollName(m: WAMessageContent): string | undefined {
  const inner = m.pollCreationMessageV4?.message;
  return (
    m.pollCreationMessage?.name ??
    m.pollCreationMessageV2?.name ??
    m.pollCreationMessageV3?.name ??
    m.pollCreationMessageV5?.name ??
    inner?.pollCreationMessage?.name ??
    undefined
  );
}

const POLL: Rule = { type: "poll", tag: "[poll]", detail: pollName };

function viewOnceInner(m: WAMessageContent): WAMessageContent | undefined {
  return (
    m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.viewOnceMessageV2Extension?.message ?? undefined
  );
}

const VIEW_ONCE: Rule = {
  type: "view_once",
  tag: (m) => (viewOnceInner(m)?.videoMessage ? "[view-once video]" : "[view-once photo]"),
};

const SYSTEM_TEXT = "[system message]";
const DELETED_TEXT = "[deleted]";

function isRevoke(m: WAMessageContent): boolean {
  return m.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE;
}

const PROTOCOL: Rule = {
  type: (m) => (isRevoke(m) ? "deleted" : "system"),
  tag: (m) => (isRevoke(m) ? DELETED_TEXT : SYSTEM_TEXT),
};

const SYSTEM: Rule = { type: "system", tag: SYSTEM_TEXT };

/** Naming the payload turns a shrug into an actionable bug report. */
const UNKNOWN: Rule = {
  type: "unknown",
  tag: (m) => {
    const key = getContentType(m) ?? Object.keys(m).find((name) => m[name as keyof WAMessageContent] != null);
    return key ? `[unsupported: ${key}]` : "[unsupported message]";
  },
};

/** Payloads WhatsApp exchanges with its own clients; no person ever sent one. */
const CONTROL_KEYS: ReadonlyArray<keyof WAMessageContent> = ["messageContextInfo", "senderKeyDistributionMessage"];

/**
 * One table drives both messageType and messageText, so the reported type and
 * the placeholder can never disagree.
 */
const RULES: Partial<Record<keyof WAMessageContent, Rule>> = {
  conversation: { type: "text", tag: "[text]", text: (m) => m.conversation },
  extendedTextMessage: { type: "text", tag: "[text]", text: (m) => m.extendedTextMessage?.text },
  imageMessage: { type: "image", tag: "[image]", caption: (m) => m.imageMessage?.caption },
  videoMessage: { type: "video", tag: "[video]", caption: (m) => m.videoMessage?.caption },
  ptvMessage: { type: "video", tag: "[video]", caption: (m) => m.ptvMessage?.caption },
  audioMessage: {
    type: (m) => (m.audioMessage?.ptt ? "voice" : "audio"),
    tag: (m) => (m.audioMessage?.ptt ? "[voice message]" : "[audio]"),
  },
  documentMessage: {
    type: "document",
    tag: "[document]",
    caption: (m) => m.documentMessage?.caption,
    detail: (m) => m.documentMessage?.fileName,
  },
  stickerMessage: { type: "sticker", tag: "[sticker]" },
  locationMessage: {
    type: "location",
    tag: "[location]",
    detail: (m) =>
      m.locationMessage?.name ?? coords(m.locationMessage?.degreesLatitude, m.locationMessage?.degreesLongitude),
  },
  liveLocationMessage: {
    type: "location",
    tag: "[location]",
    detail: (m) =>
      m.liveLocationMessage?.caption ??
      coords(m.liveLocationMessage?.degreesLatitude, m.liveLocationMessage?.degreesLongitude),
  },
  contactMessage: { type: "contact", tag: "[contact]", detail: (m) => m.contactMessage?.displayName },
  contactsArrayMessage: { type: "contact", tag: "[contact]", detail: (m) => m.contactsArrayMessage?.displayName },
  pollCreationMessage: POLL,
  pollCreationMessageV2: POLL,
  pollCreationMessageV3: POLL,
  pollCreationMessageV4: POLL,
  pollCreationMessageV5: POLL,
  reactionMessage: { type: "reaction", tag: "[reaction]", detail: (m) => m.reactionMessage?.text },
  viewOnceMessage: VIEW_ONCE,
  viewOnceMessageV2: VIEW_ONCE,
  viewOnceMessageV2Extension: VIEW_ONCE,
  protocolMessage: PROTOCOL,
  senderKeyDistributionMessage: SYSTEM,
  messageContextInfo: SYSTEM,
};

const MEDIA_KEYS: ReadonlyArray<keyof WAMessageContent> = [
  "imageMessage",
  "videoMessage",
  "ptvMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
];

interface MediaNode {
  mimetype?: string | null;
  fileLength?: ProtoLong;
  fileName?: string | null;
}

/** Envelopes that only wrap another message; the inner one is the real content. */
function unwrapEnvelopes(content: WAMessageContent | null | undefined): WAMessageContent | undefined {
  let current = content ?? undefined;
  for (let depth = 0; depth < 5 && current; depth++) {
    const inner =
      current.deviceSentMessage?.message ??
      current.ephemeralMessage?.message ??
      current.documentWithCaptionMessage?.message;
    if (!inner) break;
    current = inner;
  }
  return current;
}

function ruleFor(content: WAMessageContent | undefined): { rule: Rule; content: WAMessageContent } {
  if (!content) return { rule: UNKNOWN, content: {} };
  const key = getContentType(content);
  const rule = key ? RULES[key] : undefined;
  if (rule) return { rule, content };
  if (content.messageContextInfo || content.senderKeyDistributionMessage) return { rule: SYSTEM, content };
  return { rule: UNKNOWN, content };
}

function stubKind(raw: WAMessage): MessageType | undefined {
  const stub = raw.messageStubType;
  if (stub === null || stub === undefined) return undefined;
  if (stub === proto.WebMessageInfo.StubType.REVOKE) return "deleted";
  return stub === proto.WebMessageInfo.StubType.UNKNOWN ? undefined : "system";
}

function resolve<T>(value: T | ((m: WAMessageContent) => T), content: WAMessageContent): T {
  return typeof value === "function" ? (value as (m: WAMessageContent) => T)(content) : value;
}

/**
 * True for the machinery WhatsApp runs between devices: history-sync notices,
 * app-state and peer-data responses, sender-key distribution, bare context
 * info. They carry nothing a person wrote, so they are dropped rather than
 * shown as "[unsupported message]" — which is what they used to look like in
 * the user's own self-chat right after linking a device.
 */
export function isControlMessage(raw: WAMessage): boolean {
  if (stubKind(raw) !== undefined) return false;
  const content = unwrapEnvelopes(raw.message);
  if (!content) return true;
  const key = getContentType(content);
  if (key === "protocolMessage") return !isRevoke(content);
  if (key !== undefined) return CONTROL_KEYS.includes(key);
  const present = Object.keys(content).filter((name) => content[name as keyof WAMessageContent] != null);
  return present.length === 0 || present.every((name) => CONTROL_KEYS.includes(name as keyof WAMessageContent));
}

export function messageType(raw: WAMessage): MessageType {
  const stub = stubKind(raw);
  if (stub === "deleted") return "deleted";
  const content = unwrapEnvelopes(raw.message);
  const { rule, content: node } = ruleFor(content);
  if (rule === UNKNOWN && stub) return stub;
  return resolve(rule.type, node);
}

/** Never empty: media and system messages get a placeholder like "[sticker]". */
export function messageText(raw: WAMessage): string {
  const content = unwrapEnvelopes(raw.message);
  const { rule, content: node } = ruleFor(content);
  if (rule === UNKNOWN) {
    const stub = stubKind(raw);
    if (stub === "deleted") return DELETED_TEXT;
    if (stub === "system") return SYSTEM_TEXT;
  }

  const text = rule.text?.(node)?.trim();
  if (text) return text;
  const tag = resolve(rule.tag, node);
  const caption = rule.caption?.(node)?.trim();
  if (caption) return `${tag} ${caption}`;
  const detail = rule.detail?.(node)?.trim();
  return detail ? `${tag} ${detail}` : tag;
}

export function mediaInfo(raw: WAMessage): { mime: string; size?: number; filename?: string } | undefined {
  const outer = unwrapEnvelopes(raw.message);
  const content = outer ? (viewOnceInner(outer) ?? outer) : undefined;
  if (!content) return undefined;
  for (const key of MEDIA_KEYS) {
    const node = content[key] as MediaNode | null | undefined;
    if (!node) continue;
    return {
      mime: node.mimetype ?? "application/octet-stream",
      size: protoNumber(node.fileLength),
      filename: node.fileName ?? undefined,
    };
  }
  return undefined;
}

function contextInfo(raw: WAMessage): proto.IContextInfo | undefined {
  const content = unwrapEnvelopes(raw.message);
  if (!content) return undefined;
  const key = getContentType(content);
  if (!key) return undefined;
  const node = content[key] as { contextInfo?: proto.IContextInfo | null } | null | undefined;
  return node?.contextInfo ?? undefined;
}

/** "just now", "5m ago", "2h ago", "3d ago" — largest whole unit. */
export function formatAge(fromMs: number, nowMs: number = Date.now()): string {
  const elapsed = Math.max(0, nowMs - fromMs);
  const days = Math.floor(elapsed / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours >= 1) return `${hours}h ago`;
  const minutes = Math.floor(elapsed / 60_000);
  return minutes >= 1 ? `${minutes}m ago` : "just now";
}

/** Local-time ISO 8601 with a numeric offset, e.g. 2026-08-22T21:30:00+03:00. */
export function isoWithOffset(ms: number): string {
  const at = new Date(ms);
  const pad = (value: number, width = 2): string => String(Math.abs(value)).padStart(width, "0");
  const offsetMinutes = -at.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const date = `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  const offset = `${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${date}T${time}${sign}${offset}`;
}

export interface MessageViewContext {
  /** Canonical form of a jid: `<digits>@s.whatsapp.net` or `<id>@g.us`. */
  canonical: (jid: string) => string;
  /** Display name for a canonical jid; never empty. */
  nameFor: (jid: string) => string;
  /** Our own canonical jid. */
  ownId: string;
  /** Canonical chat this message belongs to. */
  chatId: string;
  edited: boolean;
  reactions: Array<{ emoji: string; sender: string }>;
  now?: number;
}

function senderJid(raw: WAMessage, ctx: MessageViewContext): string {
  if (raw.key.fromMe) return ctx.ownId;
  const from = raw.key.participant ?? raw.participant ?? raw.key.remoteJid ?? "";
  return from ? ctx.canonical(from) : ctx.ownId;
}

function phoneOf(jid: string): string | undefined {
  const [user = "", domain] = jid.split("@");
  return domain === "s.whatsapp.net" && /^\d+$/.test(user) ? user : undefined;
}

export function buildMessageView(raw: WAMessage, ctx: MessageViewContext): MessageView {
  const timestamp = messageTimestampMs(raw);
  const sender = senderJid(raw, ctx);
  const media = mediaInfo(raw);
  const context = contextInfo(raw);
  const quoted = context?.quotedMessage ? quotedView(context, ctx) : undefined;

  const view: MessageView = {
    message_id: messageIdFor(raw.key, ctx.chatId),
    chat_id: ctx.chatId,
    from_me: Boolean(raw.key.fromMe),
    sender: {
      id: sender,
      name: ctx.nameFor(sender) || sender,
      ...(phoneOf(sender) ? { phone: phoneOf(sender) } : {}),
    },
    type: messageType(raw),
    text: messageText(raw),
    timestamp: isoWithOffset(timestamp),
    age: formatAge(timestamp, ctx.now),
    has_media: media !== undefined,
    forwarded: Boolean(context?.isForwarded) || (protoNumber(context?.forwardingScore) ?? 0) > 0,
    edited: ctx.edited,
  };
  if (media) view.media = media;
  if (quoted) view.quoted = quoted;
  if (ctx.reactions.length > 0) view.reactions = ctx.reactions;
  return view;
}

function quotedView(
  context: proto.IContextInfo,
  ctx: MessageViewContext,
): { message_id: string; text: string; sender: string } | undefined {
  if (!context.quotedMessage || !context.stanzaId) return undefined;
  const participant = context.participant ? ctx.canonical(context.participant) : ctx.ownId;
  const key: WAMessageKey = {
    id: context.stanzaId,
    fromMe: participant === ctx.ownId,
    remoteJid: ctx.chatId,
  };
  const inner: WAMessage = { key, message: context.quotedMessage };
  return {
    message_id: messageIdFor(key, ctx.chatId),
    text: messageText(inner),
    sender: participant,
  };
}
