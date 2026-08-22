import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asWazapError, ERROR_GUIDE, type WazapError } from "./errors.js";
import type { RateLimiter } from "./ratelimit.js";
import type {
  ChatSummary,
  ContactSummary,
  MessageView,
  RecentConversation,
  Synced,
  WhatsAppApi,
} from "./wa-types.js";

type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

interface ToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

type ToolArgs = Record<string, unknown>;

interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  write: boolean;
  destructive?: boolean;
  handler: (args: ToolArgs, wa: WhatsAppApi) => Promise<ToolResult>;
}

function tool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  schema: S;
  write: boolean;
  destructive?: boolean;
  handler: (args: z.infer<z.ZodObject<S>>, wa: WhatsAppApi) => Promise<ToolResult>;
}): ToolDef {
  return { ...def, handler: def.handler as (args: ToolArgs, wa: WhatsAppApi) => Promise<ToolResult> };
}

function ok(text: string, structured: Record<string, unknown>, extra: ContentBlock[] = []): ToolResult {
  return { content: [{ type: "text", text }, ...extra], structuredContent: structured };
}

function synced<T>(result: Synced<T>, rest: Record<string, unknown>): Record<string, unknown> {
  return { ...rest, sync: result.sync };
}

export function toolError(err: WazapError): ToolResult {
  const payload: Record<string, unknown> = { error: err.code, message: err.message };
  if (err.fix) payload.fix = err.fix;
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}

const READ_ONLY_HINTS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const WRITE_HINTS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const chatId = z
  .string()
  .min(1)
  .describe('Chat id as returned by another tool ("<digits>@s.whatsapp.net" or "<id>@g.us"), or a phone number in international format');

const messageId = z
  .string()
  .min(5)
  .describe('Message id from read_messages / search_messages / get_message, e.g. "false_4072...@s.whatsapp.net_3EB0..."');

const GUIDE = `# wazap — WhatsApp for your AI agent

Read/write access to the user's linked WhatsApp account: chats, messages, media,
contacts and groups. Call get_status first if anything looks wrong.

## Identifiers
- chat_id — individual: \`<digits>@s.whatsapp.net\`; group: \`<id>@g.us\`. A phone
  number in international format (+40722123456 or 40722123456) also works. Pass
  ids back exactly as a tool returned them.
- message_id — the full id from read_messages / search_messages. Needed for
  get_message, download_media, react_to_message, edit_message, forward_message,
  delete_message, and the reply_to of send_message.

## Workflows
- Catch up: get_recent_messages(hours) for everything, or list_chats(filter:"unread")
  then read_messages(chat_id).
- Go back further: read_messages(chat_id, before: <oldest message_id you have>).
- Find a person: search_contacts → get_contact.
- Find something said: search_messages(query[, chat_id]).
- Send: send_message / send_media / send_poll / send_location. These are REAL
  messages from the user's own account and there is no undo. Confirm the
  recipient and the wording with the user before sending anything sensitive.
- Media: a message with has_media=true → download_media(message_id).
- Groups: get_group_info before manage_group; most actions need admin rights.

## Message shape
Every message has non-empty \`text\`: media and system messages carry a
placeholder like "[image] caption", "[voice message]", "[deleted]", "[poll] question".
\`timestamp\` is ISO 8601 with the machine's UTC offset, \`age\` is human-readable.

## Errors
Every failure returns \`{ error, message, fix }\`. What to do per code:
${(Object.keys(ERROR_GUIDE) as Array<keyof typeof ERROR_GUIDE>).map((code) => `- **${code}** — ${ERROR_GUIDE[code]}`).join("\n")}
`;

const TOOLS: readonly ToolDef[] = [
  tool({
    name: "learn",
    title: "Learn how to use the WhatsApp tools",
    description: `Read this FIRST, before any other WhatsApp tool. Returns the guide to the tools,
the id formats, the recommended workflows, the message shape and every error
code with what to do about it. Takes no arguments and never touches WhatsApp.`,
    schema: {},
    write: false,
    handler: async () => ok(GUIDE, { guide: GUIDE }),
  }),

  tool({
    name: "get_status",
    title: "Get the WhatsApp connection status",
    description: `Check the session: connection status ("connected" means the tools work,
"not_linked" means the user must run \`npx wazap login\`), whether the initial
history sync has finished, which account is linked, when a message last arrived,
and the versions and data directory in use.

Call this whenever another tool reports NOT_CONNECTED, NOT_LINKED or
SYNC_IN_PROGRESS, or to confirm which account you are about to send from.`,
    schema: {},
    write: false,
    handler: async (_args, wa) => {
      const s = wa.getStatus();
      const account = s.account ? `${s.account.name || "(no name)"} (${s.account.number})` : "none";
      const text = [
        `# WhatsApp: ${s.status} (sync: ${s.sync})`,
        `- **account**: ${account}`,
        `- **last message received**: ${s.last_message_received_at ?? "never"}`,
        `- **data dir**: ${s.data_dir} · **read-only**: ${s.read_only} · **rate limit**: ${s.rate_limit}/min`,
        `- **versions**: wazap ${s.wazap_version}, baileys ${s.baileys_version}`,
        s.last_error ? `- **last error**: ${s.last_error}` : null,
        s.hint ? `- **hint**: ${s.hint}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
      return ok(text, s as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "list_chats",
    title: "List WhatsApp chats",
    description: `List conversations, most recently active first. Use it to discover the chat_id
values the other tools need.

Each chat has: chat_id, name, type, unread_count, last_message {text, timestamp,
from_me}, archived, pinned, muted_until, and left (groups you are no longer in).`,
    schema: {
      filter: z
        .enum(["all", "unread", "groups", "individual", "archived"])
        .default("all")
        .describe('Which chats to list; "all" (default) excludes archived ones'),
      limit: z.number().int().min(1).max(100).default(20).describe("Maximum number of chats (1-100)"),
    },
    write: false,
    handler: async ({ filter, limit }, wa) => {
      const result = await wa.listChats(filter, limit);
      return ok(renderChats(result.data, filter), synced(result, { filter, count: result.data.length, chats: result.data }));
    },
  }),

  tool({
    name: "read_messages",
    title: "Read messages from a WhatsApp chat",
    description: `Read messages from one chat, oldest to newest.

Without \`before\` you get the most recent messages. Pass \`before\` (the oldest
message_id you already have) to page further back; wazap asks the phone for
older history when the local store runs out, which takes a few seconds.`,
    schema: {
      chat_id: chatId,
      limit: z.number().int().min(1).max(200).default(20).describe("Maximum number of messages (1-200)"),
      before: messageId.optional().describe("Return the messages immediately older than this message_id"),
    },
    write: false,
    handler: async ({ chat_id, limit, before }, wa) => {
      const result = await wa.readMessages(chat_id, limit, before);
      return ok(
        renderMessages(`Messages in ${chat_id}`, result.data),
        synced(result, { chat_id, count: result.data.length, messages: result.data }),
      );
    },
  }),

  tool({
    name: "get_recent_messages",
    title: "Get every WhatsApp conversation from the last N hours",
    description: `Everything that happened recently, grouped by chat. This is the catch-up tool:
one call instead of list_chats plus a read_messages per chat.`,
    schema: {
      hours: z.number().int().min(1).max(168).default(24).describe("Look-back window in hours (1-168)"),
      filter: z
        .enum(["all", "unread", "groups", "individual"])
        .default("all")
        .describe("Restrict to unread chats, groups, or one-to-one chats"),
    },
    write: false,
    handler: async ({ hours, filter }, wa) => {
      const result = await wa.getRecentMessages(hours, filter);
      const messageCount = result.data.reduce((n, c) => n + c.messages.length, 0);
      return ok(
        renderConversations(result.data, hours),
        synced(result, {
          hours,
          filter,
          conversation_count: result.data.length,
          message_count: messageCount,
          conversations: result.data,
        }),
      );
    },
  }),

  tool({
    name: "search_messages",
    title: "Search WhatsApp messages",
    description: `Case-insensitive text search over the messages wazap holds locally — all chats,
or one chat. It cannot reach messages the phone never synced to this device.`,
    schema: {
      query: z.string().min(1).describe("Text to search for"),
      chat_id: chatId.optional().describe("Restrict the search to this chat"),
      limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of results (1-50)"),
    },
    write: false,
    handler: async ({ query, chat_id, limit }, wa) => {
      const result = await wa.searchMessages(query, chat_id, limit);
      return ok(
        renderMessages(`Search results for "${query}"`, result.data),
        synced(result, { query, chat_id: chat_id ?? null, count: result.data.length, messages: result.data }),
      );
    },
  }),

  tool({
    name: "get_message",
    title: "Get one WhatsApp message in full",
    description: `The complete message behind a message_id, including the quoted message it
replies to, its reactions, and its media metadata. Use it after search_messages
or read_messages when you need the context around a single message.`,
    schema: { message_id: messageId },
    write: false,
    handler: async ({ message_id }, wa) => {
      const message = await wa.getMessage(message_id);
      return ok(renderMessages("Message", [message]), message as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "search_contacts",
    title: "Search WhatsApp contacts",
    description: `Find contacts by name or phone number (substring match on the name, digit match
on the number). Returns contact_id values usable as chat_id.`,
    schema: {
      query: z.string().min(2).describe("Name fragment or phone number (at least 2 characters)"),
      limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of results (1-50)"),
    },
    write: false,
    handler: async ({ query, limit }, wa) => {
      const contacts = await wa.searchContacts(query, limit);
      return ok(renderContacts(query, contacts), { query, count: contacts.length, contacts });
    },
  }),

  tool({
    name: "get_contact",
    title: "Get WhatsApp contact details",
    description: `Full details for one contact: name, number, about text, profile picture URL,
whether they are a saved contact, a business, or blocked.`,
    schema: {
      contact_id: chatId.describe('Contact id from search_contacts / list_chats, or a phone number'),
    },
    write: false,
    handler: async ({ contact_id }, wa) => {
      const c = await wa.getContact(contact_id);
      const text = [
        `# ${c.name}`,
        `- **contact_id**: \`${c.contact_id}\``,
        c.number ? `- **number**: ${c.number}` : null,
        c.about ? `- **about**: ${c.about}` : null,
        c.profile_pic_url ? `- **profile picture**: ${c.profile_pic_url}` : null,
        `- **saved**: ${c.is_my_contact} · **business**: ${c.is_business} · **blocked**: ${c.is_blocked}`,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
      return ok(text, c as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "get_group_info",
    title: "Get WhatsApp group info",
    description: `Details of a group: name, description, owner, creation date, whether only admins
may post, whether the linked account is an admin, and the participant list (up
to 500; participant_count is always the true total). The invite link is included
only when the linked account is an admin.

Call this before manage_group: most group actions need admin rights.`,
    schema: { group_id: chatId.describe('Group chat id ("<id>@g.us")') },
    write: false,
    handler: async ({ group_id }, wa) => {
      const info = await wa.getGroupInfo(group_id);
      const text = [
        `# ${info.name} (${info.participant_count} participants)`,
        `- **chat_id**: \`${info.chat_id}\``,
        info.description ? `- **description**: ${info.description}` : null,
        info.owner ? `- **owner**: ${info.owner}` : null,
        info.created_at ? `- **created**: ${info.created_at}` : null,
        `- **admins only can post**: ${info.announcement_only} · **you are admin**: ${info.i_am_admin}`,
        info.invite_link ? `- **invite link**: ${info.invite_link}` : null,
        "",
        "## Participants",
        ...info.participants.map((p) => `- ${p.name}${p.is_admin ? " (admin)" : ""} — \`${p.contact_id}\``),
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
      return ok(text, info as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "download_media",
    title: "Download media from a WhatsApp message",
    description: `Download the photo/video/audio/document attached to a message and save it to
disk on the machine running wazap. Images of 1 MB or less are also returned
inline so you can look at them.

Fails with MEDIA_UNAVAILABLE when WhatsApp has expired the file.`,
    schema: {
      message_id: messageId.describe("A message with has_media=true"),
      save_to: z.string().min(1).optional().describe("Absolute directory to save into (default: <data-dir>/media)"),
    },
    write: false,
    handler: async ({ message_id, save_to }, wa) => {
      const media = await wa.downloadMedia(message_id, save_to);
      const { inline_base64, ...structured } = media;
      const extra: ContentBlock[] = inline_base64
        ? [{ type: "image", data: inline_base64, mimeType: media.mime }]
        : [];
      const text =
        `Saved ${media.mime} (${Math.round(media.size / 1024)} KB) to:\n${media.path}` +
        (inline_base64 ? "\n(image attached inline)" : "");
      return ok(text, structured as unknown as Record<string, unknown>, extra);
    },
  }),

  tool({
    name: "send_message",
    title: "Send a WhatsApp text message",
    description: `Send a text message. This is a REAL message from the user's own account and
there is no undo — confirm the recipient and the wording with the user before
sending anything sensitive.`,
    schema: {
      chat_id: chatId,
      text: z.string().min(1).max(65536).describe("The message text"),
      reply_to: messageId.optional().describe("Quote-reply to this message"),
      mention_ids: z
        .array(z.string().min(1))
        .max(50)
        .optional()
        .describe("Chat ids to @-mention; include their names in the text yourself"),
    },
    write: true,
    handler: async ({ chat_id, text, reply_to, mention_ids }, wa) => {
      const sent = await wa.sendMessage(chat_id, text, reply_to, mention_ids);
      return ok(`Sent to ${sent.chat_id} at ${sent.timestamp} (message_id: ${sent.message_id}):\n> ${sent.text}`, sent as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "send_media",
    title: "Send a WhatsApp media message",
    description: `Send an image, video, audio file or document, from a local path on the machine
running wazap or from a public URL. Exactly one of file_path / url. Maximum
100 MB.`,
    schema: {
      chat_id: chatId,
      file_path: z.string().min(1).optional().describe("Absolute path of a local file to send"),
      url: z.string().url().optional().describe("Public http(s) URL to fetch and send"),
      caption: z.string().max(1024).optional().describe("Text shown under the media"),
      as_document: z.boolean().default(false).describe("Send as a plain document instead of rendered media"),
      as_voice: z.boolean().default(false).describe("Send an audio file as a voice note (push-to-talk)"),
    },
    write: true,
    handler: async ({ chat_id, file_path, url, caption, as_document, as_voice }, wa) => {
      const sent = await wa.sendMedia(chat_id, { file_path, url }, { caption, asDocument: as_document, asVoice: as_voice });
      return ok(`Media sent to ${sent.chat_id} at ${sent.timestamp} (message_id: ${sent.message_id})`, sent as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "send_poll",
    title: "Send a WhatsApp poll",
    description: `Send a poll to a chat. Participants vote in WhatsApp; wazap cannot read the
votes back, so ask the user to report the outcome.`,
    schema: {
      chat_id: chatId,
      question: z.string().min(1).max(255).describe("The poll question"),
      options: z.array(z.string().min(1).max(100)).min(2).max(12).describe("Answer options (2-12)"),
      multi_select: z.boolean().default(false).describe("Allow voters to pick more than one option"),
    },
    write: true,
    handler: async ({ chat_id, question, options, multi_select }, wa) => {
      const sent = await wa.sendPoll(chat_id, question, options, multi_select);
      return ok(`Poll sent to ${sent.chat_id} (message_id: ${sent.message_id}):\n> ${question}`, sent as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "send_location",
    title: "Send a WhatsApp location",
    description: "Send a map pin to a chat, optionally labelled with a place name and address.",
    schema: {
      chat_id: chatId,
      latitude: z.number().min(-90).max(90).describe("Latitude in decimal degrees"),
      longitude: z.number().min(-180).max(180).describe("Longitude in decimal degrees"),
      name: z.string().max(255).optional().describe("Place name shown on the pin"),
      address: z.string().max(500).optional().describe("Street address shown under the name"),
    },
    write: true,
    handler: async ({ chat_id, latitude, longitude, name, address }, wa) => {
      const sent = await wa.sendLocation(chat_id, latitude, longitude, name, address);
      return ok(`Location sent to ${sent.chat_id} (message_id: ${sent.message_id})`, sent as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "edit_message",
    title: "Edit a WhatsApp message you sent",
    description: `Replace the text of a message the linked account sent. WhatsApp only allows
this within 15 minutes of sending; after that send a correction instead.`,
    schema: {
      message_id: messageId.describe("A message the linked account sent"),
      text: z.string().min(1).max(65536).describe("The replacement text"),
    },
    write: true,
    handler: async ({ message_id, text }, wa) => {
      const sent = await wa.editMessage(message_id, text);
      return ok(`Edited ${message_id}:\n> ${sent.text}`, sent as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "react_to_message",
    title: "React to a WhatsApp message",
    description: 'Add an emoji reaction to a message, or pass an empty string to remove your reaction.',
    schema: {
      message_id: messageId,
      emoji: z.string().max(8).describe('A single emoji such as "👍", or "" to remove your reaction'),
    },
    write: true,
    handler: async ({ message_id, emoji }, wa) => {
      const result = await wa.reactToMessage(message_id, emoji);
      const text = emoji ? `Reacted ${emoji} to ${message_id}` : `Removed the reaction from ${message_id}`;
      return ok(text, result as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "forward_message",
    title: "Forward a WhatsApp message",
    description: "Forward an existing message to another chat. The recipient sees it marked as forwarded.",
    schema: { message_id: messageId, to_chat_id: chatId.describe("Destination chat") },
    write: true,
    handler: async ({ message_id, to_chat_id }, wa) => {
      const sent = await wa.forwardMessage(message_id, to_chat_id);
      return ok(`Forwarded ${message_id} to ${sent.chat_id} (message_id: ${sent.message_id})`, sent as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "delete_message",
    title: "Delete a WhatsApp message",
    description: `Retract a message. DESTRUCTIVE and visible to everyone in the chat — confirm
with the user first. Only works on messages the linked account sent, and only
within 2 days of sending.`,
    schema: {
      message_id: messageId,
      for_everyone: z.boolean().default(false).describe("Retract for all participants (WhatsApp supports no other kind of delete here)"),
    },
    write: true,
    destructive: true,
    handler: async ({ message_id, for_everyone }, wa) => {
      const result = await wa.deleteMessage(message_id, for_everyone);
      return ok(`Deleted ${message_id} for everyone`, result as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "manage_chat",
    title: "Manage a WhatsApp chat",
    description: `Change the state of a chat: archive/unarchive, pin/unpin, mute/unmute
(mute_hours defaults to 8), mark_read (sends read receipts) or mark_unread.`,
    schema: {
      chat_id: chatId,
      action: z
        .enum(["archive", "unarchive", "pin", "unpin", "mute", "unmute", "mark_read", "mark_unread"])
        .describe("What to do with the chat"),
      mute_hours: z.number().int().min(1).max(720).optional().describe('Hours to mute, default 8; only used by "mute"'),
    },
    write: true,
    handler: async ({ chat_id, action, mute_hours }, wa) => {
      const result = await wa.manageChat(chat_id, action, mute_hours);
      return ok(result.applied, result as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "create_group",
    title: "Create a WhatsApp group",
    description: `Create a group with the given name and participants; the linked account becomes
the owner. Each participant comes back with a status: ok, invite_needed (their
privacy settings require an invite link) or failed.`,
    schema: {
      name: z.string().min(1).max(100).describe("Group name"),
      participant_ids: z.array(z.string().min(1)).min(1).max(256).describe("Chat ids or phone numbers to add (1-256)"),
    },
    write: true,
    handler: async ({ name, participant_ids }, wa) => {
      const result = await wa.createGroup(name, participant_ids);
      const text = [`Group "${name}" created: ${result.chat_id}`, ...renderParticipants(result.participants)].join("\n");
      return ok(text, { name, ...result });
    },
  }),

  tool({
    name: "manage_group",
    title: "Manage a WhatsApp group",
    description: `Administer a group. Actions:
  - add / remove / promote / demote — need participant_ids; each participant
    comes back with status ok, invite_needed or failed
  - leave — DESTRUCTIVE, rejoining needs an invite
  - set_subject / set_description — need value
  - get_invite_link / revoke_invite_link

Everything except leave requires the linked account to be a group admin; call
get_group_info first to check.`,
    schema: {
      group_id: chatId.describe('Group chat id ("<id>@g.us")'),
      action: z
        .enum([
          "add",
          "remove",
          "promote",
          "demote",
          "leave",
          "set_subject",
          "set_description",
          "get_invite_link",
          "revoke_invite_link",
        ])
        .describe("Group action to perform"),
      participant_ids: z.array(z.string().min(1)).max(256).optional().describe("Targets of add/remove/promote/demote"),
      value: z.string().max(2048).optional().describe("New subject or description"),
    },
    write: true,
    destructive: true,
    handler: async ({ group_id, action, participant_ids, value }, wa) => {
      const result = await wa.manageGroup(group_id, action, participant_ids, value);
      const text = [result.applied, ...renderParticipants(result.participants ?? [])].join("\n");
      return ok(text, result as unknown as Record<string, unknown>);
    },
  }),
];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

export interface RegisterOpts {
  allowWrite: boolean;
  limiter: RateLimiter;
}

export function registerTools(server: McpServer, wa: WhatsAppApi, opts: RegisterOpts): void {
  for (const def of TOOLS) {
    if (def.write && !opts.allowWrite) continue;
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.schema,
        annotations: def.write
          ? { ...WRITE_HINTS, destructiveHint: def.destructive === true }
          : { ...READ_ONLY_HINTS, openWorldHint: def.name !== "learn" },
      },
      async (args: unknown): Promise<ToolResult> => {
        try {
          if (def.write) opts.limiter.take();
          return await def.handler(args as ToolArgs, wa);
        } catch (err) {
          return toolError(asWazapError(err));
        }
      },
    );
  }
}

function renderChats(chats: ChatSummary[], filter: string): string {
  if (chats.length === 0) return `No chats found (filter: ${filter}).`;
  const lines = [`# WhatsApp chats — ${filter} (${chats.length})`, ""];
  for (const c of chats) {
    const flags = [
      c.type === "group" ? "group" : null,
      c.unread_count > 0 ? `${c.unread_count} unread` : null,
      c.pinned ? "pinned" : null,
      c.muted_until ? "muted" : null,
      c.archived ? "archived" : null,
      c.left ? "left" : null,
    ].filter(Boolean);
    lines.push(`## ${c.name}${flags.length ? ` [${flags.join(", ")}]` : ""}`);
    lines.push(`- **chat_id**: \`${c.chat_id}\``);
    if (c.last_message) {
      lines.push(`- **last**: ${c.last_message.from_me ? "me: " : ""}${truncate(c.last_message.text, 160)} (${c.last_message.timestamp})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderMessages(title: string, messages: MessageView[]): string {
  if (messages.length === 0) return `${title}: no messages found.`;
  const lines = [`# ${title} (${messages.length})`, ""];
  for (const m of messages) {
    const tags = [
      m.type !== "text" ? m.type : null,
      m.forwarded ? "forwarded" : null,
      m.edited ? "edited" : null,
      m.quoted ? "reply" : null,
      m.reactions?.length ? m.reactions.map((r) => r.emoji).join("") : null,
    ].filter(Boolean);
    lines.push(`- **${m.from_me ? "me" : m.sender.name}** · ${m.age}${tags.length ? ` [${tags.join(", ")}]` : ""} · id: \`${m.message_id}\``);
    if (m.quoted) lines.push(`  > ${truncate(m.quoted.text, 160)}`);
    lines.push(`  ${truncate(m.text, 500)}`);
  }
  return lines.join("\n");
}

function renderConversations(conversations: RecentConversation[], hours: number): string {
  if (conversations.length === 0) return `No WhatsApp conversations in the last ${hours}h.`;
  const total = conversations.reduce((n, c) => n + c.messages.length, 0);
  const lines = [`# WhatsApp · last ${hours}h (${conversations.length} chats, ${total} messages)`, ""];
  for (const c of conversations) {
    lines.push(`## ${c.chat_name}${c.type === "group" ? " [group]" : ""} — \`${c.chat_id}\``);
    for (const m of c.messages) {
      lines.push(`- [${m.timestamp}] ${m.from_me ? "me" : m.sender.name}: ${truncate(m.text, 500)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderContacts(query: string, contacts: ContactSummary[]): string {
  if (contacts.length === 0) return `No contacts matching "${query}".`;
  const lines = [`# Contacts matching "${query}" (${contacts.length})`, ""];
  for (const c of contacts) {
    const flags = [c.is_my_contact ? "saved" : null, c.is_business ? "business" : null].filter(Boolean);
    lines.push(`- **${c.name}**${flags.length ? ` [${flags.join(", ")}]` : ""} — \`${c.contact_id}\`${c.number ? ` (${c.number})` : ""}`);
  }
  return lines.join("\n");
}

function renderParticipants(participants: Array<{ id: string; status: string; reason?: string }>): string[] {
  return participants.map((p) => `- ${p.id}: ${p.status}${p.reason ? ` (${p.reason})` : ""}`);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
