/**
 * Message shaping. Pure: no socket, no store, no I/O — everything the store
 * knows (display names, lid→pn) arrives through MessageViewContext.
 */

import { getContentType, proto, type WAMessage, type WAMessageContent, type WAMessageKey } from "baileys";
import type { TranscriptRecord } from "./transcribe/index.js";
import type {
  CallDirection,
  CallInfo,
  CallKind,
  CallOutcome,
  EventParty,
  MessageType,
  MessageView,
  SystemEvent,
  SystemEventAction,
} from "./wa-types.js";

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
  videoMessage: {
    type: "video",
    tag: (m) => (m.videoMessage?.gifPlayback ? "[gif]" : "[video]"),
    caption: (m) => m.videoMessage?.caption,
  },
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
const THUMBNAIL_KEYS: ReadonlyArray<keyof WAMessageContent> = [
  "imageMessage",
  "videoMessage",
  "ptvMessage",
  "documentMessage",
];

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

function ruleFor(
  content: WAMessageContent | undefined,
  key = content ? getContentType(content) : undefined,
): { rule: Rule; content: WAMessageContent } {
  if (!content) return { rule: UNKNOWN, content: {} };
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

/** The name a stub type goes by, so a notice wazap does not spell out still says which one it is. */
function stubTypeName(raw: WAMessage): string | undefined {
  return proto.WebMessageInfo.StubType[raw.messageStubType ?? -1];
}

/** The sentence for one notice. `self` is a change someone made to themselves: joining, leaving. */
type Say = (actor: string, targets: string, value: string | undefined, self: boolean) => string;

interface GroupStub {
  action: SystemEventAction;
  /** What messageStubParameters holds: everyone the change touched, the new value, or nothing to show. */
  params: "participants" | "value" | "none";
  say: Say;
}

/** A group notice before any name is looked up: the jids exactly as the stub carries them. */
interface GroupEvent {
  spec: GroupStub;
  /** Who made the change, as the key names them; undefined when WhatsApp did not say. */
  actor: string | undefined;
  fromMe: boolean;
  targets: string[];
  value: string | undefined;
}

/** A setting WhatsApp reports as on/off in a live notice and as true/false in synced history. */
function toggle(on: string, off: string, unclear: string): Say {
  return (actor, _targets, value) => {
    const state = value === "on" || value === "true" ? on : value === "off" || value === "false" ? off : unclear;
    return `${actor} ${state}`;
  };
}

const StubType = proto.WebMessageInfo.StubType;

const GROUP_STUBS: Partial<Record<number, GroupStub>> = {
  [StubType.GROUP_CREATE]: {
    action: "create",
    params: "value",
    say: (actor, _targets, value) => (value ? `${actor} created the group "${value}"` : `${actor} created the group`),
  },
  [StubType.GROUP_PARTICIPANT_ADD]: {
    action: "add",
    params: "participants",
    say: (actor, targets, _value, self) => (self ? `${targets} joined` : `${actor} added ${targets}`),
  },
  [StubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN]: {
    action: "add",
    params: "participants",
    say: (actor, targets) => `${actor} added ${targets} after a request to join`,
  },
  [StubType.GROUP_PARTICIPANT_INVITE]: {
    action: "join_via_link",
    params: "participants",
    say: (actor, targets) => `${targets || actor} joined using the invite link`,
  },
  [StubType.GROUP_PARTICIPANT_REMOVE]: {
    action: "remove",
    params: "participants",
    say: (actor, targets, _value, self) => (self ? `${targets} left` : `${actor} removed ${targets}`),
  },
  [StubType.GROUP_PARTICIPANT_LEAVE]: {
    action: "leave",
    params: "participants",
    say: (actor, targets) => `${targets || actor} left`,
  },
  [StubType.GROUP_PARTICIPANT_PROMOTE]: {
    action: "promote",
    params: "participants",
    say: (actor, targets) => `${actor} made ${targets} admin`,
  },
  [StubType.GROUP_PARTICIPANT_DEMOTE]: {
    action: "demote",
    params: "participants",
    say: (actor, targets) => `${actor} dismissed ${targets} as admin`,
  },
  [StubType.GROUP_PARTICIPANT_CHANGE_NUMBER]: {
    action: "change_number",
    params: "participants",
    say: (actor) => `${actor} changed their phone number`,
  },
  [StubType.GROUP_CHANGE_SUBJECT]: {
    action: "set_subject",
    params: "value",
    say: (actor, _targets, value) => (value ? `${actor} renamed the group to "${value}"` : `${actor} renamed the group`),
  },
  [StubType.GROUP_CHANGE_DESCRIPTION]: {
    action: "set_description",
    params: "value",
    say: (actor) => `${actor} changed the group description`,
  },
  // A removed photo and a synced one both arrive without the new photo's id, so
  // "removed" cannot be told apart from "changed" and is not claimed.
  [StubType.GROUP_CHANGE_ICON]: {
    action: "set_picture",
    params: "none",
    say: (actor) => `${actor} changed the group photo`,
  },
  // The parameter is the new invite code, and the code lets anyone in: not a thing to print.
  [StubType.GROUP_CHANGE_INVITE_LINK]: {
    action: "reset_invite_link",
    params: "none",
    say: (actor) => `${actor} reset the invite link`,
  },
  [StubType.GROUP_CHANGE_ANNOUNCE]: {
    action: "set_announcement_only",
    params: "value",
    say: toggle(
      "allowed only admins to send messages",
      "allowed every member to send messages",
      "changed who can send messages"
    ),
  },
  [StubType.GROUP_CHANGE_RESTRICT]: {
    action: "set_info_locked",
    params: "value",
    say: toggle(
      "allowed only admins to edit the group info",
      "allowed every member to edit the group info",
      "changed who can edit the group info"
    ),
  },
  [StubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE]: {
    action: "set_join_approval",
    params: "value",
    say: toggle(
      "turned on admin approval for new members",
      "turned off admin approval for new members",
      "changed admin approval for new members"
    ),
  },
  [StubType.GROUP_MEMBER_ADD_MODE]: {
    action: "set_add_mode",
    params: "value",
    say: (actor, _targets, value) =>
      value === "all_member_add"
        ? `${actor} allowed every member to add others`
        : value === "admin_add"
          ? `${actor} allowed only admins to add members`
          : `${actor} changed who can add members`,
  },
};

/**
 * A participant as a group notice names them. A live notice carries JSON with
 * a lid and, when WhatsApp sent one, the number; synced history a bare jid.
 * The number wins, since a lid alone often cannot be put to a name.
 */
function stubParty(param: string): string | undefined {
  if (!param.startsWith("{")) return param.includes("@") ? param : undefined;
  try {
    const party = JSON.parse(param) as Record<string, unknown>;
    return [party.phoneNumber, party.pn, party.id, party.lid].find(
      (jid): jid is string => typeof jid === "string" && jid.includes("@")
    );
  } catch {
    return undefined;
  }
}

/** A member label arrives as a protocol message rather than a stub, but it is the same kind of notice. */
const MEMBER_LABEL: GroupStub = {
  action: "set_member_label",
  params: "value",
  say: (actor, _targets, value) =>
    value ? `${actor} set their member label to "${value}"` : `${actor} cleared their member label`,
};

function groupEventOf(raw: WAMessage, content: WAMessageContent | undefined): GroupEvent | undefined {
  const actor = raw.key.participant || raw.participant || undefined;
  const fromMe = Boolean(raw.key.fromMe);
  const protocol = content?.protocolMessage;
  if (protocol?.type === proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE) {
    return { spec: MEMBER_LABEL, actor, fromMe, targets: [], value: protocol.memberLabel?.label || undefined };
  }
  const spec = GROUP_STUBS[raw.messageStubType ?? -1];
  if (!spec) return undefined;
  // Baileys types the parameters as any; only strings are ever a jid or a value.
  const params: string[] = (Array.isArray(raw.messageStubParameters) ? raw.messageStubParameters : []).filter(
    (param: unknown): param is string => typeof param === "string"
  );
  return {
    spec,
    actor: raw.key.participant || raw.participant || undefined,
    fromMe: Boolean(raw.key.fromMe),
    targets:
      spec.params === "participants"
        ? params.flatMap((param) => {
            const jid = stubParty(param);
            return jid ? [jid] : [];
          })
        : [],
    value: spec.params === "value" ? params[0] || undefined : undefined,
  };
}

/** Bracketed like every other placeholder, so a notice never reads as words someone typed. */
function eventLine(event: GroupEvent, actor: string, targets: string[], self: boolean): string {
  return `[${event.spec.say(actor, targets.join(", "), event.value, self)}]`;
}

/** A jid on a line with no address book behind it: the number, never a lid's digits. */
function bareLabel(jid: string): string {
  const digits = jid.split("@")[0] ?? "";
  return jid.endsWith("@lid") ? `unknown (lid …${digits.slice(-4)})` : digits || jid;
}

function eventText(event: GroupEvent): string {
  const actor = event.fromMe ? "You" : event.actor ? bareLabel(event.actor) : "Someone";
  const self = event.targets.length === 1 && event.targets[0] === event.actor;
  return eventLine(event, actor, event.targets.map(bareLabel), self);
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
function callFrom(raw: WAMessage, content: WAMessageContent | undefined): CallInfo | undefined {
  const direction: CallDirection = raw.key?.fromMe ? "outgoing" : "incoming";
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

/** A duration WhatsApp attached to a recording. Zero means it said nothing. */
function audioSeconds(content: WAMessageContent): number | undefined {
  const seconds = protoNumber(content.audioMessage?.seconds);
  return seconds === undefined || seconds <= 0 ? undefined : seconds;
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
 * Everything the helpers below read out of one message, parsed once. A message
 * goes through several of them on every path — ingest checks isControlMessage
 * and reactionOf, a render reads type, text, media and context — and each one
 * used to unwrap the envelope and classify the payload on its own. The WeakMap
 * keys on the message object, so a later pass over the same store row is free.
 * `raw.message` is replaced (not mutated) when an edit lands, so the entry
 * carries it and recomputes when it no longer matches.
 */
interface Analysis {
  /** unwrapEnvelopes(raw.message). */
  content: WAMessageContent | undefined;
  /** getContentType(content). */
  key: keyof WAMessageContent | undefined;
  /** The RULES entry the content matched, UNKNOWN when none did. */
  rule: Rule;
  /** The view-once body when the message is one, else the content itself. */
  inner: WAMessageContent | undefined;
  stub: MessageType | undefined;
  /** The group notice a stub spells out, when wazap models that stub. */
  event: GroupEvent | undefined;
  /** The stub type's name, for a notice that is not spelled out. */
  stubName: string | undefined;
  call: CallInfo | undefined;
  context: proto.IContextInfo | undefined;
  media: { mime: string; size?: number; filename?: string } | undefined;
  type: MessageType;
  /** Filled on the first messageText/viewText; not part of the parse. */
  text?: string;
}

const ANALYSES = new WeakMap<
  WAMessage,
  { message: WAMessage["message"]; stubType: WAMessage["messageStubType"]; a: Analysis }
>();

function analyze(raw: WAMessage): Analysis {
  const hit = ANALYSES.get(raw);
  if (hit && hit.message === raw.message && hit.stubType === raw.messageStubType) return hit.a;

  const content = unwrapEnvelopes(raw.message);
  const key = content ? getContentType(content) : undefined;
  const { rule } = ruleFor(content, key);
  const stub = stubKind(raw);
  const call = callFrom(raw, content);
  const node = key === undefined ? undefined : (content?.[key] as { contextInfo?: proto.IContextInfo | null } | null);
  const inner = content ? (viewOnceInner(content) ?? content) : undefined;
  let media: Analysis["media"];
  if (inner) {
    for (const mediaKey of MEDIA_KEYS) {
      const m = inner[mediaKey] as MediaNode | null | undefined;
      if (!m) continue;
      media = {
        mime: m.mimetype ?? "application/octet-stream",
        size: protoNumber(m.fileLength),
        filename: m.fileName ?? undefined,
      };
      break;
    }
  }

  const a: Analysis = {
    content,
    key,
    rule,
    inner,
    stub,
    event:
      (rule === UNKNOWN && stub === "system") || key === "protocolMessage" ? groupEventOf(raw, content) : undefined,
    stubName: stub === "system" ? stubTypeName(raw) : undefined,
    call,
    context: node?.contextInfo ?? undefined,
    media,
    type: "unknown",
  };
  a.type =
    call !== undefined
      ? "call"
      : stub === "deleted"
        ? "deleted"
        : rule === UNKNOWN && stub !== undefined
          ? stub
          : resolve(rule.type, content ?? {});
  ANALYSES.set(raw, { message: raw.message, stubType: raw.messageStubType, a });
  return a;
}

/** The same walk isControlMessage always did, over the parsed analysis. */
function controlFrom(a: Analysis): boolean {
  if (a.stub !== undefined) return false;
  const content = a.content;
  if (!content) return true;
  if (a.key === "protocolMessage") return !REPORTABLE_PROTOCOL_TYPES.has(content.protocolMessage?.type ?? -1);
  if (a.key !== undefined) return false;
  // getContentType ignores the control keys, so reaching here means the payload
  // is either nothing at all or nothing but control keys.
  const present = Object.keys(content).filter((name) => content[name as keyof WAMessageContent] != null);
  return present.length === 0 || present.every((name) => CONTROL_KEYS.includes(name as keyof WAMessageContent));
}

/** The same walk messageText always did, over the parsed analysis. */
function textFrom(a: Analysis): string {
  // The placeholder only says a group call was offered, so naming an outcome
  // ("missed") would claim something the payload never carried.
  if (a.call) {
    return a.content?.call != null && a.content.callLogMesssage == null ? "[group call]" : callText(a.call);
  }
  if (a.event) return eventText(a.event);
  const node = a.content ?? {};
  if (a.rule === UNKNOWN) {
    if (a.stub === "deleted") return DELETED_TEXT;
    if (a.stub === "system") return a.stubName ? `[system message · ${a.stubName}]` : SYSTEM_TEXT;
  }

  const text = a.rule.text?.(node)?.trim();
  if (text) return text;
  const tag = resolve(a.rule.tag, node);
  const caption = a.rule.caption?.(node)?.trim();
  if (caption) return `${tag} ${caption}`;
  const detail = a.rule.detail?.(node)?.trim();
  return detail ? `${tag} ${detail}` : tag;
}

/** A transcript belongs to a recording and to nothing else. */
function spokenFrom(a: Analysis, transcript: TranscriptRecord | undefined): string | undefined {
  if (!transcript?.text) return undefined;
  return a.type === "voice" || a.type === "audio" ? transcript.text : undefined;
}

/**
 * True for the machinery WhatsApp runs between devices: history-sync notices,
 * app-state and peer-data responses, sender-key distribution, bare context
 * info. They carry nothing a person did, so they are dropped rather than shown.
 */
export function isControlMessage(raw: WAMessage): boolean {
  return controlFrom(analyze(raw));
}

/**
 * A message whose whole content is a stub type: WhatsApp's own notices about
 * device linking, group membership and encryption. Baileys builds these with no
 * `message` field at all, so they have to be recognised before the usual
 * "no content, nothing to store" guard throws them away.
 */
export function isStubEvent(raw: WAMessage): boolean {
  return analyze(raw).stub !== undefined;
}

/**
 * Something a person sent or received, as opposed to a control notice, a stub
 * or a system line. The webhook posts these in both directions.
 */
export function isUserMessage(raw: WAMessage): boolean {
  const a = analyze(raw);
  if (controlFrom(a) || a.stub !== undefined) return false;
  return a.type !== "system";
}

export function messageType(raw: WAMessage): MessageType {
  return analyze(raw).type;
}

/** Never empty: media and system messages get a placeholder like "[sticker]". */
export function messageText(raw: WAMessage): string {
  const a = analyze(raw);
  return (a.text ??= textFrom(a));
}

export function callInfo(raw: WAMessage): CallInfo | undefined {
  return analyze(raw).call;
}

/**
 * Baileys' own stand-in for a group call offer. It says a call happened and
 * nothing else, so anything that names an outcome outranks it.
 */
export function isCallPlaceholder(raw: WAMessage): boolean {
  const content = analyze(raw).content;
  return content?.call != null && content.callLogMesssage == null;
}

/** How long a voice note or audio message runs, when WhatsApp said so. */
export function voiceSeconds(raw: WAMessage): number | undefined {
  const content = analyze(raw).content;
  return content === undefined ? undefined : audioSeconds(content);
}

/**
 * What the recall index stores for a message: the rendered view text when the
 * message carries words a person chose, and null when it is only a placeholder
 * — "[sticker]", "[deleted]", a call log, a reaction. A bare tag is nothing to
 * search by; a voice note becomes indexable once its transcript exists.
 */
export function searchableText(raw: WAMessage, transcript?: TranscriptRecord): string | null {
  const a = analyze(raw);
  const spoken = spokenFrom(a, transcript);
  const node = a.content ?? {};
  const type = resolve(a.rule.type, node);
  if (type === "reaction" || type === "deleted" || type === "system") return null;
  const own =
    a.rule.text?.(node)?.trim() || a.rule.caption?.(node)?.trim() || a.rule.detail?.(node)?.trim() || "";
  // Under five letters or digits there is no meaning to embed — a "🥰🥰", a
  // "Da" or a "..." only adds noise that outranks real hits on short queries.
  if ((own.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 5 && spoken === undefined) return null;
  const text = (a.text ??= textFrom(a));
  return spoken === undefined ? text : `${text} "${spoken}"`;
}

/** The message a REVOKE protocol message takes back, when there is one. */
export function revokedTargetKey(raw: WAMessage): WAMessageKey | undefined {
  const proto_ = analyze(raw).content?.protocolMessage;
  if (proto_?.type !== proto.Message.ProtocolMessage.Type.REVOKE) return undefined;
  const key = proto_.key;
  return key?.id ? (key as WAMessageKey) : undefined;
}

/**
 * What a reader sees. searchMessages matches on this rather than on the bare
 * placeholder, so a transcript is findable by the words it puts on the screen.
 */
export function viewText(raw: WAMessage, transcript?: TranscriptRecord): string {
  const a = analyze(raw);
  const text = (a.text ??= textFrom(a));
  const spoken = spokenFrom(a, transcript);
  return spoken === undefined ? text : `${text} "${spoken}"`;
}

/** The reaction a message is, if it is one: what was reacted with, and to which message key. An empty text withdraws. */
export function reactionOf(raw: WAMessage): { text: string; targetKey: WAMessageKey } | undefined {
  const reaction = analyze(raw).content?.reactionMessage;
  if (!reaction?.key?.remoteJid) return undefined;
  return { text: reaction.text ?? "", targetKey: reaction.key as WAMessageKey };
}

export function mediaInfo(raw: WAMessage): { mime: string; size?: number; filename?: string } | undefined {
  return analyze(raw).media;
}

/**
 * The preview WhatsApp ships inside a photo, video or document message: a JPEG
 * of a few KB, there before any download. Enough to tell a receipt from a baby.
 */
export function thumbnailOf(raw: WAMessage): { mime: string; base64: string } | undefined {
  const content = analyze(raw).inner;
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
  return (contextInfo(raw)?.mentionedJid ?? []).filter(
    (jid): jid is string => typeof jid === "string" && jid.length > 0
  );
}

/** The author of the message this one quotes, when it is a reply. */
export function quotedSenderJid(raw: WAMessage): string | undefined {
  const context = contextInfo(raw);
  if (!context?.quotedMessage) return undefined;
  return context.participant ?? undefined;
}

function contextInfo(raw: WAMessage): proto.IContextInfo | undefined {
  return analyze(raw).context;
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
  /** The user's note on a canonical jid, if any. */
  noteFor?: (jid: string) => string | undefined;
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
  if (ctx.chatId.endsWith("@s.whatsapp.net")) return ctx.chatId;
  // Baileys sets `participant` to "" on a direct message that arrived under a
  // lid, and "" is not "absent": `??` would keep it and hand the message to us.
  const from = raw.key.participant || raw.participant || raw.key.remoteJid || "";
  return from ? ctx.canonical(from) : ctx.ownId;
}

export function phoneOf(jid: string): string | undefined {
  const [user = "", domain] = jid.split("@");
  return domain === "s.whatsapp.net" && /^\d+$/.test(user) ? user : undefined;
}

export function buildMessageView(raw: WAMessage, ctx: MessageViewContext): MessageView {
  const a = analyze(raw);
  const timestamp = messageTimestampMs(raw);
  const sender = senderJid(raw, ctx);
  const context = a.context;
  const quoted = context?.quotedMessage ? quotedView(context, ctx) : undefined;
  const event = a.event ? eventView(a.event, ctx) : undefined;
  const text = event?.text ?? (a.text ??= textFrom(a));
  const spoken = spokenFrom(a, ctx.transcript);

  const view: MessageView = {
    message_id: messageIdFor(raw.key, ctx.chatId),
    chat_id: ctx.chatId,
    from_me: Boolean(raw.key.fromMe),
    sender: {
      id: sender,
      name: ctx.nameFor(sender),
      ...(phoneOf(sender) ? { phone: phoneOf(sender) } : {}),
      ...(ctx.noteFor?.(sender) ? { note: ctx.noteFor(sender) } : {}),
    },
    type: a.type,
    text: spoken === undefined ? text : `${text} "${spoken}"`,
    timestamp: isoWithOffset(timestamp),
    age: formatAge(timestamp, ctx.now),
    has_media: a.media !== undefined,
    forwarded: Boolean(context?.isForwarded) || (protoNumber(context?.forwardingScore) ?? 0) > 0,
    edited: ctx.edited,
  };
  if (a.media) view.media = a.media;
  if (quoted) view.quoted = quoted;
  if (spoken !== undefined) view.transcript = spoken;
  if (a.call) {
    view.call = a.call.participants
      ? { ...a.call, participants: a.call.participants.map((jid) => ctx.canonical(jid)) }
      : a.call;
  }
  if (ctx.reactions.length > 0) {
    view.reactions = ctx.reactions.map((r) => ({ ...r, name: ctx.nameFor(ctx.canonical(r.sender)) }));
  }
  if (event) view.system = event.system;
  return view;
}

function eventParty(jid: string, ctx: MessageViewContext): EventParty {
  const id = ctx.canonical(jid);
  const phone = phoneOf(id);
  return { id, name: ctx.nameFor(id), ...(phone ? { phone } : {}) };
}

/** A target by name, with the number beside it unless the name already is the number. */
function partyLabel(party: EventParty): string {
  return party.phone && party.phone !== party.name ? `${party.name} (${party.phone})` : party.name;
}

/** The notice with names looked up: the structured event, and the line that says it. */
function eventView(event: GroupEvent, ctx: MessageViewContext): { system: SystemEvent; text: string } {
  const actor = event.fromMe ? eventParty(ctx.ownId, ctx) : event.actor ? eventParty(event.actor, ctx) : undefined;
  const targets = event.targets.map((jid) => eventParty(jid, ctx));
  const self = targets.length === 1 && targets[0]?.id === actor?.id;
  return {
    system: {
      action: event.spec.action,
      ...(actor ? { actor } : {}),
      targets,
      ...(event.value === undefined ? {} : { value: event.value }),
    },
    text: eventLine(event, actor?.name ?? "Someone", targets.map(partyLabel), self),
  };
}

function quotedView(
  context: proto.IContextInfo,
  ctx: MessageViewContext
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
