import { accessSync, constants, statSync } from "node:fs";
import { AccountRegistry, accountPolicy, anyAccountLinked, resolveAccount } from "./accounts.js";
import { readLinkedAccount } from "./auth-state.js";
import {
  WAZAP_VERSION,
  WRITES_ENABLE_FIX,
  WRITE_TOKEN_NOTE,
  accountPaths,
  isRemoteHttp,
  paths,
  type Config,
} from "./config.js";
import { WazapError, asWazapError } from "./errors.js";
import { lockHolder, lockPid } from "./lock.js";
import { oauthProblem, readGrants } from "./oauth.js";
import { EMBED_MODELS, embedModelPath, embedReady, readRecallSettings } from "./recall/index.js";
import { installedService } from "./service.js";
import { detectedTargets, skillState } from "./skills.js";
import {
  MODELS,
  findWhisper,
  localProvider,
  maskKey,
  modelPath,
  readTranscribeSettings,
  which,
  type ProviderName,
  type TranscribeSettings,
} from "./transcribe/index.js";
import { dim, fail, fix, green, info, ok, red, warn, yellow } from "./ui.js";
import type { WebhookDelivery } from "./wa-types.js";
import {
  WEBHOOK_FAILING_AFTER,
  WEBHOOK_MAX_BACKLOG,
  WEBHOOK_MAX_INFLIGHT,
  readWebhookDelivery,
  readWebhookSettings,
  webhookFailureFix,
} from "./webhook.js";

/** `warn` works but is losing something: nothing is broken yet, and nothing blocks setup. */
export type CheckState = "ok" | "warn" | "fail" | "info";

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
  fix?: string;
}

export const MARK: Record<CheckState, string> = { ok: "✓", warn: "!", fail: "✗", info: "–" };

const GLYPH: Record<CheckState, (text: string) => string> = { ok, warn, fail, info };

const TINT: Record<CheckState, (text: string) => string> = { ok: green, warn: yellow, fail: red, info: dim };

const UPDATE_TIMEOUT_MS = 2_000;
/**
 * The account database runs on node:sqlite and needs backup(), the timeout
 * option and isTransaction: 22.16.0 on the 22 line, 24.0.0 after it. The 23
 * line never got isTransaction, so it is refused whatever its minor.
 */
const MIN_NODE_22_MINOR = 16;
const NODE_FIX = "install Node 24 LTS, or Node 22.16 or newer";

/** A check function may answer with a group, the way transcription does. */
type CheckFn = (config: Config) => Check | Check[] | Promise<Check | Check[]>;

const CHECKS: readonly CheckFn[] = [
  checkNode,
  checkDataDir,
  checkLock,
  checkService,
  checkCredentials,
  checkWrites,
  checkSkills,
  checkOAuth,
  checkTranscribe,
  checkRecall,
  checkWebhook,
  checkUpdate,
];

/** Setup will offer these. Until an account is linked, their fix lines fight `Next wazap setup`. */
const OPTIONAL_UNTIL_LINKED = new Set(["service", "skills", "transcribe"]);

export async function runChecks(config: Config): Promise<Check[]> {
  const checks: Check[] = [];
  for (const check of CHECKS) checks.push(...[await check(config)].flat());
  let linked: boolean;
  try {
    linked = anyAccountLinked(config.dataDir);
  } catch {
    linked = false;
  }
  if (linked) return checks;
  return checks.map((check) => {
    if (!OPTIONAL_UNTIL_LINKED.has(check.name) || check.fix === undefined) return check;
    const { fix: _fix, ...rest } = check;
    return rest;
  });
}

/**
 * One line, everything on it. What pipes, logs and captured output get. Colour
 * wraps the whole line rather than just the glyph: an escape landing between
 * the mark and the name would split phrases that callers grep for.
 */
export function checkLine(check: Check): string {
  const body = `${MARK[check.state]} ${check.name}: ${check.detail}${check.fix ? ` — ${check.fix}` : ""}`;
  return TINT[check.state](body);
}

/** The same check for a human: no colon, and the repair on its own line. */
export function checkLines(check: Check): string[] {
  const head = GLYPH[check.state](`${check.name} ${check.detail}`);
  return check.fix === undefined ? [head] : [head, fix(check.fix)];
}

function checkNode(): Check {
  return nodeVersionCheck(process.versions.node);
}

/** major.minor against the floor; exported so the rule is testable without another Node. */
export function nodeVersionCheck(version: string): Check {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  if (major >= 24 || (major === 22 && minor >= MIN_NODE_22_MINOR)) return { name: "node", state: "ok", detail: version };
  const detail = major === 23 ? `${version} lacks node:sqlite features wazap needs` : `${version} is too old`;
  return { name: "node", state: "fail", detail, fix: NODE_FIX };
}

function checkDataDir(config: Config): Check {
  const dir = config.dataDir;
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return { name: "data dir", state: "info", detail: `${dir} does not exist yet (login creates it)` };
  }
  if (!stat.isDirectory()) {
    return {
      name: "data dir",
      state: "fail",
      detail: `${dir} is not a directory`,
      fix: "move it aside or use --data-dir",
    };
  }

  const mode = stat.mode & 0o777;
  if (process.platform !== "win32" && mode !== 0o700) {
    return {
      name: "data dir",
      state: "fail",
      detail: `${dir} is mode ${mode.toString(8).padStart(4, "0")}, not 0700`,
      fix: `run \`chmod 700 ${dir}\``,
    };
  }
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    return {
      name: "data dir",
      state: "fail",
      detail: `${dir} is not writable`,
      fix: "fix its ownership or permissions",
    };
  }
  return { name: "data dir", state: "ok", detail: `${dir} (0700, writable)` };
}

function checkLock(config: Config): Check {
  const lockFile = paths(config.dataDir).lockFile;
  const alive = lockHolder(lockFile);
  if (alive !== null) return { name: "lock", state: "ok", detail: `held by a running server (pid ${alive})` };
  const recorded = lockPid(lockFile);
  if (recorded !== null) {
    return { name: "lock", state: "info", detail: `stale (pid ${recorded} is gone); the next start reclaims it` };
  }
  return { name: "lock", state: "info", detail: "none" };
}

/** Whether the background service is installed, alive, and running this build. */
function checkService(config: Config): Check {
  const found = installedService(config.dataDir);
  if (found === null) {
    return { name: "service", state: "info", detail: "not installed", fix: "run `wazap service install`" };
  }
  const { supervisor, record } = found;
  const pid = supervisor.pid(record);
  if (pid === null) {
    return { name: "service", state: "fail", detail: "installed but not running", fix: "run `wazap service start`" };
  }
  if (isNewer(WAZAP_VERSION, record.installedVersion)) {
    return {
      name: "service",
      state: "info",
      detail: `runs ${record.installedVersion}, ${WAZAP_VERSION} is installed`,
      fix: "run `wazap service restart`",
    };
  }
  if (isNewer(record.installedVersion, WAZAP_VERSION)) {
    return {
      name: "service",
      state: "info",
      detail: `runs ${record.installedVersion}, but only ${WAZAP_VERSION} is installed`,
      fix: "run `wazap update` — restarting keeps the newer build",
    };
  }
  return { name: "service", state: "ok", detail: `running (pid ${pid}, ${supervisor.name})` };
}

function checkCredentials(config: Config): Check {
  // The data dir is linked when any account is; every corrupt record fails,
  // naming its account.
  let records;
  try {
    records = AccountRegistry.load(config.dataDir).all();
  } catch (err) {
    const wazap = err as WazapError;
    return { name: "credentials", state: "fail", detail: wazap.message, fix: wazap.fix };
  }
  const linkedIds: string[] = [];
  for (const record of records) {
    try {
      if (readLinkedAccount(accountPaths(config.dataDir, record.id).authDir) !== null) linkedIds.push(record.id);
    } catch (err) {
      const wazap = err as WazapError;
      return { name: "credentials", state: "fail", detail: `${record.id}: ${wazap.message}`, fix: wazap.fix };
    }
  }
  if (linkedIds.length === 0) return { name: "credentials", state: "info", detail: "no account linked yet" };
  // The number is deliberately absent: status is the thing people screenshot.
  return {
    name: "credentials",
    state: "ok",
    detail: records.length > 1 ? `readable (${linkedIds.join(", ")})` : "readable",
  };
}

function checkWrites(config: Config): Check {
  const selected = resolveAccount(config.dataDir, config.accountId);
  const readOnly = accountPolicy(selected.account, config).readOnly;
  const source = selected.account.writes === undefined ? config.sources.readOnly : "accounts.json";
  if (!readOnly) {
    return {
      name: "writes",
      state: "ok",
      detail: isRemoteHttp(config)
        ? `on (${source}); a write token unlocks write tools only while this stays on`
        : `on (${source})`,
    };
  }
  return {
    name: "writes",
    state: "info",
    detail: isRemoteHttp(config)
      ? `off (${source}); write tools are not registered. ${WRITE_TOKEN_NOTE}`
      : `off (${source}); write tools are not registered`,
    fix: WRITES_ENABLE_FIX,
  };
}

/**
 * Whether each detected harness holds the workflows this build ships. A global
 * upgrade leaves the copies behind, and nothing else would ever say so.
 */
function checkSkills(): Check {
  const targets = detectedTargets();
  if (targets.length === 0) return { name: "skills", state: "info", detail: "no skill-aware client detected" };

  const states = targets.map((target) => ({ name: target.name, state: skillState(target) }));
  if (states.every((target) => target.state === "installed")) {
    return { name: "skills", state: "ok", detail: `installed for ${states.map((t) => t.name).join(", ")}` };
  }
  return {
    name: "skills",
    state: "info",
    detail: states.map((target) => `${target.state} for ${target.name}`).join("; "),
    fix: "run `wazap skills install`",
  };
}

/** Only when OAuth is configured: whether it can start, and who is signed in. */
function checkOAuth(config: Config): Check[] {
  if (!config.publicUrl && !config.oauthPassword) return [];
  const problem = oauthProblem(config);
  if (problem) return [{ name: "oauth", state: "fail", detail: problem, fix: "edit <data-dir>/.env" }];
  if (config.transport !== "http") {
    return [{ name: "oauth", state: "info", detail: "configured, but only served with WAZAP_TRANSPORT=http" }];
  }
  const grants = readGrants(paths(config.dataDir).oauthFile);
  if (grants.length === 0) {
    return [{ name: "oauth", state: "info", detail: `on at ${config.publicUrl}, no agent signed in yet` }];
  }
  const who = grants.map((g) => `${g.client} (${g.scopes.join("+")})`).join(", ");
  return [{ name: "oauth", state: "ok", detail: `on at ${config.publicUrl}; signed in: ${who}` }];
}

const TRANSCRIBE_OFF_FIX = "run `wazap config transcribe local` to transcribe voice messages";
const DOWNLOAD_FIX = "run `wazap transcribe download`";
const KEY_FIX = "run `wazap config transcribe openai`";
const MIB = 1024 * 1024;

/** What each provider needs before it can run. Keyed like PROVIDERS. */
const TRANSCRIBE_CHECKS: Record<ProviderName, (settings: TranscribeSettings) => Check[] | Promise<Check[]>> = {
  local: localChecks,
  openai: openaiChecks,
};

async function checkTranscribe(config: Config): Promise<Check | Check[]> {
  let settings: TranscribeSettings;
  try {
    settings = readTranscribeSettings(process.env, config.dataDir);
  } catch (err) {
    // A stale WAZAP_TRANSCRIBE_URL or provider name in someone's .env is exactly
    // what status is for, so the refusal is reported rather than thrown.
    const failure = asWazapError(err);
    return { name: "transcribe", state: "fail", detail: failure.message, fix: failure.fix };
  }
  if (settings.provider === null) return { name: "transcribe", state: "info", detail: "off", fix: TRANSCRIBE_OFF_FIX };
  return TRANSCRIBE_CHECKS[settings.provider](settings);
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

async function localChecks(settings: TranscribeSettings): Promise<Check[]> {
  const whisper = findWhisper(settings);
  const ffmpeg = which("ffmpeg");
  const spec = MODELS[settings.model];
  const size = fileSize(modelPath(settings.modelsDir, spec));
  // ready() reports only the first problem and looks at the binaries before the
  // model, so its fix is the platform's install hint whenever one is missing.
  const install = (await localProvider.ready(settings)).fix;

  return [
    { name: "transcribe", state: "ok", detail: "local (whisper.cpp)" },
    whisper === null
      ? { name: "whisper", state: "fail", detail: "not found", fix: install }
      : { name: "whisper", state: "ok", detail: whisper },
    ffmpeg === null
      ? { name: "ffmpeg", state: "fail", detail: "not found", fix: install }
      : { name: "ffmpeg", state: "ok", detail: "found" },
    size === null
      ? { name: "model", state: "fail", detail: `${spec.file} is not downloaded`, fix: DOWNLOAD_FIX }
      : { name: "model", state: "ok", detail: `${spec.file} (${Math.round(size / MIB)} MiB)` },
  ];
}

const RECALL_OFF_FIX = "run `wazap config recall local` to search messages by meaning";

/**
 * Off is quiet; on reports the sidecar binary and the model file, the two
 * things `embed download` plus an install can repair.
 */
async function checkRecall(config: Config): Promise<Check[]> {
  let settings;
  try {
    settings = readRecallSettings(process.env, config.dataDir);
  } catch (err) {
    const failure = asWazapError(err);
    return [{ name: "recall", state: "fail", detail: failure.message, fix: failure.fix }];
  }
  if (!settings.enabled) return [{ name: "recall", state: "info", detail: "off", fix: RECALL_OFF_FIX }];
  const spec = EMBED_MODELS[settings.model];
  const size = fileSize(embedModelPath(settings.modelsDir, spec));
  const readiness = await embedReady(settings, spec);
  // An env-set floor is the user's own calibration; only the model's
  // unmeasured default gets flagged.
  const uncalibrated =
    !spec.floorCalibrated && process.env.WAZAP_RECALL_MIN_SIMILARITY === undefined ? ", uncalibrated floor" : "";
  return [
    { name: "recall", state: "ok", detail: `local (${settings.model}${uncalibrated})` },
    readiness.ok
      ? { name: "llama-server", state: "ok", detail: settings.embedUrl ?? "found" }
      : { name: "llama-server", state: "fail", detail: readiness.detail, fix: readiness.fix },
    size === null && settings.embedUrl === null
      ? { name: "embed model", state: "fail", detail: `${spec.file} is not downloaded`, fix: "run `wazap embed download`" }
      : { name: "embed model", state: "ok", detail: `${spec.file} (${Math.round((size ?? 0) / MIB)} MiB)` },
  ];
}

/** What one account's server last wrote about its deliveries. */
export interface WebhookDeliveryRow {
  account: string;
  delivery: WebhookDelivery;
}

/** A drop is an event nobody will ever see, so it is worth a warning for a day. */
const WEBHOOK_DROP_RECENT_MS = 24 * 60 * 60 * 1000;

/**
 * W1 webhook: off is quiet; on without a URL or secret is a visible fail. Once a
 * server has posted, what it left on disk decides the rest: a run of failed
 * events fails, one failure since the last delivery or a drop in the last day
 * warns.
 */
export function webhookCheck(
  env: NodeJS.ProcessEnv = process.env,
  deliveries: readonly WebhookDeliveryRow[] = [],
  now: number = Date.now()
): Check {
  const settings = readWebhookSettings(env);
  switch (settings.kind) {
    case "off":
      return { name: "webhook", state: "info", detail: "off" };
    case "ready":
      return deliveryCheck(`on (${new URL(settings.url).host})`, deliveries, now);
    case "invalid":
      return { name: "webhook", state: "fail", detail: settings.detail, fix: settings.fix };
    default: {
      const _exhaustive: never = settings;
      return _exhaustive;
    }
  }
}

function deliveryCheck(on: string, rows: readonly WebhookDeliveryRow[], now: number): Check {
  const named = (row: WebhookDeliveryRow, text: string): string =>
    `${on}; ${rows.length > 1 ? `${row.account}: ` : ""}${text}`;
  const failing = rows.find((row) => row.delivery.consecutive_failures >= WEBHOOK_FAILING_AFTER);
  if (failing !== undefined) {
    const { consecutive_failures: run, last_failure_at: at, last_failure: failure } = failing.delivery;
    return {
      name: "webhook",
      state: "fail",
      detail: named(failing, `${run} events failed in a row, the last at ${at}: ${failure}`),
      fix: webhookFailureFix(failure ?? ""),
    };
  }
  const flaky = rows.find((row) => row.delivery.consecutive_failures > 0);
  if (flaky !== undefined) {
    const { last_failure_at: at, last_failure: failure } = flaky.delivery;
    return {
      name: "webhook",
      state: "warn",
      detail: named(flaky, `the last event failed at ${at}: ${failure}`),
      fix: webhookFailureFix(failure ?? ""),
    };
  }
  const dropping = rows.find((row) => {
    const at = row.delivery.last_dropped_at;
    return at !== null && now - Date.parse(at) < WEBHOOK_DROP_RECENT_MS;
  });
  if (dropping !== undefined) {
    const { dropped, last_dropped_at: at } = dropping.delivery;
    return {
      name: "webhook",
      state: "warn",
      detail: named(dropping, `${dropped} events dropped with the backlog full, the last at ${at}`),
      fix: `make the receiver answer sooner: wazap holds ${WEBHOOK_MAX_INFLIGHT} POSTs open and queues ${WEBHOOK_MAX_BACKLOG} behind them`,
    };
  }
  if (rows.length === 0) return { name: "webhook", state: "ok", detail: on };
  const total = (key: "delivered" | "failed" | "dropped"): number =>
    rows.reduce((sum, row) => sum + row.delivery[key], 0);
  const counts = [`${total("delivered")} delivered`];
  if (total("failed") > 0) counts.push(`${total("failed")} failed`);
  if (total("dropped") > 0) counts.push(`${total("dropped")} dropped`);
  return { name: "webhook", state: "ok", detail: `${on}; ${counts.join(", ")}` };
}

/** Every account whose server has posted at least once; a registry that will not load reads as none. */
export function webhookDeliveries(dataDir: string): WebhookDeliveryRow[] {
  let records;
  try {
    records = AccountRegistry.load(dataDir).all();
  } catch {
    return [];
  }
  return records.flatMap((record) => {
    const delivery = readWebhookDelivery(accountPaths(dataDir, record.id).webhookFile);
    return delivery === null ? [] : [{ account: record.id, delivery }];
  });
}

/** The server that delivers runs in another process, so this reads what it left in each account dir. */
function checkWebhook(config: Config): Check {
  return webhookCheck(process.env, webhookDeliveries(config.dataDir));
}

/** maskKey is the only thing that ever renders the key, here and everywhere else. */
function openaiChecks(settings: TranscribeSettings): Check[] {
  return [
    { name: "transcribe", state: "ok", detail: `openai (${settings.apiModel} at ${new URL(settings.baseUrl).host})` },
    settings.apiKey === null
      ? { name: "api key", state: "fail", detail: maskKey(null), fix: KEY_FIX }
      : { name: "api key", state: "ok", detail: maskKey(settings.apiKey) },
  ];
}

/** Version comparison over the numeric release fields; prereleases sort as their release. */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (version: string): number[] =>
    version.split(/[.\-+]/, 3).map((piece) => Number.parseInt(piece, 10) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** What the registry calls latest, or null when it will not say. */
export async function latestVersion(): Promise<string | null> {
  if (process.env.WAZAP_NO_UPDATE_CHECK === "1") return null;
  try {
    const response = await fetch("https://registry.npmjs.org/wazap-mcp/latest", {
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const { version } = (await response.json()) as { version: string };
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}

async function checkUpdate(): Promise<Check> {
  if (process.env.WAZAP_NO_UPDATE_CHECK === "1") {
    return { name: "update", state: "info", detail: "update check skipped (WAZAP_NO_UPDATE_CHECK=1)" };
  }
  const latest = await latestVersion();
  if (latest === null) return { name: "update", state: "info", detail: "update check skipped (no answer)" };
  return isNewer(latest, WAZAP_VERSION)
    ? {
        name: "update",
        state: "info",
        detail: `${latest} is out (running ${WAZAP_VERSION})`,
        fix: "run `wazap update`",
      }
    : { name: "update", state: "ok", detail: `${WAZAP_VERSION} is current` };
}
