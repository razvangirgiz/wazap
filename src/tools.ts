import { z } from "zod";
import type { AccountSource } from "./account-hub.js";
import { renderGetStatus, renderListAccounts } from "./account-resolve.js";
import { draftContextEnabled } from "./accounts.js";
import {
  createToolRegistrar,
  type ContentBlock,
  type ToolArgs,
  type ToolCtx,
  type ToolDef,
  type ToolResult,
} from "./tool-runtime.js";
export { toolError, type ToolCtx, type RegisterOpts } from "./tool-runtime.js";
import { compactConversations, renderCompact } from "./compact.js";
import { coverageNote, indexCoverageNote, searchCoverage } from "./coverage.js";
import { describeTarget, looksUnnamed, renderDraft, type DraftPayload, type DraftView } from "./drafts.js";
import { ERROR_GUIDE, WazapError } from "./errors.js";
import { FIND_CONTACT_OUTPUT, runFindContact } from "./find-contact.js";
import { freshnessNote, readFreshness } from "./freshness.js";
import { mediaCaptionOf } from "./media-details.js";
import { getMessageView, getMessageViewAcross, resolveMessageId, resolveMessageIdAcross } from "./message-ref.js";
import { clockLabel } from "./messages.js";
import {
  assertSendable,
  draftTargetOf,
  hasSendRules,
  noteConfirming,
  noteDraftTarget,
  sendPolicyOf,
  type SendPolicy,
} from "./send-guard.js";
import {
  nameSourceOf,
  resolveSenderFilter,
  withSenderIdentity,
  type IdentifiedMessage,
  type IdentifiedRecallAnswer,
} from "./sender-identity.js";
import { MESSAGE_TYPES } from "./wa-types.js";
import type {
  ChatSummary,
  ContactSummary,
  JoinGroupResult,
  JoinRequest,
  MessageView,
  OutgoingTarget,
  RecallAnswer,
  RecentConversation,
  SentMessage,
  SearchAnswer,
  Synced,
  Preview,
  UnansweredChat,
  WaitResult,
  WhatsAppApi,
} from "./wa-types.js";

export { anyAccountAllowsWrites } from "./account-resolve.js";

const ACCOUNT_ID = z
  .string()
  .min(1)
  .describe(
    "Registry account id (default, work, …). Omit to resolve from chat_id or message_id, or the default account."
  );

function tool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  schema: S;
  outputSchema?: z.ZodRawShape;
  write: boolean;
  destructive?: boolean;
  local?: boolean;
  rate?: number;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolCtx) => Promise<ToolResult>;
}): ToolDef {
  return {
    ...def,
    schema: { ...def.schema, account_id: ACCOUNT_ID.optional() },
    handler: def.handler as (args: ToolArgs, ctx: ToolCtx) => Promise<ToolResult>,
  };
}

function ok(text: string, structured: Record<string, unknown>, extra: ContentBlock[] = []): ToolResult {
  return { content: [{ type: "text", text }, ...extra], structuredContent: structured };
}

function synced<T>(result: Synced<T>, rest: Record<string, unknown>): Record<string, unknown> {
  return { ...rest, sync: result.sync };
}

/** `scan_capped`, and how far back a capped search got: older messages were not searched, which is not "none exist". */
function scanCapFields(result: SearchAnswer): Record<string, unknown> {
  return result.scanCapped === undefined
    ? { scan_capped: false }
    : { scan_capped: true, searched_back_to: result.scanCapped.searchedBackTo };
}

function scanCapNote(result: SearchAnswer): string | null {
  if (result.scanCapped === undefined) return null;
  return `The search stopped at its scan limit; messages before ${result.scanCapped.searchedBackTo.slice(0, 10)} were not searched — narrow it with chat_id, since/until or a longer query.`;
}

const chatId = z
  .string()
  .min(1)
  .describe(
    'Chat id as returned by another tool ("<digits>@s.whatsapp.net" or "<id>@g.us"), or a phone number in international format'
  );

const messageId = z
  .string()
  .min(5)
  .describe(
    'Message id from read_messages / search_messages / get_message, e.g. "false_4072...@s.whatsapp.net_3EB0..."'
  );

const messageTypes = z
  .array(z.enum([...MESSAGE_TYPES]))
  .optional()
  .describe(
    'Keep only these message types; omit for every type. The limit counts matching messages, so ["call"] returns that many calls, not that many messages of which some are calls.'
  );

const includePreviews = z
  .boolean()
  .default(false)
  .describe(
    "Attach a small JPEG of each photo, newest first, up to 12 per call, so you can see what was sent: the preview WhatsApp shipped when there is one, otherwise the photo is downloaded once and shrunk on the machine running wazap"
  );

/** Previews are 5-15 KB each; a dozen keep one answer small and the first call under the client's timeout. */
const MAX_PREVIEWS = 12;

const GUIDE = `# wazap — WhatsApp for your AI agent

Read/write access to the user's linked WhatsApp account: chats, messages, media,
contacts and groups. Call get_status first if anything looks wrong, and
link_account when it says no account is linked yet.

## Identifiers
- chat_id — individual: \`<digits>@s.whatsapp.net\`; group: \`<id>@g.us\`. A phone
  number in international format (+15550100 or 15550100) also works. Pass
  ids back exactly as a tool returned them.
- message_id — the full id from read_messages / search_messages. Needed for
  get_message, download_media, react_to_message, edit_message, forward_message,
  delete_message, manage_chat's pin_message / unpin_message / star_message /
  unstar_message, join_group on an invite message, and the reply_to of
  send_message.
- account_id — registry slug (\`default\`, \`work\`). Optional on every tool.
  Several accounts: call list_accounts first and pass account_id. A send
  to a chat no account knows, with two or more accounts, fails
  AMBIGUOUS_ACCOUNT; it never falls back to the default.

## Workflows
- Several accounts: call list_accounts first. Pass account_id on the tools
  that follow. Without it, a chat or message that only one account knows
  selects that account; a chat none of them know uses the default for reads
  and fails AMBIGUOUS_ACCOUNT for writes. link_account needs an account that
  already exists (\`wazap account add\`).
- Not linked: get_status says not_linked, logged_out, session_corrupt or
  auth_failure → link_account(phone), show the user the code, then poll
  get_status every 10 s until it says connected.
- Catch up: get_recent_messages(hours) for everything, or list_chats(filter:"unread")
  then read_messages(chat_id). Pass include_previews: true to see the photos as
  small images instead of "[image]".
- Who is waiting on the user: get_unanswered. It returns only chats whose last
  word is theirs and asks for something, with the ask quoted. When the user
  says they dealt with one outside WhatsApp, mark_handled(chat_id) takes it
  off the list until they write again.
- Who is who: set_contact_note(contact_id, note) remembers what the user
  says about a person, locally; the note then shows next to their name.
  update_contact_details files tags and key-value details ("role": "contabil"),
  which search_contacts matches — so "the accountant" resolves, and tag:
  "furnizori" lists everyone filed under it. All of it stays on this machine.
- Stories: get_stories lists the status updates received in the last day, by
  author; they show nowhere else.
- Stay on the line: wait_for_messages blocks up to 55 s until something arrives,
  and returns a cursor; call it again with that cursor to miss nothing between
  calls. Pass addressed_to_me to wake only for direct messages, @-mentions and
  replies to the user.
- Go back further: read_messages(chat_id, before: <oldest message_id you have>).
- Find a person: find_contact(name[, qualifier]) before drafting to anyone the
  user names — "mama", "Ana de la contabilitate", "Mișu". resolved gives the
  chat_id and, in a write session, how the user writes to them; ambiguous and
  not_found mean ask the user, never guess. search_contacts → get_contact
  still list and detail contacts. Names come from the phone's own address
  book; find_contact asks WhatsApp for it once when it is empty, and
  sync_contacts does it on demand. save_contact adds a number to the account's WhatsApp
  contacts or renames an entry; remove_contact drops the entry, not the chat.
  A word from a tag or a detail also finds them ("contabil" → role: contabil),
  and search_contacts({tag: "client"}) lists everyone filed under a tag.
- Find something said: search_messages(query[, chat_id]) for the exact words,
  or recall(query[, chat_id]) for what was meant — a paraphrase or another
  language still hits. Both reach every message the account keeps.
- Send: send_message / send_media / send_poll / send_location / forward_message
  draft only. They return a draft_id and a preview. Show the preview to the
  user; after they say yes, call confirm_send({ draft_id }). That is the only
  call that reaches WhatsApp. A draft lasts 15 minutes. A text draft may carry
  style_check.warnings (language, diacritics, tu/dumneavoastră, length against
  how the user writes in that chat): unless the user dictated the words, fix
  them and draft again before showing it.
- Mention someone: pass mention_ids to send_message and write @<number> in the
  text where the mention belongs (the digits of their id). A mention the text
  lacks gets its @<number> added at the end, and the preview shows the result.
- Send rules: an account may restrict who it messages (wazap config send) —
  an allowlist limits sends to its entries, a deny list refuses its own. A
  refused recipient fails SEND_BLOCKED at draft time and again at confirm_send;
  do not retry or route around it, tell the user. A draft flagged
  unnamed_recipient goes to someone outside the address book: the name shown
  is their public profile name, not a saved contact — say so to the user.
- Profile picture: set_profile_picture changes the linked account's photo;
  manage_group set_picture / remove_picture changes a group's. Show the image
  and wait for a yes first; these calls hit WhatsApp immediately.
- Media: a message with has_media=true → download_media(message_id).
- Groups: get_group_info before manage_group; most actions need admin rights.
  get_group_info also says who may edit the info (info_locked), who may add
  members (member_add_mode), whether joins need approval (join_approval) and
  how long messages last (disappearing_seconds, 0 when off). As an admin,
  manage_group list_join_requests shows who is waiting, approve_join_requests /
  reject_join_requests decide, and set_announcement_only, set_info_locked,
  set_add_mode, set_join_approval and set_disappearing change the settings.
  Every change is visible to all members at once: say what will change and
  wait for an explicit yes. delete_message takes someone else's message for
  everyone only in a group where the linked account is an admin.
- Join a group: join_group with the invite link, or with the message_id of an
  "invite" message, previews the group (name, description, members, whether an
  admin must approve). Show it; after a yes, call it again with confirm: true.
- Tidy a chat: manage_chat pin_message / unpin_message pins a message for
  everyone in the chat (pin_hours 24, 168 or 720), star_message / unstar_message
  stars it for the account only, clear empties the chat and delete removes it
  for the linked account only, and block / unblock take a person's chat. They
  hit WhatsApp at once: say what will happen and wait for a yes.
- Delete a message: delete_message with for_everyone: true retracts it for
  everyone; for_everyone: false removes it from the linked account's devices
  only, anyone's message at any age, and nobody else sees a change.

## Message shape
Every message has non-empty \`text\`: media and system messages carry a
placeholder like "[image] caption", "[voice message]", "[deleted]", "[poll] question".
A sender whose name WhatsApp has never given us reads as their phone number, or
as "unknown (lid …1234)" when even that is unknown — never as raw LID digits,
which look like a phone number and are not one.
WhatsApp's own notices (device linking, group membership, encryption) have
\`type: "system"\` and are left out of get_recent_messages unless you pass
include_system: true.
A group notice says who made which change: "[Medeea added Ana (40723124956)]",
with \`system: {action, actor, targets, value}\` naming the same people. Report
a membership change from there; never pair a new member with whoever posted
nearby. A pin reads as "[Medeea pinned a message]", and \`system.value\` is the
message_id of the message pinned.
An event has \`type: "event"\` and reads as "[event] Botez · 2026-09-20T12:00:00+03:00 ·
Biserica" with its description after it, or "[canceled event] …". A group invite
has \`type: "invite"\` and reads as "[group invite] Familia"; the invite code is
never shown, and join_group takes the message_id instead.
A message that @-mentions people carries \`mentions: [{id, name}]\`, each person
once; read_messages tags it "mentions Ana, Dan".
Reactions ride on the message they answer: read_messages tags them as
"❤️×2 😍", and get_message lists each one with who left it.
Votes ride on their poll the same way: a poll carries
\`poll: {question, options: [{name, votes, voters}], voters}\`, read_messages
tags it "3 votes" and get_message lists each option as "Da (2): Ana, Dan". An
event carries \`event_responses: {going, maybe, not_going}\`, tagged "2 going".
The votes are the ones that reached this device. A vote whose poll is not
loaded reads as "[vote on a poll that is not loaded]" until the poll arrives.
The user's own messages carry \`delivery: {status, read_by, delivered_to}\`.
\`status\` is "sent" (WhatsApp's server has it), "delivered" (it reached the
other phone), "read", "played" (a voice note or video was played), "pending"
(not yet on the server) or "error" (it failed to send). In a group it is the
furthest any one member got, and \`read_by\` / \`delivered_to\` name each member
with the time. read_messages tags it "read", or "read by 3" in a group, and
get_message lists who. Only receipts that reached this device count: with read
receipts off on either side a message stops at "delivered", a large group may
send no receipts at all, and a message WhatsApp said nothing about has no
\`delivery\`.
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
"not_linked" means the user must run \`npx wazap-mcp login\`), whether the initial
history sync has finished, which account is linked, how fresh the local history
is — \`history\` shows when a message last arrived and flags \`stale\` when the
phone has been quiet for a day while connected — the versions and data
directory in use, and how many contacts carry a name from
the phone's address book (contacts_named: 0 means it never arrived).
\`webhook.delivery\` counts the account's webhook events: delivered (last 7
days), failed and cancelled (last 30), pending; a non-zero
\`consecutive_failures\` or \`retrying\` means the receiver is refusing or
unreachable right now, and \`last_failure\` says how.

Call this whenever another tool reports NOT_CONNECTED, NOT_LINKED or
SYNC_IN_PROGRESS, or to confirm which account you are about to send from.
Without account_id the top-level fields are the default account, plus
\`accounts\` listing every live one. While a link is in progress the status
is "linking" and \`pairing\` carries the code the user still has to type
into their phone.`,
    schema: {},
    write: false,
    handler: async (_args, { wa, hub, allowWrite }) => renderGetStatus(wa.getStatus(), allowWrite, hub),
  }),

  tool({
    name: "list_accounts",
    title: "List WhatsApp accounts on this server",
    description: `List every configured WhatsApp account: id, name, connection status, masked
phone, owner name, and whether that account allows writes. Call this first
when more than one account is linked, then pass account_id on the other tools.
Takes no arguments besides the optional account_id (ignored for the listing).`,
    schema: {},
    write: false,
    handler: async (_args, { hub }) => renderListAccounts(hub),
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
The account must already exist (\`wazap account add\`). Pass account_id when
more than one is configured. An unknown id is ACCOUNT_NOT_FOUND.
Never call this when the account is already linked.`,
    schema: { phone: z.string().describe("International format, e.g. +15550100") },
    write: false,
    rate: 2,
    handler: async ({ phone }, { wa }) => {
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
        .describe('Which chats to list; "all" (default) excludes archived ones'),
      limit: z.number().int().min(1).max(100).default(20).describe("Maximum number of chats (1-100)"),
    },
    write: false,
    handler: async ({ filter, limit }, { wa }) => {
      const result = await wa.listChats(filter, limit);
      return ok(
        renderChats(result.data, filter),
        synced(result, { filter, count: result.data.length, chats: result.data })
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
      limit: z.number().int().min(1).max(200).default(20).describe("Maximum number of messages (1-200)"),
      before: messageId.optional().describe("Return the messages immediately older than this message_id"),
      types: messageTypes,
      include_previews: includePreviews,
    },
    write: false,
    handler: async ({ chat_id, limit, before, types, include_previews }, { wa }) => {
      const result = await wa.readMessages(chat_id, limit, before, types);
      const previews = include_previews ? await wa.previews(newestFirst(result.data), MAX_PREVIEWS) : [];
      return ok(
        renderMessages(
          `Messages in ${chat_id}`,
          result.data,
          previewLabels(previews),
          previewNote(result.data, previews, include_previews)
        ),
        synced(result, {
          chat_id,
          types,
          count: result.data.length,
          preview_count: previews.length,
          messages: result.data,
        }),
        previewBlocks(previews)
      );
    },
  }),

  tool({
    name: "get_recent_messages",
    title: "Get every WhatsApp conversation from the last N hours",
    description: `Everything that happened recently, grouped by chat. This is the catch-up tool:
one call instead of list_chats plus a read_messages per chat. WhatsApp's own
notices — device linking, group membership changes, encryption notices — are left
out so the counts are conversation; pass include_system to see them. A chat
lists at most its newest 2,000 messages of the window.`,
    schema: {
      hours: z.number().int().min(1).max(168).default(24).describe("Look-back window in hours (1-168)"),
      filter: z
        .enum(["all", "unread", "groups", "individual"])
        .default("all")
        .describe("Restrict to unread chats, groups, or one-to-one chats"),
      include_system: z
        .boolean()
        .default(false)
        .describe(
          "Include WhatsApp's own system notices, which are excluded from the bodies and the counts by default"
        ),
      types: messageTypes,
      include_previews: includePreviews,
      compact: z
        .boolean()
        .default(false)
        .describe(
          "Leave out media without a caption and messages with no words in them, fold what one person sent in a row into one line, and say per chat what was left out. About half the size; use it for a routine catch-up"
        ),
    },
    write: false,
    handler: async ({ hours, filter, include_system, types, include_previews, compact }, { wa }) => {
      const result = await wa.getRecentMessages(hours, filter, include_system, types);
      if (compact) {
        const conversations = compactConversations(result.data);
        return ok(
          renderCompact(conversations, hours),
          synced(result, { hours, filter, compact: true, conversation_count: conversations.length, conversations })
        );
      }
      const messageCount = result.data.reduce((n, c) => n + c.messages.length, 0);
      const all = result.data.flatMap((c) => c.messages);
      const previews = include_previews ? await wa.previews(newestFirst(all), MAX_PREVIEWS) : [];
      return ok(
        renderConversations(result.data, hours, previewLabels(previews), previewNote(all, previews, include_previews)),
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
        previewBlocks(previews)
      );
    },
  }),

  tool({
    name: "get_unanswered",
    title: "Find who is waiting on the user",
    description: `Chats where the last word is theirs and it asks for something: a question, a
request ("poți", "te rog", "can you", "when"…), or a voice note nobody has heard
yet. A conversation that ended in "ok, thanks" is not listed, and neither is an
ask older than max_age_hours (two weeks by default): that one was abandoned, not
left waiting. Groups count only when the user was @-mentioned or replied to
after their own last message. A [business] account's ask is often an automatic
reply; weigh it accordingly.

People come first, then the oldest wait. Each entry quotes the ask, says how
many of their messages arrived since the user's last one, and how long they
have been waiting. This is the follow-up half of an inbox triage; use
get_recent_messages for what happened, and this for who is still waiting.`,
    schema: {
      min_age_hours: z
        .number()
        .min(0)
        .max(8760)
        .default(0)
        .describe("Only asks at least this old, e.g. 48 for people the user forgot for two days"),
      max_age_hours: z
        .number()
        .min(1)
        .max(8760)
        .default(336)
        .describe("Ignore asks older than this; an ask left for two weeks (the default) is abandoned, not waiting"),
      limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of chats (1-50)"),
    },
    write: false,
    handler: async ({ min_age_hours, max_age_hours, limit }, { wa }) => {
      const result = await wa.getUnanswered(min_age_hours, max_age_hours, limit);
      return ok(
        renderUnanswered(result.data, min_age_hours),
        synced(result, { min_age_hours, max_age_hours, count: result.data.length, chats: result.data })
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
      hours: z.number().int().min(1).max(24).default(24).describe("Look-back window in hours (1-24)"),
      include_previews: includePreviews,
    },
    write: false,
    handler: async ({ hours, include_previews }, { wa }) => {
      const result = await wa.getStories(hours);
      const previews = include_previews ? await wa.previews(newestFirst(result.data), MAX_PREVIEWS) : [];
      return ok(
        renderStories(
          result.data,
          hours,
          previewLabels(previews),
          previewNote(result.data, previews, include_previews)
        ),
        synced(result, { hours, count: result.data.length, preview_count: previews.length, stories: result.data }),
        previewBlocks(previews)
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
      note: z.string().max(200).describe('What to remember, or "" to remove the note'),
    },
    write: false,
    local: true,
    handler: async ({ contact_id, note }, { wa }) => {
      const c = await wa.setContactNote(contact_id, note);
      return ok(
        c.note ? `Noted for ${c.name}: ${c.note}` : `Removed the note on ${c.name}.`,
        c as unknown as Record<string, unknown>
      );
    },
  }),

  tool({
    name: "update_contact_details",
    title: "Tag and annotate a contact",
    description: `File local, searchable details on a person: tags like "client" or "echipa",
and key-value fields like {"role": "contabil", "oras": "Cluj"}. This is how
"the accountant" or "all suppliers" resolve later — search_contacts matches
tag and field text, and its tag filter lists everyone carrying one. Nothing
is sent to WhatsApp: the contact never sees it and the phone is unchanged.
A field set to "" is deleted; remove_tags / remove_fields take keys away.
Pass at least one of the four edits. The person need not be a saved contact.`,
    schema: {
      contact_id: chatId.describe("Contact id or phone number"),
      add_tags: z
        .array(z.string().min(1).max(40))
        .max(30)
        .optional()
        .describe('Tags to file under, e.g. ["client", "echipa"]; lowercase tokens, "#" optional'),
      remove_tags: z.array(z.string().min(1).max(40)).optional().describe("Tags to take off"),
      fields: z
        .record(z.string().max(200))
        .optional()
        .describe('Details to set, e.g. {"role": "contabil"}; an empty value deletes the key'),
      remove_fields: z.array(z.string().min(1).max(40)).optional().describe("Detail keys to delete"),
    },
    write: false,
    local: true,
    handler: async ({ contact_id, add_tags, remove_tags, fields, remove_fields }, { wa }) => {
      const c = await wa.updateContactDetails(contact_id, {
        addTags: add_tags,
        removeTags: remove_tags,
        fields,
        removeFields: remove_fields,
      });
      return ok(renderContactCard(c), c as unknown as Record<string, unknown>);
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
    handler: async ({ chat_id }, { wa }) => {
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
    description: `Block until a message arrives, then return it, or return empty when the timeout
passes. This is how an agent stays on the line without polling: call it in a
loop, and pass the cursor it returns into the next call so nothing that landed
between two calls is missed. The first matching message starts a one-second
settle so a burst comes back together.

Only messages from other people are returned, never the user's own, and never
WhatsApp's system notices. With addressed_to_me, only direct messages, group
messages that @-mention the user, and replies to the user's own messages wake
the wait; everything else in a group is ignored. A cursor from a previous run of
wazap cannot be honoured: the wait then starts from now and says cursor_reset.

The timeout is capped at 55 seconds because MCP clients give up at 60.`,
    schema: {
      timeout_seconds: z.number().int().min(1).max(55).default(30).describe("How long to wait (1-55 s)"),
      chat_id: chatId.optional().describe("Only messages in this chat"),
      addressed_to_me: z
        .boolean()
        .default(false)
        .describe("Only direct messages, @-mentions of the user and replies to the user's messages"),
      cursor: z.string().min(1).optional().describe("The cursor returned by the previous call"),
    },
    write: false,
    handler: async ({ timeout_seconds, chat_id, addressed_to_me, cursor }, { wa }) => {
      const result = await wa.waitForMessages({
        timeoutMs: timeout_seconds * 1000,
        chatId: chat_id,
        addressedToMe: addressed_to_me,
        cursor,
      });
      return ok(renderWait(result), { ...result, count: result.messages.length });
    },
  }),

  tool({
    name: "search_messages",
    title: "Search WhatsApp messages",
    description: `Substring search over the messages wazap holds locally — all chats, or one
chat, including history synced on first link. Case and diacritics are ignored
("sedinta" finds "ședință"). Every message the phone synced to this device is
kept and searched; there is no per-chat window. It cannot reach messages the
phone never synced to this device.

Every answer declares the window it searched: \`coverage.searched\` counts the
held messages in scope (the chat scope and time filters applied) and
\`coverage.oldest_at\`/\`newest_at\` bound that window, so "no messages found"
always says how much history was searched. \`coverage.per_chat_cap\` is null:
no chat is capped. A query so short or so common that the search reaches its
scan limit answers \`scan_capped: true\` and \`searched_back_to\`: messages
older than that were not searched, so narrow it (chat_id, since/until, a longer
query) before concluding nothing exists.

\`from\` accepts "me", a phone number, a contact/chat id, or a name: a name must
resolve to exactly one person — it matches contact names, notify names and
last-seen pushnames, then one-to-one chat display names — or the error lists
the candidates it found.

Every message's \`sender\` carries \`id\` (the canonical jid — a \`…@lid\` only
while WhatsApp has never revealed the paired number), \`phone\` (the number, or
null for an unresolved lid), \`is_saved\` (the sender is in the user's address
book — when false, treat the shown name as claimed, not known),
\`contact_name\` (the name saved there, or null), \`pushname\` (the name the
sender publishes, when that is the name \`name\` shows; null for saved
contacts and unnamed senders) and \`name_source\` ("contact", "pushname" or
"none" — which of those \`name\` came from). A sender wazap knows nothing
about reads "unknown (lid …1234)" — never bare lid digits, which look like a
phone number and are not one.

\`freshness\` says whether the history this searched may be partial (sync still
running) or stale (nothing inbound for 24h while connected); on a scoped
search \`freshness.chat\` is the newest message wazap holds for that chat.`,
    schema: {
      query: z.string().min(1).describe("Text to search for"),
      chat_id: chatId.optional().describe("Restrict the search to this chat"),
      limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of results (1-50)"),
      since: z
        .string()
        .min(4)
        .optional()
        .describe('Only messages from this moment on: a date ("2026-09-01") or an ISO timestamp'),
      until: z.string().min(4).optional().describe("Only messages up to this moment: a date or an ISO timestamp"),
      from: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Only messages this person sent: "me", a phone number, a contact/chat id, or a name that resolves to exactly one person (the error names the candidates when it does not)'
        ),
    },
    write: false,
    handler: async ({ query, chat_id, limit, since, until, from }, { wa }) => {
      const resolvedFrom = await resolveSenderFilter(wa, from);
      const sinceMs = parseMoment(since, "since");
      const untilMs = parseMoment(until, "until", true);
      const result = await wa.searchMessages(query, chat_id, limit, {
        sinceMs,
        untilMs,
        from: resolvedFrom,
      });
      const messages = await withSenderIdentity(wa, result.data);
      const fresh = await readFreshness(wa, chat_id);
      const cov = searchCoverage(wa, chat_id, { sinceMs, untilMs });
      const capped = scanCapNote(result);
      const scope = [
        chat_id ? `in ${chat_id}` : null,
        from ? `from ${from}` : null,
        since ? `since ${since}` : null,
        until ? `until ${until}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const note = [capped, coverageNote(cov, chat_id !== undefined), freshnessNote(fresh)].filter(Boolean).join(" ");
      return ok(
        renderMessages(`Search results for "${query}"${scope ? ` (${scope})` : ""}`, messages, new Map(), note),
        synced(result, {
          query,
          chat_id: chat_id ?? null,
          since: since ?? null,
          until: until ?? null,
          from: from ?? null,
          from_resolved: resolvedFrom ?? null,
          count: messages.length,
          messages,
          ...scanCapFields(result),
          coverage: cov,
          freshness: fresh,
        })
      );
    },
  }),

  tool({
    name: "recall",
    title: "Semantically search WhatsApp history",
    description: `Search by meaning and by words at once over the whole WhatsApp history —
answers "the invoice Dan mentioned", "the address Ana sent", "what did they say
about the trip". A paraphrase or another language still hits through its
meaning, and a short or foreign-language question still hits through its words;
the two rankings are fused. A match found by meaning weighs a little less with
age (85% a month on, never under 70%), so the fresher of two close matches
comes first but a clearly closer old one still does; one chat takes at most
three leading places before other chats' hits, and a near-duplicate trails the
list. For an exact string — an id, a phone number, a URL —
search_messages is the better tool.

Each result carries its date, a fused score, \`matched\` ("words", "meaning" or
"both") and the cosine \`similarity\` when its meaning ranked it. chat_id, since,
until and from narrow the search exactly like search_messages — including a
name that resolves to exactly one person. A hit marked "index only" is a
message wazap holds only as text: quote its words; get_message returns them, but
download_media has nothing to open and it cannot be replied to or forwarded.
A hit found only by meaning must clear the similarity floor, so a question with
no answer comes back empty; when only weak meaning matches survive, the output
says so — do not present them as found facts.

When semantic recall is off or its embedding setup is missing, the tool does
not dead-end: it falls back to a keyword search over the local history, marked
\`mode: "keyword_fallback"\`, and \`recall_unavailable.fix\` names the command
that turns semantic recall on. An error remains only when even the fallback
cannot run.

Each hit's \`sender\` carries the same identity fields as search_messages, and
\`freshness\` says whether the local history may be partial or stale. Every
answer also declares its window: the semantic path reports how many messages
the index covers, and a keyword fallback carries the same \`coverage\` block
search_messages does.`,
    schema: {
      query: z.string().min(1).describe("What to find, said any way — the meaning is what matches"),
      chat_id: chatId.optional().describe("Restrict the search to this chat"),
      limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of results (1-50)"),
      since: z
        .string()
        .min(4)
        .optional()
        .describe('Only messages from this moment on: a date ("2026-09-01") or an ISO timestamp'),
      until: z.string().min(4).optional().describe("Only messages up to this moment: a date or an ISO timestamp"),
      from: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Only messages this person sent: "me", a phone number, a contact/chat id, or a name that resolves to exactly one person (the error names the candidates when it does not)'
        ),
    },
    write: false,
    handler: async ({ query, chat_id, limit, since, until, from }, { wa }) => {
      const resolvedFrom = await resolveSenderFilter(wa, from);
      const sinceMs = parseMoment(since, "since");
      const untilMs = parseMoment(until, "until", true);
      const scope = [
        chat_id ? `in ${chat_id}` : null,
        from ? `from ${from}` : null,
        since ? `since ${since}` : null,
        until ? `until ${until}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const title = `Recall results for "${query}"${scope ? ` (${scope})` : ""}`;
      const fresh = await readFreshness(wa, chat_id);

      let result: Synced<RecallAnswer> | null = null;
      let unavailable: WazapError | null = null;
      try {
        result = await wa.recall(query, chat_id, limit, { sinceMs, untilMs, from: resolvedFrom });
      } catch (err) {
        if (!(err instanceof WazapError) || err.code !== "RECALL_UNAVAILABLE") throw err;
        unavailable = err;
      }

      if (result === null) {
        // The setup cliff: no embeddings means the index never existed, but the
        // local history is still searchable — answer with it and say so.
        const fallback = await wa.searchMessages(query, chat_id, limit, {
          sinceMs,
          untilMs,
          from: resolvedFrom,
        });
        const messages = await withSenderIdentity(wa, fallback.data);
        const cov = searchCoverage(wa, chat_id, { sinceMs, untilMs });
        const note = `Semantic recall is unavailable (${unavailable!.message}) — these are keyword results over the local history.${unavailable!.fix ? ` ${unavailable!.fix}` : ""}`;
        return ok(
          renderMessages(
            title,
            messages,
            new Map(),
            [note, scanCapNote(fallback), coverageNote(cov, chat_id !== undefined), freshnessNote(fresh)].filter(Boolean).join(" ")
          ),
          synced(fallback, {
            query,
            chat_id: chat_id ?? null,
            since: since ?? null,
            until: until ?? null,
            from: from ?? null,
            from_resolved: resolvedFrom ?? null,
            mode: "keyword_fallback",
            recall_unavailable: {
              message: unavailable!.message,
              ...(unavailable!.fix ? { fix: unavailable!.fix } : {}),
            },
            count: messages.length,
            messages,
            ...scanCapFields(fallback),
            coverage: cov,
            freshness: fresh,
          })
        );
      }

      const identified = await withSenderIdentity(
        wa,
        result.data.hits.map((hit) => hit.message)
      );
      const hits = result.data.hits.map((hit, i) => ({ ...hit, message: identified[i]! }));
      const answer: IdentifiedRecallAnswer = { hits, index: result.data.index };
      // While the index is still catching up renderRecall says so itself; the
      // coverage line only repeats it.
      const note = [
        result.data.index.state === "indexing" ? null : indexCoverageNote(result.data.index),
        freshnessNote(fresh),
      ]
        .filter(Boolean)
        .join(" ");
      return ok(
        `${renderRecall(title, answer)}${note ? `\n${note}` : ""}`,
        synced(result, {
          query,
          chat_id: chat_id ?? null,
          since: since ?? null,
          until: until ?? null,
          from: from ?? null,
          from_resolved: resolvedFrom ?? null,
          count: hits.length,
          index: result.data.index,
          hits,
          freshness: fresh,
        })
      );
    },
  }),

  tool({
    name: "get_message",
    title: "Get one WhatsApp message in full",
    description: `The complete message behind a message_id, including the quoted message it
replies to, each reaction with who left it, who chose each option of a poll or
answered an event, and its media metadata. Use it after search_messages
or read_messages when you need the context around a single message.

On the user's own messages, \`delivery.status\` says how far it got ("sent",
"delivered", "read", "played", "pending" or "error"), and in a group
\`read_by\` and \`delivered_to\` name who, with the time. It stops at "delivered"
or is missing when read receipts are off on either side, and large groups may
send none.

The id also resolves in its raw form: \`false_<lid>@lid_<stanza>\` works even
when the chat's number was never learned, and an id that names the same
message under the lid or the paired number finds it either way. With several
accounts linked and no \`account_id\`, an id the resolved account cannot find
is tried on each of the others in turn before MESSAGE_NOT_FOUND comes back,
and the answer's \`account_id\` names the one that had it; pass \`account_id\`
to keep the lookup on one account.

The \`sender\` carries the same identity fields as search_messages: \`id\` (the
canonical jid — a \`…@lid\` only while WhatsApp has never revealed the paired
number), \`phone\` (the number, or null for an unresolved lid), \`is_saved\`
(whether the sender is in the user's address book), \`contact_name\` (the name
saved there, or null), \`pushname\` (the name the sender publishes, when that
is the name \`name\` shows) and \`name_source\` ("contact", "pushname" or
"none" — which of those \`name\` came from).`,
    // account_id is named again here so the handler sees it typed: an explicit
    // id keeps the lookup on that one account instead of walking the bindings.
    schema: { message_id: messageId, account_id: ACCOUNT_ID.optional() },
    write: false,
    handler: async ({ message_id, account_id }, { wa, hub, accountId }) => {
      const resolved = { id: accountId, wa };
      const { binding, message } =
        account_id === undefined
          ? await getMessageViewAcross(hub, resolved, message_id)
          : { binding: resolved, message: await getMessageView(wa, message_id) };
      const [identified] = await withSenderIdentity(binding.wa, [message]);
      const view = identified ?? message;
      const text = [renderMessages("Message", [view]), reactionLine(view), voteLines(view), deliveryLines(view)]
        .filter(Boolean)
        .join("\n");
      return ok(text, {
        ...(view as unknown as Record<string, unknown>),
        account_id: binding.id,
      });
    },
  }),

  tool({
    name: "search_contacts",
    title: "Search WhatsApp contacts",
    description: `Find contacts by name, phone number, tag or detail: a substring match on the
name, a digit match on the number, or a word from a local tag or detail — so
"contabil" finds the person filed under role: contabil by update_contact_details.
With only tag it lists everyone carrying that tag. Returns contact_id values
usable as chat_id.`,
    schema: {
      query: z
        .string()
        .min(2)
        .optional()
        .describe(
          "Name fragment, phone number, or tag/detail text (at least 2 characters). Omit with tag to list everyone carrying it."
        ),
      tag: z.string().min(1).optional().describe('Only contacts filed under this tag ("client"); "#" optional'),
      limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of results (1-50)"),
    },
    write: false,
    handler: async ({ query, tag, limit }, { wa }) => {
      if (query === undefined && tag === undefined) {
        throw new WazapError(
          "INVALID_ID",
          "Pass a query or a tag.",
          'search_contacts({ query: "ion" }) or search_contacts({ tag: "client" })'
        );
      }
      const contacts = await wa.searchContacts(query ?? "", limit, { tag });
      const what = tag !== undefined ? `tag #${tag.replace(/^#+/, "")}` : `"${query}"`;
      return ok(renderContacts(what, contacts), {
        query: query ?? null,
        tag: tag ?? null,
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
named_before and named_after so you can tell whether it helped; if both are 0
the phone has no saved contacts for these people.`,
    schema: {},
    write: false,
    handler: async (_args, { wa }) => {
      const result = await wa.syncContacts();
      const text =
        result.named_after > result.named_before
          ? `Address book synced: ${result.named_after} named contacts (was ${result.named_before}).`
          : result.named_after > 0
            ? `Address book already current: ${result.named_after} named contacts.`
            : "WhatsApp sent no names at all; the phone has no saved contacts for these people.";
      return ok(text, result as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "get_contact",
    title: "Get WhatsApp contact details",
    description: `Full details for one contact: name, number, about text, profile picture URL,
whether they are a saved contact, a business, or blocked. \`name_source\` says
where the shown name comes from — "contact" when it is the saved address-book
name (is_my_contact), "pushname" when it is a name the person publishes, or
"none" when there is no usable name.`,
    schema: {
      contact_id: chatId.describe("Contact id from search_contacts / list_chats, or a phone number"),
    },
    write: false,
    handler: async ({ contact_id }, { wa }) => {
      const c = await wa.getContact(contact_id);
      const text = [
        `# ${c.name}`,
        `- **contact_id**: \`${c.contact_id}\``,
        c.number ? `- **number**: ${c.number}` : null,
        c.note ? `- **note**: ${c.note}` : null,
        c.tags?.length ? `- **tags**: ${c.tags.map((t) => `#${t}`).join(" ")}` : null,
        ...Object.entries(c.fields ?? {}).map(([key, value]) => `- **${key}**: ${value}`),
        c.about ? `- **about**: ${c.about}` : null,
        c.profile_pic_url ? `- **profile picture**: ${c.profile_pic_url}` : null,
        `- **saved**: ${c.is_my_contact} · **business**: ${c.is_business} · **blocked**: ${c.is_blocked} · **name source**: ${nameSourceOf(c)}`,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
      return ok(text, { ...c, name_source: nameSourceOf(c) } as unknown as Record<string, unknown>);
    },
  }),

  // ---- find_contact (F2-3) ------------------------------------------------
  tool({
    name: "find_contact",
    title: "Find who the user means",
    description: `Who a name, nickname, relationship ("mama") or group name means, before drafting to them.
resolved: contact.chat_id, plus context (recent messages, how the user writes there) in a write session.
ambiguous or not_found: ask the user, then call again; never send to a guess.`,
    schema: {
      name: z
        .string()
        .min(1)
        .max(100)
        .describe('What the user calls them: "Ana", "mamei", "Mișu", "fotbal"; case endings and diacritics do not matter'),
      qualifier: z
        .string()
        .max(100)
        .optional()
        .describe('What tells two of that name apart: "contabilitate", a group, or the last 4 digits of the number'),
      kind: z.enum(["person", "group", "any"]).default("any").describe("Only people, only groups, or both"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe("Candidates listed when ambiguous (1-10): at most 5 from each account, so above 5 only across accounts"),
      include_context: z
        .boolean()
        .default(true)
        .describe("Attach the recent exchange and the user's style when resolved; only in a session that can write"),
    },
    outputSchema: FIND_CONTACT_OUTPUT,
    write: false,
    handler: async (args, ctx) => runFindContact(args, ctx),
  }),
  // ---- end find_contact ----------------------------------------------------

  tool({
    name: "save_contact",
    title: "Add or rename a WhatsApp contact",
    description: `Save a person in the account's WhatsApp contacts: a new entry for a phone
number, or a new name for an existing one. The name syncs to every linked
device, and with save_on_phone (default) also into the phone's own address
book. WhatsApp keeps no other fields — email, "my accountant" and the like go
to set_contact_note, which stays on this machine.`,
    schema: {
      contact_id: chatId.describe("Contact id from search_contacts / get_contact, or a phone number"),
      name: z.string().min(1).max(100).describe("Full name to save the contact under"),
      first_name: z.string().min(1).max(100).optional().describe("First name, when it differs from the full name"),
      save_on_phone: z
        .boolean()
        .default(true)
        .describe("Also write the contact into the phone's address book; false keeps it inside WhatsApp"),
    },
    write: true,
    handler: async ({ contact_id, name, first_name, save_on_phone }, { wa }) => {
      const c = await wa.saveContact(contact_id, name, { firstName: first_name, saveOnPhone: save_on_phone });
      return ok(`Saved ${c.name} (${c.contact_id}) to contacts.`, c as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "remove_contact",
    title: "Remove a WhatsApp contact",
    description: `Take a person out of the account's WhatsApp contacts: the saved entry and its
name go, the chat and its history stay. Nothing is sent to the contact.`,
    schema: {
      contact_id: chatId.describe("Contact id from search_contacts / get_contact, or a phone number"),
    },
    write: true,
    destructive: true,
    handler: async ({ contact_id }, { wa }) => {
      const c = await wa.removeContact(contact_id);
      return ok(
        `Removed ${c.contact_id} from contacts; the chat is untouched.`,
        c as unknown as Record<string, unknown>
      );
    },
  }),

  tool({
    name: "get_group_info",
    title: "Get WhatsApp group info",
    description: `Details of a group: name, description, owner, creation date, whether only admins
may post, whether the linked account is an admin, and the participant list (up
to 500; participant_count is always the true total). The invite link is included
only when the linked account is an admin. The settings come too: info_locked
(only admins edit the name, description and photo), member_add_mode ("admins"
or "all"), join_approval, disappearing_seconds (0 when off), and community
({is_community, parent_group_id}) when the group is a community or belongs to one.

Call this before manage_group: most group actions need admin rights.`,
    schema: { group_id: chatId.describe('Group chat id ("<id>@g.us")') },
    write: false,
    handler: async ({ group_id }, { wa }) => {
      const info = await wa.getGroupInfo(group_id);
      const text = [
        `# ${info.name} (${info.participant_count} participants)`,
        `- **chat_id**: \`${info.chat_id}\``,
        info.description ? `- **description**: ${info.description}` : null,
        info.owner ? `- **owner**: ${info.owner}` : null,
        info.created_at ? `- **created**: ${info.created_at}` : null,
        `- **admins only can post**: ${info.announcement_only} · **you are admin**: ${info.i_am_admin}`,
        `- **admins only can edit info**: ${info.info_locked} · **who can add members**: ${info.member_add_mode} · **join approval**: ${info.join_approval} · **disappearing messages**: ${disappearingLabel(info.disappearing_seconds)}`,
        info.community?.is_community ? "- **community**: this group is a community" : null,
        info.community?.parent_group_id ? `- **in community**: \`${info.community.parent_group_id}\`` : null,
        info.invite_link ? `- **invite link**: ${info.invite_link}` : null,
        "",
        "## Participants",
        ...info.participants.map(
          (p) =>
            `- ${p.name}${p.is_admin ? " (admin)" : ""}${looksUnnamed({ chat_id: p.contact_id, name: p.name }) ? " [unnamed]" : ""} — \`${p.contact_id}\``
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
disk on the machine running wazap. The file at \`path\` is already decrypted —
open or process it as is; nothing else is needed. Images of 1 MB or less are
also returned inline so you can look at them.

The structured result carries: \`path\` (the saved file), \`mime\`, \`size\`
(bytes), \`filename\` (the name it was saved under — a timestamped name wazap
made, not the sender's), \`original_filename\` (the name the sender's file had,
or null when the envelope carried none), \`caption\` (the text the sender wrote
under the media, or null — audio and voice notes cannot carry one),
\`message_id\` and \`sender\` (the same identity fields as search_messages —
is_saved, contact_name, pushname, name_source — or null when even the message
can no longer be read back).

The id resolves in its raw form too: \`false_<lid>@lid_<stanza>\` works whether
or not the chat's number was ever learned — when it was, the lid spelling finds
the same message filed under the paired number. An unresolved sender never
blocks the file. Without \`account_id\` the same lookup walks every linked
account's store in turn before failing, and the result's \`account_id\` names
the one that served the file.

Fails with MEDIA_UNAVAILABLE when WhatsApp has expired the file.`,
    schema: {
      message_id: messageId.describe("A message with has_media=true"),
      save_to: z.string().min(1).optional().describe("Absolute directory to save into (default: <data-dir>/media)"),
      // Same reason as get_message: the handler branches on whether it was given.
      account_id: ACCOUNT_ID.optional(),
    },
    write: false,
    handler: async ({ message_id, save_to, account_id }, { wa, hub, accountId }) => {
      const resolved = { id: accountId, wa };
      const found =
        account_id === undefined
          ? await resolveMessageIdAcross(hub, resolved, message_id)
          : { binding: resolved, sid: await resolveMessageId(wa, message_id) };
      const media = await found.binding.wa.downloadMedia(found.sid, save_to);
      // The envelope's caption, filename and sender live on the message, not the file.
      const view = await getMessageView(found.binding.wa, found.sid).catch(() => undefined);
      const [identified] = view === undefined ? [] : await withSenderIdentity(found.binding.wa, [view]);
      const { inline_base64, ...structured } = media;
      const extra: ContentBlock[] = inline_base64 ? [{ type: "image", data: inline_base64, mimeType: media.mime }] : [];
      const text =
        `Saved ${media.mime} (${Math.round(media.size / 1024)} KB) to:\n${media.path}` +
        (inline_base64 ? "\n(image attached inline)" : "");
      return ok(
        text,
        {
          ...structured,
          message_id,
          account_id: found.binding.id,
          caption: view === undefined ? null : mediaCaptionOf(view),
          original_filename: view?.media?.filename ?? null,
          sender: identified?.sender ?? null,
        },
        extra
      );
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
          'ISO 639-1 code of what is spoken, e.g. "ro"; "auto" detects it. Omit to use the configured default.'
        ),
    },
    write: false,
    rate: 10,
    handler: async ({ message_id, language }, { wa }) => {
      const result = await wa.transcribeAudio(message_id, language);
      const clock = result.duration_seconds === undefined ? "" : ` ${clockLabel(result.duration_seconds)}`;
      const facts = [result.language, result.provider, result.cached ? "cached" : null].filter(Boolean).join(", ");
      return ok(`Transcribed${clock} (${facts}): "${result.text}"`, result as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "send_message",
    title: "Draft a WhatsApp text message",
    description: `Draft a text message. Does not send. Returns a draft_id and a preview of the
recipient and exact text. Show that preview to the user; after they say yes,
call confirm_send. A draft lasts 15 minutes.

To @-mention people, pass mention_ids and write @<number> in the text where
each mention belongs, the digits of their id (@40722123456). A mention the
text lacks gets its @<number> added at the end, so the preview is the text
that goes out.

A draft to someone the user writes to often may carry style_check: warnings
where the text does not read like the user there. It never blocks.`,
    schema: {
      chat_id: chatId,
      text: z.string().min(1).max(65536).describe("The message text"),
      reply_to: messageId.optional().describe("Quote-reply to this message"),
      mention_ids: z
        .array(z.string().min(1))
        .max(50)
        .optional()
        .describe("Chat ids to @-mention; write @<number> in the text for each, or wazap adds it at the end"),
    },
    write: true,
    handler: async ({ chat_id, text, reply_to, mention_ids }, ctx) => {
      return draftAndGuard({ kind: "text", chatId: chat_id, text, replyTo: reply_to, mentionIds: mention_ids }, ctx);
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
      file_path: z.string().min(1).optional().describe("Absolute path of a local file to send"),
      url: z.string().url().optional().describe("Public http(s) URL to fetch and send"),
      caption: z.string().max(1024).optional().describe("Text shown under the media"),
      as_document: z.boolean().default(false).describe("Send as a plain document instead of rendered media"),
      as_voice: z.boolean().default(false).describe("Send an audio file as a voice note (push-to-talk)"),
      as_gif: z
        .boolean()
        .default(false)
        .describe("Send a .gif or an mp4 as a looping GIF, the way WhatsApp plays them"),
    },
    write: true,
    handler: async ({ chat_id, file_path, url, caption, as_document, as_voice, as_gif }, ctx) => {
      return draftAndGuard(
        {
          kind: "media",
          chatId: chat_id,
          source: { file_path, url },
          caption,
          asDocument: as_document,
          asVoice: as_voice,
          asGif: as_gif,
        },
        ctx
      );
    },
  }),

  tool({
    name: "send_poll",
    title: "Draft a WhatsApp poll",
    description: `Draft a poll. Does not send. Participants vote in WhatsApp, and their votes
show on the poll message: read_messages counts them and get_message says who
chose each option. Show the preview; after the user says yes, call confirm_send.`,
    schema: {
      chat_id: chatId,
      question: z.string().min(1).max(255).describe("The poll question"),
      options: z.array(z.string().min(1).max(100)).min(2).max(12).describe("Answer options (2-12)"),
      multi_select: z.boolean().default(false).describe("Allow voters to pick more than one option"),
    },
    write: true,
    handler: async ({ chat_id, question, options, multi_select }, ctx) => {
      return draftAndGuard({ kind: "poll", chatId: chat_id, question, options, multiSelect: multi_select }, ctx);
    },
  }),

  tool({
    name: "send_location",
    title: "Draft a WhatsApp location",
    description: `Draft a map pin, optionally labelled with a place name and address. Does not
send. Show the preview; after the user says yes, call confirm_send.`,
    schema: {
      chat_id: chatId,
      latitude: z.number().min(-90).max(90).describe("Latitude in decimal degrees"),
      longitude: z.number().min(-180).max(180).describe("Longitude in decimal degrees"),
      name: z.string().max(255).optional().describe("Place name shown on the pin"),
      address: z.string().max(500).optional().describe("Street address shown under the name"),
    },
    write: true,
    handler: async ({ chat_id, latitude, longitude, name, address }, ctx) => {
      return draftAndGuard({ kind: "location", chatId: chat_id, latitude, longitude, name, address }, ctx);
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
    handler: async ({ message_id, text }, { wa }) => {
      const sent = await wa.editMessage(message_id, text);
      return ok(`Edited ${message_id}:\n> ${sent.text}`, sent as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "react_to_message",
    title: "React to a WhatsApp message",
    description: "Add an emoji reaction to a message, or pass an empty string to remove your reaction.",
    schema: {
      message_id: messageId,
      emoji: z.string().max(8).describe('A single emoji such as "👍", or "" to remove your reaction'),
    },
    write: true,
    handler: async ({ message_id, emoji }, { wa }) => {
      const result = await wa.reactToMessage(message_id, emoji);
      const text = emoji ? `Reacted ${emoji} to ${message_id}` : `Removed the reaction from ${message_id}`;
      return ok(text, result as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "forward_message",
    title: "Draft a forwarded WhatsApp message",
    description: `Draft a forward of an existing message to another chat. Does not send. The
recipient will see it marked as forwarded. Show the preview; after the user
says yes, call confirm_send.`,
    schema: { message_id: messageId, to_chat_id: chatId.describe("Destination chat") },
    write: true,
    handler: async ({ message_id, to_chat_id }, ctx) => {
      return draftAndGuard({ kind: "forward", chatId: to_chat_id, messageId: message_id }, ctx);
    },
  }),

  tool({
    name: "confirm_send",
    title: "Send a drafted WhatsApp message",
    description: `Send a draft created by send_message, send_media, send_poll, send_location or
forward_message. This is the only call that reaches WhatsApp, and it sends a
draft at most once: confirming it again answers the same receipt with
already_sent: true. Only the MCP session that created the draft may confirm it.
After reinitializing or reconnecting with a new session, draft again and obtain
fresh user approval. A missing or expired draft_id also means draft again and
show the new preview before calling this. SEND_OUTCOME_UNKNOWN means WhatsApp
may have the message: check the chat with read_messages before anything else,
and never draft it again without asking the user.`,
    schema: {
      draft_id: z.string().min(1).describe("The draft_id returned by a send_* tool"),
    },
    write: true,
    handler: async ({ draft_id }, { wa, hub, accountId, draftOwner }) => {
      const policy = liveSendPolicy(hub, accountId);
      const ref = draftTargetOf(draft_id);
      if (hasSendRules(policy)) {
        if (ref === undefined) {
          throw new WazapError(
            "SEND_BLOCKED",
            `The recipient of draft ${draft_id} is not on record, so the send rules of account "${accountId}" cannot be checked.`,
            "Draft the message again with a send tool, then confirm_send"
          );
        }
        assertSendable(policy, ref.target, accountId);
      }
      noteConfirming(draft_id);
      const sent = await wa.confirm(draft_id, draftOwner);
      return ok(sentText(sent, ref?.target), sent as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "delete_message",
    title: "Delete a WhatsApp message",
    description: `Delete a message. DESTRUCTIVE — confirm with the user first. for_everyone is
required, and picks one of two different deletes; tell the user which:
  - for_everyone: true retracts it for everyone in the chat. Works on messages
    the linked account sent, within 2 days of sending. In a group where the
    linked account is an admin it also takes someone else's message, deleted
    as an admin; anywhere else that is NOT_OWN_MESSAGE.
  - for_everyone: false removes it from the linked account's own devices only:
    anyone's message, at any age. Nobody else sees a change.`,
    schema: {
      message_id: messageId,
      for_everyone: z
        .boolean()
        .describe("Required. true retracts it for everyone in the chat; false deletes it for the linked account only"),
    },
    write: true,
    destructive: true,
    handler: async ({ message_id, for_everyone }, { wa }) => {
      const result = await wa.deleteMessage(message_id, for_everyone);
      const scope = result.for_everyone ? "for everyone" : "for the linked account only";
      return ok(`Deleted ${message_id} ${scope}`, result as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "set_profile_picture",
    title: "Set the linked WhatsApp profile picture",
    description: `Set the linked WhatsApp account's own profile picture from a local path on the
machine running wazap or from a public URL. Exactly one of file_path / url.
JPEG, PNG or WebP only, at most 10 MB. DESTRUCTIVE and visible to every contact.
Show the image and wait for a yes first. This call hits WhatsApp immediately;
there is no draft.`,
    schema: {
      file_path: z.string().min(1).optional().describe("Absolute path of a local JPEG, PNG or WebP"),
      url: z.string().url().optional().describe("Public http(s) URL to fetch and use as the photo"),
    },
    write: true,
    destructive: true,
    handler: async ({ file_path, url }, { wa }) => {
      const result = await wa.setOwnProfilePicture({ file_path, url });
      const where = result.profile_pic_url ?? "WhatsApp has not published a URL yet";
      return ok(`Updated the linked account's profile picture (${where})`, result);
    },
  }),

  tool({
    name: "manage_chat",
    title: "Manage a WhatsApp chat",
    description: `Change a chat, or a message in it. Actions:
  - archive / unarchive, pin / unpin (the chat), mute / unmute (mute_hours
    defaults to 8), mark_read (sends read receipts) / mark_unread
  - pin_message / unpin_message — need message_id; pins it for everyone in the
    chat, for pin_hours 24, 168 (default) or 720
  - star_message / unstar_message — need message_id; the star is the linked
    account's own
  - clear — DESTRUCTIVE, empties the chat for the linked account only
  - delete — DESTRUCTIVE, deletes the chat for the linked account only
  - block / unblock — a person's chat only; a blocked person can no longer
    message or call the account

A message_id must belong to chat_id. Every action hits WhatsApp at once and
there is no draft: say what will change and wait for a yes before calling it.`,
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
          "pin_message",
          "unpin_message",
          "star_message",
          "unstar_message",
          "clear",
          "delete",
          "block",
          "unblock",
        ])
        .describe("What to do with the chat"),
      mute_hours: z.number().int().min(1).max(720).optional().describe('Hours to mute, default 8; only used by "mute"'),
      message_id: messageId
        .optional()
        .describe("The message for pin_message, unpin_message, star_message and unstar_message; it must be in chat_id"),
      pin_hours: z
        .union([z.literal(24), z.literal(168), z.literal(720)])
        .optional()
        .describe("How long pin_message keeps the message pinned: 24, 168 (default) or 720 hours"),
    },
    write: true,
    destructive: true,
    handler: async ({ chat_id, action, mute_hours, message_id, pin_hours }, { wa }) => {
      const result = await wa.manageChat(chat_id, action, {
        muteHours: mute_hours,
        messageId: message_id,
        pinHours: pin_hours,
      });
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
    handler: async ({ name, participant_ids }, { wa }) => {
      const result = await wa.createGroup(name, participant_ids);
      const text = [`Group "${name}" created: ${result.chat_id}`, ...renderParticipants(result.participants)].join(
        "\n"
      );
      return ok(text, { name, ...result });
    },
  }),

  tool({
    name: "join_group",
    title: "Join a WhatsApp group from an invite",
    description: `Join a group from an invite: a link (https://chat.whatsapp.com/<code>, or the
code alone) as invite, or the message_id of an invite message someone sent
(type "invite"). Exactly one of invite / message_id.

Without confirm: true it joins nothing and returns the group's name,
description, member count and whether an admin must approve new members.
Show that to the user and wait for an explicit yes, then call again with the
same invite or message_id and confirm: true. Every member sees the account
join. The answer is the group's chat_id, or pending_approval when an admin
must let the account in first.`,
    schema: {
      invite: z.string().min(1).max(512).optional().describe("A https://chat.whatsapp.com/ link, or its code"),
      message_id: messageId.optional().describe('An invite message (type "invite") from read_messages'),
      confirm: z
        .boolean()
        .default(false)
        .describe("true joins, only after the user said yes to the preview; omit to preview"),
    },
    write: true,
    handler: async ({ invite, message_id, confirm }, { wa }) => {
      const result = await wa.joinGroup({ invite, messageId: message_id, confirm });
      return ok(renderJoin(result), result as unknown as Record<string, unknown>);
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
  - set_picture — needs exactly one of file_path / url: JPEG, PNG or WebP, at
    most 10 MB. Every member sees it at once and there is no draft: show the
    image and wait for a yes first
  - remove_picture — takes the group photo down; ask first the same way
  - get_invite_link / revoke_invite_link
  - list_join_requests — who is waiting for approval, with when and how they asked
  - approve_join_requests / reject_join_requests — need participant_ids from
    list_join_requests; each comes back with status ok or failed
  - set_announcement_only / set_info_locked / set_join_approval — value "on" or "off"
  - set_add_mode — value "admins" or "all"
  - set_disappearing — value "off", "24h", "7d" or "90d"

Everything except leave requires the linked account to be a group admin; call
get_group_info first to check. Every change is visible to all members at once:
say what will change and wait for a yes before calling it.`,
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
          "set_picture",
          "remove_picture",
          "get_invite_link",
          "revoke_invite_link",
          "list_join_requests",
          "approve_join_requests",
          "reject_join_requests",
          "set_announcement_only",
          "set_info_locked",
          "set_add_mode",
          "set_join_approval",
          "set_disappearing",
        ])
        .describe("Group action to perform"),
      participant_ids: z
        .array(z.string().min(1))
        .max(256)
        .optional()
        .describe("Targets of add/remove/promote/demote/approve_join_requests/reject_join_requests"),
      value: z
        .string()
        .max(2048)
        .optional()
        .describe(
          'New subject or description; "on"/"off" for set_announcement_only, set_info_locked, set_join_approval; "admins"/"all" for set_add_mode; "off"/"24h"/"7d"/"90d" for set_disappearing'
        ),
      file_path: z.string().min(1).optional().describe("set_picture: absolute path of a local JPEG, PNG or WebP"),
      url: z.string().url().optional().describe("set_picture: public http(s) URL to fetch and use as the photo"),
    },
    write: true,
    destructive: true,
    handler: async ({ group_id, action, participant_ids, value, file_path, url }, { wa }) => {
      const result = await wa.manageGroup(group_id, action, participant_ids, value, { file_path, url });
      const text = [
        result.applied,
        ...renderParticipants(result.participants ?? []),
        ...renderJoinRequests(result.join_requests ?? []),
      ].join("\n");
      return ok(text, result as unknown as Record<string, unknown>);
    },
  }),
];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

export const registerTools = createToolRegistrar(TOOLS);

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
    lines.push(`## ${c.name}${flags.length ? ` [${flags.join(", ")}]` : ""}${c.note ? ` · ${c.note}` : ""}`);
    lines.push(`- **chat_id**: \`${c.chat_id}\``);
    if (c.last_message) {
      lines.push(
        `- **last**: ${c.last_message.from_me ? "me: " : ""}${truncate(c.last_message.text, 160)} (${c.last_message.timestamp})`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** A date or an ISO timestamp as epoch ms; a bare date for `until` means the end of that day. */
function parseMoment(value: string | undefined, field: string, endOfDay = false): number | undefined {
  if (value === undefined) return undefined;
  const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  const ms = Date.parse(bareDate ? `${value.trim()}T${endOfDay ? "23:59:59.999" : "00:00:00"}` : value);
  if (Number.isNaN(ms)) {
    throw new WazapError(
      "INVALID_ID",
      `${field} is not a date: "${value}".`,
      'Pass "2026-09-01" or an ISO timestamp like "2026-09-01T14:00:00+03:00"'
    );
  }
  return ms;
}

function newestFirst(messages: MessageView[]): string[] {
  return [...messages].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).map((m) => m.message_id);
}

/** message_id → "preview 3", numbered the way the image blocks are attached. */
function previewLabels(previews: Preview[]): Map<string, string> {
  return new Map(previews.map((p, i) => [p.message_id, `preview ${i + 1}`]));
}

function previewBlocks(previews: Preview[]): ContentBlock[] {
  return previews.map((p) => ({ type: "image", data: p.base64, mimeType: p.mime }));
}

/** The line under the title that says what was attached and what could not be. */
function previewNote(messages: MessageView[], previews: Preview[], asked: boolean): string | null {
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
function senderLabel(m: AnyMessage, introduced: Set<string>): string {
  if (m.from_me) return "me";
  if (!m.sender.note || introduced.has(m.sender.id)) return m.sender.name;
  introduced.add(m.sender.id);
  return `${m.sender.name} · ${m.sender.note}`;
}

/** A join_group answer: the preview and the step after it, or where the join landed. */
function renderJoin(r: JoinGroupResult): string {
  const name = r.name ? `"${r.name}"` : "the group";
  if (r.status === "joined") return `Joined ${name}${r.group_id ? `: \`${r.group_id}\`` : ""}.`;
  if (r.status === "pending_approval") {
    return `Asked to join ${name}. An admin of the group must approve the request before the account is in.`;
  }
  const facts = [
    r.participant_count === null ? null : `${r.participant_count} members`,
    r.join_approval === null ? null : r.join_approval ? "an admin must approve new members" : "no approval needed",
  ].filter(Boolean);
  return [
    `Group invite: ${name}${facts.length ? ` (${facts.join(", ")})` : ""}. Not joined.`,
    r.description ? `Description: ${r.description}` : null,
    r.group_id ? `group_id: \`${r.group_id}\`` : null,
    "",
    "Show this to the user. After they say yes, call join_group again with the same invite or message_id and confirm: true.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** A rendered message, with or without the resolved sender identity fields. */
type AnyMessage = MessageView | IdentifiedMessage;

/** "❤️×2 😍": each emoji once, in the order it first came, counted when more than one person chose it. */
function reactionTag(reactions: ReadonlyArray<{ emoji: string }>): string {
  const counts = new Map<string, number>();
  for (const { emoji } of reactions) counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
  return [...counts].map(([emoji, n]) => (n > 1 ? `${emoji}×${n}` : emoji)).join(" ");
}

/** Who left which reaction, for the one message get_message renders: "reactions: ❤️ Medeea, 😍 Lory". */
function reactionLine(m: AnyMessage): string | null {
  if (!m.reactions?.length) return null;
  return `  reactions: ${m.reactions.map((r) => `${r.emoji} ${r.name}`).join(", ")}`;
}

/** "3 votes" on a poll, "2 going · 1 maybe" on an event: how many, and who only in get_message. */
function voteTag(m: AnyMessage): string | null {
  if (m.poll) return m.poll.voters > 0 ? `${m.poll.voters} vote${m.poll.voters === 1 ? "" : "s"}` : null;
  if (!m.event_responses) return null;
  const { going, maybe, not_going } = m.event_responses;
  const counts: Array<[number, string]> = [
    [going.length, "going"],
    [maybe.length, "maybe"],
    [not_going.length, "not going"],
  ];
  const parts = counts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Who chose what, for the one message get_message renders: "Da (2): Ana, Dan" per option, "going: Ana · maybe: Dan" for an event. */
function voteLines(m: AnyMessage): string | null {
  const names = (voters: ReadonlyArray<{ name: string }>): string => voters.map((v) => v.name).join(", ");
  if (m.poll) {
    const lines = m.poll.options.map(
      (option) => `  ${option.name} (${option.votes})${option.voters.length > 0 ? `: ${names(option.voters)}` : ""}`
    );
    return lines.length > 0 ? lines.join("\n") : null;
  }
  if (!m.event_responses) return null;
  const { going, maybe, not_going } = m.event_responses;
  const groups: Array<[string, ReadonlyArray<{ name: string }>]> = [
    ["going", going],
    ["maybe", maybe],
    ["not going", not_going],
  ];
  const parts = groups.filter(([, voters]) => voters.length > 0).map(([label, voters]) => `${label}: ${names(voters)}`);
  return parts.length > 0 ? `  ${parts.join(" · ")}` : null;
}

/** "read", "delivered", "sent" on the user's own messages; "read by 3" in a group once members did. */
function deliveryTag(m: AnyMessage): string | null {
  if (!m.delivery) return null;
  const readers = m.delivery.read_by?.length ?? 0;
  return readers > 0 ? `read by ${readers}` : m.delivery.status;
}

/** Who has it, for the one message get_message renders: "read by: Ana (14:02), Dan (14:05)". */
function deliveryLines(m: AnyMessage): string | null {
  const who = (label: string, receivers?: ReadonlyArray<{ name: string; at: string }>): string | null =>
    receivers?.length ? `  ${label}: ${receivers.map((r) => `${r.name} (${r.at.slice(11, 16)})`).join(", ")}` : null;
  const lines = [who("read by", m.delivery?.read_by), who("delivered to", m.delivery?.delivered_to)].filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : null;
}

function renderMessages(
  title: string,
  messages: ReadonlyArray<AnyMessage>,
  labels: Map<string, string> = new Map(),
  note: string | null = null
): string {
  if (messages.length === 0) return `${title}: no messages found.${note ? ` ${note}` : ""}`;
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
      m.reactions?.length ? reactionTag(m.reactions) : null,
      m.mentions?.length ? `mentions ${m.mentions.map((person) => person.name).join(", ")}` : null,
      voteTag(m),
      deliveryTag(m),
    ].filter(Boolean);
    lines.push(
      `- **${senderLabel(m, introduced)}** · ${m.age}${tags.length ? ` [${tags.join(", ")}]` : ""} · id: \`${m.message_id}\``
    );
    if (m.quoted) lines.push(`  > ${truncate(m.quoted.text, 160)}`);
    lines.push(`  ${truncate(m.text, 500)}`);
  }
  return lines.join("\n");
}

/**
 * Ranked hits with the date always on the line and the score that ordered
 * them. "index only" warns that wazap holds the message only as text, so
 * download_media has nothing to open.
 */
function renderRecall(title: string, answer: RecallAnswer | IdentifiedRecallAnswer): string {
  const { hits, index } = answer;
  const catchingUp =
    index.state === "indexing"
      ? `The index is still catching up: ${index.indexed} indexed, ${index.pending} pending — more matches may appear.`
      : null;
  if (hits.length === 0) {
    return `${title}: no messages found.${catchingUp ? ` ${catchingUp}` : ""}`;
  }
  // Under ~0.55 cosine, embeddinggemma matches are usually coincidental — the
  // agent must not present them as found facts. A hit whose words matched is
  // not a guess, whatever its similarity.
  const best = Math.max(0, ...hits.map((h) => h.similarity ?? 0));
  const weak = hits.every((h) => h.matched === "meaning") && best < 0.55;
  const lines = [`# ${title} (${hits.length})`, ""];
  if (weak) {
    lines.push(
      `Weak matches only (best similarity ${best.toFixed(2)}): the query may have no real answer — treat these as guesses.`,
      ""
    );
  }
  if (catchingUp) lines.push(catchingUp, "");
  const introduced = new Set<string>();
  for (const hit of hits) {
    const m = hit.message;
    const tags = [
      `score ${hit.score.toFixed(3)}`,
      hit.matched === "both" ? "words + meaning" : hit.matched,
      hit.from_index ? "index only" : null,
      m.type !== "text" ? m.type : null,
      m.quoted ? "reply" : null,
      m.edited ? "edited" : null,
    ].filter(Boolean);
    lines.push(
      `- [${m.timestamp}] **${senderLabel(m, introduced)}** · \`${m.chat_id}\` [${tags.join(", ")}] · id: \`${m.message_id}\``
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
  note: string | null = null
): string {
  if (conversations.length === 0) return `No WhatsApp conversations in the last ${hours}h.`;
  const total = conversations.reduce((n, c) => n + c.messages.length, 0);
  const lines = [`# WhatsApp · last ${hours}h (${conversations.length} chats, ${total} messages)`, ""];
  if (note) lines.splice(1, 0, note);
  for (const c of conversations) {
    lines.push(
      `## ${c.chat_name}${c.type === "group" ? " [group]" : ""}${c.note ? ` · ${c.note}` : ""} — \`${c.chat_id}\``
    );
    const introduced = new Set<string>();
    for (const m of c.messages) {
      const label = labels.get(m.message_id);
      lines.push(
        `- [${m.timestamp}] ${senderLabel(m, introduced)}: ${truncate(m.text, 500)}${label ? ` (${label})` : ""}`
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
  note: string | null
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
    lines.push(`- ${m.age} · ${truncate(m.text, 300)}${label ? ` (${label})` : ""} · id: \`${m.message_id}\``);
  }
  return lines.join("\n");
}

function renderUnanswered(chats: UnansweredChat[], minAgeHours: number): string {
  const since = minAgeHours > 0 ? ` for ${minAgeHours}h or more` : "";
  if (chats.length === 0) return `Nobody is waiting on you${since}.`;
  const lines = [`# Waiting on you${since} (${chats.length})`, ""];
  chats.forEach((c, i) => {
    const who =
      (c.type === "group"
        ? `${c.name} [group] — ${c.ask.sender.name}`
        : `${c.name}${c.business ? " [business]" : ""}`) + (c.note ? ` · ${c.note}` : "");
    const more = c.messages_since_you > 1 ? `, ${c.messages_since_you} messages since yours` : "";
    lines.push(`${i + 1}. **${who}** · ${c.age}${more} — \`${c.chat_id}\``);
    lines.push(`   > ${truncate(c.ask.text, 300)}`);
    lines.push(`   ask id: \`${c.ask.message_id}\``);
  });
  return lines.join("\n");
}

function renderWait(result: WaitResult): string {
  const tail = [
    `cursor: \`${result.cursor}\``,
    result.cursor_reset ? "The cursor was from another run; this wait started from now." : null,
  ]
    .filter(Boolean)
    .join("\n");
  if (result.messages.length === 0) return `Nothing arrived before the timeout.\n${tail}`;
  const lines = [`# ${result.messages.length} new message${result.messages.length === 1 ? "" : "s"}`, ""];
  let chat = "";
  const introduced = new Set<string>();
  for (const m of result.messages) {
    if (m.chat_id !== chat) {
      chat = m.chat_id;
      lines.push(`## \`${chat}\``);
    }
    lines.push(`- [${m.timestamp}] ${senderLabel(m, introduced)}: ${truncate(m.text, 500)} · id: \`${m.message_id}\``);
  }
  lines.push("", tail);
  return lines.join("\n");
}

/** The card a contact mutation answers with: who it is plus the local filing. */
function renderContactCard(c: ContactSummary): string {
  const lines = [
    `# ${c.name}`,
    `- **contact_id**: \`${c.contact_id}\``,
    c.number ? `- **number**: ${c.number}` : null,
    c.note ? `- **note**: ${c.note}` : null,
    c.tags?.length ? `- **tags**: ${c.tags.map((t) => `#${t}`).join(" ")}` : null,
    ...Object.entries(c.fields ?? {}).map(([key, value]) => `- **${key}**: ${value}`),
    `- **saved**: ${c.is_my_contact} · **business**: ${c.is_business}`,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

function renderContacts(what: string, contacts: ContactSummary[]): string {
  if (contacts.length === 0) return `No contacts matching ${what}.`;
  const lines = [`# Contacts matching ${what} (${contacts.length})`, ""];
  for (const c of contacts) {
    const flags = [
      c.is_my_contact ? "saved" : null,
      c.is_business ? "business" : null,
      ...(c.tags ?? []).map((t) => `#${t}`),
    ].filter(Boolean);
    lines.push(
      `- **${c.name}**${flags.length ? ` [${flags.join(", ")}]` : ""}${c.note ? ` · ${c.note}` : ""} — \`${c.contact_id}\`${c.number ? ` (${c.number})` : ""}`
    );
  }
  return lines.join("\n");
}

function renderParticipants(participants: Array<{ id: string; status: string; reason?: string }>): string[] {
  return participants.map((p) => `- ${p.id}: ${p.status}${p.reason ? ` (${p.reason})` : ""}`);
}

function renderJoinRequests(requests: JoinRequest[]): string[] {
  return requests.map((r) => {
    const details = [r.requested_at ? `asked ${r.requested_at}` : null, r.method ? `via ${r.method}` : null]
      .filter((part): part is string => part !== null)
      .join(", ");
    return `- ${r.name} — \`${r.id}\`${details ? ` (${details})` : ""}`;
  });
}

/** 86400 reads as "24h" and 604800 as "7d", the way manage_group set_disappearing takes them. */
function disappearingLabel(seconds: number): string {
  if (!seconds) return "off";
  if (seconds % 86_400 !== 0) return `${seconds}s`;
  const days = seconds / 86_400;
  return days === 1 ? "24h" : `${days}d`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function drafted(view: DraftView): ToolResult {
  return ok(renderDraft(view), { ...view });
}

/**
 * The account's send rules, read fresh from accounts.json: a rule written
 * while a draft waits must still fire when confirm_send comes, so the record
 * is re-read rather than trusted from registry memory.
 */
function liveSendPolicy(hub: AccountSource, accountId: string): SendPolicy {
  const record = hub.recordOnDisk(accountId);
  if (!record || !record.enabled) throw new WazapError("SEND_BLOCKED", "The account send policy is unavailable.",
    "Restore the account policy before sending; do not fall back to cached rules");
  return sendPolicyOf(record);
}

/**
 * is_my_contact is the only name with the address book behind it: a pushname
 * or a chat title is self-published, so a recipient known only that way is
 * flagged for the agent. The lookup is local; if it cannot run, the flag the
 * name's own shape set stands.
 */
async function flagUnnamed(view: DraftView, wa: WhatsAppApi): Promise<void> {
  const to = view.to;
  if (view.unnamed_recipient === true || to.chat_id.endsWith("@g.us")) return;
  if (typeof wa.searchContacts !== "function") return;
  try {
    if (typeof wa.getStatus === "function" && to.number !== undefined) {
      const own = wa.getStatus().account?.number;
      if (own !== undefined && own === to.number) return;
    }
    const hits = await wa.searchContacts(to.number ?? to.chat_id, 10);
    const hit = hits.find((c) => c.contact_id === to.chat_id || (to.number !== undefined && c.number === to.number));
    if (hit === undefined || !hit.is_my_contact) view.unnamed_recipient = true;
  } catch {
    /* the shape-based answer stands */
  }
}

/**
 * Every outbound draft passes here: the account's send rules are checked on
 * the id as typed and again on the resolved recipient, and the draft's target
 * is recorded so confirm_send can re-check rules written after the draft.
 */
async function draftAndGuard(payload: DraftPayload, ctx: ToolCtx): Promise<ToolResult> {
  const policy = liveSendPolicy(ctx.hub, ctx.accountId);
  // A bare @lid may still resolve to an allowed phone inside the service; only
  // the deny list can fire on it before that resolution.
  const pre = payload.chatId.trim().endsWith("@lid") ? { allow: null, deny: policy.deny } : policy;
  assertSendable(pre, { chat_id: payload.chatId }, ctx.accountId);
  const view = await ctx.wa.draft(payload, ctx.draftOwner);
  assertSendable(policy, view.to, ctx.accountId);
  noteDraftTarget(view, ctx.accountId, ctx.draftOwner);
  await flagUnnamed(view, ctx.wa);
  if (payload.kind === "text") checkStyle(view, payload.text, ctx);
  return drafted(view);
}

/**
 * send_message's style_check (F2-3): additive, and a failure only leaves it
 * out. An account that turned the draft context off gets no style statistics
 * here either.
 */
function checkStyle(view: DraftView, text: string, { wa, hub, accountId }: ToolCtx): void {
  if (typeof wa.styleCheck !== "function") return;
  try {
    const record = hub.recordOnDisk(accountId);
    if (record === undefined || !draftContextEnabled(record)) return;
    const check = wa.styleCheck(view.to.chat_id, text);
    if (check !== null) view.style_check = check;
  } catch {
    /* the draft stands without it */
  }
}

function sentText(sent: SentMessage, to?: OutgoingTarget): string {
  const who = to === undefined ? sent.chat_id : describeTarget(to);
  if (sent.already_sent === true) {
    return `Already sent to ${who} at ${sent.timestamp} (message_id: ${sent.message_id}); nothing was sent again:\n> ${sent.text}`;
  }
  return `Sent to ${who} at ${sent.timestamp} (message_id: ${sent.message_id}):\n> ${sent.text}`;
}
