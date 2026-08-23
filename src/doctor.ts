import { accessSync, constants, statSync } from "node:fs";
import { readLinkedAccount } from "./auth-state.js";
import { WAZAP_VERSION, paths, type Config } from "./config.js";
import { WazapError, asWazapError } from "./errors.js";
import { lockHolder, lockPid } from "./lock.js";
import { oauthProblem, readGrants } from "./oauth.js";
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
import { dim, fail, fix, green, info, ok, red } from "./ui.js";

export type CheckState = "ok" | "fail" | "info";

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
  fix?: string;
}

export const MARK: Record<CheckState, string> = { ok: "✓", fail: "✗", info: "–" };

const GLYPH: Record<CheckState, (text: string) => string> = { ok, fail, info };

const TINT: Record<CheckState, (text: string) => string> = { ok: green, fail: red, info: dim };

const UPDATE_TIMEOUT_MS = 2_000;
const MIN_NODE_MAJOR = 20;

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
  checkUpdate,
];

export async function runChecks(config: Config): Promise<Check[]> {
  const checks: Check[] = [];
  for (const check of CHECKS) checks.push(...[await check(config)].flat());
  return checks;
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
  const version = process.versions.node;
  const major = Number.parseInt(version.split(".")[0]!, 10);
  return major >= MIN_NODE_MAJOR
    ? { name: "node", state: "ok", detail: version }
    : { name: "node", state: "fail", detail: `${version} is too old`, fix: `install Node ${MIN_NODE_MAJOR} or newer` };
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
    return { name: "data dir", state: "fail", detail: `${dir} is not a directory`, fix: "move it aside or use --data-dir" };
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
    return { name: "data dir", state: "fail", detail: `${dir} is not writable`, fix: "fix its ownership or permissions" };
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
  if (record.installedVersion !== WAZAP_VERSION) {
    return {
      name: "service",
      state: "info",
      detail: `runs ${record.installedVersion}, ${WAZAP_VERSION} is installed`,
      fix: "run `wazap service restart`",
    };
  }
  return { name: "service", state: "ok", detail: `running (pid ${pid}, ${supervisor.name})` };
}

function checkCredentials(config: Config): Check {
  const authDir = paths(config.dataDir).authDir;
  try {
    const account = readLinkedAccount(authDir);
    // The number is deliberately absent: status is the thing people screenshot.
    return account === null
      ? { name: "credentials", state: "info", detail: "no account linked yet" }
      : { name: "credentials", state: "ok", detail: "readable" };
  } catch (err) {
    const wazap = err as WazapError;
    return { name: "credentials", state: "fail", detail: wazap.message, fix: wazap.fix };
  }
}

function checkWrites(config: Config): Check {
  return {
    name: "writes",
    state: "ok",
    detail: `${config.readOnly ? "off" : "on"} (${config.sources.readOnly})`,
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
  const parts = (version: string): number[] => version.split(/[.\-+]/, 3).map((piece) => Number.parseInt(piece, 10) || 0);
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
    ? { name: "update", state: "info", detail: `${latest} is out (running ${WAZAP_VERSION})`, fix: "run `wazap update`" }
    : { name: "update", state: "ok", detail: `${WAZAP_VERSION} is current` };
}
