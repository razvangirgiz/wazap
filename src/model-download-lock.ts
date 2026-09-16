/** Cooperative per-destination exclusion, including safe recovery of known dead owners. */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rmdir, unlink } from "node:fs/promises";
import { WazapError } from "./errors.js";

const FIX =
  "Wait for the other download and retry. If a lock remains, inspect <model>.download-lock/owner-*.json; remove the lock directory only after confirming no downloader is using it";
function locked(): WazapError {
  return new WazapError(
    "TRANSCRIBE_FAILED",
    "Another model download holds this destination, or its lock cannot be safely recovered.",
    FIX
  );
}
function cleanupFailed(): WazapError {
  return new WazapError("TRANSCRIBE_FAILED", "Could not release the model download lock safely.", FIX);
}

/** Never interpret EPERM or an unknown process-probe failure as proof of death. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** A PID on another host/container is not meaningful to this process. */
async function scope(): Promise<string | null> {
  if (process.platform !== "linux") return `${process.platform}:${hostname()}`;
  try {
    return `linux:${hostname()}:${await readlink("/proc/self/ns/pid")}`;
  } catch {
    return null;
  } // Without a namespace identity, automatic recovery is disabled.
}

interface Owner {
  file: string;
  pid: number;
  scope: string;
}
async function knownOwner(directory: string): Promise<Owner | null> {
  try {
    if (!(await lstat(directory)).isDirectory()) return null;
    const names = await readdir(directory);
    if (names.length !== 1 || !/^owner-[\da-f-]{36}\.json$/.test(names[0]!)) return null;
    const file = join(directory, names[0]!);
    const info = await lstat(file);
    if (!info.isFile() || info.size < 1 || info.size > 4096) return null;
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (value === null || typeof value !== "object") return null;
    const owner = value as { version?: unknown; pid?: unknown; scope?: unknown };
    if (
      owner.version !== 1 ||
      typeof owner.pid !== "number" ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0 ||
      owner.pid > 2_147_483_647 ||
      typeof owner.scope !== "string"
    )
      return null;
    return { file, pid: owner.pid, scope: owner.scope };
  } catch {
    return null;
  } // Empty, malformed or inaccessible claims are never age-expired.
}

export interface ModelDownloadLock {
  /** Canonical parent prevents directory symlink/relative aliases bypassing exclusion. */
  path: string;
  release(): Promise<void>;
}

export async function acquireModelDownloadLock(path: string): Promise<ModelDownloadLock> {
  const absolute = resolve(path);
  const target = join(await realpath(dirname(absolute)), basename(absolute));
  const directory = `${target}.download-lock`;
  const localScope = await scope();

  const claim = async (): Promise<ModelDownloadLock | null> => {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw err;
    }
    const file = join(directory, `owner-${randomUUID()}.json`);
    let created = false;
    try {
      const handle = await open(file, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(
          JSON.stringify({ version: 1, pid: process.pid, scope: localScope, started_at: new Date().toISOString() })
        );
      } finally {
        await handle.close();
      }
    } catch (err) {
      // Only remove our own metadata, then an empty directory. Never recurse.
      if (created) {
        try {
          await unlink(file);
        } catch {
          throw cleanupFailed();
        }
      }
      await rmdir(directory).catch(() => {});
      throw err;
    }
    let releasing: Promise<void> | undefined;
    return {
      path: target,
      release() {
        return (releasing ??= (async () => {
          try {
            // Successful unlink of our unique name is the right to remove the
            // now-empty directory. An old/repeated release cannot remove a successor.
            await unlink(file);
            await rmdir(directory);
          } catch {
            throw cleanupFailed();
          }
        })());
      },
    };
  };

  const fresh = await claim();
  if (fresh) return fresh;
  const owner = await knownOwner(directory);
  if (!owner || localScope === null || owner.scope !== localScope || alive(owner.pid)) throw locked();
  try {
    // Several processes may observe the same dead owner. Only ONE can unlink
    // this generation's unique filename; losers MUST NOT remove the directory.
    await unlink(owner.file);
    await rmdir(directory);
  } catch {
    throw locked();
  }
  const recovered = await claim();
  if (!recovered) throw locked(); // Another ordinary claimant may win after rmdir.
  return recovered;
}
