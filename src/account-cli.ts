import { AccountRegistry, ownerNumber } from "./accounts.js";
import { readLinkedAccount, type LinkedAccount } from "./auth-state.js";
import { ask, leftoverFix, warnIfServerRunning } from "./cli.js";
import { ACCOUNT_USAGE, MIGRATE_USAGE, accountPaths, paths, type Config } from "./config.js";
import { WazapError } from "./errors.js";
import { lockHolder } from "./lock.js";
import { say } from "./logger.js";
import { rollbackMigration } from "./migrate.js";
import { serviceHolding } from "./service.js";
import { brand, info, maskNumber, ok } from "./ui.js";

export interface StatusAccountRow {
  id: string;
  name: string;
  enabled: boolean;
  default: boolean;
  account: LinkedAccount | null;
  /** The jid remembered at link time, so an unlinked row still says whose it was. */
  owner: string | null;
}

type AccountVerb = "list" | "add" | "remove" | "enable" | "disable" | "default";

function parseAccountVerb(verb: string | undefined): AccountVerb {
  switch (verb) {
    case "list":
    case "add":
    case "remove":
    case "enable":
    case "disable":
    case "default":
      return verb;
    default:
      throw new WazapError("INVALID_ID", `Unknown account command "${verb ?? ""}".`, ACCOUNT_USAGE);
  }
}

/** The number is masked: a status screenshot should not carry it. */
export function describeAccount(account: LinkedAccount): string {
  const number = maskNumber(account.number);
  return account.name ? `${account.name} (${number})` : number;
}

export function describeStatusAccount(row: StatusAccountRow): string {
  const flag = row.enabled ? "enabled" : "disabled";
  const who =
    row.account !== null
      ? describeAccount(row.account)
      : row.owner !== null
        ? `was ${maskNumber(ownerNumber(row.owner))}`
        : "not linked";
  return `${row.id}  ${flag}  ${who}`;
}

export function accountRows(config: Config): StatusAccountRow[] {
  const registry = AccountRegistry.load(config.dataDir);
  return registry.all().map((record) => {
    let linked: LinkedAccount | null = null;
    try {
      linked = readLinkedAccount(accountPaths(config.dataDir, record.id).authDir);
    } catch {
      linked = null;
    }
    return {
      id: record.id,
      name: record.name,
      enabled: record.enabled,
      default: record.id === registry.defaultId(),
      account: linked,
      owner: record.owner ?? null,
    };
  });
}

export async function runAccount(config: Config): Promise<void> {
  const [rawVerb, id] = config.args;
  const verb = parseAccountVerb(rawVerb);
  switch (verb) {
    case "list":
      if (id !== undefined) throw new WazapError("INVALID_ID", `Cannot run \`wazap account list ${id}\`.`, ACCOUNT_USAGE);
      listAccounts(config);
      return;
    case "add":
      if (id === undefined) throw new WazapError("INVALID_ID", "Missing account id.", ACCOUNT_USAGE);
      addAccount(config, id);
      return;
    case "remove":
      if (id === undefined) throw new WazapError("INVALID_ID", "Missing account id.", ACCOUNT_USAGE);
      await removeAccount(config, id);
      return;
    case "enable":
      if (id === undefined) throw new WazapError("INVALID_ID", "Missing account id.", ACCOUNT_USAGE);
      enableAccount(config, id, true);
      return;
    case "disable":
      if (id === undefined) throw new WazapError("INVALID_ID", "Missing account id.", ACCOUNT_USAGE);
      enableAccount(config, id, false);
      return;
    case "default":
      if (id === undefined) throw new WazapError("INVALID_ID", "Missing account id.", ACCOUNT_USAGE);
      defaultAccount(config, id);
      return;
    default: {
      const _exhaustive: never = verb;
      return _exhaustive;
    }
  }
}

function listAccounts(config: Config): void {
  for (const row of accountRows(config)) {
    say(`${describeStatusAccount(row)}${row.default ? "  (default)" : ""}`);
  }
}

function addAccount(config: Config, id: string): void {
  const record = AccountRegistry.load(config.dataDir).add(id, config.accountName);
  say(ok(`Account "${record.id}" added.`));
  warnIfServerRunning(config);
}

async function removeAccount(config: Config, id: string): Promise<void> {
  const registry = AccountRegistry.load(config.dataDir);
  if (registry.get(id) === undefined) {
    throw new WazapError("INVALID_ID", `No account "${id}".`, "Run `wazap account list`");
  }
  // Removing an account under a live hub would orphan its socket; even the
  // service must be stopped by hand, so the fix names whichever holder it is.
  const running = lockHolder(paths(config.dataDir).lockFile);
  if (running !== null) {
    throw new WazapError(
      "INVALID_ID",
      `wazap is running (pid ${running}).`,
      leftoverFix(running, serviceHolding(config.dataDir, running) !== null),
    );
  }
  if (!config.assumeYes) {
    if (process.stdin.isTTY !== true) {
      throw new WazapError(
        "INVALID_ID",
        `Refusing to delete account "${id}" without --yes.`,
        "Re-run with --yes",
      );
    }
    const answer = await ask(`${brand("?")} Delete account "${id}" and its local data? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      say(info("Cancelled."));
      return;
    }
  }
  registry.remove(id);
  say(ok(`Account "${id}" removed.`));
}

function enableAccount(config: Config, id: string, enabled: boolean): void {
  const registry = AccountRegistry.load(config.dataDir);
  if (enabled) registry.enable(id);
  else registry.disable(id);
  say(ok(`Account "${id}" ${enabled ? "enabled" : "disabled"}.`));
  warnIfServerRunning(config);
}

function defaultAccount(config: Config, id: string): void {
  AccountRegistry.load(config.dataDir).setDefault(id);
  say(ok(`Default account: "${id}".`));
  warnIfServerRunning(config);
}

export function runMigrate(config: Config): void {
  const [verb] = config.args;
  if (verb !== "rollback") {
    throw new WazapError(
      "INVALID_ID",
      `Cannot run \`wazap migrate ${config.args.join(" ")}\`.`,
      MIGRATE_USAGE,
    );
  }
  rollbackMigration(config.dataDir);
  say(ok("Rolled back the data-dir layout."));
}
