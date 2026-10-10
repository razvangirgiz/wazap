/**
 * `wazap drafts [approve|discard <draft_id>]`: drafts-only mode from the shell
 * of the machine wazap runs on. Only the running server holds the WhatsApp
 * session, so these ask it over the control line (control.ts), whose token
 * only this machine's data dir holds; an agent's MCP session cannot reach it.
 */
import { ask } from "./cli.js";
import { paths, type Config } from "./config.js";
import { CONTROL_ROUTES, askRunningServer } from "./control.js";
import type { PendingApproval } from "./approvals.js";
import { WazapError } from "./errors.js";
import { say } from "./logger.js";
import { brand, dim, info, ok } from "./ui.js";
import type { SentMessage } from "./wa-types.js";

const LIST_TIMEOUT_MS = 10_000;
/** A send waits for WhatsApp's answer, as confirm_send does. */
const APPROVE_TIMEOUT_MS = 90_000;

const DRAFTS_USAGE = "Run `wazap drafts`, `wazap drafts approve <draft_id>` or `wazap drafts discard <draft_id>`";

async function askServer<T extends Record<string, unknown>>(
  config: Config,
  route: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<T> {
  const p = paths(config.dataDir);
  const answer = await askRunningServer<T>(p.controlFile, p.lockFile, route, body, timeoutMs);
  if (answer.kind === "answered") return answer.body;
  throw new WazapError(
    "SERVICE_ERROR",
    answer.kind === "none"
      ? "No wazap server is running, and only the running server can send a draft."
      : `The running wazap (pid ${answer.pid}) does not answer on its control line.`,
    answer.kind === "none" ? "Start it with `wazap service start` (or `wazap serve --daemon`), then run this again" : "Restart it with `wazap service restart`, then run this again"
  );
}

async function pending(config: Config): Promise<PendingApproval[]> {
  const body = await askServer<{ drafts?: unknown }>(config, CONTROL_ROUTES.drafts, {}, LIST_TIMEOUT_MS);
  return Array.isArray(body.drafts) ? (body.drafts as PendingApproval[]) : [];
}

function show(entry: PendingApproval): void {
  say(`${brand(entry.draft_id)} ${dim(`· account ${entry.account_id} · lapses ${entry.expires_at}`)}`);
  for (const line of entry.preview.split("\n")) say(`  ${line}`);
  if (entry.send_yourself_url !== undefined) say(dim(`  or send it yourself: ${entry.send_yourself_url}`));
}

export async function runDrafts(config: Config): Promise<void> {
  const [verb, id] = config.args;
  if (verb === undefined || verb === "list") {
    if (id !== undefined) throw new WazapError("INVALID_ID", "`wazap drafts` takes no draft id.", DRAFTS_USAGE);
    const drafts = await pending(config);
    if (config.json) {
      process.stdout.write(`${JSON.stringify({ drafts })}\n`);
      return;
    }
    if (drafts.length === 0) {
      say(info("No drafts wait for approval."));
      return;
    }
    for (const entry of drafts) {
      show(entry);
      say("");
    }
    say(dim("Send one with `wazap drafts approve <draft_id>`, or drop it with `wazap drafts discard <draft_id>`."));
    return;
  }
  if ((verb !== "approve" && verb !== "discard") || id === undefined) {
    throw new WazapError("INVALID_ID", `Cannot run \`wazap drafts ${config.args.join(" ")}\`.`, DRAFTS_USAGE);
  }

  if (verb === "discard") {
    await askServer(config, CONTROL_ROUTES.discard, { draft_id: id }, LIST_TIMEOUT_MS);
    say(ok(`Discarded ${id}. Nothing was sent.`));
    return;
  }

  // The words go out as you, so you read them first, unless --yes says you did.
  const entry = (await pending(config)).find((draft) => draft.draft_id === id);
  if (entry !== undefined) show(entry);
  if (!config.assumeYes) {
    if (process.stdin.isTTY !== true) {
      throw new WazapError(
        "INVALID_ID",
        "Approving sends a message as you, and nobody is at a terminal to say yes.",
        `Run \`wazap drafts approve ${id}\` at a terminal, or add --yes once you have read the draft with \`wazap drafts\``
      );
    }
    const answer = await ask(`${brand("?")} Send it? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      say(info("Not sent. The draft still waits."));
      return;
    }
  }
  const body = await askServer<{ receipt?: SentMessage }>(config, CONTROL_ROUTES.approve, { draft_id: id }, APPROVE_TIMEOUT_MS);
  const receipt = body.receipt;
  if (config.json) {
    process.stdout.write(`${JSON.stringify({ draft_id: id, receipt })}\n`);
    return;
  }
  say(
    ok(
      receipt?.already_sent === true
        ? `Already sent at ${receipt.timestamp}; nothing was sent again.`
        : `Sent${receipt === undefined ? "" : ` at ${receipt.timestamp} (message_id ${receipt.message_id})`}.`
    )
  );
}
