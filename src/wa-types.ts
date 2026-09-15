/** Public shapes of the WhatsApp service: what the MCP tools and the CLI consume. */

import type { DraftPayload, DraftView } from "./drafts.js";
import type { RecallStatus } from "./recall/index.js";
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
  "event",
  "invite",
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
  /** Registry id (`default`, `work`, …), not the WhatsApp jid. */
  account_id: string;
  account_name: string;
  enabled: boolean;
  /**
   * Account writes policy (`!read_only`). `get_status` overwrites this key with
   * whether the current MCP session registered write tools.
   */
  write_tools: boolean;
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
  /** W1 outbound webhook: on/off, whether url+secret are present, delivery `last_error`. */
  webhook: WebhookInfo;
  /** Local semantic recall: off, or how far the index is from caught-up. */
  recall: RecallStatus;
  /** Present only while `status` is "linking". */
  pairing?: PairingInfo;
  hint?: string;
}

/** One row of `get_status.accounts` / `list_accounts`. Policy `write_tools`, not the session bit. */
export interface ListedAccount {
  id: string;
  name: string;
  status: ConnectionStatus | "disabled";
  phone_masked: string | null;
  owner_name: string | null;
  write_tools: boolean;
  enabled: boolean;
}

export interface WebhookInfo {
  enabled: boolean;
  valid: boolean;
  last_error: string | null;
  /** Only while the webhook is on and valid: what this server delivered since it started. */
  delivery?: WebhookDelivery;
}

/** Events, not POSTs: a retried event that finally fails is one `failed`. */
export interface WebhookDelivery {
  delivered: number;
  /** Refused with a 4xx, or still failing once the retries ran out. */
  failed: number;
  /** Turned away by a full backlog, so never posted. */
  dropped: number;
  /** Failed events since the last delivery; zero once one gets through. */
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure: string | null;
  last_dropped_at: string | null;
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
  /** The user's own note on this person, when there is one. */
  note?: string;
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
  /** One per person who reacted; `name` resolves `sender` the way a message's sender is. */
  reactions?: Array<{ emoji: string; sender: string; name: string }>;
  /** Who the message @-mentions, each once, resolved the way a reaction's sender is. */
  mentions?: Array<{ id: string; name: string }>;
  /** A group notice spelled out: who made which change, to whom. */
  system?: SystemEvent;
  /** On a poll: its options, each with who chose it. */
  poll?: PollResults;
  /** On an event: who answered going, maybe and not going. */
  event_responses?: EventResponses;
  edited: boolean;
  /** On the account's own messages: how far it got. Absent while WhatsApp has confirmed nothing. */
  delivery?: Delivery;
}

export type DeliveryStatus = "error" | "pending" | "sent" | "delivered" | "read" | "played";

export interface Delivery {
  /** In a group, the furthest any one member got. */
  status: DeliveryStatus;
  /** Group members who read it, earliest first. */
  read_by?: Receiver[];
  /** Group members it reached who have not read it yet, earliest first. */
  delivered_to?: Receiver[];
}

/** A group member a message reached, resolved the way a reaction's sender is; `at` in timestamp's format. */
export interface Receiver {
  id: string;
  name: string;
  at: string;
}

/** Someone who voted or answered, resolved the way a reaction's sender is. */
export interface Voter {
  id: string;
  name: string;
}

export interface PollResults {
  question: string;
  options: Array<{ name: string; votes: number; voters: Voter[] }>;
  /** How many people voted; with multiple answers allowed, fewer than the votes. */
  voters: number;
}

export interface EventResponses {
  going: Voter[];
  maybe: Voter[];
  not_going: Voter[];
}

/** Someone a group notice names, resolved the way a sender is. */
export interface EventParty {
  id: string;
  name: string;
  phone?: string;
}

/** The change behind a group notice, in manage_group's words where it has one. */
export type SystemEventAction =
  | "create"
  | "add"
  | "remove"
  | "promote"
  | "demote"
  | "leave"
  | "join_via_link"
  | "change_number"
  | "set_subject"
  | "set_description"
  | "set_picture"
  | "reset_invite_link"
  | "set_announcement_only"
  | "set_info_locked"
  | "set_add_mode"
  | "set_join_approval"
  | "set_member_label"
  | "set_disappearing"
  | "join_request"
  | "pin_message"
  | "unpin_message"
  | "keep_message"
  | "unkeep_message"
  | "share_history";

export interface SystemEvent {
  action: SystemEventAction;
  /** Absent when WhatsApp did not say who made the change. */
  actor?: EventParty;
  /** Whom the change was made to; empty for a change to the group itself. */
  targets: EventParty[];
  /**
   * The new subject or description, the new state of a setting, the message_id
   * a pin or a keep points at, or how many messages a shared history holds.
   */
  value?: string;
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

/** One recall hit: the message plus the score it ranked by. */
export interface RecallHit {
  /** Cosine similarity × recency decay; hits are sorted by it, so fresh matches win. */
  score: number;
  /** Raw cosine similarity before the recency decay. */
  similarity: number;
  message: MessageView;
  /** The message left the live store; text and date come from the index itself. */
  from_index: boolean;
}

export interface RecallAnswer {
  hits: RecallHit[];
  /** The index at query time; "indexing" means more matches may still land. */
  index: RecallStatus;
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
  /** Local labels the agent filed this person under ("client", "echipa"); searchable. */
  tags?: string[];
  /** Local key-value details ("role": "contabil"); searchable. */
  fields?: Record<string, string>;
  number: string | null;
  is_my_contact: boolean;
  is_business: boolean;
}

/** What updateContactDetails applies; all four are optional but at least one must do something. */
export interface ContactDetailsEdit {
  addTags?: string[];
  removeTags?: string[];
  /** Keys set to the given value; an empty value deletes the key. */
  fields?: Record<string, string>;
  removeFields?: string[];
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
  /** Only admins may change the name, description and photo. */
  info_locked: boolean;
  /** Who may add members. */
  member_add_mode: "admins" | "all";
  /** New members wait for an admin to approve them. */
  join_approval: boolean;
  /** How long messages last before they disappear; 0 when disappearing messages are off. */
  disappearing_seconds: number;
  /** Present when the group is a community, or belongs to one. */
  community?: { is_community: boolean; parent_group_id: string | null };
  invite_link?: string;
}

/** Someone waiting for an admin to let them into a group. */
export interface JoinRequest {
  id: string;
  name: string;
  requested_at: string | null;
  /** How they asked, in WhatsApp's words ("invite_link", "linked_group_join", "non_admin_add"), when it says. */
  method: string | null;
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
  | "mark_unread"
  | "pin_message"
  | "unpin_message"
  | "star_message"
  | "unstar_message"
  | "clear"
  | "delete"
  | "block"
  | "unblock";

/** What some chat actions need beside the chat: the hours of a mute or a pin, the message a pin or a star is on. */
export interface ChatActionOptions {
  muteHours?: number;
  messageId?: string;
  /** How long a pinned message stays pinned: 24, 168 or 720 hours, the choices WhatsApp offers. */
  pinHours?: number;
}

export type GroupAction =
  | "add"
  | "remove"
  | "promote"
  | "demote"
  | "leave"
  | "set_subject"
  | "set_description"
  | "set_picture"
  | "remove_picture"
  | "get_invite_link"
  | "revoke_invite_link"
  | "list_join_requests"
  | "approve_join_requests"
  | "reject_join_requests"
  | "set_announcement_only"
  | "set_info_locked"
  | "set_add_mode"
  | "set_join_approval"
  | "set_disappearing";

export interface ChatActionResult {
  chat_id: string;
  action: ChatAction;
  applied: string;
  /** On the actions that take a message: the message acted on. */
  message_id?: string;
}

/** A group invite looked at, or acted on. The invite code itself is never part of it. */
export interface JoinGroupResult {
  /** "preview": nothing joined yet; "joined": the account is in; "pending_approval": an admin must let it in. */
  status: "preview" | "joined" | "pending_approval";
  group_id: string | null;
  name: string | null;
  description: string | null;
  participant_count: number | null;
  /** New members wait for an admin to approve them; null when WhatsApp did not say. */
  join_approval: boolean | null;
}

export interface GroupActionResult {
  group_id: string;
  action: GroupAction;
  applied: string;
  participants?: ParticipantResult[];
  invite_link?: string;
  /** After set_picture: the new photo's URL, or null while WhatsApp has not published one. */
  profile_pic_url?: string | null;
  /** After list_join_requests: who is waiting, as WhatsApp listed them. */
  join_requests?: JoinRequest[];
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
  hasChat(jid: string): boolean;
  hasMessage(id: string): boolean;
  hasDraft(id: string): boolean;
  link(phone: string): Promise<PairingInfo>;
  listChats(filter: ChatFilter, limit: number): Promise<Synced<ChatSummary[]>>;
  readMessages(chatId: string, limit: number, before?: string, types?: MessageType[]): Promise<Synced<MessageView[]>>;
  getRecentMessages(
    hours: number,
    filter: Exclude<ChatFilter, "archived">,
    includeSystem?: boolean,
    types?: MessageType[]
  ): Promise<Synced<RecentConversation[]>>;
  searchMessages(
    query: string,
    chatId: string | undefined,
    limit: number,
    opts?: SearchOptions
  ): Promise<Synced<MessageView[]>>;
  recall(
    query: string,
    chatId: string | undefined,
    limit: number,
    opts?: SearchOptions
  ): Promise<Synced<RecallAnswer>>;
  getMessage(messageId: string): Promise<MessageView>;
  searchContacts(query: string, limit: number, opts?: { tag?: string }): Promise<ContactSummary[]>;
  getContact(contactId: string): Promise<ContactDetails>;
  syncContacts(): Promise<ContactSyncResult>;
  updateContactDetails(contactId: string, edit: ContactDetailsEdit): Promise<ContactSummary>;
  saveContact(
    contactId: string,
    name: string,
    opts?: { firstName?: string; saveOnPhone?: boolean }
  ): Promise<ContactSummary>;
  removeContact(contactId: string): Promise<ContactSummary>;
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
    opts: { caption?: string; asDocument: boolean; asVoice: boolean; asGif: boolean }
  ): Promise<SentMessage>;
  sendPoll(chatId: string, question: string, options: string[], multiSelect: boolean): Promise<SentMessage>;
  sendLocation(
    chatId: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string
  ): Promise<SentMessage>;
  editMessage(messageId: string, text: string): Promise<SentMessage>;
  reactToMessage(messageId: string, emoji: string): Promise<{ message_id: string; emoji: string }>;
  forwardMessage(messageId: string, toChatId: string): Promise<SentMessage>;
  deleteMessage(messageId: string, forEveryone: boolean): Promise<{ message_id: string; for_everyone: boolean }>;
  setOwnProfilePicture(source: MediaSource): Promise<{ profile_pic_url: string | null }>;
  manageChat(chatId: string, action: ChatAction, opts?: ChatActionOptions): Promise<ChatActionResult>;
  createGroup(name: string, participantIds: string[]): Promise<{ chat_id: string; participants: ParticipantResult[] }>;
  joinGroup(opts: { invite?: string; messageId?: string; confirm: boolean }): Promise<JoinGroupResult>;
  manageGroup(
    groupId: string,
    action: GroupAction,
    participantIds?: string[],
    value?: string,
    source?: MediaSource
  ): Promise<GroupActionResult>;
}
