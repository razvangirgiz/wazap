import { Accounts, type AccountProfile } from "./accounts.js";
import { accessContext, caller, type AccessContext } from "./access.js";
import type { Config } from "./config.js";
import { paths } from "./config.js";
import { WazapError, asWazapError } from "./errors.js";
import { writeLock, releaseLock, lockHolder } from "./lock.js";
import { logError } from "./logger.js";
import { WhatsAppService } from "./whatsapp.js";
import type { WhatsAppApi } from "./wa-types.js";

export type AccountRuntime = WhatsAppApi & {
  start(): Promise<void>;
  stop(): Promise<void>;
  setCacheLimit?(limit: number): void;
  onGiveUp?: (() => void) | null;
};
interface Entry {
  api: AccountRuntime;
  config: Config;
  signature: string;
  lock?: string;
  error?: string;
}
export interface AccountAccess {
  ids: string[];
  fingerprint: string;
}

export class AccountManager {
  readonly accounts: Accounts;
  private entries = new Map<string, Entry>();
  private refreshing: Promise<void> | null = null;
  private stopped = false;
  private pending = new Map<string, Promise<void>>();
  private failures = new Map<string, string>();
  private startingCount = 0;
  private startWaiters: Array<() => void> = [];
  private reaper?: ReturnType<typeof setInterval>;
  private active = new Map<string, Set<Promise<unknown>>>();
  error: string | null = null;

  constructor(
    readonly config: Config,
    private factory: (c: Config) => AccountRuntime = (c) =>
      new WhatsAppService(c),
  ) {
    this.accounts = new Accounts(config.dataDir);
    this.accounts.initialize();
  }
  async start(): Promise<void> {
    await this.refresh();
    await Promise.all([...this.pending.values()]);
    if (!this.stopped && !this.reaper) {
      this.reaper = setInterval(() => {
        void this.refresh().catch((err) => {
          this.error = asWazapError(err).message;
        });
      }, 2_000);
      this.reaper.unref();
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.reaper);
    await this.refreshing?.catch(() => {});
    await Promise.all([...this.pending.values()]);
    const results = await Promise.allSettled(
      [...this.entries].map(async ([id, entry]) => {
        try {
          await entry.api.stop();
          await Promise.allSettled([...(this.active.get(id) ?? [])]);
        } finally {
          if (entry.lock) releaseLock(entry.lock);
        }
      }),
    );
    this.entries.clear();
    if (results.some((r) => r.status === "rejected"))
      throw new WazapError(
        "ARCHIVE_UNAVAILABLE",
        "One or more account archives failed to close.",
      );
  }
  access(allowed?: string[]): AccountAccess {
    const permitted = this.config.allowedAccountIds;
    const ids = this.accounts
      .list()
      .map((a) => a.id)
      .filter(
        (id) =>
          (!permitted || permitted.includes(id)) &&
          (!allowed || allowed.includes(id)),
      )
      .sort();
    return { ids, fingerprint: this.accounts.fingerprint(ids) };
  }
  validateAccess(context = caller()): void {
    if (context.accountAccess) {
      const current = this.access(context.accountAccess.ids);
      if (JSON.stringify(current) !== JSON.stringify(context.accountAccess))
        throw new WazapError(
          "ACCOUNT_ACCESS_CHANGED",
          "Account access changed. Reinitialize this MCP connection.",
        );
    }
  }
  private signature(a: AccountProfile): string {
    return JSON.stringify([a.enabled, this.accounts.settings(a)]);
  }
  async refresh(): Promise<void> {
    if (this.stopped)
      throw new WazapError("NOT_CONNECTED", "Wazap is stopping.");
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshNow();
    try {
      await this.refreshing;
      this.error = null;
    } catch (err) {
      this.error = asWazapError(err).message;
      throw err;
    } finally {
      this.refreshing = null;
    }
  }
  private async refreshNow(): Promise<void> {
    const profiles = this.accounts.list();
    const budget = Math.max(
      1,
      Math.floor(10_000 / Math.max(1, profiles.length)),
    );
    for (const entry of this.entries.values())
      entry.api.setCacheLimit?.(budget);
    for (const id of new Set([
      ...profiles.map((a) => a.id),
      ...this.entries.keys(),
    ])) {
      if (this.pending.has(id)) continue;
      const a = profiles.find((a) => a.id === id),
        entry = this.entries.get(id);
      if (a && entry && entry.signature === this.signature(a)) continue;
      const work = this.replace(id, a, profiles.length)
        .catch((err) => {
          this.failures.set(id, asWazapError(err).message);
          logError(`account ${id}`, err);
        })
        .finally(() => {
          this.pending.delete(id);
        });
      this.pending.set(id, work);
    }
  }
  private async replace(
    id: string,
    a: AccountProfile | undefined,
    count: number,
  ): Promise<void> {
    const old = this.entries.get(id);
    if (old) {
      await Promise.allSettled([...(this.active.get(id) ?? [])]);
      try {
        await old.api.stop();
      } finally {
        if (old.lock) releaseLock(old.lock);
        this.entries.delete(id);
      }
    }
    if (!a || this.stopped) return;
    if (this.startingCount >= 2)
      await new Promise<void>((resolve) => this.startWaiters.push(resolve));
    this.startingCount++;
    let lock: string | undefined;
    try {
      if (this.stopped) return;
      const config = this.accounts.config(this.config, a, count);
      const lockFile = paths(config.dataDir).lockFile;
      if (!(a.legacy && lockHolder(lockFile) === process.pid)) {
        if (!writeLock(lockFile))
          throw new WazapError(
            "ACCOUNT_REGISTRY_ERROR",
            `Account ${id} is held by another process.`,
          );
        lock = lockFile;
      }
      const api = this.factory(config);
      const entry: Entry = { api, config, signature: this.signature(a), lock };
      this.entries.set(id, entry);
      api.onGiveUp = () => {
        entry.signature = "restart-needed";
        logError(
          `account ${id}`,
          "Reconnects exhausted; restarting this account independently.",
        );
      };
      try {
        await api.start();
        this.failures.delete(id);
      } catch (err) {
        entry.error = asWazapError(err).message;
        throw err;
      }
    } catch (err) {
      if (!this.entries.has(id) && lock) releaseLock(lock);
      throw err;
    } finally {
      this.startingCount--;
      this.startWaiters.shift()?.();
    }
  }
  list(context = caller()): Array<Record<string, unknown>> {
    this.validateAccess(context);
    const allowed = this.access(context.accountAccess?.ids).ids;
    return this.accounts
      .list()
      .filter((a) => allowed.includes(a.id))
      .map((a) => {
        const entry = this.entries.get(a.id),
          status = entry?.api.getStatus();
        const number = status?.account?.number;
        return {
          account_id: a.id,
          account_name: a.name,
          enabled: a.enabled,
          number: number ? `…${number.slice(-4)}` : null,
          status: this.failures.has(a.id)
            ? "unavailable"
            : (status?.status ?? "connecting"),
          sync: status?.sync ?? "partial",
          archive: this.failures.has(a.id)
            ? { state: "error", error: this.failures.get(a.id) }
            : status?.archive,
          read_only:
            this.config.readOnly ||
            context.allowWrite === false ||
            entry?.config.readOnly === true ||
            !a.enabled,
        };
      });
  }
  health(): { ok: boolean; status: string } {
    let bad: boolean;
    try {
      bad =
        !!this.error ||
        this.accounts
          .list()
          .some(
            (a) =>
              a.enabled &&
              (this.failures.has(a.id) ||
                this.entries.get(a.id)?.api.getStatus().archive?.state ===
                  "error"),
          );
    } catch {
      bad = true;
    }
    return { ok: !bad, status: bad ? "degraded" : "ready" };
  }
  selected(id?: string, context = caller()): AccountProfile {
    this.validateAccess(context);
    const all = this.accounts.list();
    if (!id && all.length !== 1)
      throw new WazapError(
        "ACCOUNT_REQUIRED",
        "Choose account_id explicitly; call list_accounts.",
      );
    const a = all.find((a) => a.id === (id ?? all[0]?.id));
    if (!a || !this.access(context.accountAccess?.ids).ids.includes(a.id))
      throw new WazapError(
        "ACCOUNT_NOT_FOUND",
        "Unknown or inaccessible account.",
      );
    return a;
  }
  draftAccount(
    draftId: string,
    id?: string,
  ): { account: AccountProfile; draftId: string } {
    const match = /^(a_[a-f0-9]{32}|default):(d_[a-f0-9]+)$/.exec(draftId);
    if (!match) return { account: this.selected(id), draftId };
    if (id && id !== match[1])
      throw new WazapError(
        "ACCOUNT_MISMATCH",
        "The draft belongs to another account.",
      );
    return { account: this.selected(match[1]), draftId: match[2]! };
  }
  async withAccount<T>(
    id: string | undefined,
    write: boolean,
    operation: (api: WhatsAppApi, account: AccountProfile) => Promise<T>,
    linkingPhone?: string,
  ): Promise<T> {
    await this.refresh();
    let a = this.selected(id);
    if (!a.enabled && (write || linkingPhone !== undefined))
      throw new WazapError(
        "ACCOUNT_DISABLED",
        "Enable this account before connecting or writing.",
      );
    await this.pending.get(a.id);
    this.validateAccess();
    a = this.selected(a.id);
    const entry = this.entries.get(a.id);
    if (this.failures.has(a.id))
      throw new WazapError("ARCHIVE_UNAVAILABLE", this.failures.get(a.id)!);
    if (!entry)
      throw new WazapError(
        "ACCOUNT_NOT_FOUND",
        "Unknown or inaccessible account.",
      );
    if (entry.error) throw new WazapError("ARCHIVE_UNAVAILABLE", entry.error);
    if (entry.signature !== this.signature(a))
      throw new WazapError(
        "ACCOUNT_ACCESS_CHANGED",
        "Account settings changed during startup. Retry with a fresh connection.",
      );
    if (!a.enabled && (write || linkingPhone !== undefined))
      throw new WazapError(
        "ACCOUNT_DISABLED",
        "Enable this account before connecting or writing.",
      );
    const allowWrite =
      caller().allowWrite && !entry.config.readOnly && a.enabled;
    if (write && !allowWrite)
      throw new WazapError("READ_ONLY", "This account or client is read-only.");
    if (linkingPhone !== undefined)
      this.accounts.checkPhone(a.id, linkingPhone);
    const context = { ...caller(), allowWrite };
    const work = accessContext.run(context, () => operation(entry.api, a));
    let active = this.active.get(a.id);
    if (!active) {
      active = new Set();
      this.active.set(a.id, active);
    }
    active.add(work);
    try {
      return await work;
    } finally {
      active.delete(work);
    }
  }
}
