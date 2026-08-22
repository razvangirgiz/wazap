export type ErrorCode =
  | "NOT_LINKED"
  | "SESSION_EXPIRED"
  | "SESSION_CORRUPT"
  | "NOT_CONNECTED"
  | "SYNC_IN_PROGRESS"
  | "INVALID_PHONE"
  | "INVALID_ID"
  | "NOT_ON_WHATSAPP"
  | "CHAT_NOT_FOUND"
  | "MESSAGE_NOT_FOUND"
  | "CONTACT_NOT_FOUND"
  | "GROUP_NOT_FOUND"
  | "NOT_A_PARTICIPANT"
  | "NOT_ADMIN"
  | "GROUP_ANNOUNCEMENT_ONLY"
  | "MEDIA_UNAVAILABLE"
  | "FILE_NOT_FOUND"
  | "FILE_TOO_LARGE"
  | "URL_FETCH_FAILED"
  | "TEXT_TOO_LONG"
  | "EDIT_WINDOW_EXPIRED"
  | "RETRACT_WINDOW_EXPIRED"
  | "NOT_OWN_MESSAGE"
  | "READ_ONLY"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "WHATSAPP_ERROR";

export class WazapError extends Error {
  readonly code: ErrorCode;
  readonly fix?: string;

  constructor(code: ErrorCode, message: string, fix?: string) {
    super(message);
    this.name = "WazapError";
    this.code = code;
    this.fix = fix;
  }
}

export const RELINK_FIX = "Run `npx wazap-mcp login`";
export const RESET_FIX = "Run `npx wazap-mcp logout` then `npx wazap-mcp login`";

/** What an agent should do about each code. Rendered by the `learn` tool. */
export const ERROR_GUIDE: Record<ErrorCode, string> = {
  NOT_LINKED: "No WhatsApp account is linked. Tell the user to run `npx wazap-mcp login`; do not retry.",
  SESSION_EXPIRED: "The account was unlinked from the phone. Tell the user to run `npx wazap-mcp login`; do not retry.",
  SESSION_CORRUPT: "Stored credentials are unreadable. Tell the user to run `npx wazap-mcp logout` then `npx wazap-mcp login`.",
  NOT_CONNECTED: "The socket is still connecting or reconnecting. Call get_status, wait, retry once.",
  SYNC_IN_PROGRESS: "History sync has not finished. Retry in a few seconds; earlier messages may be missing until then.",
  INVALID_PHONE: "The number is not in international format. Ask the user for a number with a country code, e.g. +15550100.",
  INVALID_ID: "The id is not a WhatsApp chat, contact or group id. Use an id exactly as returned by another tool.",
  NOT_ON_WHATSAPP: "That number has no WhatsApp account. Do not retry; confirm the number with the user.",
  CHAT_NOT_FOUND: "No such chat is known. Call list_chats or search_contacts to get a valid chat_id.",
  MESSAGE_NOT_FOUND: "No such message is loaded. Use a message_id from read_messages or search_messages.",
  CONTACT_NOT_FOUND: "No such contact is known. Call search_contacts first.",
  GROUP_NOT_FOUND: "No such group is known, or the id is not a group id (it must end in @g.us).",
  NOT_A_PARTICIPANT: "The linked account is not in that group. Do not retry.",
  NOT_ADMIN: "The linked account is not an admin of that group, so this action is refused. Do not retry.",
  GROUP_ANNOUNCEMENT_ONLY: "Only admins may post in that group. Do not retry.",
  MEDIA_UNAVAILABLE: "The media expired on WhatsApp's servers or was never synced. Do not retry; ask the sender to resend.",
  FILE_NOT_FOUND: "The local path does not exist on the machine running wazap. Check the path with the user.",
  FILE_TOO_LARGE: "The file exceeds WhatsApp's 100 MB limit. Send a smaller file.",
  URL_FETCH_FAILED: "The URL could not be fetched. Check it, or download the file first and pass file_path.",
  TEXT_TOO_LONG: "The text exceeds WhatsApp's limit. Split it into several messages.",
  EDIT_WINDOW_EXPIRED: "WhatsApp only allows editing within 15 minutes of sending. Send a correction instead.",
  RETRACT_WINDOW_EXPIRED: "WhatsApp only allows deleting for everyone within 2 days. Do not retry.",
  NOT_OWN_MESSAGE: "This action only works on messages the linked account sent. Do not retry.",
  READ_ONLY: "wazap runs read-only, so writes are refused. Tell the user to restart without WAZAP_READ_ONLY.",
  RATE_LIMITED: "Too many writes too fast. Wait the number of seconds in the fix, then retry once.",
  TIMEOUT: "WhatsApp did not answer in time. Retry once; if it fails again, call get_status.",
  WHATSAPP_ERROR: "WhatsApp rejected the operation. Read the message; do not blindly retry.",
};

/** Any thrown value as a WazapError, so no tool ever surfaces a raw error. */
export function asWazapError(err: unknown): WazapError {
  if (err instanceof WazapError) return err;
  return new WazapError("WHATSAPP_ERROR", err instanceof Error ? err.message : String(err));
}
