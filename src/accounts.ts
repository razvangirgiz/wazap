import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { accountPaths, paths, type AccountPaths, type Config } from "./config.js";
import { WazapError } from "./errors.js";

export const DEFAULT_ACCOUNT_ID = "default";
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface AccountRecord {
  id: string;
  name: string;
  enabled: boolean;
  owner: string | null;
  writes?: boolean;
  rate_limit?: number;
  webhook_url?: string;
  webhook_secret?: string;
}

export interface AccountsFile {
  v: 2;
  default: string;
  accounts: AccountRecord[];
}

export interface ResolvedAccount {
  registry: AccountRegistry;
  account: AccountRecord;
  paths: AccountPaths;
}

const FIX_LIST = "Run `wazap account list`";
const FIX_ADD = "Run `wazap account add <id>` first, or `wazap account list`";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/** Global flag/env is a hard off. A per-account `writes: false` turns that account off. */
export function accountPolicy(
  account: AccountRecord,
  config: Pick<Config, "readOnly" | "rateLimitPerMinute">,
): { readOnly: boolean; rateLimit: number } {
  return {
    readOnly: config.readOnly || account.writes === false,
    rateLimit: account.rate_limit ?? config.rateLimitPerMinute,
  };
}

/** Atomic JSON write: tmp plus rename, mode 0600, the same contract as daemon.json. */
export function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

export function parseAccountId(id: string): string {
  if (!ACCOUNT_ID_RE.test(id)) {
    throw new WazapError(
      "INVALID_ID",
      `Invalid account id "${id}".`,
      "Use a slug like default or work: lowercase letters, digits, hyphen; 1–32 characters",
    );
  }
  return id;
}

function synthesizedDefault(): AccountsFile {
  return {
    v: 2,
    default: DEFAULT_ACCOUNT_ID,
    accounts: [{ id: DEFAULT_ACCOUNT_ID, name: DEFAULT_ACCOUNT_ID, enabled: true, owner: null }],
  };
}

function parseAccountRecord(value: unknown, file: string): AccountRecord {
  if (!isRecord(value) || typeof value.id !== "string" || !ACCOUNT_ID_RE.test(value.id)) {
    throw new WazapError("INVALID_ID", `Invalid account entry in ${file}.`, "Fix or remove accounts.json");
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw new WazapError("INVALID_ID", `Account "${value.id}" in ${file} has no name.`, "Fix or remove accounts.json");
  }
  if (typeof value.enabled !== "boolean") {
    throw new WazapError("INVALID_ID", `Account "${value.id}" in ${file} is missing enabled.`, "Fix or remove accounts.json");
  }
  if (value.owner !== null && typeof value.owner !== "string") {
    throw new WazapError("INVALID_ID", `Account "${value.id}" in ${file} has a bad owner.`, "Fix or remove accounts.json");
  }
  const record: AccountRecord = {
    id: value.id,
    name: value.name,
    enabled: value.enabled,
    owner: value.owner,
  };
  if (value.writes !== undefined) {
    if (typeof value.writes !== "boolean") {
      throw new WazapError("INVALID_ID", `Account "${value.id}" in ${file} has a bad writes flag.`, "Fix or remove accounts.json");
    }
    record.writes = value.writes;
  }
  if (value.rate_limit !== undefined) {
    if (typeof value.rate_limit !== "number" || !Number.isFinite(value.rate_limit) || value.rate_limit < 0) {
      throw new WazapError("INVALID_ID", `Account "${value.id}" in ${file} has a bad rate_limit.`, "Fix or remove accounts.json");
    }
    record.rate_limit = value.rate_limit;
  }
  if (value.webhook_url !== undefined) {
    if (typeof value.webhook_url !== "string" || value.webhook_url.trim() === "") {
      throw new WazapError("INVALID_ID", `Account "${value.id}" in ${file} has a bad webhook_url.`, "Fix or remove accounts.json");
    }
    record.webhook_url = value.webhook_url.trim().replace(/\/+$/, "");
  }
  if (value.webhook_secret !== undefined) {
    if (typeof value.webhook_secret !== "string" || value.webhook_secret === "") {
      throw new WazapError("INVALID_ID", `Account "${value.id}" in ${file} has a bad webhook_secret.`, "Fix or remove accounts.json");
    }
    record.webhook_secret = value.webhook_secret;
  }
  return record;
}

function parseAccountsFile(value: unknown, file: string): AccountsFile {
  if (!isRecord(value) || value.v !== 2 || typeof value.default !== "string" || !Array.isArray(value.accounts)) {
    throw new WazapError("INVALID_ID", `Could not read ${file}.`, "Fix the JSON or remove the file");
  }
  if (value.accounts.length === 0) {
    throw new WazapError("INVALID_ID", `${file} lists no accounts.`, FIX_ADD);
  }
  const accounts = value.accounts.map((entry) => parseAccountRecord(entry, file));
  const ids = new Set(accounts.map((account) => account.id));
  if (ids.size !== accounts.length) {
    throw new WazapError("INVALID_ID", `${file} lists the same account id twice.`, "Fix or remove accounts.json");
  }
  if (!ids.has(value.default)) {
    throw new WazapError("INVALID_ID", `${file} default "${value.default}" is not an account.`, "Fix or remove accounts.json");
  }
  return { v: 2, default: value.default, accounts };
}

export class AccountRegistry {
  private constructor(
    readonly dataDir: string,
    private file: AccountsFile,
  ) {}

  /**
   * Load accounts.json, or an in-memory default account when the file is
   * missing. A missing file next to `accounts/default/` is not an error; the
   * migrator creates the file. This load still synthesizes so login and status
   * work on a fresh data dir without writing anything.
   */
  static load(dataDir: string): AccountRegistry {
    const file = paths(dataDir).accountsFile;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if (isEnoent(err)) return new AccountRegistry(dataDir, synthesizedDefault());
      throw new WazapError("INVALID_ID", `Could not read ${file}.`, "Fix the JSON or remove the file");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new WazapError("INVALID_ID", `Could not read ${file}.`, "Fix the JSON or remove the file");
    }
    return new AccountRegistry(dataDir, parseAccountsFile(parsed, file));
  }

  save(): void {
    this.commit(this.file);
  }

  defaultId(): string {
    return this.file.default;
  }

  all(): AccountRecord[] {
    return this.file.accounts.map((account) => ({ ...account }));
  }

  get(id: string): AccountRecord | undefined {
    const found = this.file.accounts.find((account) => account.id === id);
    return found === undefined ? undefined : { ...found };
  }

  add(id: string, name?: string): AccountRecord {
    const slug = parseAccountId(id);
    if (this.get(slug) !== undefined) {
      throw new WazapError("INVALID_ID", `Account "${slug}" already exists.`, "Pick another id");
    }
    const record: AccountRecord = {
      id: slug,
      name: name === undefined || name.trim() === "" ? slug : name.trim(),
      enabled: true,
      owner: null,
    };
    this.commit({ ...this.file, accounts: [...this.file.accounts, record] });
    mkdirSync(accountPaths(this.dataDir, slug).root, { recursive: true, mode: 0o700 });
    return { ...record };
  }

  remove(id: string): void {
    const slug = parseAccountId(id);
    if (this.file.accounts.length <= 1) {
      throw new WazapError("INVALID_ID", "Cannot remove the last account.", "Add another account first");
    }
    const accounts = this.file.accounts.filter((account) => account.id !== slug);
    if (accounts.length === this.file.accounts.length) {
      throw new WazapError("INVALID_ID", `No account "${slug}".`, FIX_LIST);
    }
    this.commit({
      ...this.file,
      default: this.file.default === slug ? accounts[0]!.id : this.file.default,
      accounts,
    });
    rmSync(accountPaths(this.dataDir, slug).root, { recursive: true, force: true });
  }

  enable(id: string): void {
    this.commit(this.withAccount(id, (account) => ({ ...account, enabled: true })));
  }

  disable(id: string): void {
    this.commit(this.withAccount(id, (account) => ({ ...account, enabled: false })));
  }

  setOwner(id: string, owner: string | null): void {
    this.commit(this.withAccount(id, (account) => ({ ...account, owner })));
  }

  setWrites(id: string, writes: boolean): void {
    this.commit(this.withAccount(id, (account) => ({ ...account, writes })));
  }

  setWebhook(id: string, webhook: { url?: string; secret?: string }): void {
    this.commit(
      this.withAccount(id, (account) => {
        const next = { ...account };
        if (webhook.url !== undefined) next.webhook_url = webhook.url.trim().replace(/\/+$/, "");
        if (webhook.secret !== undefined) next.webhook_secret = webhook.secret;
        return next;
      }),
    );
  }

  private commit(next: AccountsFile): void {
    writeJsonFile(paths(this.dataDir).accountsFile, next);
    this.file = next;
  }

  private withAccount(id: string, update: (account: AccountRecord) => AccountRecord): AccountsFile {
    const slug = parseAccountId(id);
    let found = false;
    const accounts = this.file.accounts.map((account) => {
      if (account.id !== slug) return account;
      found = true;
      return update(account);
    });
    if (!found) {
      throw new WazapError("INVALID_ID", `No account "${slug}".`, FIX_LIST);
    }
    return { ...this.file, accounts };
  }
}

/** The account `--account` named, or the default. Unknown ids fail. */
export function resolveAccount(dataDir: string, accountId?: string): ResolvedAccount {
  const registry = AccountRegistry.load(dataDir);
  const id = accountId === undefined ? registry.defaultId() : parseAccountId(accountId);
  const account = registry.get(id);
  if (account === undefined) {
    throw new WazapError("INVALID_ID", `No account "${id}".`, FIX_ADD);
  }
  return { registry, account, paths: accountPaths(dataDir, account.id) };
}

/** Persist a synthesized default so a just-migrated dir always has accounts.json. */
export function ensureAccountsFile(dataDir: string): AccountRegistry {
  const registry = AccountRegistry.load(dataDir);
  if (!existsSync(paths(dataDir).accountsFile)) registry.save();
  return registry;
}
