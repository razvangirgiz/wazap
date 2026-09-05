export type ErrorCode =
  | "ACCOUNT_REQUIRED"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_MISMATCH"
  | "ACCOUNT_DUPLICATE"
  | "ACCOUNT_REGISTRY_ERROR"
  | "ACCOUNT_DISABLED"
  | "ACCOUNT_ACCESS_CHANGED"
  | "ARCHIVE_UNAVAILABLE"
  | "MEDIA_ACCESS_DENIED"
  | "SEND_OUTCOME_UNKNOWN"
  | "NOT_LINKED"
  | "ALREADY_LINKED"
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
  | "TRANSCRIBE_UNAVAILABLE"
  | "TRANSCRIBE_FAILED"
  | "TIMEOUT"
  | "SERVICE_ERROR"
  | "DRAFT_NOT_FOUND"
  | "DRAFT_EXPIRED"
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
  ACCOUNT_REQUIRED: "Call list_accounts and select account_id explicitly.",
  ACCOUNT_NOT_FOUND: "Unknown or inaccessible account. Call list_accounts.",
  ACCOUNT_MISMATCH: "This operation belongs to another account. Keep the original account or create a new profile.",
  ACCOUNT_DUPLICATE: "This WhatsApp identity is already registered; use its existing profile.",
  ACCOUNT_REGISTRY_ERROR: "Read the accounts diagnostic. Do not delete or reset data.",
  ACCOUNT_DISABLED: "The account is disabled. Enable it with wazap accounts enable before connecting or writing.",
  ACCOUNT_ACCESS_CHANGED: "Account access changed. Reinitialize the MCP connection and begin pagination again.",
  ARCHIVE_UNAVAILABLE: "Archive unavailable. Read the diagnostic; do not reset or delete data.",
  MEDIA_ACCESS_DENIED: "This source is outside the permitted export directory or public network.",
  SEND_OUTCOME_UNKNOWN: "Sending may have succeeded. Do not resend. Check the conversation and confirm with the user.",
  NOT_LINKED: "No WhatsApp account is linked. Tell the user to run `npx wazap-mcp login`; do not retry.",
  ALREADY_LINKED: "The account is linked; call get_status.",
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
  READ_ONLY: "This client is read-only. The user can enable writes with wazap config writes on; --read-only remains an absolute restriction.",
  RATE_LIMITED: "Too many writes too fast. Wait the number of seconds in the fix, then retry once.",
  TRANSCRIBE_UNAVAILABLE:
    "Transcription is off, or its binaries or model are missing. Tell the user to run the command in the fix; do not retry.",
  TRANSCRIBE_FAILED: "The transcription provider ran and failed. Read the message; retry once at most.",
  TIMEOUT: "WhatsApp did not answer in time. Retry once; if it fails again, call get_status.",
  SERVICE_ERROR:
    "wazap's own background service could not be managed. This is a machine problem, not a WhatsApp one: read the fix and tell the user.",
  DRAFT_NOT_FOUND:
    "That draft_id is unknown for this client or account. Check its source account and exact ID before preparing a new draft and asking for approval.",
  DRAFT_EXPIRED:
    "The draft expired (15 minutes). Call the send tool again to draft, show the new preview, then confirm_send.",
  WHATSAPP_ERROR: "WhatsApp rejected the operation. Read the message; do not blindly retry.",
};

/** Any thrown value as a WazapError, so no tool ever surfaces a raw error. */
export function asWazapError(err: unknown): WazapError {
  if (err instanceof WazapError) return err;
  return new WazapError("WHATSAPP_ERROR", err instanceof Error ? err.message : String(err));
}
