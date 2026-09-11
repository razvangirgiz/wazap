/**
 * One process, N WhatsApp sockets. The registry names the accounts; this holds
 * a live service for each enabled one, with its own reconnect loop and write
 * bucket. MCP tools resolve a service per call.
 */

import { AccountRegistry, type AccountRecord } from "./accounts.js";
import { accountPaths, type Config } from "./config.js";
import { WazapError } from "./errors.js";
import { logError } from "./logger.js";
import type { WhatsAppApi } from "./wa-types.js";
import { WhatsAppService } from "./whatsapp.js";

const FIX_ENABLE = "Run `wazap account enable <id>` or `wazap account add <id>`";

/** What HTTP, stdio and `registerTools` use to pick an account. */
export interface AccountSource {
  get(id: string): WhatsAppApi | undefined;
  default(): WhatsAppApi;
  all(): WhatsAppApi[];
  findByChat(jid: string): WhatsAppApi[];
  findByMessage(id: string): WhatsAppApi[];
  record(id: string): AccountRecord | undefined;
  records(): AccountRecord[];
}

function accountIdOf(wa: WhatsAppApi): string {
  if (typeof wa.getStatus !== "function") return "default";
  try {
    const id = wa.getStatus().account_id;
    return typeof id === "string" && id.length > 0 ? id : "default";
  } catch {
    return "default";
  }
}

function canFindChat(wa: WhatsAppApi): wa is WhatsAppApi & { hasChat(jid: string): boolean } {
  return typeof wa.hasChat === "function";
}

function canFindMessage(wa: WhatsAppApi): wa is WhatsAppApi & { hasMessage(id: string): boolean } {
  return typeof wa.hasMessage === "function";
}

/** One live service as a hub, so existing tests can keep passing a stub `wa`. */
export function singletonSource(wa: WhatsAppApi): AccountSource {
  const idOf = (): string => accountIdOf(wa);
  const self = (): AccountRecord => {
    let name = idOf();
    try {
      const listed = wa.getStatus().account_name;
      if (typeof listed === "string" && listed.length > 0) name = listed;
    } catch {
      // Stub services often have no getStatus.
    }
    return { id: idOf(), name, enabled: true, owner: null };
  };
  return {
    get(id) {
      return id === idOf() ? wa : undefined;
    },
    default: () => wa,
    all: () => [wa],
    findByChat(jid) {
      return canFindChat(wa) && wa.hasChat(jid) ? [wa] : [];
    },
    findByMessage(id) {
      return canFindMessage(wa) && wa.hasMessage(id) ? [wa] : [];
    },
    record(id) {
      return id === idOf() ? self() : undefined;
    },
    records: () => [self()],
  };
}

export function isAccountSource(value: AccountSource | WhatsAppApi): value is AccountSource {
  return (
    typeof value === "object" &&
    value !== null &&
    "default" in value &&
    "all" in value &&
    typeof (value as AccountSource).default === "function" &&
    typeof (value as AccountSource).all === "function"
  );
}

export function asAccountSource(source: AccountSource | WhatsAppApi): AccountSource {
  if (!isAccountSource(source)) return singletonSource(source);
  const complete =
    typeof source.get === "function" &&
    typeof source.findByChat === "function" &&
    typeof source.findByMessage === "function" &&
    typeof source.record === "function" &&
    typeof source.records === "function";
  return complete ? source : singletonSource(source.default());
}

export class AccountHub implements AccountSource {
  private readonly services = new Map<string, WhatsAppService>();
  private readonly known = new Map<string, AccountRecord>();
  private readonly givenUp = new Set<string>();
  private readonly primary: WhatsAppService;
  /** Process exit hook. Fires only after every enabled account has given up. */
  onGiveUp: (() => void) | null = null;

  constructor(config: Config, registry: AccountRegistry) {
    for (const account of registry.all()) {
      this.known.set(account.id, { ...account });
    }
    const enabled = registry.all().filter((account) => account.enabled);
    if (enabled.length === 0) {
      throw new WazapError("INVALID_ID", "No enabled account to serve.", FIX_ENABLE);
    }
    for (const account of enabled) {
      const wa = new WhatsAppService(config, account, accountPaths(config.dataDir, account.id));
      wa.onGiveUp = () => this.noteGiveUp(account.id);
      this.services.set(account.id, wa);
    }
    const first = this.services.values().next().value;
    if (first === undefined) {
      throw new WazapError("INVALID_ID", "No enabled account to serve.", FIX_ENABLE);
    }
    this.primary = this.services.get(registry.defaultId()) ?? first;
  }

  async start(): Promise<void> {
    await Promise.all(
      [...this.services].map(([id, wa]) =>
        wa.start().catch((err: unknown) => {
          logError(`whatsapp start ${id}`, err);
          this.noteGiveUp(id);
        }),
      ),
    );
  }

  async stop(): Promise<void> {
    await Promise.all([...this.services.values()].map((wa) => wa.stop()));
  }

  get(id: string): WhatsAppService | undefined {
    return this.services.get(id);
  }

  default(): WhatsAppService {
    return this.primary;
  }

  all(): WhatsAppService[] {
    return [...this.services.values()];
  }

  findByChat(jid: string): WhatsAppService[] {
    return this.all().filter((wa) => wa.hasChat(jid));
  }

  findByMessage(id: string): WhatsAppService[] {
    return this.all().filter((wa) => wa.hasMessage(id));
  }

  record(id: string): AccountRecord | undefined {
    const found = this.known.get(id);
    return found === undefined ? undefined : { ...found };
  }

  records(): AccountRecord[] {
    return [...this.known.values()].map((account) => ({ ...account }));
  }

  private noteGiveUp(id: string): void {
    if (this.givenUp.has(id)) return;
    this.givenUp.add(id);
    logError("whatsapp", `account ${id}: reconnects exhausted`);
    if (this.givenUp.size < this.services.size) return;
    this.onGiveUp?.();
  }
}
