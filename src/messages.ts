/**
 * Message shaping. Pure: no socket, no store, no I/O — everything the store
 * knows (display names, lid→pn) arrives through MessageViewContext.
 */

import { getContentType, proto, type WAMessage, type WAMessageContent, type WAMessageKey } from "baileys";
import type { TranscriptRecord } from "./transcribe/index.js";
import type { CallDirection, CallInfo, CallKind, CallOutcome, MessageType, MessageView } from "./wa-types.js";

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

/** Stable across restarts. Not stable if the chat's own jid is later remapped
 * from a LID to a phone number, which is why wazap does not remap chat jids. */
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

/** Names the payload, so a bug report says which one to add. */
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
 * The protocol messages that report something a person did. Baileys enumerates
 * exactly these as cross-user in Utils/process-message.js — every other type is
 * one device talking to another. MESSAGE_EDIT is cross-user too, but wazap
 * applies the edit to the message it edits, so its envelope is not a second
 * message to show.
 */
const REPORTABLE_PROTOCOL_TYPES: ReadonlySet<number> = new Set([
  proto.Message.ProtocolMessage.Type.REVOKE,
  proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
  proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
]);

/**
 * One table drives both messageType and messageText, so the reported type and
 * the placeholder can never disagree.
 */
const RULES: Partial<Record<keyof WAMessageContent, Rule>> = {
  conversation: { type: "text", tag: "[text]", text: (m) => m.conversation },
  extendedTextMessage: { type: "text", tag: "[text]", text: (m) => m.extendedTextMessage?.text },
  imageMessage: { type: "image", tag: "[image]", caption: (m) => m.imageMessage?.caption },
  // A GIF on WhatsApp is an mp4 with a flag; the reader deserves the word.
  videoMessage: { type: "video", tag: (m) => (m.videoMessage?.gifPlayback ? "[gif]" : "[video]"), caption: (m) => m.videoMessage?.caption },
  ptvMessage: { type: "video", tag: "[video]", caption: (m) => m.ptvMessage?.caption },
  audioMessage: {
    type: (m) => (m.audioMessage?.ptt ? "voice" : "audio"),
    // The duration goes inside the brackets, the way a call's does: everything
    // after the tag is caption territory, and this is not a caption.
    tag: (m) => {
      const kind = m.audioMessage?.ptt ? "voice message" : "audio";
      const seconds = audioSeconds(m);
      return seconds === undefined ? `[${kind}]` : `[${kind} · ${clockLabel(seconds)}]`;
    },
  },
  documentMessage: {
    type: "document",
    tag: "[document]",
    caption: (m) => m.documentMessage?.caption,
    detail: (m) => m.documentMessage?.fileName,
  },
  stickerMessage: { type: "sticker", tag: "[sticker]" },
  lottieStickerMessage: { type: "sticker", tag: "[sticker]" },
  // The header WhatsApp sends before the photos of an album; the photos follow
  // as messages of their own, so this is a notice, not content.
  // An edit WhatsApp encrypted with the message's own secret; the new text
  // is not readable from a linked device, only the fact of the edit.
  secretEncryptedMessage: {
    type: "system",
    tag: (m) => (m.secretEncryptedMessage?.secretEncType === 1 ? "[edited an event]" : "[edited a message]"),
  },
  albumMessage: {
    type: "system",
    tag: (m) => {
      const n = (m.albumMessage?.expectedImageCount ?? 0) + (m.albumMessage?.expectedVideoCount ?? 0);
      return n > 0 ? `[album · ${n} items]` : "[album]";
    },
  },
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
  jpegThumbnail?: Uint8Array | null;
}

/** Media whose WhatsApp envelope carries a JPEG preview of a few KB. */
const THUMBNAIL_KEYS: ReadonlyArray<keyof WAMessageContent> = ["imageMessage", "videoMessage", "ptvMessage", "documentMessage"];

/** Envelopes that only wrap another message; the inner one is the real content. */
function unwrapEnvelopes(content: WAMessageContent | null | undefined): WAMessageContent | undefined {
  let current = content ?? undefined;
  for (let depth = 0; depth < 5 && current; depth++) {
    const inner =
      current.deviceSentMessage?.message ??
      current.ephemeralMessage?.message ??
      current.documentWithCaptionMessage?.message ??
      // A photo or video sent as part of an album, or in reply to a story:
      // the real message sits one level down.
      current.associatedChildMessage?.message;
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
  // Only when the control keys are all there is. A payload wazap does not model
  // yet usually carries messageContextInfo alongside it, and calling that a
  // system message would hide someone's event, album or order behind
  // "[system message]" and then out of the digest.
  if (key === undefined && (content.messageContextInfo || content.senderKeyDistributionMessage)) {
    return { rule: SYSTEM, content };
  }
  return { rule: UNKNOWN, content };
}

function stubKind(raw: WAMessage): MessageType | undefined {
  const stub = raw.messageStubType;
  if (stub === null || stub === undefined) return undefined;
  if (stub === proto.WebMessageInfo.StubType.REVOKE) return "deleted";
  return stub === proto.WebMessageInfo.StubType.UNKNOWN ? undefined : "system";
}

/** Nobody picked up. Which word that is depends on which end of the call you were. */
type Unanswered = "no answer";

const CALL_OUTCOMES: Partial<Record<number, CallOutcome | Unanswered>> = {
  [proto.Message.CallLogMessage.CallOutcome.CONNECTED]: "answered",
  [proto.Message.CallLogMessage.CallOutcome.ACCEPTED_ELSEWHERE]: "answered",
  [proto.Message.CallLogMessage.CallOutcome.ONGOING]: "answered",
  [proto.Message.CallLogMessage.CallOutcome.REJECTED]: "rejected",
  [proto.Message.CallLogMessage.CallOutcome.MISSED]: "no answer",
  [proto.Message.CallLogMessage.CallOutcome.FAILED]: "no answer",
  [proto.Message.CallLogMessage.CallOutcome.SILENCED_BY_DND]: "no answer",
  [proto.Message.CallLogMessage.CallOutcome.SILENCED_UNKNOWN_CALLER]: "no answer",
};

const CALL_STUB_KINDS: Partial<Record<number, CallKind>> = {
  [proto.WebMessageInfo.StubType.CALL_MISSED_VOICE]: "voice",
  [proto.WebMessageInfo.StubType.CALL_MISSED_VIDEO]: "video",
  [proto.WebMessageInfo.StubType.CALL_MISSED_GROUP_VOICE]: "voice",
  [proto.WebMessageInfo.StubType.CALL_MISSED_GROUP_VIDEO]: "video",
};

function settle(outcome: CallOutcome | Unanswered, direction: CallDirection): CallOutcome {
  if (outcome !== "no answer") return outcome;
  return direction === "outgoing" ? "unanswered" : "missed";
}

/**
 * Calls never reach the RULES table: `getContentType` looks for a key
 * containing "Message" and the proto field is spelled `callLogMesssage`, so it
 * reports undefined and a call arriving next to messageContextInfo would render
 * as "[system message]". Hence this runs before the table, not inside it.
 */
export function callInfo(raw: WAMessage): CallInfo | undefined {
  const direction: CallDirection = raw.key?.fromMe ? "outgoing" : "incoming";
  const content = unwrapEnvelopes(raw.message);
  const logged = content?.callLogMesssage;
  if (logged) {
    const outcome = settle(CALL_OUTCOMES[logged.callOutcome ?? -1] ?? "no answer", direction);
    const seconds = protoNumber(logged.durationSecs);
    const participants = (logged.participants ?? []).flatMap((one) => (one.jid ? [one.jid] : []));
    return {
      kind: logged.isVideo ? "video" : "voice",
      direction,
      outcome,
      ...(outcome === "answered" && seconds !== undefined && seconds > 0 ? { duration_seconds: seconds } : {}),
      ...(participants.length > 0 ? { participants } : {}),
    };
  }
  const stub = CALL_STUB_KINDS[raw.messageStubType ?? -1];
  if (stub) return { kind: stub, direction, outcome: settle("no answer", direction) };
  if (content?.call != null) return { kind: "voice", direction, outcome: settle("no answer", direction) };
  return undefined;
}

/**
 * Baileys' own stand-in for a group call offer. It says a call happened and
 * nothing else, so anything that names an outcome outranks it.
 */
export function isCallPlaceholder(raw: WAMessage): boolean {
  const content = unwrapEnvelopes(raw.message);
  return content?.call != null && content.callLogMesssage == null;
}

/** A duration WhatsApp attached to a recording. Zero means it said nothing. */
function audioSeconds(content: WAMessageContent): number | undefined {
  const seconds = protoNumber(content.audioMessage?.seconds);
  return seconds === undefined || seconds <= 0 ? undefined : seconds;
}

/** How long a voice note or audio message runs, when WhatsApp said so. */
export function voiceSeconds(raw: WAMessage): number | undefined {
  const content = unwrapEnvelopes(raw.message);
  return content === undefined ? undefined : audioSeconds(content);
}

/** 0:06, 3:05, 1:02:03 — a recording reads as a clock, unlike a call's "6 min". */
export function clockLabel(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const pad = (value: number): string => String(value).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const rest = pad(total % 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${rest}` : `${minutes}:${rest}`;
}

function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest} min`;
}

/** An outcome you caused reads as a suffix; one that happened to you is an adjective. */
export function callText(info: CallInfo): string {
  const duration = info.duration_seconds === undefined ? "" : ` · ${durationLabel(info.duration_seconds)}`;
  if (info.direction === "outgoing") {
    return `[outgoing ${info.kind} call${info.outcome === "answered" ? duration : ` · ${info.outcome}`}]`;
  }
  const adjective = info.outcome === "answered" ? "" : `${info.outcome} `;
  return `[${adjective}${info.kind} call${duration}]`;
}

function resolve<T>(value: T | ((m: WAMessageContent) => T), content: WAMessageContent): T {
  return typeof value === "function" ? (value as (m: WAMessageContent) => T)(content) : value;
}

/**
 * True for the machinery WhatsApp runs between devices: history-sync notices,
 * app-state and peer-data responses, sender-key distribution, bare context
 * info. They carry nothing a person did, so they are dropped rather than shown.
 */
export function isControlMessage(raw: WAMessage): boolean {
  if (isStubEvent(raw)) return false;
  const content = unwrapEnvelopes(raw.message);
  if (!content) return true;
  const key = getContentType(content);
  if (key === "protocolMessage") return !REPORTABLE_PROTOCOL_TYPES.has(content.protocolMessage?.type ?? -1);
  if (key !== undefined) return false;
  // getContentType ignores the control keys, so reaching here means the payload
  // is either nothing at all or nothing but control keys.
  const present = Object.keys(content).filter((name) => content[name as keyof WAMessageContent] != null);
  return present.length === 0 || present.every((name) => CONTROL_KEYS.includes(name as keyof WAMessageContent));
}

/**
 * A message whose whole content is a stub type: WhatsApp's own notices about
 * device linking, group membership and encryption. Baileys builds these with no
 * `message` field at all, so they have to be recognised before the usual
 * "no content, nothing to store" guard throws them away.
 */
export function isStubEvent(raw: WAMessage): boolean {
  return stubKind(raw) !== undefined;
}

export function messageType(raw: WAMessage): MessageType {
  if (callInfo(raw)) return "call";
  const stub = stubKind(raw);
  if (stub === "deleted") return "deleted";
  const content = unwrapEnvelopes(raw.message);
  const { rule, content: node } = ruleFor(content);
  if (rule === UNKNOWN && stub) return stub;
  return resolve(rule.type, node);
}

/** Never empty: media and system messages get a placeholder like "[sticker]". */
export function messageText(raw: WAMessage): string {
  const call = callInfo(raw);
  // The placeholder only says a group call was offered, so naming an outcome
  // ("missed") would claim something the payload never carried.
  if (call) return isCallPlaceholder(raw) ? "[group call]" : callText(call);
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

/** A transcript belongs to a recording and to nothing else. */
function spokenTranscript(raw: WAMessage, transcript: TranscriptRecord | undefined): string | undefined {
  if (!transcript?.text) return undefined;
  const type = messageType(raw);
  return type === "voice" || type === "audio" ? transcript.text : undefined;
}

/**
 * What a reader sees. searchMessages matches on this rather than on the bare
 * placeholder, so a transcript is findable by the words it puts on the screen.
 */
export function viewText(raw: WAMessage, transcript?: TranscriptRecord): string {
  const text = messageText(raw);
  const spoken = spokenTranscript(raw, transcript);
  return spoken === undefined ? text : `${text} "${spoken}"`;
}

/** The reaction a message is, if it is one: what was reacted with, and to which message key. An empty text withdraws. */
export function reactionOf(raw: WAMessage): { text: string; targetKey: WAMessageKey } | undefined {
  const content = unwrapEnvelopes(raw.message);
  const reaction = content?.reactionMessage;
  if (!reaction?.key?.remoteJid) return undefined;
  return { text: reaction.text ?? "", targetKey: reaction.key as WAMessageKey };
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

/**
 * The preview WhatsApp ships inside a photo, video or document message: a JPEG
 * of a few KB, there before any download. Enough to tell a receipt from a baby.
 */
export function thumbnailOf(raw: WAMessage): { mime: string; base64: string } | undefined {
  const outer = unwrapEnvelopes(raw.message);
  const content = outer ? (viewOnceInner(outer) ?? outer) : undefined;
  if (!content) return undefined;
  for (const key of THUMBNAIL_KEYS) {
    const node = content[key] as MediaNode | null | undefined;
    const bytes = node?.jpegThumbnail;
    if (bytes && bytes.length > 0) return { mime: "image/jpeg", base64: Buffer.from(bytes).toString("base64") };
  }
  return undefined;
}

/** Who a message @-mentions, as the jids WhatsApp put on it (lid or phone). */
export function mentionedJids(raw: WAMessage): string[] {
  return (contextInfo(raw)?.mentionedJid ?? []).filter((jid): jid is string => typeof jid === "string" && jid.length > 0);
}

/** The author of the message this one quotes, when it is a reply. */
export function quotedSenderJid(raw: WAMessage): string | undefined {
  const context = contextInfo(raw);
  if (!context?.quotedMessage) return undefined;
  return context.participant ?? undefined;
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
  transcript?: TranscriptRecord;
  now?: number;
}

function senderJid(raw: WAMessage, ctx: MessageViewContext): string {
  if (raw.key.fromMe) return ctx.ownId;
  // In a one-to-one chat the other side wrote it, whatever id the key carries.
  if (!ctx.chatId.endsWith("@g.us")) return ctx.chatId;
  // Baileys sets `participant` to "" on a direct message that arrived under a
  // lid, and "" is not "absent": `??` would keep it and hand the message to us.
  const from = raw.key.participant || raw.participant || raw.key.remoteJid || "";
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
  const call = callInfo(raw);

  const view: MessageView = {
    message_id: messageIdFor(raw.key, ctx.chatId),
    chat_id: ctx.chatId,
    from_me: Boolean(raw.key.fromMe),
    sender: {
      id: sender,
      name: ctx.nameFor(sender),
      ...(phoneOf(sender) ? { phone: phoneOf(sender) } : {}),
    },
    type: messageType(raw),
    text: viewText(raw, ctx.transcript),
    timestamp: isoWithOffset(timestamp),
    age: formatAge(timestamp, ctx.now),
    has_media: media !== undefined,
    forwarded: Boolean(context?.isForwarded) || (protoNumber(context?.forwardingScore) ?? 0) > 0,
    edited: ctx.edited,
  };
  if (media) view.media = media;
  if (quoted) view.quoted = quoted;
  const spoken = spokenTranscript(raw, ctx.transcript);
  if (spoken !== undefined) view.transcript = spoken;
  if (call) {
    view.call = call.participants
      ? { ...call, participants: call.participants.map((jid) => ctx.canonical(jid)) }
      : call;
  }
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
