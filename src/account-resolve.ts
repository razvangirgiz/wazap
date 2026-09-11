/**
 * Per-call account resolution and the list/status overlays that need the hub.
 * Tool handlers stay in tools.ts.
 */

import type { AccountBinding, AccountSource } from "./account-hub.js";
import type { AccountRecord } from "./accounts.js";
import { WazapError } from "./errors.js";
import { maskNumber } from "./ui.js";
import type { ListedAccount, StatusInfo } from "./wa-types.js";

export interface ToolPayload {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface ResolveTool {
  name: string;
  write: boolean;
}

const FIX_ADD_ACCOUNT = "Run `wazap account add`";
const FIX_PASS_ACCOUNT = "Pass account_id";

function ok(text: string, structured: Record<string, unknown>): ToolPayload {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

export function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function attachAccountId(result: ToolPayload, accountId: string): ToolPayload {
  return { ...result, structuredContent: { ...(result.structuredContent ?? {}), account_id: accountId } };
}

/** Write tools register when any live account allows writes. */
export function anyAccountAllowsWrites(hub: AccountSource): boolean {
  return hub.bindings().some((row) => row.wa.getStatus().read_only !== true);
}

function pickFromMatches(
  matches: AccountBinding[],
  write: boolean,
  hub: AccountSource,
  what: "chat" | "message" | "draft",
): AccountBinding {
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new WazapError(
      "AMBIGUOUS_ACCOUNT",
      `Several accounts have that ${what}: ${matches.map((row) => row.id).join(", ")}.`,
      FIX_PASS_ACCOUNT,
    );
  }
  if (write) {
    throw new WazapError("AMBIGUOUS_ACCOUNT", `No account knows that ${what}.`, FIX_PASS_ACCOUNT);
  }
  return hub.defaultBinding();
}

function resolveGivenId(hub: AccountSource, requested: string, toolName: string): AccountBinding {
  const record = hub.record(requested);
  const live = hub.binding(requested);
  if (record !== undefined && !record.enabled) {
    throw new WazapError(
      "ACCOUNT_DISABLED",
      `Account "${requested}" is disabled.`,
      `Run \`wazap account enable ${requested}\` and restart the server`,
    );
  }
  if (live === undefined) {
    const fix = toolName === "link_account" ? FIX_ADD_ACCOUNT : `${FIX_ADD_ACCOUNT}, or call list_accounts`;
    throw new WazapError("ACCOUNT_NOT_FOUND", `No account "${requested}".`, fix);
  }
  return live;
}

export function resolveToolAccount(
  hub: AccountSource,
  args: Record<string, unknown>,
  tool: ResolveTool,
): AccountBinding {
  if (tool.name === "list_accounts") return hub.defaultBinding();

  const requested = stringArg(args, "account_id");
  if (requested !== undefined) return resolveGivenId(hub, requested, tool.name);

  const live = hub.bindings();
  if (live.length === 1) return live[0]!;

  const chatId = stringArg(args, "chat_id") ?? stringArg(args, "group_id") ?? stringArg(args, "contact_id");
  const messageId = stringArg(args, "message_id");
  const draftId = stringArg(args, "draft_id");
  if (chatId !== undefined) return pickFromMatches(hub.findByChat(chatId), tool.write, hub, "chat");
  if (messageId !== undefined) return pickFromMatches(hub.findByMessage(messageId), tool.write, hub, "message");
  if (draftId !== undefined) return pickFromMatches(hub.findByDraft(draftId), false, hub, "draft");

  return hub.defaultBinding();
}

function listedFromStatus(s: StatusInfo, enabled: boolean, id = s.account_id): ListedAccount {
  return {
    id,
    name: s.account_name,
    status: s.status,
    phone_masked: s.account ? maskNumber(s.account.number) : null,
    owner_name: s.account?.name ?? null,
    write_tools: !s.read_only,
    enabled,
  };
}

function listedFromRecord(record: AccountRecord): ListedAccount {
  return {
    id: record.id,
    name: record.name,
    status: record.enabled ? "disconnected" : "disabled",
    phone_masked: null,
    owner_name: null,
    write_tools: false,
    enabled: record.enabled,
  };
}

function renderAccountLines(rows: ListedAccount[]): string[] {
  return rows.map((row) => {
    const who = row.owner_name ? `${row.owner_name}${row.phone_masked ? ` (${row.phone_masked})` : ""}` : "not linked";
    const writes = row.write_tools ? "writes on" : "writes off";
    const flag = row.enabled ? row.status : "disabled";
    return `- **${row.id}** (${row.name}) · ${flag} · ${who} · ${writes}`;
  });
}

export function renderListAccounts(hub: AccountSource): ToolPayload {
  const accounts: ListedAccount[] = [];
  for (const record of hub.records()) {
    const live = hub.binding(record.id);
    accounts.push(live === undefined ? listedFromRecord(record) : listedFromStatus(live.wa.getStatus(), record.enabled, live.id));
  }
  const text = [`# Accounts (${accounts.length})`, "", ...renderAccountLines(accounts)].join("\n");
  return ok(text, { count: accounts.length, default: hub.defaultBinding().id, accounts });
}

function webhookStatusLine(webhook: StatusInfo["webhook"]): string {
  if (!webhook.enabled) return "- **webhook**: off";
  if (!webhook.valid) return `- **webhook**: invalid${webhook.last_error ? ` · ${webhook.last_error}` : ""}`;
  return `- **webhook**: on${webhook.last_error ? ` · last error: ${webhook.last_error}` : ""}`;
}

/** The get_status body: `write_tools` is this session's, not the process default. */
export function renderGetStatus(s: StatusInfo, writeTools: boolean, hub: AccountSource): ToolPayload {
  const account = s.account ? `${s.account.name || "(no name)"} (${s.account.number})` : "none";
  const writeLine = writeTools
    ? "registered"
    : s.read_only
      ? "not registered (server is read-only; run `wazap config writes on` and restart)"
      : "not registered (this session used a read token)";
  const accounts = hub.bindings().map((row) => listedFromStatus(row.wa.getStatus(), true, row.id));
  const text = [
    `# WhatsApp: ${s.status} (sync: ${s.sync})`,
    `- **account**: ${account}`,
    `- **last message received**: ${s.last_message_received_at ?? "never"}`,
    `- **contacts named**: ${s.contacts_named}`,
    `- **data dir**: ${s.data_dir} · **read-only**: ${s.read_only} · **write tools**: ${writeLine} · **rate limit**: ${s.rate_limit}/min`,
    `- **versions**: wazap ${s.wazap_version}, baileys ${s.baileys_version}`,
    s.pairing ? `- **pairing code**: ${s.pairing.code} for ${s.pairing.phone_masked}, until ${s.pairing.expires_at}` : null,
    webhookStatusLine(s.webhook),
    s.last_error ? `- **last error**: ${s.last_error}` : null,
    s.hint ? `- **hint**: ${s.hint}` : null,
    accounts.length > 1 ? `- **accounts**: ${accounts.map((row) => row.id).join(", ")}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return ok(text, { ...s, write_tools: writeTools, accounts } as unknown as Record<string, unknown>);
}
