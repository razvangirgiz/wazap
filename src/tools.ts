/**
 * MCP tool registration — full WhatsApp coverage.
 *
 * Read:  learn, get_status, get_recent_chats, search_contacts, get_contact,
 *        search_messages, read_messages, download_media, get_group_info
 * Write: send_message, send_media, react_to_message, forward_message,
 *        delete_message, manage_chat, create_group, manage_group
 *
 * Every tool returns a human-readable Markdown summary in `content` plus the
 * full structured data in `structuredContent` for programmatic clients.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  WhatsAppService,
  ChatSummary,
  ContactSummary,
  MessageSummary,
  RecentConversation,
} from "./whatsapp.js";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface ToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

function ok(text: string, structured: Record<string, unknown>, extra: ContentBlock[] = []): ToolResult {
  return { content: [{ type: "text", text }, ...extra], structuredContent: structured };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Wrap a tool handler so thrown errors become clean MCP error results. */
function guarded<A extends unknown[]>(fn: (...args: A) => Promise<ToolResult>) {
  return async (...args: A): Promise<ToolResult> => {
    try {
      return await fn(...args);
    } catch (err) {
      return fail(errorMessage(err));
    }
  };
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const WRITES = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const chatIdSchema = z
  .string()
  .min(1)
  .describe('Chat id, e.g. "1234567890@c.us", "...@g.us", "...@lid", or a bare phone number');

const messageIdSchema = z
  .string()
  .min(5)
  .describe('Full message id from read_messages / search_messages, e.g. "true_123...@c.us_3EB0..."');

/** Usage guide returned by the `learn` tool (the docs agents read before acting). */
const GUIDE = `# WhatsApp integration — how to use these tools

Full read/write access to the user's linked WhatsApp account: chats, contacts,
message search, media, reactions, chat management, and groups.

## ID formats (important)
- chat_id — individual: \`<number>@c.us\`; group: \`<id>@g.us\`; newer accounts may
  show \`<id>@lid\` — always pass ids back exactly as returned. A bare phone
  number in international format (e.g. "40712345678") is also accepted.
- message_id — the full serialized id returned by read_messages /
  search_messages (looks like \`true_40...@c.us_3EB0...\`). Needed for
  download_media, react_to_message, forward_message, delete_message and the
  reply_to option of send_message.

## Recommended workflows
- Read a conversation: get_recent_chats → read_messages(chat_id)
- Find a person: search_contacts("name or number") → get_contact for details
- Find something said: search_messages("query"[, chat_id])
- Send: send_message(chat_id, message[, reply_to]) — confirm recipient + wording
  with the user before sending anything sensitive. No undo.
- Media: read_messages shows has_media=true → download_media(message_id);
  send_media accepts a local file path or a URL, optional caption.
- Tidy up: manage_chat(chat_id, action) for archive/pin/mute/mark_read etc.
- Groups: get_group_info, create_group, manage_group (add/remove/promote/
  demote/leave/set_subject/set_description/get_invite_link).

## Notes
- Timestamps are ISO 8601 (UTC).
- Media-only messages show their body as "[image]", "[audio]", etc.
- delete_message with for_everyone=true and manage_group remove/leave are
  destructive — double-check with the user first.
- If a tool says "WhatsApp is not ready", the session is still connecting;
  call get_status, wait a few seconds, retry.
`;

export function registerTools(server: McpServer, wa: WhatsAppService, allowWrite = true): void {
  // Mutating tools are gated by the caller's token: a read-only-token session
  // gets a clear error instead of being able to message or modify anything.
  const writeGuarded = <A extends unknown[]>(fn: (...args: A) => Promise<ToolResult>) =>
    allowWrite
      ? guarded(fn)
      : guarded(async (): Promise<ToolResult> => {
          throw new Error(
            "This bearer token is read-only — sending and mutations require the write token (held by the write-token client).",
          );
        });

  // ---- Docs & status ----------------------------------------------------------

  server.registerTool(
    "learn",
    {
      title: "Learn how to use the WhatsApp tools",
      description: `Read this FIRST, before using any other WhatsApp tool.

Returns a short guide explaining all available WhatsApp tools, the id formats
(chat_id vs message_id), recommended workflows, and safety caveats. It takes no
arguments and never touches WhatsApp.`,
      inputSchema: {},
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    async () => ok(GUIDE, { guide: GUIDE }),
  );

  server.registerTool(
    "get_status",
    {
      title: "Get WhatsApp connection status",
      description: `Check the WhatsApp session: connection status ("ready" means all tools work),
the linked account (id/name/platform), and the last error if any.

Call this when another tool reports "not ready", or to identify which account
is linked before sending.`,
      inputSchema: {},
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    guarded(async () => {
      const status = wa.getStatus();
      const account = status.account
        ? `${status.account.name || "(no name)"} <${status.account.id}> on ${status.account.platform}`
        : "unknown (not ready yet)";
      const text = [
        `# WhatsApp status: ${status.status}`,
        `- **account**: ${account}`,
        status.lastError ? `- **last error**: ${status.lastError}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      return ok(text, status as unknown as Record<string, unknown>);
    }),
  );

  // ---- Chats & messages (read) --------------------------------------------------

  server.registerTool(
    "get_recent_chats",
    {
      title: "Get recent WhatsApp chats",
      description: `List WhatsApp conversations, most-recently-active first. Use this to discover
the chat_id values other tools need.

Args:
  - limit (number): max chats to return, 1-100 (default 20)
  - filter (string): "all" (default, excludes archived), "unread", "groups",
      "individual", or "archived"

Each chat includes: chat_id, name, is_group, unread_count, archived, pinned,
muted, last_activity (ISO 8601), last_message.`,
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe("Maximum number of chats (1-100)"),
        filter: z
          .enum(["all", "unread", "groups", "individual", "archived"])
          .default("all")
          .describe('Which chats to list (default "all" = everything except archived)'),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ limit, filter }: { limit: number; filter: "all" | "unread" | "groups" | "individual" | "archived" }) => {
      const chats = await wa.getRecentChats(limit, filter);
      return ok(renderChats(chats, filter), { count: chats.length, filter, chats });
    }),
  );

  server.registerTool(
    "read_messages",
    {
      title: "Read WhatsApp messages",
      description: `Read the most recent messages from one WhatsApp chat, oldest-to-newest.

Args:
  - chat_id (string): chat to read (from get_recent_chats / search_contacts)
  - limit (number): max messages, 1-100 (default 20)

Each message includes: id (use it for reactions/replies/forward/delete/
download_media), chat_id, from_me, sender, body ("[image]" etc. for media),
type, has_media, has_quoted, timestamp (ISO 8601).`,
      inputSchema: {
        chat_id: chatIdSchema,
        limit: z.number().int().min(1).max(1000).default(20).describe("Maximum number of messages (1-1000; large values load older history and are slower)"),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ chat_id, limit }: { chat_id: string; limit: number }) => {
      const messages = await wa.readMessages(chat_id, limit);
      return ok(renderMessages(`Messages in ${chat_id}`, messages), {
        chat_id,
        count: messages.length,
        messages,
      });
    }),
  );

  server.registerTool(
    "get_recent_messages",
    {
      title: "Get recent WhatsApp conversations (durable)",
      description: `All WhatsApp conversations active in the last N hours, grouped by chat, read
from a durable on-disk journal rather than volatile memory — so the result is
complete even right after the server restarted. This is the tool the nightly
read-only consumers should use.

Args:
  - hours (number): how far back to look, 1-168 (default 24)

Each conversation has: chat_id, chat_name, is_group, last_activity (ISO 8601),
and messages[] (timestamp, sender, from_me, body), oldest-to-newest.`,
      inputSchema: {
        hours: z.number().int().min(1).max(168).default(24).describe("Look-back window in hours (1-168)"),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ hours }: { hours: number }) => {
      const conversations = await wa.getRecentMessages(hours);
      const messageCount = conversations.reduce((n, c) => n + c.messages.length, 0);
      return ok(renderConversations(conversations, hours), {
        hours,
        conversation_count: conversations.length,
        message_count: messageCount,
        conversations,
      });
    }),
  );

  server.registerTool(
    "load_older_history",
    {
      title: "Load older WhatsApp history for a chat",
      description: `Pull messages OLDER than what's currently loaded for a chat, by asking WhatsApp
for more history (beyond the initial sync). Use when read_messages doesn't reach
far enough back. Read the chat first so there is an anchor message.

The requested older messages arrive a few seconds later and then become visible
to read_messages / search_messages. Bounded by what WhatsApp still keeps on its
servers and by the per-chat cap — it cannot reach the user's full phone archive.

Args:
  - chat_id (string): the chat to deepen
  - count (number): how many older messages to request, 1-200 (default 50)

Returns how many messages the chat had before/after and the new oldest timestamp.`,
      inputSchema: {
        chat_id: chatIdSchema,
        count: z.number().int().min(1).max(200).default(50).describe("Older messages to request (1-200)"),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ chat_id, count }: { chat_id: string; count: number }) => {
      const r = await wa.fetchOlderHistory(chat_id, count);
      const text =
        r.gained > 0
          ? `Loaded ${r.gained} older message(s) in ${r.chat_id} (${r.had} → ${r.now}). Oldest now: ${r.oldest}.`
          : `No older messages came back for ${r.chat_id} (still ${r.now}). WhatsApp may have no more, or they are still arriving — retry read_messages shortly.`;
      return ok(text, r as unknown as Record<string, unknown>);
    }),
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search WhatsApp messages",
      description: `Full-text search across WhatsApp messages — all chats, or one chat.

Args:
  - query (string): text to search for
  - chat_id (string, optional): restrict the search to this chat
  - limit (number): max results, 1-50 (default 20)

Returns the same message shape as read_messages (each result includes its
chat_id and message id).`,
      inputSchema: {
        query: z.string().min(1).describe("Text to search for"),
        chat_id: chatIdSchema.optional(),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of results (1-50)"),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ query, chat_id, limit }: { query: string; chat_id?: string; limit: number }) => {
      const messages = await wa.searchMessages(query, chat_id, limit);
      return ok(renderMessages(`Search results for "${query}"`, messages), {
        query,
        chat_id: chat_id ?? null,
        count: messages.length,
        messages,
      });
    }),
  );

  // ---- Contacts -----------------------------------------------------------------

  server.registerTool(
    "search_contacts",
    {
      title: "Search WhatsApp contacts",
      description: `Find WhatsApp contacts by name or phone number (case-insensitive substring
match; numbers match on digits, minimum 5).

Args:
  - query (string): name fragment or phone number
  - limit (number): max results, 1-50 (default 10)

Returns contact_id (usable as chat_id for send_message/read_messages), name,
number, is_my_contact, is_business.`,
      inputSchema: {
        query: z.string().min(2).describe("Name fragment or phone number to search for"),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of results (1-50)"),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ query, limit }: { query: string; limit: number }) => {
      const contacts = await wa.searchContacts(query, limit);
      return ok(renderContacts(query, contacts), { query, count: contacts.length, contacts });
    }),
  );

  server.registerTool(
    "get_contact",
    {
      title: "Get WhatsApp contact details",
      description: `Full details for one contact: name, number, about/status text, profile picture
URL, is_blocked, is_business.

Args:
  - contact_id (string): from search_contacts / get_recent_chats, or a bare
      phone number in international format.`,
      inputSchema: {
        contact_id: z
          .string()
          .min(1)
          .describe('Contact id, e.g. "40712345678@c.us", or a bare phone number'),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ contact_id }: { contact_id: string }) => {
      const c = await wa.getContact(contact_id);
      const lines = [
        `# ${c.name}`,
        `- **contact_id**: \`${c.contact_id}\``,
        c.number ? `- **number**: ${c.number}` : null,
        c.about ? `- **about**: ${c.about}` : null,
        c.profile_pic_url ? `- **profile picture**: ${c.profile_pic_url}` : null,
        `- **my contact**: ${c.is_my_contact} · **business**: ${c.is_business} · **blocked**: ${c.is_blocked}`,
      ].filter(Boolean);
      return ok(lines.join("\n"), c as unknown as Record<string, unknown>);
    }),
  );

  // ---- Media ---------------------------------------------------------------------

  server.registerTool(
    "download_media",
    {
      title: "Download media from a WhatsApp message",
      description: `Download the photo/video/audio/document attached to a message and save it on
disk. Small images (≤1 MB) are also returned inline so you can view them.

Args:
  - message_id (string): a message with has_media=true (from read_messages /
      search_messages)

Returns: path (absolute, on the server machine), filename, mimetype, size_bytes.
Fails if the media expired on WhatsApp's servers.`,
      inputSchema: { message_id: messageIdSchema },
      annotations: READ_ONLY,
    },
    guarded(async ({ message_id }: { message_id: string }) => {
      const media = await wa.downloadMedia(message_id);
      const { base64, ...structured } = media;
      const extra: ContentBlock[] = base64
        ? [{ type: "image", data: base64, mimeType: media.mimetype }]
        : [];
      const text =
        `Saved ${media.mimetype} (${Math.round(media.size_bytes / 1024)} KB) to:\n${media.path}` +
        (base64 ? "\n(image attached inline)" : "");
      return ok(text, structured as unknown as Record<string, unknown>, extra);
    }),
  );

  server.registerTool(
    "send_media",
    {
      title: "Send a WhatsApp media message",
      description: `Send an image/video/audio/document to a chat, from a local file path (on the
server machine) or a public URL. Optional caption. There is no undo.

Args:
  - chat_id (string): recipient chat
  - file_path (string, optional): absolute path of a local file
  - url (string, optional): public http(s) URL to fetch and send
  - caption (string, optional): text shown under the media
  - as_document (boolean): send as a plain document instead of rendered media
      (default false)

Exactly one of file_path / url is required.`,
      inputSchema: {
        chat_id: chatIdSchema,
        file_path: z.string().min(1).optional().describe("Absolute path of a local file to send"),
        url: z.string().url().optional().describe("Public http(s) URL of the media to send"),
        caption: z.string().max(1024).optional().describe("Optional caption"),
        as_document: z.boolean().default(false).describe("Send as document instead of rendered media"),
      },
      annotations: WRITES,
    },
    writeGuarded(
      async ({
        chat_id,
        file_path,
        url,
        caption,
        as_document,
      }: {
        chat_id: string;
        file_path?: string;
        url?: string;
        caption?: string;
        as_document: boolean;
      }) => {
        if (Boolean(file_path) === Boolean(url)) {
          return fail("Provide exactly one of file_path or url.");
        }
        const sent = await wa.sendMedia(chat_id, { file_path, url }, caption, as_document);
        return ok(
          `Media sent to ${sent.to} at ${sent.timestamp} (message id: ${sent.id})`,
          sent as unknown as Record<string, unknown>,
        );
      },
    ),
  );

  // ---- Sending & message actions --------------------------------------------------

  server.registerTool(
    "send_message",
    {
      title: "Send a WhatsApp message",
      description: `Send a text message to a WhatsApp chat. This sends a REAL message from the
user's account — there is no undo. Confirm recipient and wording with the user
before sending anything sensitive.

Args:
  - chat_id (string): recipient chat (from get_recent_chats / search_contacts,
      or a bare phone number)
  - message (string): text to send (1-4096 chars)
  - reply_to (string, optional): message_id to quote-reply to

Returns the sent message's id, normalized chat_id, body and timestamp.`,
      inputSchema: {
        chat_id: chatIdSchema,
        message: z
          .string()
          .min(1, "Message cannot be empty")
          .max(4096, "Message must not exceed 4096 characters")
          .describe("The text message to send"),
        reply_to: messageIdSchema.optional(),
      },
      annotations: WRITES,
    },
    writeGuarded(async ({ chat_id, message, reply_to }: { chat_id: string; message: string; reply_to?: string }) => {
      const sent = await wa.sendMessage(chat_id, message, reply_to);
      return ok(
        `Sent to ${sent.to} at ${sent.timestamp} (message id: ${sent.id}):\n> ${sent.body}`,
        sent as unknown as Record<string, unknown>,
      );
    }),
  );

  server.registerTool(
    "react_to_message",
    {
      title: "React to a WhatsApp message",
      description: `Add an emoji reaction to a message, or remove your existing reaction.

Args:
  - message_id (string): from read_messages / search_messages
  - emoji (string): a single emoji like "👍"; pass "" (empty) to remove your reaction`,
      inputSchema: {
        message_id: messageIdSchema,
        emoji: z.string().max(8).describe('Emoji to react with, or "" to remove the reaction'),
      },
      annotations: WRITES,
    },
    writeGuarded(async ({ message_id, emoji }: { message_id: string; emoji: string }) => {
      const result = await wa.reactToMessage(message_id, emoji);
      return ok(result, { message_id, emoji });
    }),
  );

  server.registerTool(
    "forward_message",
    {
      title: "Forward a WhatsApp message",
      description: `Forward an existing message to another chat. The recipient sees it as forwarded.

Args:
  - message_id (string): the message to forward
  - to_chat_id (string): destination chat`,
      inputSchema: {
        message_id: messageIdSchema,
        to_chat_id: chatIdSchema,
      },
      annotations: WRITES,
    },
    writeGuarded(async ({ message_id, to_chat_id }: { message_id: string; to_chat_id: string }) => {
      const result = await wa.forwardMessage(message_id, to_chat_id);
      return ok(result, { message_id, to_chat_id });
    }),
  );

  server.registerTool(
    "delete_message",
    {
      title: "Delete a WhatsApp message",
      description: `Delete a message. DESTRUCTIVE — confirm with the user first.

Args:
  - message_id (string): the message to delete
  - for_everyone (boolean): true = retract for all participants (only works on
      recent messages you sent); false (default) = delete only on this account`,
      inputSchema: {
        message_id: messageIdSchema,
        for_everyone: z.boolean().default(false).describe("Retract for everyone (true) or delete locally (false)"),
      },
      annotations: { ...WRITES, destructiveHint: true },
    },
    writeGuarded(async ({ message_id, for_everyone }: { message_id: string; for_everyone: boolean }) => {
      const result = await wa.deleteMessage(message_id, for_everyone);
      return ok(result, { message_id, for_everyone });
    }),
  );

  // ---- Chat management -------------------------------------------------------------

  server.registerTool(
    "manage_chat",
    {
      title: "Manage a WhatsApp chat",
      description: `Change the state of a chat. Actions:
  - "archive" / "unarchive"
  - "pin" / "unpin"
  - "mute" / "unmute" — mute takes optional mute_hours (omit = mute indefinitely)
  - "mark_read" — send read receipts for the chat
  - "mark_unread" — flag the chat as unread

Args:
  - chat_id (string)
  - action (string): one of the above
  - mute_hours (number, optional): only for "mute", 1-720`,
      inputSchema: {
        chat_id: chatIdSchema,
        action: z
          .enum(["archive", "unarchive", "pin", "unpin", "mute", "unmute", "mark_read", "mark_unread"])
          .describe("What to do with the chat"),
        mute_hours: z.number().int().min(1).max(720).optional().describe('Hours to mute (only for "mute")'),
      },
      annotations: WRITES,
    },
    writeGuarded(
      async ({
        chat_id,
        action,
        mute_hours,
      }: {
        chat_id: string;
        action: "archive" | "unarchive" | "pin" | "unpin" | "mute" | "unmute" | "mark_read" | "mark_unread";
        mute_hours?: number;
      }) => {
        const result = await wa.manageChat(chat_id, action, mute_hours);
        return ok(result, { chat_id, action, mute_hours: mute_hours ?? null });
      },
    ),
  );

  // ---- Groups -----------------------------------------------------------------------

  server.registerTool(
    "get_group_info",
    {
      title: "Get WhatsApp group info",
      description: `Details of a group chat: name, description, owner, creation date, and the
participant list (contact_id, name, is_admin; first 100 participants).

Args:
  - chat_id (string): a group chat id ("...@g.us")`,
      inputSchema: { chat_id: chatIdSchema },
      annotations: READ_ONLY,
    },
    guarded(async ({ chat_id }: { chat_id: string }) => {
      const info = await wa.getGroupInfo(chat_id);
      const lines = [
        `# ${info.name} (${info.participant_count} participants)`,
        `- **chat_id**: \`${info.chat_id}\``,
        info.description ? `- **description**: ${info.description}` : null,
        info.owner ? `- **owner**: ${info.owner}` : null,
        info.created_at ? `- **created**: ${info.created_at}` : null,
        "",
        "## Participants",
        ...info.participants.map(
          (p) => `- ${p.name}${p.is_admin ? " (admin)" : ""} — \`${p.contact_id}\``,
        ),
      ].filter((l): l is string => l !== null);
      return ok(lines.join("\n"), info as unknown as Record<string, unknown>);
    }),
  );

  server.registerTool(
    "create_group",
    {
      title: "Create a WhatsApp group",
      description: `Create a new WhatsApp group with the given name and participants. The user's
account becomes the group owner.

Args:
  - name (string): group subject (1-100 chars)
  - participant_ids (string[]): contact ids or bare phone numbers to add (1-50)

Returns the new group's chat_id and any participants that could not be added.`,
      inputSchema: {
        name: z.string().min(1).max(100).describe("Group name/subject"),
        participant_ids: z
          .array(z.string().min(5))
          .min(1)
          .max(50)
          .describe("Contact ids or phone numbers to add"),
      },
      annotations: WRITES,
    },
    writeGuarded(async ({ name, participant_ids }: { name: string; participant_ids: string[] }) => {
      const result = await wa.createGroup(name, participant_ids);
      const text =
        `Group "${name}" created: ${result.chat_id}` +
        (result.missing.length ? `\nCould not add: ${result.missing.join(", ")}` : "");
      return ok(text, { name, ...result });
    }),
  );

  server.registerTool(
    "manage_group",
    {
      title: "Manage a WhatsApp group",
      description: `Administer a group chat (most actions require the linked account to be a group
admin). Actions:
  - "add" / "remove" / "promote" / "demote" — require participant_ids
  - "leave" — leave the group (DESTRUCTIVE: rejoining needs an invite)
  - "set_subject" / "set_description" — require value
  - "get_invite_link" — returns the group's invite link

Args:
  - chat_id (string): group chat id ("...@g.us")
  - action (string): one of the above
  - participant_ids (string[], optional)
  - value (string, optional): new subject/description`,
      inputSchema: {
        chat_id: chatIdSchema,
        action: z
          .enum(["add", "remove", "promote", "demote", "leave", "set_subject", "set_description", "get_invite_link"])
          .describe("Group action to perform"),
        participant_ids: z.array(z.string().min(5)).max(50).optional().describe("Targets for add/remove/promote/demote"),
        value: z.string().max(2048).optional().describe("New subject or description"),
      },
      annotations: { ...WRITES, destructiveHint: true },
    },
    writeGuarded(
      async ({
        chat_id,
        action,
        participant_ids,
        value,
      }: {
        chat_id: string;
        action: "add" | "remove" | "promote" | "demote" | "leave" | "set_subject" | "set_description" | "get_invite_link";
        participant_ids?: string[];
        value?: string;
      }) => {
        const result = await wa.manageGroup(chat_id, action, participant_ids, value);
        return ok(result, { chat_id, action, participant_ids: participant_ids ?? null, value: value ?? null });
      },
    ),
  );
}

// ---- Markdown rendering -----------------------------------------------------

function renderChats(chats: ChatSummary[], filter: string): string {
  if (chats.length === 0) return `No chats found (filter: ${filter}).`;
  const lines = [`# WhatsApp chats — ${filter} (${chats.length})`, ""];
  for (const c of chats) {
    const flags = [
      c.is_group ? "group" : null,
      c.unread_count > 0 ? `${c.unread_count} unread` : null,
      c.pinned ? "pinned" : null,
      c.muted ? "muted" : null,
      c.archived ? "archived" : null,
    ].filter(Boolean);
    lines.push(`## ${c.name}${flags.length ? ` [${flags.join(", ")}]` : ""}`);
    lines.push(`- **chat_id**: \`${c.chat_id}\``);
    if (c.last_activity) lines.push(`- **last activity**: ${c.last_activity}`);
    if (c.last_message) lines.push(`- **last message**: ${truncate(c.last_message, 160)}`);
    lines.push("");
  }
  return lines.join("\n");
}

function renderMessages(title: string, messages: MessageSummary[]): string {
  if (messages.length === 0) return `${title}: no messages found.`;
  const lines = [`# ${title} (${messages.length})`, ""];
  for (const m of messages) {
    const who = m.from_me ? "me" : m.sender;
    const tags = [m.has_media ? "media" : null, m.has_quoted ? "reply" : null].filter(Boolean);
    lines.push(`- **${who}** · ${m.timestamp}${tags.length ? ` [${tags.join(", ")}]` : ""} · id: \`${m.id}\``);
    lines.push(`  ${truncate(m.body, 500)}`);
  }
  return lines.join("\n");
}

function renderConversations(conversations: RecentConversation[], hours: number): string {
  if (conversations.length === 0) return `No WhatsApp conversations in the last ${hours}h.`;
  const total = conversations.reduce((n, c) => n + c.messages.length, 0);
  const lines = [
    `# WhatsApp conversations · last ${hours}h (${conversations.length} chats, ${total} messages)`,
    "",
  ];
  for (const c of conversations) {
    lines.push(`## ${c.chat_name}${c.is_group ? " [group]" : ""} — \`${c.chat_id}\``);
    for (const m of c.messages) {
      lines.push(`- [${m.timestamp}] ${m.from_me ? "me" : m.sender}: ${truncate(m.body, 500)}`);
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
    lines.push(
      `- **${c.name}**${flags.length ? ` [${flags.join(", ")}]` : ""} — \`${c.contact_id}\`${c.number ? ` (${c.number})` : ""}`,
    );
  }
  return lines.join("\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
