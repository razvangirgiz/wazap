/**
 * Public types for the WhatsApp wrapper. Kept separate so other modules
 * (agent.ts, inbox.ts, config.ts, tools.ts) import these instead of
 * whatsapp-web.js, decoupling the rest of the codebase from the transport.
 *
 * The `WaMessage` interface is the adapter contract: the Baileys-backed
 * service emits objects shaped like the whatsapp-web.js Message the rest of
 * the code already consumes, so agent.ts stays unchanged.
 */

export type WhatsAppStatus =
  | "starting"
  | "qr"
  | "authenticated"
  | "ready"
  | "disconnected"
  | "auth_failure";

export interface StatusInfo {
  status: WhatsAppStatus;
  lastError: string | null;
  account: { id: string; name: string; platform: string } | null;
}

export interface ChatSummary {
  chat_id: string;
  name: string;
  is_group: boolean;
  unread_count: number;
  archived: boolean;
  pinned: boolean;
  muted: boolean;
  last_activity: string | null;
  last_message: string | null;
}

export interface MessageSummary {
  id: string;
  chat_id: string;
  from_me: boolean;
  sender: string;
  body: string;
  type: string;
  has_media: boolean;
  has_quoted: boolean;
  timestamp: string;
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

export interface SentMessage {
  id: string;
  to: string;
  body: string;
  timestamp: string;
}

export interface MediaResult {
  path: string;
  filename: string;
  mimetype: string;
  size_bytes: number;
  base64: string | null;
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
  | "get_invite_link";

export interface WhatsAppServiceOpts {
  authPath?: string;
  qrFile?: string;
  label?: string;
  /**
   * Read-only connection: all message-sending and state mutations throw. Used
   * for a personal account so an accidental MCP call can never send
   * a message from the owner's personal number. Default false.
   */
  readOnly?: boolean;
  /**
   * Ask WhatsApp to sync fuller history on connect (and reconnect), so the
   * a nightly consumer's 24h window is robust even right after a restart that
   * empties the in-memory store. Default false.
   */
  syncFullHistory?: boolean;
  /**
   * Directory for the durable message journal. When set, every live content
   * message (incoming and own) is appended to a daily JSONL file, so the
   * read-only consumer's window survives restarts that wipe the in-memory store.
   * null/undefined = journaling off.
   */
  journalDir?: string;
  /**
   * File for the on-disk store snapshot (chat list + recent messages). When set,
   * the store survives restarts instead of starting empty. null = no persistence.
   */
  storeCacheFile?: string;
  /**
   * Directory for the per-chat history store. When set, messages received from
   * Baileys history sync (messaging-history.set) and live traffic (messages.upsert)
   * are appended to per-chat JSONL files and reloaded on the next startup, so
   * conversation history survives process restarts. null/undefined = disabled.
   */
  historyStoreDir?: string;
}

/** One chat's messages within a recent-window pull, read from the journal. */
export interface RecentConversation {
  chat_id: string;
  chat_name: string;
  is_group: boolean;
  last_activity: string;
  messages: Array<{
    timestamp: string;
    sender: string;
    from_me: boolean;
    body: string;
  }>;
}

/** Serialized id, whatsapp-web.js-compatible shape: `id._serialized` + `id.remote`. */
export interface WaMessageId {
  _serialized: string;
  remote: string;
  id: string;
  fromMe: boolean;
}

/** Minimal media payload, matching what `msg.downloadMedia()` used to return. */
export interface WaMedia {
  data: string; // base64
  mimetype: string;
  filename: string | null;
}

/**
 * Adapter shape consumed by agent.ts / whatsapp.ts internals. Mirrors the
 * subset of the whatsapp-web.js Message the codebase actually reads.
 */
export interface WaMessage {
  id: WaMessageId;
  from: string;
  to: string;
  author?: string;
  fromMe: boolean;
  body: string;
  type: string;
  timestamp: number;
  hasMedia: boolean;
  hasQuotedMsg: boolean;
  getChat(): Promise<WaChat>;
  downloadMedia(): Promise<WaMedia | undefined>;
  react(emoji: string): Promise<void>;
  forward(chat: WaChat): Promise<void>;
  delete(forEveryone: boolean): Promise<void>;
}

/** Adapter shape for a chat, mirroring the whatsapp-web.js Chat subset used. */
export interface WaChat {
  id: { _serialized: string; user: string };
  name: string;
  isGroup: boolean;
  getContact(): Promise<WaContact>;
}

/** Adapter shape for a contact, mirroring the whatsapp-web.js Contact subset used. */
export interface WaContact {
  id: { _serialized: string };
  isMe: boolean;
}
