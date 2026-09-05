import { z } from "zod";

const id = z.string().min(1);
const origin = { account_id: id.optional(), account_name: z.string().optional() };
const row = (shape: z.ZodRawShape) => z.object({ ...origin, ...shape }).passthrough();
const message = row({ message_id: id, chat_id: id, text: z.string(), timestamp: z.string() });
const chat = row({ chat_id: id });
const contact = row({ contact_id: id, name: z.string() });
const receipt = { message_id: id, chat_id: id, text: z.string(), timestamp: z.string() };
const draft = {
  status: z.literal("draft"), draft_id: id,
  to: z.object({ chat_id: id, name: z.string() }).passthrough(),
  preview: z.string(), expires_at: z.string(),
  kind: z.enum(["text", "media", "poll", "location", "forward"]),
};
const page = {
  sync: z.enum(["in_progress", "done", "partial"]).optional(),
  coverage: z.object({ source: z.string() }).passthrough().optional(),
  accounts: z.array(row({ account_id: id })).optional(),
  partial: z.boolean().optional(),
};
const count = z.number().int().nonnegative();

/** Stable result fields; passthrough retains existing and future diagnostic metadata. */
const shapes: Record<string, z.ZodRawShape> = {
  learn: { guide: z.string() },
  list_accounts: { accounts: z.array(row({ account_id: id, account_name: z.string() })) },
  get_status: { status: z.string() },
  link_account: { code: id, phone_masked: z.string(), expires_at: z.string(), next: z.string() },
  list_chats: { ...page, count, chats: z.array(chat) },
  read_messages: { ...page, count, messages: z.array(message), has_more_local: z.boolean().optional(), history_fetch: z.enum(["not_requested", "received", "timed_out", "unavailable"]).optional() },
  search_messages: { ...page, count, messages: z.array(message), next_before: z.string().nullable().optional() },
  get_recent_messages: { ...page, conversation_count: count, conversations: z.array(chat), next_cursor: z.string().nullable().optional() },
  get_unanswered: { ...page, count, chats: z.array(chat) },
  get_stories: { ...page, count, stories: z.array(message) },
  get_message: receipt,
  search_contacts: { count, contacts: z.array(contact) },
  get_contact: { contact_id: id, name: z.string() },
  set_contact_note: { contact_id: id, name: z.string() },
  mark_handled: { chat_id: id, ask_id: z.string().nullable() },
  wait_for_messages: { count, messages: z.array(message), cursor: z.string(), timed_out: z.boolean(), cursor_reset: z.boolean() },
  sync_contacts: { named_before: count, named_after: count },
  get_group_info: { chat_id: id, participant_count: count, participants: z.array(contact) },
  download_media: { path: z.string(), mime: z.string(), size: count },
  transcribe_audio: { text: z.string(), provider: z.string(), cached: z.boolean() },
  send_message: draft, send_media: draft, send_poll: draft, send_location: draft, forward_message: draft,
  confirm_send: receipt, edit_message: receipt,
  react_to_message: { message_id: id, emoji: z.string() },
  delete_message: { message_id: id, for_everyone: z.boolean() },
  manage_chat: { applied: z.string() },
  create_group: { chat_id: id, participants: z.array(z.object({ id, status: z.enum(["ok", "invite_needed", "failed"]) }).passthrough()) },
  manage_group: { applied: z.string() },
};

export function toolOutputSchema(name: string) {
  const shape = shapes[name];
  if (!shape) throw new Error(`Missing output schema for ${name}`);
  return row(shape);
}
