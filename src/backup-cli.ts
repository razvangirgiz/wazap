/**
 * `wazap backup <path>`: one copy of an account database, on demand.
 *
 * The copy is taken online and read-only, so it is the same command whether a
 * server is running or not: it never migrates the database, never writes to it,
 * and a running server's writes neither block it nor land halfway in it. What
 * it writes is a whole SQLite database — `0600`, in a folder created `0700` —
 * that any wazap of the version that wrote it can open.
 *
 * It is not encrypted, and it holds every message the account has.
 */
import { existsSync, lstatSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { resolveAccount } from "./accounts.js";
import { BACKUP_USAGE, type Config } from "./config.js";
import { backupDatabase, StorageError } from "./db/index.js";
import { WazapError } from "./errors.js";
import { say } from "./logger.js";
import { ok, tilde } from "./ui.js";

/** MiB once it is worth saying in MiB, KiB below that: the same grain doctor uses. */
function bytes(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KiB` : `${Math.round(n / (1024 * 1024))} MiB`;
}

export async function runBackup(config: Config): Promise<void> {
  const { account, paths } = resolveAccount(config.dataDir, config.accountId);
  const source = paths.databaseFile;
  if (!existsSync(source)) {
    throw new WazapError(
      "FILE_NOT_FOUND",
      `Account "${account.id}" has no database yet.`,
      "Start wazap once so the account has something to copy"
    );
  }

  const given = config.args[0];
  if (given === undefined || given === "") throw new WazapError("INVALID_ID", "A backup needs a path to write to.", BACKUP_USAGE);
  const destination = resolve(given);
  const there = lstatSync(destination, { throwIfNoEntry: false });
  if (there?.isDirectory() === true) {
    throw new WazapError("INVALID_ID", "That path is a folder.", "Give the file to write, e.g. `wazap backup ~/wazap-backup.sqlite`");
  }
  // A link is a file that stands for another; replacing one only on --force
  // keeps `wazap backup` from following it somewhere the user did not mean.
  if (there !== undefined && config.force !== true) {
    throw new WazapError("INVALID_ID", "That file already exists.", "Pass --force to replace it, or give another path");
  }

  try {
    await backupDatabase(source, destination);
  } catch (err) {
    if (err instanceof StorageError) throw new WazapError("SERVICE_ERROR", err.message, err.fix);
    throw err;
  }
  say(ok(`${tilde(destination)} · ${bytes(statSync(destination).size)} · the messages in it are not encrypted`));
}
