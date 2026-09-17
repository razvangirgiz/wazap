import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { AccountSource } from "./account-hub.js";
import { attachAccountId, resolveToolAccount, stringArg } from "./account-resolve.js";
import { CLIENT_META_KEY, LOCAL_CLIENT, localClient } from "./client-name.js";
import { asWazapError, WazapError } from "./errors.js";
import { RateLimiter } from "./ratelimit.js";
import { requireDraftOwner } from "./send-guard.js";
import type { WhatsAppApi } from "./wa-types.js";

export type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export type ToolArgs = Record<string, unknown>;

export interface ToolCtx {
  wa: WhatsAppApi;
  hub: AccountSource;
  allowWrite: boolean;
  accountId: string;
  /** Opaque, per MCP session; stored with the session's drafts, never shown to or taken from a caller. */
  draftOwner: string;
  /**
   * Who the session's credential names, stable across its sessions and token
   * rotations: `oauth:<client_id>`, `token:<label>`, or for stdio and the
   * daemon's own clients `local:<MCP client name>` (client-name.ts). What
   * catch_up keeps its mark under.
   */
  client: string;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  /** The structured content's shape, when the tool declares one. */
  outputSchema?: z.ZodRawShape;
  write: boolean;
  /** A read that changes local state a repeat call sees (catch_up's mark). */
  idempotent?: boolean;
  destructive?: boolean;
  /** Changes only local notes, so available in read-only mode too. */
  local?: boolean;
  /** Per-tool budget, separate from the account's write budget. */
  rate?: number;
  handler: (args: ToolArgs, ctx: ToolCtx) => Promise<ToolResult>;
}

export interface RegisterOpts {
  allowWrite: boolean;
  /** Trusted local stdio defaults to true; every HTTP session explicitly sets its capability. */
  allowLocalFiles?: boolean;
  /** Tool calls this session may have running at once. */
  maxInFlight?: number;
  /** Tool calls every session together may have running at once. */
  maxInFlightTotal?: number;
  /** See ToolCtx.client; `local` when omitted, which names each call after the MCP client making it. */
  client?: string;
}

/** Agents fan out: Claude Code routinely sends several tool calls at once, and wait_for_messages holds one for up to 55 s. */
const MAX_IN_FLIGHT = 8;
const MAX_IN_FLIGHT_TOTAL = 32;

export function toolError(err: WazapError): ToolResult {
  const payload: Record<string, unknown> = { error: err.code, message: err.message };
  if (err.fix) payload.fix = err.fix;
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}

/** An error result as text alone: `{ error, message, fix }` stays in the text block. */
export function withoutStructuredContent(result: ToolResult): ToolResult {
  const { structuredContent: _structured, ...rest } = result;
  return rest;
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

function rateLabel(name: string): string {
  const verb = name.split("_")[0] ?? name;
  return verb.charAt(0).toUpperCase() + verb.slice(1);
}

/** Built once for the tool catalogue: reconnects never reset the process-wide rate buckets. */
export function createToolRegistrar(defs: readonly ToolDef[]) {
  // Hold a slot until the actual handler settles, even if its HTTP caller
  // disconnects. Reinitializing a session cannot reset the process budget.
  let inFlight = 0;
  const buckets = new Map<string, RateLimiter>(
    defs.flatMap((def) =>
      def.rate === undefined ? [] : [[def.name, new RateLimiter(def.rate, undefined, rateLabel(def.name))] as const]
    )
  );
  return function registerTools(server: McpServer, hub: AccountSource, opts: RegisterOpts): void {
    // Each stdio server / HTTP session / upstream bridge session owns its drafts.
    // New initialization intentionally requires re-drafting, even with the same token,
    // and so does a restart: no later session is ever handed this id again.
    const draftOwner = `session_${randomUUID()}`;
    let sessionInFlight = 0;
    // A local session is named after its MCP client, or the client a bridge passes on; a credential's name stands.
    const clientOf = (extra?: { _meta?: Record<string, unknown> }): string => {
      const named = opts.client ?? LOCAL_CLIENT;
      if (named !== LOCAL_CLIENT) return named;
      const session = (server as { server?: { getClientVersion?(): { name?: string } | undefined } }).server;
      return localClient(extra?._meta?.[CLIENT_META_KEY] ?? session?.getClientVersion?.()?.name);
    };
    for (const def of defs) {
      if (def.write && !opts.allowWrite) continue;
      const own = buckets.get(def.name);
      server.registerTool(
        def.name,
        {
          title: def.title,
          description:
            def.description +
            (opts.allowLocalFiles === false && (def.schema.file_path || def.schema.save_to)
              ? "\nThis remote session cannot use file_path or save_to. Use public HTTP(S) URLs, forward existing messages, or download_media with its default directory."
              : ""),
          inputSchema: def.schema,
          ...(def.outputSchema === undefined ? {} : { outputSchema: def.outputSchema }),
          annotations: def.write
            ? { ...WRITE_HINTS, destructiveHint: def.destructive === true }
            : def.local
              ? LOCAL_HINTS
              : { ...READ_ONLY_HINTS, openWorldHint: def.name !== "learn", ...(def.idempotent === false ? { idempotentHint: false } : {}) },
        },
        async (args: unknown, extra?: { _meta?: Record<string, unknown> }): Promise<ToolResult> => {
          const parsed = (args ?? {}) as ToolArgs;
          let resolved: { id: string; wa: WhatsAppApi } | undefined;
          let admitted = false;
          try {
            if (inFlight >= (opts.maxInFlightTotal ?? MAX_IN_FLIGHT_TOTAL) || sessionInFlight >= (opts.maxInFlight ?? MAX_IN_FLIGHT)) {
              throw new WazapError("RATE_LIMITED", "Too many tool operations are still running.",
                "Wait for pending operations to finish, then retry once");
            }
            inFlight++;
            sessionInFlight++;
            admitted = true;
            // Reject before any lookup/stat/read/write, including directory overrides on read tools.
            if (opts.allowLocalFiles === false && (parsed.file_path !== undefined || parsed.save_to !== undefined)) {
              throw new WazapError(
                "MEDIA_ACCESS_DENIED",
                "This MCP session cannot access arbitrary host files or choose download directories.",
                "Use a public HTTP(S) media URL, forward an existing WhatsApp message, or download_media without save_to"
              );
            }
            own?.take();
            let resolveArgs = parsed;
            if (def.name === "confirm_send") {
              const ref = requireDraftOwner(
                stringArg(parsed, "draft_id") ?? "",
                draftOwner,
                stringArg(parsed, "account_id")
              );
              // Resolve using the recorded account even if its service has evicted the draft.
              resolveArgs = { ...parsed, account_id: ref.accountId };
            }
            resolved = resolveToolAccount(hub, resolveArgs, def);
            // A writable account registers tools for the session, not permission to
            // touch every account. Gate before draft/media/group preflight work.
            const live = def.write ? hub.recordOnDisk(resolved.id) : undefined;
            if (def.write && (!live || !live.enabled)) {
              throw new WazapError("READ_ONLY", `Account "${resolved.id}" is missing or disabled; this write is refused.`,
                `Restore the account policy deliberately; a disabled account needs \`wazap account enable ${resolved.id}\` first`);
            }
            if (
              def.write &&
              (live?.writes === false || hub.record(resolved.id)?.writes === false || resolved.wa.getStatus?.().read_only === true)
            ) {
              throw new WazapError(
                "READ_ONLY",
                `Account "${resolved.id}" is read-only, so this write is refused.`,
                `Check global and account writes settings with the user; enable deliberately and restart the server (account: ${resolved.id})`
              );
            }
            const result = await def.handler(parsed, {
              wa: resolved.wa,
              hub,
              allowWrite: opts.allowWrite,
              accountId: resolved.id,
              draftOwner,
              client: clientOf(extra),
            });
            return attachAccountId(result, resolved.id);
          } catch (err) {
            const result = toolError(asWazapError(err));
            const id = resolved?.id ?? stringArg(parsed, "account_id");
            const stamped = id === undefined ? result : attachAccountId(result, id);
            // A client validates structuredContent against the declared outputSchema even on an
            // error, so a tool that declares one answers an error with its JSON in the text only.
            return def.outputSchema === undefined ? stamped : withoutStructuredContent(stamped);
          } finally {
            if (admitted) { inFlight--; sessionInFlight--; }
          }
        }
      );
    }
  };
}
