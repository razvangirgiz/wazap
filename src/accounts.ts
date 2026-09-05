import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import dotenv from "dotenv";
import { atomicWrite } from "./atomic-file.js";
import { paths, readOnlySetting, type Config } from "./config.js";
import { WazapError } from "./errors.js";
import { writeLock, releaseLock } from "./lock.js";

export interface AccountProfile {
  id: string;
  name: string;
  enabled: boolean;
  legacy?: boolean;
  owner?: string;
}
interface AccountRegistry {
  version: 1;
  accounts: AccountProfile[];
}
const ID = /^(default|a_[a-f0-9]{32})$/;

/** The legacy directory is a fixed exception, never a user-provided registry path. */
export class Accounts {
  readonly file: string;
  constructor(readonly root: string) {
    this.root = resolve(root);
    this.file = join(this.root, "accounts.json");
  }

  list(): AccountProfile[] {
    if (!existsSync(this.file)) {
      const legacy = ["auth", "archive.sqlite", "store.json", "history"].some(
        (p) => existsSync(join(this.root, p)),
      );
      return legacy
        ? [{ id: "default", name: "WhatsApp", enabled: true, legacy: true }]
        : [];
    }
    try {
      const registry = JSON.parse(
        readFileSync(this.file, "utf8"),
      ) as AccountRegistry;
      if (registry.version !== 1 || !Array.isArray(registry.accounts))
        throw Error("Unsupported schema");
      const ids = new Set<string>(),
        names = new Set<string>();
      for (const a of registry.accounts) {
        if (
          !a ||
          !ID.test(a.id) ||
          typeof a.name !== "string" ||
          !a.name.trim() ||
          a.name.length > 80 ||
          /[\r\n\x00-\x1f]/.test(a.name) ||
          typeof a.enabled !== "boolean" ||
          (a.legacy !== undefined && a.legacy !== true) ||
          (a.legacy && a.id !== "default") ||
          (a.id === "default" && !a.legacy) ||
          (a.owner !== undefined && !/^\d+@s\.whatsapp\.net$/.test(a.owner))
        )
          throw Error("Invalid account record");
        if (ids.has(a.id) || names.has(a.name.toLowerCase()))
          throw Error("Duplicate account id or name");
        ids.add(a.id);
        names.add(a.name.toLowerCase());
      }
      const owners = registry.accounts.flatMap((a) =>
        a.owner ? [a.owner] : [],
      );
      if (new Set(owners).size !== owners.length)
        throw Error("Duplicate WhatsApp owner");
      return registry.accounts;
    } catch (err) {
      throw new WazapError(
        "ACCOUNT_REGISTRY_ERROR",
        `Cannot read accounts.json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private update(
    change: (accounts: AccountProfile[]) => void,
  ): AccountProfile[] {
    const lock = join(this.root, "accounts.lock");
    if (!writeLock(lock))
      throw new WazapError(
        "ACCOUNT_REGISTRY_ERROR",
        "Accounts are being changed by another process. Retry.",
      );
    try {
      const accounts = this.list();
      change(accounts);
      atomicWrite(this.file, JSON.stringify({ version: 1, accounts }, null, 2));
      return accounts;
    } finally {
      releaseLock(lock);
    }
  }

  initialize(): void {
    if (existsSync(this.file)) {
      this.list();
      return;
    }
    this.update((accounts) => {
      if (!accounts.length)
        accounts.push({
          id: "default",
          name: "WhatsApp",
          enabled: true,
          legacy: true,
        });
    });
  }

  add(name: string): AccountProfile {
    const a: AccountProfile = {
      id: `a_${randomUUID().replaceAll("-", "")}`,
      name: this.name(name),
      enabled: true,
    };
    this.update((accounts) => {
      this.uniqueName(accounts, a.name);
      accounts.push(a);
    });
    return a;
  }
  rename(id: string, name: string): void {
    name = this.name(name);
    this.update((accounts) => {
      const a = this.find(accounts, id);
      this.uniqueName(
        accounts.filter((x) => x.id !== id),
        name,
      );
      a.name = name;
    });
  }
  enable(id: string, enabled: boolean): void {
    this.update((accounts) => {
      this.find(accounts, id).enabled = enabled;
    });
  }
  bind(id: string, owner: string): void {
    owner = owner.replace(/:\d+@/, "@");
    if (!/^\d+@s\.whatsapp\.net$/.test(owner))
      throw new WazapError(
        "ACCOUNT_MISMATCH",
        "Unrecognized WhatsApp identity.",
      );
    const current = this.list();
    if (this.find(current, id).owner === owner) return;
    this.update((accounts) => {
      const a = this.find(accounts, id);
      if (a.owner && a.owner !== owner)
        throw new WazapError(
          "ACCOUNT_MISMATCH",
          "This profile belongs to another WhatsApp account. Add a new profile.",
        );
      if (
        accounts.some(
          (other) =>
            other.id !== id &&
            (other.owner === owner || this.credentialOwner(other) === owner),
        )
      )
        throw new WazapError(
          "ACCOUNT_DUPLICATE",
          "This WhatsApp account already belongs to another profile.",
        );
      a.owner = owner;
    });
  }
  checkPhone(id: string, phone: string): void {
    const owner = `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
    const all = this.list(),
      a = this.find(all, id);
    if (a.owner && a.owner !== owner)
      throw new WazapError(
        "ACCOUNT_MISMATCH",
        "Use the original number or create a new account profile.",
      );
    if (
      all.some(
        (other) =>
          other.id !== id &&
          (other.owner === owner || this.credentialOwner(other) === owner),
      )
    )
      throw new WazapError(
        "ACCOUNT_DUPLICATE",
        "This WhatsApp account is already registered.",
      );
  }
  private credentialOwner(a: AccountProfile): string | undefined {
    const file = join(this.directory(a), "auth", "creds.json");
    if (!existsSync(file)) return;
    try {
      const id = JSON.parse(readFileSync(file, "utf8")).me?.id;
      return typeof id === "string" ? id.replace(/:\d+@/, "@") : undefined;
    } catch {
      throw new WazapError(
        "ACCOUNT_REGISTRY_ERROR",
        `Cannot establish the owner of profile ${a.id}: unreadable credentials.`,
      );
    }
  }
  get(id?: string): AccountProfile {
    const accounts = this.list();
    if (!id && accounts.length !== 1)
      throw new WazapError(
        "ACCOUNT_REQUIRED",
        "Choose an account explicitly.",
        "Run wazap accounts list or call list_accounts.",
      );
    return this.find(accounts, id ?? accounts[0]!.id);
  }
  directory(a: AccountProfile): string {
    if (!ID.test(a.id))
      throw new WazapError("ACCOUNT_REGISTRY_ERROR", "Invalid account id.");
    const dir = a.legacy ? this.root : join(this.root, "accounts", a.id);
    if (!a.legacy)
      for (const part of [join(this.root, "accounts"), dir]) {
        if (
          existsSync(part) &&
          (lstatSync(part).isSymbolicLink() || !lstatSync(part).isDirectory())
        )
          throw new WazapError(
            "ACCOUNT_REGISTRY_ERROR",
            "Account directories must be real directories, not links.",
          );
      }
    return dir;
  }
  fingerprint(ids?: string[]): string {
    const accounts = this.list().filter((a) => !ids || ids.includes(a.id));
    return createHash("sha256")
      .update(
        JSON.stringify(
          accounts.map((a) => ({
            id: a.id,
            enabled: a.enabled,
            settings: this.settings(a),
          })),
        ),
      )
      .digest("hex");
  }
  settings(a: AccountProfile): Record<string, string> {
    const file = paths(this.directory(a)).envFile;
    return existsSync(file) ? dotenv.parse(readFileSync(file)) : {};
  }
  config(base: Config, a: AccountProfile, count = this.list().length): Config {
    const dataDir = this.directory(a),
      settings = this.settings(a);
    const env = { ...(base.accountEnv ?? process.env), ...settings };
    const boolean = (key: string, fallback: boolean): boolean => {
      if (settings[key] === undefined) return fallback;
      const value = settings[key]!.trim().toLowerCase();
      if (
        !["0", "1", "true", "false", "on", "off", "yes", "no"].includes(value)
      )
        throw new WazapError(
          "ACCOUNT_REGISTRY_ERROR",
          `Invalid ${key} for ${a.id}.`,
        );
      return ["1", "true", "on", "yes"].includes(value);
    };
    return {
      ...base,
      dataDir,
      rootDataDir: this.root,
      accountId: a.id,
      accountOwner: a.owner,
      accountEnv: env,
      offline: !a.enabled,
      cacheLimit: Math.max(1, Math.floor(10_000 / Math.max(1, count))),
      readOnly:
        base.readOnly ||
        (settings.WAZAP_READ_ONLY === undefined
          ? false
          : readOnlySetting(settings.WAZAP_READ_ONLY)),
      persistHistory:
        base.persistHistory &&
        boolean("WAZAP_PERSIST_HISTORY", base.persistHistory),
      syncFullHistory: boolean("WAZAP_SYNC_FULL_HISTORY", base.syncFullHistory),
      exportDir: settings.WAZAP_EXPORT_DIR
        ? resolve(settings.WAZAP_EXPORT_DIR)
        : base.exportDir,
      validateAccount: (owner) => this.bind(a.id, owner),
    };
  }
  private find(accounts: AccountProfile[], id: string): AccountProfile {
    const a = accounts.find((a) => a.id === id);
    if (!a)
      throw new WazapError(
        "ACCOUNT_NOT_FOUND",
        "Unknown or inaccessible account.",
      );
    return a;
  }
  private name(name: string): string {
    name = name.trim();
    if (!name || name.length > 80 || /[\r\n\x00-\x1f]/.test(name))
      throw new WazapError(
        "INVALID_ID",
        "Account names must contain 1–80 characters on one line.",
      );
    return name;
  }
  private uniqueName(accounts: AccountProfile[], name: string): void {
    if (accounts.some((a) => a.name.toLowerCase() === name.toLowerCase()))
      throw new WazapError("INVALID_ID", "Choose a distinct account name.");
  }
}
