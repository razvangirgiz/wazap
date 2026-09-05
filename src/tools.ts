import { toolOutputSchema } from "./tool-results.js";
import { WAZAP_NPX } from "./version.js";
import { AccountManager } from "./account-manager.js";
import {
  aggregate,
  annotate,
  AGGREGATE_TOOLS,
  GLOBAL_TOOLS,
  SINGLE_TOOLS,
} from "./multi-account-tools.js";
import { accessContext, type AccessContext } from "./access.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compactConversations, renderCompact } from "./compact.js";
import { renderDraft, type DraftView } from "./drafts.js";
import { asWazapError, ERROR_GUIDE, WazapError } from "./errors.js";
import { clockLabel } from "./messages.js";
import { RateLimiter } from "./ratelimit.js";
import { MESSAGE_TYPES } from "./wa-types.js";
import type {
  ChatSummary,
  ContactSummary,
  MessageView,
  RecentConversation,
  SentMessage,
  Synced,
  Preview,
  UnansweredChat,
  WaitResult,
  WhatsAppApi,
} from "./wa-types.js";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

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
  /** Changes wazap's own notes on this machine and nothing on WhatsApp, so it is there in read-only mode too. */
  local?: boolean;
  /** Calls a minute allowed to this tool alone. The session write bucket is separate. */
  rate?: number;
  handler: (args: ToolArgs, wa: WhatsAppApi) => Promise<ToolResult>;
}

function tool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  schema: S;
  write: boolean;
  destructive?: boolean;
  local?: boolean;
  rate?: number;
  handler: (
    args: z.infer<z.ZodObject<S>>,
    wa: WhatsAppApi,
  ) => Promise<ToolResult>;
}): ToolDef {
  return {
    ...def,
    handler: def.handler as (
      args: ToolArgs,
      wa: WhatsAppApi,
    ) => Promise<ToolResult>,
  };
}

function ok(
  text: string,
  structured: Record<string, unknown>,
  extra: ContentBlock[] = [],
): ToolResult {
  if (structured.coverage) {
    const c = structured.coverage as Record<string, unknown>;
    if (c.triage_scan_limit)
      text += `\nScan: at most ${c.triage_scan_limit} recent messages per chat; up to ${c.result_limit} candidates returned.`;
    text += `\nCoverage: ${c.source}; ${c.oldest_available_at ?? "unknown"} – ${c.newest_available_at ?? "unknown"}. Phone history coverage is unknown.`;
  }
  if (structured.sync === "partial")
    text +=
      "\nSync is partial; missing results do not prove that no messages exist.";
  if (structured.history_fetch === "timed_out")
    text +=
      "\nAdditional history timed out. This page contains only currently available messages.";
  return {
    content: [{ type: "text", text }, ...extra],
    structuredContent: structured,
  };
}

function synced<T>(
  result: Synced<T>,
  rest: Record<string, unknown>,
): Record<string, unknown> {
  const { data, ...metadata } = result;
  return { ...rest, ...metadata };
}

export function toolError(err: WazapError): ToolResult {
  const payload: Record<string, unknown> = {
    error: err.code,
    message: err.message,
  };
  if (err.fix) payload.fix = err.fix;
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

const READ_ONLY_HINTS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const WRITE_HINTS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;
const LOCAL_HINTS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const chatId = z
  .string()
  .min(1)
  .describe(
    'Chat id as returned by another tool ("<digits>@s.whatsapp.net" or "<id>@g.us"), or a phone number in international format',
  );

const messageId = z
  .string()
  .min(5)
  .describe(
    'Message id from read_messages / search_messages / get_message, e.g. "false_4072...@s.whatsapp.net_3EB0..."',
  );

const messageTypes = z
  .array(z.enum([...MESSAGE_TYPES]))
  .optional()
  .describe(
    'Keep only these message types; omit for every type. The limit counts matching messages, so ["call"] returns that many calls, not that many messages of which some are calls.',
  );

const includePreviews = z
  .boolean()
  .default(false)
  .describe(
    "Attach a small JPEG of each photo, newest first, up to 12 per call, so you can see what was sent: the preview WhatsApp shipped when there is one, otherwise the photo is downloaded once and shrunk on the machine running wazap",
  );

/** Previews are 5-15 KB each; a dozen keep one answer small and the first call under the client's timeout. */
const MAX_PREVIEWS = 12;

const GUIDE = `# wazap — WhatsApp for your AI agent

Read/write access to the user's linked WhatsApp accounts. Call list_accounts to
choose account_id. With multiple profiles, every account operation needs an explicit
account_id. Keep the account_id from each result when replying or editing. Show the
sending account in every draft. Search and catch-up can use all_accounts: true;
partial account results do not prove absence. Account additions require new OAuth
consent; existing grants never expand automatically.

Read/write access: chats, messages, media,
contacts and groups. Call get_status first if anything looks wrong, and
link_account when it says no account is linked yet.

## Identifiers
- chat_id — individual: \`<digits>@s.whatsapp.net\`; group: \`<id>@g.us\`. A phone
  number in international format (+15550100 or 15550100) also works. Pass
  ids back exactly as a tool returned them.
- message_id — the full id from read_messages / search_messages. Needed for
  get_message, download_media, react_to_message, edit_message, forward_message,
  delete_message, and the reply_to of send_message.

## Workflows
- Not linked: get_status says not_linked, logged_out, session_corrupt or
  auth_failure → link_account(phone), show the user the code, then poll
  get_status every 10 s until it says connected.
- Catch up: get_recent_messages(hours), following next_cursor for further pages, or list_chats(filter:"unread")
  then read_messages(chat_id). Pass include_previews: true to see the photos as
  small images instead of "[image]".
- Follow-up candidates: get_unanswered. It scans a bounded recent tail for
  apparent requests. These are candidates, not proof that a reply is owed. When the user
  says they dealt with one outside WhatsApp, mark_handled(chat_id) takes it
  off the list until they write again.
- Who is who: set_contact_note(contact_id, note) remembers what the user
  says about a person, locally; the note then shows next to their name.
- Stories: get_stories lists the status updates received in the last day, by
  author; they show nowhere else.
- Explicit live wait only (not background scheduling): wait_for_messages blocks up to 55 s until something arrives,
  and returns a cursor; call it again with that cursor to miss nothing between
  calls. Pass addressed_to_me to wake only for direct messages, @-mentions and
  replies to the user.
- Go back further: read_messages(chat_id, before: <oldest message_id you have>).
- Find a person: search_contacts → get_contact. Names come from the phone's own
  address book; if they are missing (get_status shows contacts_named: 0), call
  sync_contacts once.
- Find something said: search_messages(query[, chat_id]).
- Send: send_message / send_media / send_poll / send_location / forward_message
  draft only. They return a draft_id and a preview. Show the preview to the
  user; after they say yes, call confirm_send({ draft_id }). That is the only
  call that reaches WhatsApp. A draft lasts 15 minutes.
- Media: a message with has_media=true → download_media(message_id).
- Groups: get_group_info before manage_group; most actions need admin rights.

## Message shape
Every message has non-empty \`text\`: media and system messages carry a
placeholder like "[image] caption", "[voice message]", "[deleted]", "[poll] question".
A sender whose name WhatsApp has never given us reads as their phone number, or
as "unknown (lid …1234)" when even that is unknown — never as raw LID digits,
which look like a phone number and are not one.
WhatsApp's own notices (device linking, group membership, encryption) have
\`type: "system"\` and are left out of get_recent_messages unless you pass
include_system: true.
A voice note reads as "[voice message · 0:42]"; once transcribed, what was said
follows the placeholder in quotes and is carried bare in \`transcript\`.
Call transcribe_audio(message_id) on a voice note that has no transcript yet.
A WhatsApp call is a message with \`type: "call"\` carrying
\`call: {kind, direction, outcome, duration_seconds}\`, reading as
"[voice call · 6 min]" or "[missed voice call]".
read_messages and get_recent_messages take \`types\` to narrow to a subset of
these types, e.g. \`types: ["call"]\` for the call log of a chat.
\`timestamp\` is ISO 8601 with the machine's UTC offset, \`age\` is human-readable.

## Errors
Every failure returns \`{ error, message, fix }\`. What to do per code:
${(Object.keys(ERROR_GUIDE) as Array<keyof typeof ERROR_GUIDE>).map((code) => `- **${code}** — ${ERROR_GUIDE[code]}`).join("\n")}
`;

const TOOLS: readonly ToolDef[] = [
  tool({
    name: "learn",
    title: "Learn how to use the WhatsApp tools",
    description: `Use this when you need WhatsApp workflows, ID formats or error recovery. Returns the guide to the tools,
the id formats, the recommended workflows, the message shape and every error
code with what to do about it. Takes no arguments and never touches WhatsApp.`,
    schema: {},
    write: false,
    handler: async () => ok(GUIDE, { guide: GUIDE }),
  }),

  tool({
    name: "list_accounts",
    title: "List your WhatsApp accounts",
    description:
      "List accessible account IDs, names, connection and archive states. With multiple profiles, pass account_id on each account operation. No global active account is changed.",
    schema: {},
    write: false,
    handler: async (_args, wa) => {
      const s = wa.getStatus();
      return ok("WhatsApp account", {
        accounts: [
          {
            account_id: "default",
            account_name: "WhatsApp",
            status: s.status,
            sync: s.sync,
            read_only: s.read_only,
          },
        ],
      });
    },
  }),

  tool({
    name: "get_status",
    title: "Get the WhatsApp connection status",
    description: `Check the session: connection status ("connected" means the tools work,
"not_linked" means the user must run \`${WAZAP_NPX} login\`), whether the initial
history sync has finished, which account is linked, when a message last arrived,
the versions and data directory in use, and how many contacts carry a name from
the phone's address book (contacts_named: 0 means it never arrived).

Call this whenever another tool reports NOT_CONNECTED, NOT_LINKED or
SYNC_IN_PROGRESS, or to confirm which account you are about to send from.
While a link is in progress the status is "linking" and \`pairing\` carries the
code the user still has to type into their phone.`,
    schema: {},
    write: false,
    handler: async (_args, wa) => {
      const s = wa.getStatus();
      const account = s.account
        ? `${s.account.name || "(no name)"} (${s.account.number})`
        : "none";
      const text = [
        `# WhatsApp: ${s.status} (sync: ${s.sync})`,
        `- **account**: ${account}`,
        `- **last message received**: ${s.last_message_received_at ?? "never"}`,
        `- **contacts named**: ${s.contacts_named}`,
        `- **data dir**: ${s.data_dir} · **read-only**: ${s.read_only} · **rate limit**: ${s.rate_limit}/min`,
        `- **versions**: wazap ${s.wazap_version}, baileys ${s.baileys_version}`,
        s.pairing
          ? `- **pairing code**: ${s.pairing.code} for ${s.pairing.phone_masked}, until ${s.pairing.expires_at}`
          : null,
        s.last_error ? `- **last error**: ${s.last_error}` : null,
        s.hint ? `- **hint**: ${s.hint}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
      return ok(text, s as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "link_account",
    title: "Link a WhatsApp account",
    description: `Pair this wazap with the user's WhatsApp when get_status says not_linked, logged_out,
session_corrupt or auth_failure. Ask the user for their phone number in international format,
call this, and show them the code it returns with these exact steps:
WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead → enter the code.
Then call get_status every 10 seconds until it says connected (up to 3 minutes). The code expires;
call this again for a fresh one if get_status goes back to not_linked with an error.
Never call this when the account is already linked.`,
    schema: {
      phone: z.string().describe("International format, e.g. +15550100"),
    },
    write: false,
    rate: 2,
    handler: async ({ phone }, wa) => {
      const pairing = await wa.link(phone);
      const next =
        "Show the user the code and the steps, then call get_status every 10 seconds until it says connected.";
      const text = [
        `# Pairing code: ${pairing.code}`,
        `- **number**: ${pairing.phone_masked}`,
        `- **expires**: ${pairing.expires_at}`,
        "",
        "On their phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead → enter the code.",
        next,
      ].join("\n");
      return ok(text, { ...pairing, next });
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
        .describe(
          'Which chats to list; "all" (default) excludes archived ones',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of chats (1-100)"),
    },
    write: false,
    handler: async ({ filter, limit }, wa) => {
      const result = await wa.listChats(filter, limit);
      return ok(
        renderChats(result.data, filter),
        synced(result, {
          filter,
          count: result.data.length,
          chats: result.data,
        }),
      );
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
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(20)
        .describe("Maximum number of messages (1-200)"),
      before: messageId
        .optional()
        .describe("Return the messages immediately older than this message_id"),
      types: messageTypes,
      include_previews: includePreviews,
    },
    write: false,
    handler: async (
      { chat_id, limit, before, types, include_previews },
      wa,
    ) => {
      const result = await wa.readMessages(chat_id, limit, before, types);
      const previews = include_previews
        ? await wa.previews(newestFirst(result.data), MAX_PREVIEWS)
        : [];
      return ok(
        renderMessages(
          `Messages in ${chat_id}`,
          result.data,
          previewLabels(previews),
          previewNote(result.data, previews, include_previews),
        ),
        synced(result, {
          chat_id,
          types,
          count: result.data.length,
          preview_count: previews.length,
          messages: result.data,
        }),
        previewBlocks(previews),
      );
    },
  }),

  tool({
    name: "get_recent_messages",
    title: "Catch up on recent WhatsApp conversations",
    description: `Use when the user asks what they missed on WhatsApp or wants a recent summary. Returns a bounded page of available messages grouped by chat, not a guarantee of complete phone history. Prefer compact=true for summaries; use next_cursor for further pages. This is the catch-up tool:
one call instead of list_chats plus a read_messages per chat. WhatsApp's own
notices — device linking, group membership changes, encryption notices — are left
out so the counts are conversation; pass include_system to see them.`,
    schema: {
      limit: z.number().int().min(1).max(500).default(200),
      cursor: z.string().optional(),
      hours: z
        .number()
        .int()
        .min(1)
        .max(168)
        .default(24)
        .describe("Look-back window in hours (1-168)"),
      filter: z
        .enum(["all", "unread", "groups", "individual"])
        .default("all")
        .describe("Restrict to unread chats, groups, or one-to-one chats"),
      include_system: z
        .boolean()
        .default(false)
        .describe(
          "Include WhatsApp's own system notices, which are excluded from the bodies and the counts by default",
        ),
      types: messageTypes,
      include_previews: includePreviews,
      compact: z
        .boolean()
        .default(false)
        .describe(
          "Leave out media without a caption and messages with no words in them, fold what one person sent in a row into one line, and say per chat what was left out. About half the size; use it for a routine catch-up",
        ),
    },
    write: false,
    handler: async (
      {
        hours,
        filter,
        include_system,
        types,
        include_previews,
        compact,
        limit,
        cursor,
      },
      wa,
    ) => {
      const result = await wa.getRecentMessages(
        hours,
        filter,
        include_system,
        types,
        limit,
        cursor,
      );
      if (compact) {
        const conversations = compactConversations(result.data);
        return ok(
          renderCompact(conversations, hours),
          synced(result, {
            hours,
            filter,
            compact: true,
            conversation_count: conversations.length,
            conversations,
          }),
        );
      }
      const messageCount = result.data.reduce(
        (n, c) => n + c.messages.length,
        0,
      );
      const all = result.data.flatMap((c) => c.messages);
      const previews = include_previews
        ? await wa.previews(newestFirst(all), MAX_PREVIEWS)
        : [];
      return ok(
        renderConversations(
          result.data,
          hours,
          previewLabels(previews),
          previewNote(all, previews, include_previews),
        ),
        synced(result, {
          hours,
          filter,
          include_system,
          types,
          conversation_count: result.data.length,
          message_count: messageCount,
          preview_count: previews.length,
          conversations: result.data,
        }),
        previewBlocks(previews),
      );
    },
  }),

  tool({
    name: "get_unanswered",
    title: "Find possible follow-ups",
    description: `Use when the user asks who may be waiting for a reply on WhatsApp. Do not treat these candidates as proven obligations.
Chats where the last word is theirs and it asks for something: a question, a
request ("poți", "te rog", "can you", "when"…), or a voice note nobody has heard
yet. A conversation that ended in "ok, thanks" is not listed, and neither is an
ask older than max_age_hours (two weeks by default), which is outside the scan window. Groups count only when the user was @-mentioned or replied to
after their own last message. A [business] account's ask is often an automatic
reply; weigh it accordingly.

People come first, then the oldest wait. Each entry quotes the ask, says how
many of their messages arrived since the user's last one, and how long they
have been waiting. This is the follow-up half of an inbox triage; use
get_recent_messages for context. These are candidates, not demonstrated obligations;
resolution outside WhatsApp is unknown. At most 30 messages per chat are inspected.`,
    schema: {
      min_age_hours: z
        .number()
        .min(0)
        .max(8760)
        .default(0)
        .describe(
          "Only asks at least this old, e.g. 48 for people the user forgot for two days",
        ),
      max_age_hours: z
        .number()
        .min(1)
        .max(8760)
        .default(336)
        .describe(
          "Ignore asks older than this; an ask left for two weeks (the default) is abandoned, not waiting",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe("Maximum number of chats (1-50)"),
    },
    write: false,
    handler: async ({ min_age_hours, max_age_hours, limit }, wa) => {
      const result = await wa.getUnanswered(
        min_age_hours,
        max_age_hours,
        limit,
      );
      return ok(
        renderUnanswered(result.data, min_age_hours),
        synced(result, {
          min_age_hours,
          max_age_hours,
          count: result.data.length,
          chats: result.data,
        }),
      );
    },
  }),

  tool({
    name: "get_stories",
    title: "See the stories people posted",
    description: `The stories (status updates) the linked account has received in the last N
hours, newest first, each with its author, its text or caption and its time.
WhatsApp keeps a story for a day and so does wazap; nothing older is held.
With include_previews the photos come as small images, and download_media
works on a story's message_id like on any message. Stories never appear in
chats, catch-ups or waits; this is the only place they show.`,
    schema: {
      hours: z
        .number()
        .int()
        .min(1)
        .max(24)
        .default(24)
        .describe("Look-back window in hours (1-24)"),
      include_previews: includePreviews,
    },
    write: false,
    handler: async ({ hours, include_previews }, wa) => {
      const result = await wa.getStories(hours);
      const previews = include_previews
        ? await wa.previews(newestFirst(result.data), MAX_PREVIEWS)
        : [];
      return ok(
        renderStories(
          result.data,
          hours,
          previewLabels(previews),
          previewNote(result.data, previews, include_previews),
        ),
        synced(result, {
          hours,
          count: result.data.length,
          preview_count: previews.length,
          stories: result.data,
        }),
        previewBlocks(previews),
      );
    },
  }),

  tool({
    name: "set_contact_note",
    title: "Note something about a contact",
    description: `Remember something about a person, on this machine only: "Hermi, my own agent",
"the accountant", "always answers late". The note then rides along wherever
the contact shows: list_chats, search_contacts, get_contact, get_recent_messages
and get_unanswered. Nothing is sent to WhatsApp and the contact never sees it.
An empty note removes it.`,
    schema: {
      contact_id: chatId.describe("Contact id or phone number"),
      note: z
        .string()
        .max(200)
        .describe('What to remember, or "" to remove the note'),
    },
    write: false,
    local: true,
    handler: async ({ contact_id, note }, wa) => {
      const c = await wa.setContactNote(contact_id, note);
      return ok(
        c.note
          ? `Noted for ${c.name}: ${c.note}`
          : `Removed the note on ${c.name}.`,
        c as unknown as Record<string, unknown>,
      );
    },
  }),

  tool({
    name: "mark_handled",
    title: "Take a chat off the waiting list",
    description: `The user dealt with what this chat was asking, outside WhatsApp or by a
reply wazap did not see: a phone call, a meeting, a decision. The open ask is
remembered as handled and the chat leaves get_unanswered. The next message
from the other side makes a new ask and the chat comes back on its own.
Kept on this machine only; nothing is sent or marked read on WhatsApp.`,
    schema: { chat_id: chatId },
    write: false,
    local: true,
    handler: async ({ chat_id }, wa) => {
      const r = await wa.markHandled(chat_id);
      const text = r.ask_id
        ? `${r.name} is off the waiting list until they write again. Handled: "${truncate(r.ask_text ?? "", 120)}"`
        : `${r.name} had nothing open; nothing to mark.`;
      return ok(text, r as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "wait_for_messages",
    title: "Wait for new WhatsApp messages",
    description: `Use only when the user explicitly asks to wait for new messages now. This does not schedule background monitoring.
Block until a message arrives, then return it, or return empty when the timeout
passes. This is how an agent stays on the line without polling: call it in a
loop only for an explicit live wait in the current conversation, and pass the cursor it returns into the next call so nothing that landed
between two calls is missed. The first matching message starts a one-second
settle so a burst comes back together.

Only messages from other people are returned, never the user's own, and never
WhatsApp's system notices. With addressed_to_me, only direct messages, group
messages that @-mention the user, and replies to the user's own messages wake
the wait; everything else in a group is ignored. A cursor from a previous run of
wazap cannot be honoured: the wait then starts from now and says cursor_reset.

The timeout is capped at 55 seconds because MCP clients give up at 60.`,
    schema: {
      timeout_seconds: z
        .number()
        .int()
        .min(1)
        .max(55)
        .default(30)
        .describe("How long to wait (1-55 s)"),
      chat_id: chatId.optional().describe("Only messages in this chat"),
      addressed_to_me: z
        .boolean()
        .default(false)
        .describe(
          "Only direct messages, @-mentions of the user and replies to the user's messages",
        ),
      cursor: z
        .string()
        .min(1)
        .optional()
        .describe("The cursor returned by the previous call"),
    },
    write: false,
    handler: async (
      { timeout_seconds, chat_id, addressed_to_me, cursor },
      wa,
    ) => {
      const result = await wa.waitForMessages({
        timeoutMs: timeout_seconds * 1000,
        chatId: chat_id,
        addressedToMe: addressed_to_me,
        cursor,
      });
      return ok(renderWait(result), {
        ...result,
        count: result.messages.length,
      });
    },
  }),

  tool({
    name: "search_messages",
    title: "Search WhatsApp messages",
    description: `Case-insensitive text search over the messages wazap holds locally — all chats,
or one chat. It cannot reach messages the phone never synced to this device.`,
    schema: {
      before: messageId.optional(),
      query: z.string().min(1).describe("Text to search for"),
      chat_id: chatId.optional().describe("Restrict the search to this chat"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe("Maximum number of results (1-50)"),
      since: z
        .string()
        .min(4)
        .optional()
        .describe(
          'Only messages from this moment on: a date ("2026-09-01") or an ISO timestamp',
        ),
      until: z
        .string()
        .min(4)
        .optional()
        .describe(
          "Only messages up to this moment: a date or an ISO timestamp",
        ),
      from: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Only messages this person sent: "me", a contact id or a phone number',
        ),
    },
    write: false,
    handler: async (
      { query, chat_id, limit, since, until, from, before },
      wa,
    ) => {
      const result = await wa.searchMessages(query, chat_id, limit, {
        before,
        sinceMs: parseMoment(since, "since"),
        untilMs: parseMoment(until, "until", true),
        from,
      });
      const scope = [
        chat_id ? `in ${chat_id}` : null,
        from ? `from ${from}` : null,
        since ? `since ${since}` : null,
        until ? `until ${until}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return ok(
        renderMessages(
          `Search results for "${query}"${scope ? ` (${scope})` : ""}`,
          result.data,
        ),
        synced(result, {
          query,
          chat_id: chat_id ?? null,
          since: since ?? null,
          until: until ?? null,
          from: from ?? null,
          count: result.data.length,
          messages: result.data,
        }),
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
      return ok(
        renderMessages("Message", [message]),
        message as unknown as Record<string, unknown>,
      );
    },
  }),

  tool({
    name: "search_contacts",
    title: "Search WhatsApp contacts",
    description: `Find contacts by name or phone number (substring match on the name, digit match
on the number). Returns contact_id values usable as chat_id.`,
    schema: {
      query: z
        .string()
        .min(2)
        .describe("Name fragment or phone number (at least 2 characters)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of results (1-50)"),
    },
    write: false,
    handler: async ({ query, limit }, wa) => {
      const contacts = await wa.searchContacts(query, limit);
      return ok(renderContacts(query, contacts), {
        query,
        count: contacts.length,
        contacts,
      });
    },
  }),

  tool({
    name: "sync_contacts",
    title: "Fetch the phone's address book again",
    description: `Ask WhatsApp to send the linked phone's address book from scratch, and wait up
to 15 seconds for it. Nothing on WhatsApp changes: this only refills wazap's
own contact list.

Use it when get_status reports contacts_named: 0, or when senders in a group
read as phone numbers for people you know are saved on the phone. Returns
named_before and named_after so you can tell whether it helped; if both are 0, no names were received; this does not prove the phone has no saved contacts.`,
    schema: {},
    write: false,
    handler: async (_args, wa) => {
      const result = await wa.syncContacts();
      const text =
        result.named_after > result.named_before
          ? `Address book synced: ${result.named_after} named contacts (was ${result.named_before}).`
          : result.named_after > 0
            ? `Address book already current: ${result.named_after} named contacts.`
            : "No contact names were received. The phone address book may be unavailable or synchronization incomplete.";
      return ok(text, result as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "get_contact",
    title: "Get WhatsApp contact details",
    description: `Full details for one contact: name, number, about text, profile picture URL,
whether they are a saved contact, a business, or blocked.`,
    schema: {
      contact_id: chatId.describe(
        "Contact id from search_contacts / list_chats, or a phone number",
      ),
    },
    write: false,
    handler: async ({ contact_id }, wa) => {
      const c = await wa.getContact(contact_id);
      const text = [
        `# ${c.name}`,
        `- **contact_id**: \`${c.contact_id}\``,
        c.number ? `- **number**: ${c.number}` : null,
        c.note ? `- **note**: ${c.note}` : null,
        c.about ? `- **about**: ${c.about}` : null,
        c.profile_pic_url
          ? `- **profile picture**: ${c.profile_pic_url}`
          : null,
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
        ...info.participants.map(
          (p) =>
            `- ${p.name}${p.is_admin ? " (admin)" : ""} — \`${p.contact_id}\``,
        ),
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
disk on the machine running wazap. This path is not a ChatGPT download link; do not present it as a downloadable attachment. Images of 1 MB or less are also returned
inline so you can look at them.

Fails with MEDIA_UNAVAILABLE when WhatsApp has expired the file.`,
    schema: {
      message_id: messageId.describe("A message with has_media=true"),
      save_to: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Absolute directory to save into (default: <data-dir>/media)",
        ),
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
    name: "transcribe_audio",
    title: "Transcribe a WhatsApp voice message",
    description: `Turn a voice note or an audio message into text. The transcript is cached, so a
second call on the same message costs nothing, and from then on the message reads
as [voice message · 0:42] "what was said" in read_messages, get_recent_messages
and get_message, and its words become searchable through search_messages.

What it costs depends on how the user set transcription up: the local provider
(whisper.cpp) is free and the audio never leaves the machine, while the API
provider uploads the audio to a third-party service and is billed per minute.
Either way this is capped at 10 calls a minute.

TRANSCRIBE_UNAVAILABLE means transcription is off or unfinished on this machine;
the fix names the command the user has to run. Do not retry it.`,
    schema: {
      message_id: messageId.describe("A message whose type is voice or audio"),
      language: z
        .string()
        .min(2)
        .max(16)
        .optional()
        .describe(
          'ISO 639-1 code of what is spoken, e.g. "ro"; "auto" detects it. Omit to use the configured default.',
        ),
    },
    write: false,
    rate: 10,
    handler: async ({ message_id, language }, wa) => {
      const result = await wa.transcribeAudio(message_id, language);
      const clock =
        result.duration_seconds === undefined
          ? ""
          : ` ${clockLabel(result.duration_seconds)}`;
      const facts = [
        result.language,
        result.provider,
        result.cached ? "cached" : null,
      ]
        .filter(Boolean)
        .join(", ");
      return ok(
        `Transcribed${clock} (${facts}): "${result.text}"`,
        result as unknown as Record<string, unknown>,
      );
    },
  }),

  tool({
    name: "send_message",
    title: "Draft a WhatsApp text message",
    description: `Draft a text message. Does not send. Returns a draft_id and a preview of the
recipient and exact text. Show that preview to the user; after they say yes,
call confirm_send. A draft lasts 15 minutes.`,
    schema: {
      chat_id: chatId,
      text: z.string().min(1).max(65536).describe("The message text"),
      reply_to: messageId.optional().describe("Quote-reply to this message"),
      mention_ids: z
        .array(z.string().min(1))
        .max(50)
        .optional()
        .describe(
          "Chat ids to @-mention; include their names in the text yourself",
        ),
    },
    write: true,
    handler: async ({ chat_id, text, reply_to, mention_ids }, wa) => {
      return drafted(
        await wa.draft({
          kind: "text",
          chatId: chat_id,
          text,
          replyTo: reply_to,
          mentionIds: mention_ids,
        }),
      );
    },
  }),

  tool({
    name: "send_media",
    title: "Draft a WhatsApp media message",
    description: `Draft an image, video, audio file, document or GIF, from a local path on the machine
running wazap or from a public URL. Does not send. Exactly one of file_path / url.
Maximum 100 MB. Show the preview; after the user says yes, call confirm_send.
A GIF is sent with as_gif: an mp4 goes out looping, a .gif is converted to mp4
first (needs ffmpeg on the machine running wazap).`,
    schema: {
      chat_id: chatId,
      file_path: z
        .string()
        .min(1)
        .optional()
        .describe("Absolute path of a local file to send"),
      url: z
        .string()
        .url()
        .optional()
        .describe("Public http(s) URL to fetch and send"),
      caption: z
        .string()
        .max(1024)
        .optional()
        .describe("Text shown under the media"),
      as_document: z
        .boolean()
        .default(false)
        .describe("Send as a plain document instead of rendered media"),
      as_voice: z
        .boolean()
        .default(false)
        .describe("Send an audio file as a voice note (push-to-talk)"),
      as_gif: z
        .boolean()
        .default(false)
        .describe(
          "Send a .gif or an mp4 as a looping GIF, the way WhatsApp plays them",
        ),
    },
    write: true,
    handler: async (
      { chat_id, file_path, url, caption, as_document, as_voice, as_gif },
      wa,
    ) => {
      return drafted(
        await wa.draft({
          kind: "media",
          chatId: chat_id,
          source: { file_path, url },
          caption,
          asDocument: as_document,
          asVoice: as_voice,
          asGif: as_gif,
        }),
      );
    },
  }),

  tool({
    name: "send_poll",
    title: "Draft a WhatsApp poll",
    description: `Draft a poll. Does not send. Participants vote in WhatsApp; wazap cannot read
the votes back. Show the preview; after the user says yes, call confirm_send.`,
    schema: {
      chat_id: chatId,
      question: z.string().min(1).max(255).describe("The poll question"),
      options: z
        .array(z.string().min(1).max(100))
        .min(2)
        .max(12)
        .describe("Answer options (2-12)"),
      multi_select: z
        .boolean()
        .default(false)
        .describe("Allow voters to pick more than one option"),
    },
    write: true,
    handler: async ({ chat_id, question, options, multi_select }, wa) => {
      return drafted(
        await wa.draft({
          kind: "poll",
          chatId: chat_id,
          question,
          options,
          multiSelect: multi_select,
        }),
      );
    },
  }),

  tool({
    name: "send_location",
    title: "Draft a WhatsApp location",
    description: `Draft a map pin, optionally labelled with a place name and address. Does not
send. Show the preview; after the user says yes, call confirm_send.`,
    schema: {
      chat_id: chatId,
      latitude: z
        .number()
        .min(-90)
        .max(90)
        .describe("Latitude in decimal degrees"),
      longitude: z
        .number()
        .min(-180)
        .max(180)
        .describe("Longitude in decimal degrees"),
      name: z
        .string()
        .max(255)
        .optional()
        .describe("Place name shown on the pin"),
      address: z
        .string()
        .max(500)
        .optional()
        .describe("Street address shown under the name"),
    },
    write: true,
    handler: async ({ chat_id, latitude, longitude, name, address }, wa) => {
      return drafted(
        await wa.draft({
          kind: "location",
          chatId: chat_id,
          latitude,
          longitude,
          name,
          address,
        }),
      );
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
      return ok(
        `Edited ${message_id}:\n> ${sent.text}`,
        sent as unknown as Record<string, unknown>,
      );
    },
  }),

  tool({
    name: "react_to_message",
    title: "React to a WhatsApp message",
    description:
      "Add an emoji reaction to a message, or pass an empty string to remove your reaction.",
    schema: {
      message_id: messageId,
      emoji: z
        .string()
        .max(8)
        .describe('A single emoji such as "👍", or "" to remove your reaction'),
    },
    write: true,
    handler: async ({ message_id, emoji }, wa) => {
      const result = await wa.reactToMessage(message_id, emoji);
      const text = emoji
        ? `Reacted ${emoji} to ${message_id}`
        : `Removed the reaction from ${message_id}`;
      return ok(text, result as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "forward_message",
    title: "Draft a forwarded WhatsApp message",
    description: `Draft a forward of an existing message to another chat. Does not send. The
recipient will see it marked as forwarded. Show the preview; after the user
says yes, call confirm_send.`,
    schema: {
      message_id: messageId,
      to_chat_id: chatId.describe("Destination chat"),
    },
    write: true,
    handler: async ({ message_id, to_chat_id }, wa) => {
      return drafted(
        await wa.draft({
          kind: "forward",
          chatId: to_chat_id,
          messageId: message_id,
        }),
      );
    },
  }),

  tool({
    name: "confirm_send",
    title: "Send a drafted WhatsApp message",
    description: `Send a draft created by send_message, send_media, send_poll, send_location or
forward_message, after explicit user approval. Repeated confirmations return
an existing receipt without sending again. SEND_OUTCOME_UNKNOWN means delivery
may have succeeded: do not resend automatically. A missing or expired draft
requires a new preview and approval.`,
    schema: {
      draft_id: z
        .string()
        .min(1)
        .describe("The draft_id returned by a send_* tool"),
    },
    write: true,
    handler: async ({ draft_id }, wa) => {
      const sent = await wa.confirm(draft_id);
      return ok(sentText(sent), sent as unknown as Record<string, unknown>);
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
      for_everyone: z
        .boolean()
        .default(false)
        .describe(
          "Retract for all participants (WhatsApp supports no other kind of delete here)",
        ),
    },
    write: true,
    destructive: true,
    handler: async ({ message_id, for_everyone }, wa) => {
      const result = await wa.deleteMessage(message_id, for_everyone);
      return ok(
        `Deleted ${message_id} for everyone`,
        result as unknown as Record<string, unknown>,
      );
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
        .enum([
          "archive",
          "unarchive",
          "pin",
          "unpin",
          "mute",
          "unmute",
          "mark_read",
          "mark_unread",
        ])
        .describe("What to do with the chat"),
      mute_hours: z
        .number()
        .int()
        .min(1)
        .max(720)
        .optional()
        .describe('Hours to mute, default 8; only used by "mute"'),
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
      participant_ids: z
        .array(z.string().min(1))
        .min(1)
        .max(256)
        .describe("Chat ids or phone numbers to add (1-256)"),
    },
    write: true,
    handler: async ({ name, participant_ids }, wa) => {
      const result = await wa.createGroup(name, participant_ids);
      const text = [
        `Group "${name}" created: ${result.chat_id}`,
        ...renderParticipants(result.participants),
      ].join("\n");
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
      participant_ids: z
        .array(z.string().min(1))
        .max(256)
        .optional()
        .describe("Targets of add/remove/promote/demote"),
      value: z
        .string()
        .max(2048)
        .optional()
        .describe("New subject or description"),
    },
    write: true,
    destructive: true,
    handler: async ({ group_id, action, participant_ids, value }, wa) => {
      const result = await wa.manageGroup(
        group_id,
        action,
        participant_ids,
        value,
      );
      const text = [
        result.applied,
        ...renderParticipants(result.participants ?? []),
      ].join("\n");
      return ok(text, result as unknown as Record<string, unknown>);
    },
  }),
];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

export interface RegisterOpts {
  allowWrite: boolean;
  context?: AccessContext;
}

/** Derived, so a second rated tool cannot inherit a message naming the wrong budget. */
function rateLabel(name: string): string {
  const verb = name.split("_")[0] ?? name;
  return verb.charAt(0).toUpperCase() + verb.slice(1);
}

/**
 * One bucket per rated tool for the whole process: an HTTP client
 * re-initializing gets a new McpServer on every session, and a cap that
 * resets with it would be no cap at all.
 */
const RATE_BUCKETS = new Map<string, RateLimiter>(
  TOOLS.flatMap((def) =>
    def.rate === undefined
      ? []
      : [
          [
            def.name,
            new RateLimiter(def.rate, undefined, rateLabel(def.name)),
          ] as const,
        ],
  ),
);

export function registerTools(
  server: McpServer,
  wa: WhatsAppApi | AccountManager,
  opts: RegisterOpts,
): void {
  for (const def of TOOLS) {
    if (
      !GLOBAL_TOOLS.has(def.name) &&
      !SINGLE_TOOLS.has(def.name) &&
      !AGGREGATE_TOOLS.has(def.name)
    )
      throw Error(`Missing account scope for ${def.name}`);
    if (def.write && !opts.allowWrite) continue;
    const own = RATE_BUCKETS.get(def.name);
    server.registerTool(
      def.name,
      {
        title: def.title,
        outputSchema: toolOutputSchema(def.name),
        description: def.description,
        inputSchema: GLOBAL_TOOLS.has(def.name)
          ? def.schema
          : {
              ...def.schema,
              account_id: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Stable account_id from list_accounts; required when multiple profiles exist",
                ),
              ...(AGGREGATE_TOOLS.has(def.name)
                ? {
                    account_ids: z
                      .array(z.string().min(1))
                      .min(1)
                      .max(100)
                      .optional(),
                    all_accounts: z
                      .boolean()
                      .optional()
                      .describe(
                        "Read all authorized account archives; each result retains its account",
                      ),
                  }
                : {}),
            },
        annotations: def.write
          ? {
              ...WRITE_HINTS,
              destructiveHint: def.destructive === true,
              idempotentHint: def.name === "confirm_send",
            }
          : def.name === "transcribe_audio" || def.name === "link_account"
            ? WRITE_HINTS
            : def.local
              ? LOCAL_HINTS
              : { ...READ_ONLY_HINTS, openWorldHint: def.name !== "learn" },
      },
      async (args: unknown): Promise<ToolResult> => {
        try {
          own?.take();
          return await accessContext.run(
            opts.context ?? {
              principal: "local",
              allowWrite: opts.allowWrite,
              local: true,
            },
            async () => {
              const input = args as ToolArgs;
              if (!(wa instanceof AccountManager))
                return def.handler(input, wa);
              wa.validateAccess();
              if (def.name === "list_accounts") {
                await wa.refresh();
                const accounts = wa.list();
                return ok(
                  accounts
                    .map(
                      (a) =>
                        `${a.account_name} — ${a.account_id}: ${a.status}${a.read_only ? " (read-only)" : ""}`,
                    )
                    .join("\n"),
                  { accounts },
                );
              }
              if (def.name === "learn")
                return def.handler(input, {} as WhatsAppApi);
              const selectors =
                Number(input.account_id !== undefined) +
                Number(input.account_ids !== undefined) +
                Number(input.all_accounts === true);
              if (selectors > 1)
                throw new WazapError(
                  "INVALID_ID",
                  "Use account_id, account_ids or all_accounts, not several selectors.",
                );
              if (
                AGGREGATE_TOOLS.has(def.name) &&
                (input.account_ids !== undefined || input.all_accounts === true)
              )
                return aggregate(wa, def.name, input);
              let id = input.account_id as string | undefined;
              let routed = input;
              if (def.name === "confirm_send") {
                const draft = wa.draftAccount(String(input.draft_id), id);
                id = draft.account.id;
                routed = { ...input, draft_id: draft.draftId };
              }
              return wa.withAccount(
                id,
                def.write,
                async (api, account) => {
                  const origin = {
                    account_id: account.id,
                    account_name: account.name,
                  };
                  if (
                    ["get_recent_messages", "wait_for_messages"].includes(
                      def.name,
                    ) &&
                    typeof routed.cursor === "string"
                  ) {
                    const prefix = `ac1.${account.id}.`;
                    if (routed.cursor.startsWith(prefix))
                      routed = {
                        ...routed,
                        cursor: Buffer.from(
                          routed.cursor.slice(prefix.length),
                          "base64url",
                        ).toString(),
                      };
                    else if (
                      account.id !== "default" ||
                      wa.accounts.list().length !== 1 ||
                      routed.cursor.startsWith("ac1.")
                    )
                      throw new WazapError(
                        "ACCOUNT_MISMATCH",
                        "This cursor belongs to another account. Start again.",
                      );
                  }
                  const result = await def.handler(routed, api);
                  for (const key of ["cursor", "next_cursor"]) {
                    const value = result.structuredContent?.[key];
                    if (typeof value === "string") {
                      const wrapped = `ac1.${account.id}.${Buffer.from(value).toString("base64url")}`;
                      result.structuredContent![key] = wrapped;
                      result.content = result.content.map((b) =>
                        b.type === "text"
                          ? { ...b, text: b.text.replaceAll(value, wrapped) }
                          : b,
                      );
                    }
                  }
                  if (result.structuredContent?.draft_id) {
                    const old = String(result.structuredContent.draft_id),
                      next = `${account.id}:${old}`;
                    result.structuredContent.draft_id = next;
                    result.content = result.content.map((b) =>
                      b.type === "text"
                        ? { ...b, text: b.text.replaceAll(old, next) }
                        : b,
                    );
                  }
                  result.structuredContent = {
                    ...(annotate(result.structuredContent, origin) as Record<
                      string,
                      unknown
                    >),
                    ...origin,
                  };
                  result.content.unshift({
                    type: "text",
                    text: `Account: ${account.name} (${account.id})`,
                  });
                  return result;
                },
                def.name === "link_account" ? String(input.phone) : undefined,
              );
            },
          );
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
    lines.push(
      `## ${c.name}${flags.length ? ` [${flags.join(", ")}]` : ""}${c.note ? ` · ${c.note}` : ""}`,
    );
    lines.push(`- **chat_id**: \`${c.chat_id}\``);
    if (c.last_message) {
      lines.push(
        `- **last**: ${c.last_message.from_me ? "me: " : ""}${truncate(c.last_message.text, 160)} (${c.last_message.timestamp})`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** A date or an ISO timestamp as epoch ms; a bare date for `until` means the end of that day. */
function parseMoment(
  value: string | undefined,
  field: string,
  endOfDay = false,
): number | undefined {
  if (value === undefined) return undefined;
  const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  const ms = Date.parse(
    bareDate
      ? `${value.trim()}T${endOfDay ? "23:59:59.999" : "00:00:00"}`
      : value,
  );
  if (Number.isNaN(ms)) {
    throw new WazapError(
      "INVALID_ID",
      `${field} is not a date: "${value}".`,
      'Pass "2026-09-01" or an ISO timestamp like "2026-09-01T14:00:00+03:00"',
    );
  }
  return ms;
}

function newestFirst(messages: MessageView[]): string[] {
  return [...messages]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map((m) => m.message_id);
}

/** message_id → "preview 3", numbered the way the image blocks are attached. */
function previewLabels(previews: Preview[]): Map<string, string> {
  return new Map(previews.map((p, i) => [p.message_id, `preview ${i + 1}`]));
}

function previewBlocks(previews: Preview[]): ContentBlock[] {
  return previews.map((p) => ({
    type: "image",
    data: p.base64,
    mimeType: p.mime,
  }));
}

/** The line under the title that says what was attached and what could not be. */
function previewNote(
  messages: MessageView[],
  previews: Preview[],
  asked: boolean,
): string | null {
  if (!asked) return null;
  const photos = messages.filter((m) => m.type === "image").length;
  const missing = photos - previews.length;
  const parts = [
    previews.length > 0
      ? `${previews.length} preview${previews.length === 1 ? "" : "s"} attached, numbered in the order of the image blocks`
      : null,
    missing > 0
      ? `${missing} photo${missing === 1 ? "" : "s"} without a preview (over the ${MAX_PREVIEWS} per call, expired, not JPEG, or out of time; call again for more)`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `${parts.join("; ")}.` : null;
}

/** The sender's name, with the user's note on them the first time they appear in this rendering. */
function senderLabel(m: MessageView, introduced: Set<string>): string {
  if (m.from_me) return "me";
  if (!m.sender.note || introduced.has(m.sender.id)) return m.sender.name;
  introduced.add(m.sender.id);
  return `${m.sender.name} · ${m.sender.note}`;
}

function renderMessages(
  title: string,
  messages: MessageView[],
  labels: Map<string, string> = new Map(),
  note: string | null = null,
): string {
  if (messages.length === 0) return `${title}: no messages found.`;
  const lines = [`# ${title} (${messages.length})`, ""];
  if (note) lines.splice(1, 0, note);
  const introduced = new Set<string>();
  for (const m of messages) {
    const tags = [
      labels.get(m.message_id) ?? null,
      m.type !== "text" ? m.type : null,
      m.forwarded ? "forwarded" : null,
      m.edited ? "edited" : null,
      m.quoted ? "reply" : null,
      m.reactions?.length ? m.reactions.map((r) => r.emoji).join("") : null,
    ].filter(Boolean);
    lines.push(
      `- **${senderLabel(m, introduced)}** · ${m.age}${tags.length ? ` [${tags.join(", ")}]` : ""} · id: \`${m.message_id}\``,
    );
    if (m.quoted) lines.push(`  > ${truncate(m.quoted.text, 160)}`);
    lines.push(`  ${truncate(m.text, 500)}`);
  }
  return lines.join("\n");
}

function renderConversations(
  conversations: RecentConversation[],
  hours: number,
  labels: Map<string, string> = new Map(),
  note: string | null = null,
): string {
  if (conversations.length === 0)
    return `No WhatsApp conversations in the last ${hours}h.`;
  const total = conversations.reduce((n, c) => n + c.messages.length, 0);
  const lines = [
    `# WhatsApp · last ${hours}h (${conversations.length} chats, ${total} messages)`,
    "",
  ];
  if (note) lines.splice(1, 0, note);
  for (const c of conversations) {
    lines.push(
      `## ${c.chat_name}${c.type === "group" ? " [group]" : ""}${c.note ? ` · ${c.note}` : ""} — \`${c.chat_id}\``,
    );
    const introduced = new Set<string>();
    for (const m of c.messages) {
      const label = labels.get(m.message_id);
      lines.push(
        `- [${m.timestamp}] ${senderLabel(m, introduced)}: ${truncate(m.text, 500)}${label ? ` (${label})` : ""}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderStories(
  stories: MessageView[],
  hours: number,
  labels: Map<string, string>,
  note: string | null,
): string {
  if (stories.length === 0) return `No stories in the last ${hours}h.`;
  const lines = [`# Stories · last ${hours}h (${stories.length})`, ""];
  if (note) lines.splice(1, 0, note);
  let author = "";
  for (const m of stories) {
    if (m.sender.id !== author) {
      author = m.sender.id;
      lines.push(`## ${m.sender.name} — \`${m.sender.id}\``);
    }
    const label = labels.get(m.message_id);
    lines.push(
      `- ${m.age} · ${truncate(m.text, 300)}${label ? ` (${label})` : ""} · id: \`${m.message_id}\``,
    );
  }
  return lines.join("\n");
}

function renderUnanswered(
  chats: UnansweredChat[],
  minAgeHours: number,
): string {
  const since = minAgeHours > 0 ? ` for ${minAgeHours}h or more` : "";
  if (chats.length === 0)
    return `No follow-up candidates found in the available messages${since}.`;
  const lines = [
    `# Possible follow-ups${since} (${chats.length})`,
    "Heuristic candidates; a reply may already have been handled elsewhere.",
    "",
  ];
  chats.forEach((c, i) => {
    const who =
      (c.type === "group"
        ? `${c.name} [group] — ${c.ask.sender.name}`
        : `${c.name}${c.business ? " [business]" : ""}`) +
      (c.note ? ` · ${c.note}` : "");
    const more =
      c.messages_since_you > 1
        ? `, ${c.messages_since_you} messages since yours`
        : "";
    lines.push(`${i + 1}. **${who}** · ${c.age}${more} — \`${c.chat_id}\``);
    lines.push(`   > ${truncate(c.ask.text, 300)}`);
    lines.push(`   ask id: \`${c.ask.message_id}\``);
  });
  return lines.join("\n");
}

function renderWait(result: WaitResult): string {
  const tail = [
    `cursor: \`${result.cursor}\``,
    result.cursor_reset
      ? "The cursor was from another run; this wait started from now."
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  if (result.messages.length === 0)
    return `Nothing arrived before the timeout.\n${tail}`;
  const lines = [
    `# ${result.messages.length} new message${result.messages.length === 1 ? "" : "s"}`,
    "",
  ];
  let chat = "";
  const introduced = new Set<string>();
  for (const m of result.messages) {
    if (m.chat_id !== chat) {
      chat = m.chat_id;
      lines.push(`## \`${chat}\``);
    }
    lines.push(
      `- [${m.timestamp}] ${senderLabel(m, introduced)}: ${truncate(m.text, 500)} · id: \`${m.message_id}\``,
    );
  }
  lines.push("", tail);
  return lines.join("\n");
}

function renderContacts(query: string, contacts: ContactSummary[]): string {
  if (contacts.length === 0) return `No contacts matching "${query}".`;
  const lines = [`# Contacts matching "${query}" (${contacts.length})`, ""];
  for (const c of contacts) {
    const flags = [
      c.is_my_contact ? "saved" : null,
      c.is_business ? "business" : null,
    ].filter(Boolean);
    lines.push(
      `- **${c.name}**${flags.length ? ` [${flags.join(", ")}]` : ""}${c.note ? ` · ${c.note}` : ""} — \`${c.contact_id}\`${c.number ? ` (${c.number})` : ""}`,
    );
  }
  return lines.join("\n");
}

function renderParticipants(
  participants: Array<{ id: string; status: string; reason?: string }>,
): string[] {
  return participants.map(
    (p) => `- ${p.id}: ${p.status}${p.reason ? ` (${p.reason})` : ""}`,
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function drafted(view: DraftView): ToolResult {
  return ok(renderDraft(view), { ...view });
}

function sentText(sent: SentMessage): string {
  return `Sent to ${sent.chat_id} at ${sent.timestamp} (message_id: ${sent.message_id}):\n> ${sent.text}`;
}
