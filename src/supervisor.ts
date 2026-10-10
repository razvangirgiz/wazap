/**
 * wazap's own supervisor, for machines with neither launchd nor systemd: a
 * container whose PID 1 is tini or a shell, a box without a user session. It
 * is the third Supervisor next to them, so `service install|status|start|stop|
 * restart|logs|uninstall`, `expose`, `login` and `update` drive it the same way.
 *
 * One small process per unit (`wazap supervise <unit.json>`), started in a
 * session of its own so it outlives the shell and the terminal that started
 * it, keeps the unit's command running:
 *
 *   - a pidfile claimed like server.lock, so two supervisors never run one unit
 *     (a zombie holder counts as gone, as everywhere in this file);
 *   - the command's stdout and stderr appended to the unit's two log files,
 *     which are copied aside and emptied past 10 MB;
 *   - a crash restarted after 1 s, doubling to a minute while it keeps
 *     crashing within a minute of starting, and given up after ten such
 *     crashes in a row (systemd's StartLimitBurst, in effect), which `status`
 *     reports;
 *   - SIGTERM stops the command (SIGKILL after 15 s), then itself.
 *
 * A wazap command it runs gets an IPC channel, and `serve` shuts down when the
 * channel closes: a supervisor killed with -9 does not leave a server holding
 * the data dir's lock with nobody to restart or stop it. `stop` also kills a
 * command whose supervisor is already gone, after checking the pid still runs
 * that command. It does not come back after the machine restarts: nothing
 * starts it at boot. `wazap service start` does.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WazapError } from "./errors.js";
import { lockPid, releaseLock, writeLock } from "./lock.js";
import type { Supervisor, UnitRef, UnitSpec } from "./service.js";

/** Restarts wait this long, doubling while the command keeps crashing early. */
export const RESTART_MIN_MS = 1_000;
export const RESTART_MAX_MS = 60_000;
/** A run at least this long was healthy: the next crash starts the backoff over. */
export const HEALTHY_RUN_MS = 60_000;
/** Crashes in a row, each within HEALTHY_RUN_MS of its start, before giving up. */
export const MAX_QUICK_CRASHES = 10;
const STOP_GRACE_MS = 15_000;
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const LOG_CHECK_MS = 10 * 60_000;
const TAIL_LINES = 50;

/** What `supervise` keeps beside the pidfile, for `status` and `stop`. */
export interface SupervisorState {
  supervisor: number;
  child: number | null;
  /** argv[0..1] of the command, to tell it from an unrelated process that took its pid. */
  command: string[];
  startedAt: number | null;
  restarts: number;
  lastExit: string | null;
  gaveUp: boolean;
}

export function defaultStateDir(): string {
  const base = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(base, "wazap");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Running, not merely a pid: a process that exited but was never reaped (a
 * zombie, while its parent is busy) still answers signal 0, and waiting for
 * it to stop would wait forever.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return !zombie(pid);
}

function zombie(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
  } catch {
    /* not Linux, or gone */
  }
  if (process.platform === "linux") return false;
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 && (result.stdout ?? "").trim().startsWith("Z");
}

/** The command line `pid` runs, or null when it cannot be read (gone, or no /proc and no ps). */
export function commandOf(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
  } catch {
    /* not Linux, or gone */
  }
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const line = (result.stdout ?? "").trim();
  return line === "" ? null : line;
}

/** Alive, and still running something that names every one of `marks`: never a pid the system handed to someone else. */
function runs(pid: number | null, marks: readonly string[]): pid is number {
  if (pid === null || !alive(pid)) return false;
  const command = commandOf(pid);
  return command !== null && marks.every((mark) => command.includes(mark));
}

function files(dir: string, label: string) {
  return {
    unit: join(dir, `${label}.json`),
    pid: join(dir, `${label}.pid`),
    state: join(dir, `${label}.state.json`),
    out: join(dir, `${label}.out.log`),
    err: join(dir, `${label}.err.log`),
  };
}

export function readState(file: string): SupervisorState | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SupervisorState;
    return typeof parsed.supervisor === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(file: string, state: SupervisorState): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  // A rename, not a rewrite, so a reader never sees half a file.
  renameSync(tmp, file);
}

function readUnit(file: string): UnitSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new WazapError("SERVICE_ERROR", `${file} is not a unit wazap wrote.`, "run `wazap service install` again");
  }
  const unit = parsed as Partial<UnitSpec>;
  if (
    typeof unit.label !== "string" ||
    !Array.isArray(unit.argv) ||
    unit.argv.length === 0 ||
    !unit.argv.every((part) => typeof part === "string") ||
    typeof unit.env !== "object" ||
    unit.env === null
  ) {
    throw new WazapError("SERVICE_ERROR", `${file} is not a unit wazap wrote.`, "run `wazap service install` again");
  }
  return unit as UnitSpec;
}

/** The marks that identify a unit's command: its program and, for node, the script it runs. */
function commandMarks(argv: readonly string[]): string[] {
  return argv.slice(0, 2).map((part) => basename(part));
}

/** This build's entry point, which the supervisor process runs. */
function entryScript(): string {
  return realpathSync(fileURLToPath(new URL("./index.js", import.meta.url)));
}

const STOP_FIX = "run `wazap service logs`, then `wazap service stop` again";

export function builtinSupervisor(stateDir: () => string = defaultStateDir): Supervisor {
  const where = (label: string) => files(stateDir(), label);

  /** The supervisor process for `label`, when one is alive and is ours. */
  const supervisorPid = (label: string): number | null => {
    const f = where(label);
    const pid = lockPid(f.pid);
    return runs(pid, ["supervise", basename(f.unit)]) ? pid : null;
  };

  const stopUnit = (ref: UnitRef): void => {
    const f = where(ref.label);
    const state = readState(f.state);
    const pid = supervisorPid(ref.label);
    if (pid !== null) {
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + STOP_GRACE_MS + 5_000;
      while (alive(pid) && Date.now() < deadline) sleepSync(100);
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    // A command whose supervisor was killed outright: stop it too, but only
    // while its pid still runs that command.
    const child = state?.child ?? null;
    if (state !== null && runs(child, commandMarks(state.command))) {
      process.kill(child, "SIGTERM");
      const deadline = Date.now() + STOP_GRACE_MS;
      while (alive(child) && Date.now() < deadline) sleepSync(100);
      if (alive(child)) process.kill(child, "SIGKILL");
    }
    if (pid !== null && alive(pid)) {
      throw new WazapError("SERVICE_ERROR", `The supervisor (pid ${pid}) did not stop.`, STOP_FIX);
    }
    rmSync(f.pid, { force: true });
    rmSync(f.state, { force: true });
  };

  const startUnit = (ref: UnitRef): void => {
    const f = where(ref.label);
    if (supervisorPid(ref.label) !== null) return;
    readUnit(ref.unitFile);
    // A command left running by a supervisor that died: one owner at a time.
    const stale = readState(f.state);
    if (stale !== null && runs(stale.child, commandMarks(stale.command))) stopUnit(ref);
    mkdirSync(dirname(f.err), { recursive: true, mode: 0o700 });
    const err = openSync(f.err, "a", 0o600);
    let child;
    try {
      child = spawn(process.execPath, [entryScript(), "supervise", ref.unitFile], {
        detached: true,
        stdio: ["ignore", "ignore", err],
        env: { HOME: homedir(), PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
    } finally {
      closeSync(err);
    }
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new WazapError("SERVICE_ERROR", "Could not start the wazap supervisor.", STOP_FIX);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (lockPid(f.pid) === pid) return;
      // Two starts at once: the other one's supervisor won the pidfile, and this one left.
      if (!alive(pid)) {
        if (supervisorPid(ref.label) !== null) return;
        break;
      }
      sleepSync(50);
    }
    const reason = tail(f.err, 3).join(" / ");
    throw new WazapError(
      "SERVICE_ERROR",
      `The wazap supervisor did not start${reason === "" ? "." : `: ${reason}`}`,
      "run `wazap service logs`"
    );
  };

  const supervisor: Supervisor = {
    name: "builtin",
    available: () => process.platform !== "win32",
    logDir: () => stateDir(),
    unitFile: (label) => where(label).unit,
    render: (unit) => `${JSON.stringify(unit, null, 2)}\n`,
    start: startUnit,
    stop: stopUnit,
    restart: (ref) => {
      stopUnit(ref);
      startUnit(ref);
    },
    remove: (ref) => {
      stopUnit(ref);
      rmSync(ref.unitFile, { force: true });
    },
    pid: (ref) => {
      const state = readState(where(ref.label).state);
      if (state === null || supervisorPid(ref.label) === null) return null;
      return state.child !== null && alive(state.child) ? state.child : null;
    },
    logs: (ref) => {
      const file = where(ref.label).err;
      return [`tail -f ${file}`, ...tail(file, TAIL_LINES)];
    },
    describe: (ref) => {
      const state = readState(where(ref.label).state);
      if (state === null) return null;
      if (state.gaveUp) return `gave up after ${MAX_QUICK_CRASHES} quick crashes (last: ${state.lastExit ?? "unknown"})`;
      return state.restarts > 0 ? `restarted ${state.restarts} times (last exit: ${state.lastExit ?? "unknown"})` : null;
    },
  };
  return supervisor;
}

function tail(file: string, lines: number): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Run `gone` once this process's supervisor is gone, when one started it with
 * an IPC channel (the `ipc` above). A channel that closed while this process
 * was still loading has already fired its "disconnect" to nobody, so that is
 * checked first: `process.connected` is false by then.
 */
export function whenSupervisorGone(gone: () => void): void {
  if (typeof process.send !== "function") return;
  if (!process.connected) gone();
  else process.once("disconnect", gone);
}

/** The wait before restart number `quick` in a row of quick crashes (1-based). */
export function restartDelay(quick: number): number {
  if (quick <= 1) return RESTART_MIN_MS;
  return Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** (quick - 1));
}

/** Copy a log aside and empty it once it passes the limit; the writer's O_APPEND keeps writing at the new end. */
function rotate(file: string): void {
  try {
    if (statSync(file).size < LOG_MAX_BYTES) return;
    copyFileSync(file, `${file}.1`);
    truncateSync(file, 0);
  } catch {
    /* a log that cannot be rotated is still written */
  }
}

/**
 * `wazap supervise <unit.json>`: the supervisor process itself. Not for people;
 * `wazap service start` runs it. Resolves when it has stopped for good.
 */
export async function runSupervise(
  unitFile: string,
  opts: { now?: () => number; delay?: (quick: number) => number } = {}
): Promise<void> {
  const now = opts.now ?? Date.now;
  const delayFor = opts.delay ?? restartDelay;
  const unit = readUnit(unitFile);
  const f = files(dirname(unitFile), unit.label);
  const note = (line: string): void => {
    try {
      appendFileSync(f.err, `${new Date(now()).toISOString()} supervisor: ${line}\n`, { mode: 0o600 });
    } catch {
      /* nowhere to say it */
    }
  };
  // Its own idea of alive: a dead supervisor's zombie, in a container whose
  // PID 1 never reaps, would otherwise hold the unit forever.
  if (!writeLock(f.pid, alive)) {
    note(`another supervisor (pid ${lockPid(f.pid)}) already runs ${unit.label}; this one exits`);
    return;
  }

  const state: SupervisorState = {
    supervisor: process.pid,
    child: null,
    command: unit.argv.slice(0, 2),
    startedAt: null,
    restarts: 0,
    lastExit: null,
    gaveUp: false,
  };
  writeState(f.state, state);

  let stopping = false;
  let current: ReturnType<typeof spawn> | null = null;
  let wake: (() => void) | null = null;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    note(`${signal}: stopping ${unit.label}`);
    wake?.();
    if (current !== null && current.exitCode === null && current.signalCode === null) {
      current.kill("SIGTERM");
      const pid = current.pid;
      setTimeout(() => {
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
      }, STOP_GRACE_MS).unref();
    }
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  // The terminal that started it closing is not a reason to stop.
  process.on("SIGHUP", () => {});

  const rotation = setInterval(() => {
    rotate(f.out);
    rotate(f.err);
  }, LOG_CHECK_MS);
  rotation.unref();

  const node = basename(unit.argv[0]!).startsWith("node");
  let quick = 0;
  try {
    while (!stopping) {
      rotate(f.out);
      rotate(f.err);
      const out = openSync(f.out, "a", 0o600);
      const err = openSync(f.err, "a", 0o600);
      const startedAt = now();
      try {
        current = spawn(unit.argv[0]!, unit.argv.slice(1), {
          env: { ...unit.env },
          // A wazap command learns its supervisor is gone when this channel closes.
          stdio: node ? ["ignore", out, err, "ipc"] : ["ignore", out, err],
        });
      } finally {
        closeSync(out);
        closeSync(err);
      }
      const child = current;
      const exit = await new Promise<string>((resolve) => {
        child.once("error", (error) => resolve(`could not start: ${error.message}`));
        child.once("exit", (code, signal) => resolve(signal !== null ? `signal ${signal}` : `code ${code}`));
        if (child.pid !== undefined) {
          state.child = child.pid;
          state.startedAt = startedAt;
          writeState(f.state, state);
          note(`started ${unit.label} (pid ${child.pid})`);
        }
      });
      current = null;
      state.child = null;
      state.lastExit = exit;
      if (stopping) {
        note(`${unit.label} stopped (${exit})`);
        break;
      }
      quick = now() - startedAt >= HEALTHY_RUN_MS ? 1 : quick + 1;
      if (quick > MAX_QUICK_CRASHES) {
        state.gaveUp = true;
        writeState(f.state, state);
        note(`${unit.label} exited (${exit}) ${MAX_QUICK_CRASHES} times in a row within a minute; giving up. Fix the cause, then run \`wazap service start\``);
        return;
      }
      state.restarts += 1;
      writeState(f.state, state);
      const delay = delayFor(quick);
      note(`${unit.label} exited (${exit}); restarting in ${Math.round(delay / 1000)} s`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  } finally {
    clearInterval(rotation);
    if (!state.gaveUp) rmSync(f.state, { force: true });
    releaseLock(f.pid);
  }
}
