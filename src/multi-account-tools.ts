import { createHash } from "node:crypto";
import { AccountManager } from "./account-manager.js";
import { caller } from "./access.js";
import { WazapError, asWazapError } from "./errors.js";
import { compactConversations } from "./compact.js";
import type {
  MessageView,
  RecentConversation,
  ReadSnapshot,
  MessageType,
  ChatFilter,
  UnansweredChat,
} from "./wa-types.js";

type Args = Record<string, unknown>;
type Origin = { account_id: string; account_name: string };
type Message = MessageView & Origin;
type Conversation = RecentConversation & Origin;
interface Cursor {
  v: 1;
  fingerprint: string;
  snapshots: Record<string, ReadSnapshot>;
}
export const AGGREGATE_TOOLS = new Set([
  "search_messages",
  "get_recent_messages",
  "get_unanswered",
]);
export const GLOBAL_TOOLS = new Set(["learn", "list_accounts"]);
export const SINGLE_TOOLS = new Set([
  "get_status",
  "link_account",
  "list_chats",
  "read_messages",
  "get_stories",
  "set_contact_note",
  "mark_handled",
  "wait_for_messages",
  "get_message",
  "search_contacts",
  "sync_contacts",
  "get_contact",
  "get_group_info",
  "download_media",
  "transcribe_audio",
  "send_message",
  "send_media",
  "send_poll",
  "send_location",
  "edit_message",
  "react_to_message",
  "forward_message",
  "confirm_send",
  "delete_message",
  "manage_chat",
  "create_group",
  "manage_group",
]);

/** Annotate every independently actionable object, including compact-message lines. */
export function annotate(value: unknown, origin: Origin): unknown {
  if (Array.isArray(value)) return value.map((v) => annotate(v, origin));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, annotate(v, origin)]),
  );
  if (
    [
      "message_id",
      "message_ids",
      "chat_id",
      "contact_id",
      "group_id",
      "draft_id",
    ].some((k) => k in result)
  )
    Object.assign(result, {
      account_id: origin.account_id,
      account_name: origin.account_name,
    });
  return result;
}
function moment(value: unknown, end = false): number | undefined {
  if (value === undefined) return;
  const str = String(value).trim();
  const ms = Date.parse(
    /^\d{4}-\d{2}-\d{2}$/.test(str)
      ? `${str}T${end ? "23:59:59.999" : "00:00:00"}`
      : str,
  );
  if (!Number.isFinite(ms))
    throw new WazapError("INVALID_ID", "Use an ISO timestamp or date.");
  return ms;
}
function decode(text: string, fingerprint: string): Cursor {
  try {
    if (!text.startsWith("ma1.") || text.length > 100_000) throw Error();
    const c = JSON.parse(Buffer.from(text.slice(4), "base64url").toString());
    if (
      c.v !== 1 ||
      c.fingerprint !== fingerprint ||
      !c.snapshots ||
      typeof c.snapshots !== "object"
    )
      throw Error();
    for (const s of Object.values(c.snapshots) as ReadSnapshot[]) {
      if (
        !s ||
        !Number.isFinite(s.through) ||
        !Number.isSafeInteger(s.watermark) ||
        s.watermark < 0 ||
        (s.anchor &&
          (!Number.isFinite(s.anchor.ts) || typeof s.anchor.sid !== "string"))
      )
        throw Error();
    }
    return c;
  } catch {
    throw new WazapError(
      "INVALID_ID",
      "Cursor does not match these accounts, filters or permissions. Start again.",
    );
  }
}
function order(a: Message, b: Message): number {
  return (
    Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
    (b.account_id < a.account_id ? -1 : b.account_id > a.account_id ? 1 : 0) ||
    (b.message_id < a.message_id ? -1 : b.message_id > a.message_id ? 1 : 0)
  );
}

export async function aggregate(
  manager: AccountManager,
  tool: string,
  args: Args,
) {
  manager.validateAccess();
  const permitted = manager.access(caller().accountAccess?.ids);
  const ids = args.all_accounts
    ? permitted.ids
    : [...new Set(args.account_ids as string[])].sort();
  if (!ids.length)
    throw new WazapError(
      "ACCOUNT_REQUIRED",
      "Select at least one accessible account.",
    );
  for (const id of ids) manager.selected(id);
  if (args.chat_id || (args.from && args.from !== "me"))
    throw new WazapError(
      "ACCOUNT_REQUIRED",
      "Chat and contact ID filters require a single account_id.",
    );
  const { cursor: ignoredCursor, before: ignoredBefore, ...filters } = args;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        tool,
        filters,
        ids,
        access: permitted,
        principal: caller().principal,
      }),
    )
    .digest("hex");
  const rawCursor = (tool === "search_messages" ? args.before : args.cursor) as
    | string
    | undefined;
  const cursor: Cursor = rawCursor
    ? decode(rawCursor, fingerprint)
    : { v: 1, fingerprint, snapshots: {} };
  if (
    rawCursor &&
    JSON.stringify(Object.keys(cursor.snapshots).sort()) !== JSON.stringify(ids)
  )
    throw new WazapError(
      "INVALID_ID",
      "Incomplete account cursor. Start again.",
    );
  const limit = Number(
    args.limit ?? (tool === "get_recent_messages" ? 200 : 20),
  );
  const accountResults: Array<Record<string, unknown>> = [];
  const messages: Message[] = [],
    conversations = new Map<string, Conversation>();
  const candidates: Array<UnansweredChat & Origin> = [];
  let hasMore = false,
    partial = false;
  const through = Date.now();
  // A bounded number of archive reads, even for a large registry.
  for (let offset = 0; offset < ids.length; offset += 2) {
    await Promise.all(
      ids.slice(offset, offset + 2).map(async (id) => {
        const account = manager.selected(id),
          origin = { account_id: id, account_name: account.name };
        try {
          await manager.withAccount(id, false, async (api) => {
            if (tool === "get_unanswered") {
              const result = await api.getUnanswered(
                Number(args.min_age_hours ?? 0),
                Number(args.max_age_hours ?? 336),
                limit,
              );
              candidates.push(
                ...result.data.map(
                  (c) => annotate(c, origin) as UnansweredChat & Origin,
                ),
              );
              partial ||= result.sync !== "done";
              accountResults.push({
                ...origin,
                sync: result.sync,
                coverage: result.coverage,
              });
              return;
            }
            if (!cursor.snapshots[id]) {
              if (!api.captureReadSnapshot)
                throw new WazapError(
                  "ARCHIVE_UNAVAILABLE",
                  "This account cannot capture a stable read.",
                );
              cursor.snapshots[id] = {
                ...(await api.captureReadSnapshot()),
                through,
              };
            }
            const snapshot = cursor.snapshots[id]!;
            if (tool === "search_messages") {
              const result = await api.searchMessages(
                String(args.query),
                undefined,
                limit + 1,
                {
                  sinceMs: moment(args.since),
                  untilMs: moment(args.until, true),
                  from: args.from as string | undefined,
                  snapshot,
                },
              );
              messages.push(...result.data.map((m) => ({ ...m, ...origin })));
              hasMore ||= !!result.next_before;
              partial ||= result.sync !== "done";
              accountResults.push({
                ...origin,
                sync: result.sync,
                coverage: result.coverage,
              });
            } else {
              const result = await api.getRecentMessages(
                Number(args.hours ?? 24),
                (args.filter ?? "all") as Exclude<ChatFilter, "archived">,
                args.include_system === true,
                args.types as MessageType[] | undefined,
                limit + 1,
                undefined,
                snapshot,
              );
              for (const c of result.data) {
                conversations.set(`${id}:${c.chat_id}`, {
                  ...c,
                  ...origin,
                  messages: [],
                });
                messages.push(...c.messages.map((m) => ({ ...m, ...origin })));
              }
              hasMore ||= !!result.next_cursor;
              partial ||= result.sync !== "done";
              accountResults.push({
                ...origin,
                sync: result.sync,
                coverage: result.coverage,
              });
            }
          });
        } catch (err) {
          partial = true;
          const error = asWazapError(err);
          accountResults.push({
            ...origin,
            error: error.code,
            message: error.message,
          });
        }
      }),
    );
  }
  manager.validateAccess();
  accountResults.sort((a, b) =>
    String(a.account_id).localeCompare(String(b.account_id)),
  );
  const failed = accountResults.some((a) => a.error);
  const selected = messages.sort(order).slice(0, limit);
  for (const id of ids) {
    const last = selected.filter((m) => m.account_id === id).at(-1);
    if (last)
      cursor.snapshots[id]!.anchor = {
        ts: Date.parse(last.timestamp),
        sid: last.message_id,
      };
  }
  const next =
    !failed && (hasMore || messages.length > limit)
      ? `ma1.${Buffer.from(JSON.stringify(cursor)).toString("base64url")}`
      : null;
  const structured: Record<string, unknown> = {
    accounts: accountResults,
    sync: partial ? "partial" : "done",
    coverage: { source: "account_archives", phone_history: "unknown" },
    partial: failed,
    ...(failed
      ? {
          history_note:
            "An account is unavailable. Retry this same page, or start a new query with fewer accounts; no continuation cursor is issued.",
        }
      : {}),
  };
  if (tool === "get_unanswered") {
    candidates.sort(
      (a, b) =>
        (a.type === b.type ? 0 : a.type === "individual" ? -1 : 1) ||
        Date.parse(a.waiting_since) - Date.parse(b.waiting_since) ||
        a.account_id.localeCompare(b.account_id) ||
        a.chat_id.localeCompare(b.chat_id),
    );
    structured.chats = candidates.slice(0, limit);
    structured.count = Math.min(candidates.length, limit);
    structured.basis = "heuristic_candidates";
  } else if (tool === "search_messages") {
    structured.messages = selected.map((m) => annotate(m, m));
    structured.count = selected.length;
    structured.next_before = next;
  } else {
    for (const m of [...selected].reverse())
      conversations
        .get(`${m.account_id}:${m.chat_id}`)!
        .messages.push(annotate(m, m) as MessageView);
    const grouped = [...conversations.values()]
      .filter((c) => c.messages.length)
      .map((c) => ({ ...c, last_activity: c.messages.at(-1)!.timestamp }))
      .sort(
        (a, b) =>
          Date.parse(b.last_activity) - Date.parse(a.last_activity) ||
          a.account_id.localeCompare(b.account_id) ||
          a.chat_id.localeCompare(b.chat_id),
      );
    structured.conversations = args.compact
      ? grouped.map((c) => annotate(compactConversations([c])[0], c))
      : grouped;
    structured.message_count = selected.length;
    structured.conversation_count = grouped.length;
    structured.next_cursor = next;
  }
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > = [];
  const previews: Array<Record<string, unknown>> = [];
  if (args.include_previews && !args.compact) {
    for (const id of ids) {
      if (previews.length >= 12) break;
      const origin = {
        account_id: id,
        account_name: manager.selected(id).name,
      };
      const mids = selected
        .filter((m) => m.account_id === id)
        .map((m) => m.message_id);
      if (!mids.length) continue;
      try {
        await manager.withAccount(id, false, async (api) => {
          for (const p of await api.previews(mids, 12 - previews.length)) {
            previews.push({
              ...origin,
              message_id: p.message_id,
              preview: previews.length + 1,
            });
            content.push({ type: "image", data: p.base64, mimeType: p.mime });
          }
        });
      } catch {
        previews.push({ ...origin, unavailable: true });
      }
    }
    structured.previews = previews;
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `${tool === "get_unanswered" ? "Possible follow-ups, not demonstrated obligations." : "Messages by account."}\nPhone history coverage is unknown.${partial ? " Results are partial; missing results do not prove absence." : ""}\n${JSON.stringify(structured, null, 2)}`,
      },
      ...content,
    ],
    structuredContent: structured,
  };
}
