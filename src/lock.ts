import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Pid recorded in the lock file, whether or not that process is still alive. */
export function lockPid(lockFile: string): number | null {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10);
  } catch {
    return null;
  }
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Pid of the live process holding the lock, or null if free (missing or stale). */
export function lockHolder(lockFile: string): number | null {
  const pid = lockPid(lockFile);
  if (pid === null) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user, so it is alive.
    return (err as NodeJS.ErrnoException).code === "EPERM" ? pid : null;
  }
}

/** Create the lock file, or false if it already existed. */
function claim(lockFile: string): boolean {
  try {
    writeFileSync(lockFile, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** Take the lock, or false if another live process holds it. */
export function writeLock(lockFile: string): boolean {
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
  if (claim(lockFile)) return true;
  if (lockHolder(lockFile) !== null) return false;
  try {
    unlinkSync(lockFile);
  } catch {
    /* someone else cleared the stale lock first */
  }
  return claim(lockFile);
}

/** Remove the lock, but only if it is still ours. */
export function releaseLock(lockFile: string): void {
  try {
    if (Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10) !== process.pid) return;
    unlinkSync(lockFile);
  } catch {
    /* already gone */
  }
}
