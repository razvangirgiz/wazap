/** Public shapes of the WhatsApp service: what the MCP tools and the CLI consume. */

import type { DraftPayload, DraftView } from "./drafts.js";
import type { ProviderName } from "./transcribe/index.js";

export type ConnectionStatus =
  | "not_linked"
  /** A pairing code has been issued and WhatsApp is waiting for it on the phone. */
  | "linking"
  | "connecting"
  | "connected"
  | "disconnected"
  | "logged_out"
  | "session_corrupt"
  | "auth_failure";

export type SyncState = "in_progress" | "done";

export type ChatType = "individual" | "group";

export type ChatFilter = "all" | "unread" | "groups" | "individual" | "archived";

/** The zod enum the tools expose derives from this, so the two cannot drift. */
export const MESSAGE_TYPES = [
  "text",
  "image",
  "video",
  "audio",
  "voice",
  "document",
  "sticker",
  "location",
  "contact",
  "poll",
  "reaction",
  "deleted",
  "view_once",
  "call",
  "system",
  "unknown",
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

export type CallKind = "voice" | "video";

export type CallDirection = "incoming" | "outgoing";

/** "unanswered" is the outgoing side of "missed": nobody picked up either way. */
export type CallOutcome = "answered" | "missed" | "rejected" | "unanswered";

export interface CallInfo {
  kind: CallKind;
  direction: CallDirection;
  outcome: CallOutcome;
  duration_seconds?: number;
  participants?: string[];
}

/** The code the user types into their phone, and how long it stays good for. */
export interface PairingInfo {
  code: string;
  phone_masked: string;
  expires_at: string;
}

export interface StatusInfo {
  status: ConnectionStatus;
  /** When the socket entered `status`. What /healthz calls a stall on. */
  status_since: string;
  sync: SyncState;
  account: { id: string; name: string; number: string } | null;
  last_message_received_at: string | null;
  reconnect_attempts: number;
  /** Contacts carrying a name from the phone's address book. Zero means it never arrived. */
  contacts_named: number;
  wazap_version: string;
  baileys_version: string;
  data_dir: string;
  read_only: boolean;
  rate_limit: number;
  last_error: string | null;
  /** Present only while `status` is "linking". */
  pairing?: PairingInfo;
  hint?: string;
}

export interface ChatSummary {
  chat_id: string;
  name: string;
  note?: string;
  type: ChatType;
  unread_count: number;
  last_message: { text: string; timestamp: string; from_me: boolean } | null;
  archived: boolean;
  pinned: boolean;
  muted_until: string | null;
  /** Groups only: we are no longer a participant. */
  left?: boolean;
}

export interface MessageSender {
  id: string;
  name: string;
  phone?: string;
}

export interface MessageView {
  message_id: string;
  chat_id: string;
  from_me: boolean;
  sender: MessageSender;
  type: MessageType;
  /** Never empty: media and system messages get a placeholder like "[sticker]". */
  text: string;
  timestamp: string;
  age: string;
  has_media: boolean;
  media?: { mime: string; size?: number; filename?: string };
  quoted?: { message_id: string; text: string; sender: string };
  call?: CallInfo;
  /** What a voice note or audio message says, once it has been transcribed. */
  transcript?: string;
  forwarded: boolean;
  reactions?: Array<{ emoji: string; sender: string }>;
  edited: boolean;
}

export interface RecentConversation {
  chat_id: string;
  chat_name: string;
  note?: string;
  type: ChatType;
  last_activity: string;
  messages: MessageView[];
}

/** What wait_for_messages is asked to watch for. */
export interface WaitOptions {
  timeoutMs: number;
  chatId?: string;
  /** Only messages that address the linked account: any direct message, or a group message that @-mentions it or replies to one of its own. */
  addressedToMe: boolean;
  cursor?: string;
}

export interface WaitResult {
  messages: MessageView[];
  /** Pass back on the next call to continue from here without a gap. */
  cursor: string;
  timed_out: boolean;
  /** The cursor came from another run of wazap and could not be honoured; the wait started from now. */
  cursor_reset: boolean;
}

/** A small JPEG of a photo: the one WhatsApp shipped in the message, or one made here from the photo. */
export interface Preview {
  message_id: string;
  mime: string;
  base64: string;
}

/** A conversation whose last word is theirs and reads as something asked of the user. */
export interface UnansweredChat {
  chat_id: string;
  name: string;
  type: ChatType;
  /** The message that asks; a voice note counts as an ask until it has been heard. */
  ask: MessageView;
  /** How many of their messages arrived after the user's last one. */
  messages_since_you: number;
  /** A WhatsApp Business account, whose asks are often automatic replies. */
  business: boolean;
  note?: string;
  waiting_since: string;
  age: string;
}

export interface SearchOptions {
  /** Epoch ms; only messages at or after it. */
  sinceMs?: number;
  /** Epoch ms; only messages at or before it. */
  untilMs?: number;
  /** "me", or a contact / chat id: only messages that person sent. */
  from?: string;
}

export interface HandledResult {
  chat_id: string;
  name: string;
  /** The ask that was open; the chat is off the waiting list until a newer one arrives. */
  ask_id: string | null;
  ask_text: string | null;
}

export interface ContactSummary {
  contact_id: string;
  name: string;
  /** What the user told wazap about this person; kept locally, never sent. */
  note?: string;
  number: string | null;
  is_my_contact: boolean;
  is_business: boolean;
}

export interface ContactDetails extends ContactSummary {
  about: string | null;
  profile_pic_url: string | null;
  is_blocked: boolean;
}

export interface GroupParticipantInfo {
  contact_id: string;
  name: string;
  is_admin: boolean;
}

export interface GroupInfo {
  chat_id: string;
  name: string;
  description: string | null;
  owner: string | null;
  created_at: string | null;
  participant_count: number;
  participants: GroupParticipantInfo[];
  announcement_only: boolean;
  i_am_admin: boolean;
  invite_link?: string;
}

export interface ParticipantResult {
  id: string;
  status: "ok" | "invite_needed" | "failed";
  reason?: string;
}

export interface SentMessage {
  message_id: string;
  chat_id: string;
  text: string;
  timestamp: string;
}

/** Who a draft or send is aimed at, after jid resolution. Groups have no number. */
export interface OutgoingTarget {
  chat_id: string;
  name: string;
  number?: string;
}

export interface MediaResult {
  path: string;
  mime: string;
  size: number;
  filename: string;
  /** Base64 of images small enough to inline in the tool result. */
  inline_base64: string | null;
}

export interface TranscribeResult {
  text: string;
  language?: string;
  duration_seconds?: number;
  provider: ProviderName;
  /** The transcript was already on hand, so no provider ran and nothing was billed. */
  cached: boolean;
}

export type ChatAction =
  | "archive"
  | "unarchive"
  | "pin"
  | "unpin"
  | "mute"
  | "unmute"
  | "mark_read"
  | "mark_unread";

export type GroupAction =
  | "add"
  | "remove"
  | "promote"
  | "demote"
  | "leave"
  | "set_subject"
  | "set_description"
  | "get_invite_link"
  | "revoke_invite_link";

export interface ChatActionResult {
  chat_id: string;
  action: ChatAction;
  applied: string;
}

export interface GroupActionResult {
  group_id: string;
  action: GroupAction;
  applied: string;
  participants?: ParticipantResult[];
  invite_link?: string;
}

export interface MediaSource {
  file_path?: string;
  url?: string;
}

/** Read results carry the sync state, so an agent knows the data may be partial. */
export interface Synced<T> {
  data: T;
  sync: SyncState;
}

export interface ContactSyncResult {
  requested: boolean;
  named_before: number;
  named_after: number;
}

/**
 * The surface the MCP tools and the CLI use. Declared here so tools.ts compiles
 * against the contract rather than the implementation.
 */
export interface WhatsAppApi {
  getStatus(): StatusInfo;
  link(phone: string): Promise<PairingInfo>;
  listChats(filter: ChatFilter, limit: number): Promise<Synced<ChatSummary[]>>;
  readMessages(chatId: string, limit: number, before?: string, types?: MessageType[]): Promise<Synced<MessageView[]>>;
  getRecentMessages(
    hours: number,
    filter: Exclude<ChatFilter, "archived">,
    includeSystem?: boolean,
    types?: MessageType[],
  ): Promise<Synced<RecentConversation[]>>;
  searchMessages(query: string, chatId: string | undefined, limit: number, opts?: SearchOptions): Promise<Synced<MessageView[]>>;
  getMessage(messageId: string): Promise<MessageView>;
  searchContacts(query: string, limit: number): Promise<ContactSummary[]>;
  getContact(contactId: string): Promise<ContactDetails>;
  syncContacts(): Promise<ContactSyncResult>;
  getGroupInfo(groupId: string): Promise<GroupInfo>;
  downloadMedia(messageId: string, saveTo?: string): Promise<MediaResult>;
  transcribeAudio(messageId: string, language?: string): Promise<TranscribeResult>;
  waitForMessages(opts: WaitOptions): Promise<WaitResult>;
  getStories(hours: number): Promise<Synced<MessageView[]>>;
  setContactNote(contactId: string, note: string): Promise<ContactSummary>;
  markHandled(chatId: string): Promise<HandledResult>;
  previews(messageIds: string[], max: number): Promise<Preview[]>;
  getUnanswered(minAgeHours: number, maxAgeHours: number, limit: number): Promise<Synced<UnansweredChat[]>>;
  draft(payload: DraftPayload): Promise<DraftView>;
  confirm(draftId: string): Promise<SentMessage>;
  sendMessage(chatId: string, text: string, replyTo?: string, mentionIds?: string[]): Promise<SentMessage>;
  sendMedia(
    chatId: string,
    source: MediaSource,
    opts: { caption?: string; asDocument: boolean; asVoice: boolean; asGif: boolean },
  ): Promise<SentMessage>;
  sendPoll(chatId: string, question: string, options: string[], multiSelect: boolean): Promise<SentMessage>;
  sendLocation(
    chatId: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string,
  ): Promise<SentMessage>;
  editMessage(messageId: string, text: string): Promise<SentMessage>;
  reactToMessage(messageId: string, emoji: string): Promise<{ message_id: string; emoji: string }>;
  forwardMessage(messageId: string, toChatId: string): Promise<SentMessage>;
  deleteMessage(messageId: string, forEveryone: boolean): Promise<{ message_id: string; for_everyone: boolean }>;
  manageChat(chatId: string, action: ChatAction, muteHours?: number): Promise<ChatActionResult>;
  createGroup(name: string, participantIds: string[]): Promise<{ chat_id: string; participants: ParticipantResult[] }>;
  manageGroup(
    groupId: string,
    action: GroupAction,
    participantIds?: string[],
    value?: string,
  ): Promise<GroupActionResult>;
}
