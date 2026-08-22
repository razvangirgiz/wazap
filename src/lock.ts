import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Pid of the live process holding the lock, or null if free (missing or stale). */
export function lockHolder(lockFile: string): number | null {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10);
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user, so it is alive.
    return (err as NodeJS.ErrnoException).code === "EPERM" ? pid : null;
  }
}

export function writeLock(lockFile: string): void {
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
  writeFileSync(lockFile, `${process.pid}\n`, { mode: 0o600 });
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
