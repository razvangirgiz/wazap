import { accessSync, constants, statSync } from "node:fs";
import { readLinkedAccount } from "./auth-state.js";
import { WAZAP_VERSION, paths, type Config } from "./config.js";
import { WazapError } from "./errors.js";
import { lockHolder, lockPid } from "./lock.js";
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

type CheckFn = (config: Config) => Check | Promise<Check>;

const CHECKS: readonly CheckFn[] = [checkNode, checkDataDir, checkLock, checkCredentials, checkWrites, checkUpdate];

export async function runChecks(config: Config): Promise<Check[]> {
  const checks: Check[] = [];
  for (const check of CHECKS) checks.push(await check(config));
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

/** Version comparison over the numeric release fields; prereleases sort as their release. */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (version: string): number[] => version.split(/[.\-+]/, 3).map((piece) => Number.parseInt(piece, 10) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

async function checkUpdate(): Promise<Check> {
  if (process.env.WAZAP_NO_UPDATE_CHECK === "1") {
    return { name: "update", state: "info", detail: "update check skipped (WAZAP_NO_UPDATE_CHECK=1)" };
  }
  try {
    const response = await fetch("https://registry.npmjs.org/wazap-mcp/latest", {
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { name: "update", state: "info", detail: `update check skipped (registry answered ${response.status})` };
    }
    const { version } = (await response.json()) as { version: string };
    return isNewer(version, WAZAP_VERSION)
      ? { name: "update", state: "info", detail: `${version} is out (running ${WAZAP_VERSION})`, fix: "run `npx wazap-mcp@latest`" }
      : { name: "update", state: "ok", detail: `${WAZAP_VERSION} is current` };
  } catch {
    return { name: "update", state: "info", detail: "update check skipped (offline)" };
  }
}
