/**
 * The commands that read an account's database from the shell, without a
 * server and without WhatsApp: `wazap search` and `wazap embed index`. Each
 * holds the session lock for as long as it runs, like any one-shot command,
 * and opens the account stored-only, so no socket is ever made.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { AccountRegistry, resolveAccount } from "./accounts.js";
import { accountPaths, paths, type Config } from "./config.js";
import { WazapError, asWazapError } from "./errors.js";
import { lockHolder, releaseLock, writeLock } from "./lock.js";
import { say } from "./logger.js";
import { EMBED_MODELS, embedReady, readRecallSettings, type RecallStatus } from "./recall/index.js";
import { MEANING_FAILURES } from "./tools.js";
import { dim, fail, fix, info, ok, spinner, warn } from "./ui.js";
import type { MessageView, RecallHit } from "./wa-types.js";
import { WhatsAppService } from "./whatsapp.js";

export const MATCH_MODES = ["hybrid", "meaning", "words"] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const PROGRESS_MS = 1_000;

/** The session lock, or the refusal naming who holds it: one process owns a data dir. */
function holdSession(config: Config, what: string): () => void {
  const lockFile = paths(config.dataDir).lockFile;
  for (let attempt = 0; attempt < 5; attempt++) {
    const running = lockHolder(lockFile);
    if (running !== null) {
      throw new WazapError(
        "WHATSAPP_ERROR",
        `A wazap server (pid ${running}) owns ${config.dataDir}.`,
        `${what} through your MCP client while it runs, or stop it first (\`wazap service stop\`)`
      );
    }
    if (writeLock(lockFile)) return () => releaseLock(lockFile);
  }
  throw new WazapError("WHATSAPP_ERROR", `Could not take the session lock in ${lockFile}.`, "Run the command again");
}

async function openStored(config: Config, accountId: string, index = false): Promise<WhatsAppService> {
  const { account } = resolveAccount(config.dataDir, accountId);
  const wa = new WhatsAppService(config, account, accountPaths(config.dataDir, account.id));
  await wa.openStored({ index });
  return wa;
}

export function parseMatch(raw: string | undefined): MatchMode {
  const value = (raw ?? "hybrid").trim().toLowerCase();
  if ((MATCH_MODES as readonly string[]).includes(value)) return value as MatchMode;
  throw new WazapError("INVALID_ID", `Unknown --match ${raw}.`, `Use --match ${MATCH_MODES.join("|")}`);
}

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= MAX_LIMIT) return n;
  throw new WazapError("INVALID_ID", `--limit must be a whole number from 1 to ${MAX_LIMIT}, got "${raw}".`);
}

/** One hit as the JSON prints it: the message and, when ranked by recall, how it matched. */
interface SearchRow {
  matched: RecallHit["matched"];
  score?: number;
  similarity?: number | null;
  message_id: string;
  chat_id: string;
  from: string;
  timestamp: string;
  text: string;
}

function row(message: MessageView, rank: Pick<SearchRow, "matched" | "score" | "similarity">): SearchRow {
  return {
    ...rank,
    message_id: message.message_id,
    chat_id: message.chat_id,
    from: message.from_me ? "me" : message.sender.name,
    timestamp: message.timestamp,
    // A voice note's text already quotes its transcript.
    text: message.transcript === undefined || message.text.includes(message.transcript) ? message.text : `${message.text} "${message.transcript}"`,
  };
}

/**
 * `wazap search "<query>" [--match hybrid|meaning|words] [--limit n] [--account id] [--json]`.
 * hybrid is what the MCP search tool does: meaning and words fused, falling
 * back to words when meaning search cannot run. meaning keeps only the hits
 * meaning found and fails when it cannot run; words never embeds anything.
 * Two things differ from the server's search, because nothing stays up between
 * two shell searches: the query waits for llama-server to start rather than
 * answering by words after a few seconds, and recency does not weigh the order.
 * With --json a failure is one JSON object on stdout too, `{ error: { code, message, fix? } }`,
 * and the exit code is 1.
 */
export async function runSearch(config: Config): Promise<void> {
  try {
    await search(config);
  } catch (err) {
    if (!config.json) throw err;
    const fault = asWazapError(err);
    process.stdout.write(`${JSON.stringify({ error: { code: fault.code, message: fault.message, ...(fault.fix ? { fix: fault.fix } : {}) } }, null, 2)}\n`);
    say(fail(fault.message));
    if (fault.fix) say(fix(fault.fix));
    process.exitCode = 1;
  }
}

async function search(config: Config): Promise<void> {
  const [query] = config.args;
  if (query === undefined || query.trim() === "") throw new WazapError("INVALID_ID", "Nothing to search for.", 'Run `wazap search "<words>"`');
  const match = parseMatch(config.match);
  const limit = parseLimit(config.limit);
  const release = holdSession(config, "Search");
  const accountId = config.accountId ?? AccountRegistry.load(config.dataDir).defaultId();
  let wa: WhatsAppService | null = null;
  try {
    wa = await openStored(config, accountId);
    let rows: SearchRow[] | null = null;
    let mode: "hybrid" | "meaning" | "words" | "keyword_fallback" = match;
    let unavailable: WazapError | null = null;
    let index: RecallStatus | null = null;
    if (match !== "words") {
      try {
        const answer = await wa.recall(query, undefined, limit);
        index = wa.indexStatus();
        rows = answer.data.hits
          .filter((hit) => match === "hybrid" || hit.matched !== "words")
          .map((hit) => row(hit.message, { matched: hit.matched, score: hit.score, similarity: hit.similarity }));
      } catch (err) {
        if (!(err instanceof WazapError) || !MEANING_FAILURES.has(err.code)) throw err;
        if (match === "meaning") throw err;
        unavailable = err;
        mode = "keyword_fallback";
      }
    }
    if (rows === null) {
      const found = await wa.searchMessages(query, undefined, limit);
      rows = found.data.map((message) => row(message, { matched: "words" }));
    }

    if (config.json) {
      const out = {
        query,
        account: accountId,
        mode,
        count: rows.length,
        hits: rows,
        ...(index === null ? {} : { index }),
        ...(unavailable === null ? {} : { recall_unavailable: { code: unavailable.code, message: unavailable.message, ...(unavailable.fix ? { fix: unavailable.fix } : {}) } }),
      };
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return;
    }
    if (unavailable !== null) {
      say(warn(`Meaning search is unavailable (${unavailable.message}); these match the words only.`));
      if (unavailable.fix) say(fix(unavailable.fix));
    }
    if (rows.length === 0) {
      say(info(`Nothing found for "${query}".`));
    } else {
      say(ok(`${rows.length} result${rows.length === 1 ? "" : "s"} for "${query}" (${mode})`));
      for (const hit of rows) {
        const how = hit.score === undefined ? hit.matched : `${hit.matched === "both" ? "words + meaning" : hit.matched}, ${hit.score.toFixed(3)}`;
        say(`  ${dim(`${hit.timestamp}  ${hit.chat_id}  [${how}]`)}`);
        say(`  ${hit.from}: ${hit.text}`);
      }
    }
    if (index !== null && index.state === "indexing") say(info(`The meaning index is ${left(index)}: run \`wazap embed index --wait\` for meaning matches.`));
  } finally {
    await wa?.stop();
    release();
  }
}

/** What is left to embed; a queue never filled for the model has no count yet. */
function left(index: RecallStatus): string {
  if (index.state === "indexing" && index.pending === 0) return "not built yet";
  return `${index.pending} left`;
}

/** The accounts `embed index` works on: the one named, or every enabled one. */
function indexAccounts(config: Config): string[] {
  if (config.accountId !== undefined) return [resolveAccount(config.dataDir, config.accountId).account.id];
  return AccountRegistry.load(config.dataDir)
    .all()
    .filter((account) => account.enabled)
    .map((account) => account.id);
}

/**
 * `wazap embed index [--wait] [--account id] [--json]`. Without --wait it says
 * where each index stands; with it, it embeds what is queued to the end, with
 * a progress line, and exits 0 only when every index is ready.
 */
export async function runEmbedIndex(config: Config): Promise<void> {
  const settings = readRecallSettings(process.env, config.dataDir);
  if (!settings.enabled) {
    throw new WazapError("RECALL_UNAVAILABLE", "Semantic recall is off, so there is no index to build.", "Run `wazap config recall local`");
  }
  if (!config.persistHistory) {
    throw new WazapError("RECALL_UNAVAILABLE", "Semantic recall needs message history kept on disk, which is off.", "Set WAZAP_PERSIST_HISTORY=1");
  }
  if (config.wait) {
    const readiness = await embedReady(settings, EMBED_MODELS[settings.model]);
    if (!readiness.ok) throw new WazapError("RECALL_UNAVAILABLE", readiness.detail, readiness.fix);
  }
  const release = holdSession(config, "Indexing happens in the running server; check get_status");
  const results: { account: string; index: RecallStatus }[] = [];
  try {
    for (const id of indexAccounts(config)) {
      const wa = await openStored(config, id, config.wait);
      try {
        results.push({ account: id, index: config.wait ? await buildWithProgress(wa, id, config.json) : wa.indexStatus() });
      } finally {
        await wa.stop();
      }
    }
  } finally {
    release();
  }

  const ready = results.every((result) => result.index.state === "ready");
  if (config.json) {
    process.stdout.write(`${JSON.stringify({ model: settings.model, ready, accounts: results }, null, 2)}\n`);
  } else {
    for (const { account, index } of results) {
      const line = `${account}: index ${index.state}, ${index.indexed} indexed, ${left(index)} (${settings.model})`;
      say(index.state === "ready" ? ok(line) : index.state === "degraded" ? fail(line) : info(line));
      if (index.state === "degraded") {
        if (index.detail) say(fail(index.detail));
        if (index.fix) say(fix(index.fix));
      }
    }
    if (!config.wait && !ready) say(info("Run `wazap embed index --wait` to embed what is left."));
  }
  if (config.wait && !ready) process.exitCode = 1;
}

async function buildWithProgress(wa: WhatsAppService, account: string, quiet: boolean): Promise<RecallStatus> {
  const spin = quiet ? null : spinner(`${account}: embedding…`);
  let done = false;
  const build = wa.buildIndex().finally(() => {
    done = true;
  });
  try {
    while (!done) {
      await Promise.race([build.catch(() => {}), sleep(PROGRESS_MS)]);
      if (done) break;
      const status = wa.indexStatus();
      spin?.update(`${account}: embedding — ${status.indexed} indexed, ${status.pending} left`);
    }
    const status = await build;
    spin?.stop();
    return status;
  } catch (err) {
    spin?.stop(fail(asWazapError(err).message));
    throw err;
  }
}
