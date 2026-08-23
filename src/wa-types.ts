/** Public shapes of the WhatsApp service: what the MCP tools and the CLI consume. */

import type { ProviderName } from "./transcribe/index.js";

export type ConnectionStatus =
  | "not_linked"
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

export interface StatusInfo {
  status: ConnectionStatus;
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
  hint?: string;
}

export interface ChatSummary {
  chat_id: string;
  name: string;
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
  type: ChatType;
  last_activity: string;
  messages: MessageView[];
}

export interface ContactSummary {
  contact_id: string;
  name: string;
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
  listChats(filter: ChatFilter, limit: number): Promise<Synced<ChatSummary[]>>;
  readMessages(chatId: string, limit: number, before?: string, types?: MessageType[]): Promise<Synced<MessageView[]>>;
  getRecentMessages(
    hours: number,
    filter: Exclude<ChatFilter, "archived">,
    includeSystem?: boolean,
    types?: MessageType[],
  ): Promise<Synced<RecentConversation[]>>;
  searchMessages(query: string, chatId: string | undefined, limit: number): Promise<Synced<MessageView[]>>;
  getMessage(messageId: string): Promise<MessageView>;
  searchContacts(query: string, limit: number): Promise<ContactSummary[]>;
  getContact(contactId: string): Promise<ContactDetails>;
  syncContacts(): Promise<ContactSyncResult>;
  getGroupInfo(groupId: string): Promise<GroupInfo>;
  downloadMedia(messageId: string, saveTo?: string): Promise<MediaResult>;
  transcribeAudio(messageId: string, language?: string): Promise<TranscribeResult>;
  sendMessage(chatId: string, text: string, replyTo?: string, mentionIds?: string[]): Promise<SentMessage>;
  sendMedia(
    chatId: string,
    source: MediaSource,
    opts: { caption?: string; asDocument: boolean; asVoice: boolean },
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
