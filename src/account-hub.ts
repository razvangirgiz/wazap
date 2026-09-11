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

/** A live socket plus the registry id that owns it. Tools never recover the id from getStatus. */
export interface AccountBinding {
  readonly id: string;
  readonly wa: WhatsAppApi;
}

/** What HTTP, stdio and `registerTools` use to pick an account. */
export interface AccountSource {
  binding(id: string): AccountBinding | undefined;
  defaultBinding(): AccountBinding;
  bindings(): AccountBinding[];
  findByChat(jid: string): AccountBinding[];
  findByMessage(id: string): AccountBinding[];
  findByDraft(id: string): AccountBinding[];
  record(id: string): AccountRecord | undefined;
  records(): AccountRecord[];
}

function bind(id: string, wa: WhatsAppApi): AccountBinding {
  return { id, wa };
}

function readSingletonId(wa: WhatsAppApi): string {
  try {
    const id = wa.getStatus().account_id;
    return typeof id === "string" && id.length > 0 ? id : "default";
  } catch {
    return "default";
  }
}

function readSingletonName(wa: WhatsAppApi, fallback: string): string {
  try {
    const name = wa.getStatus().account_name;
    return typeof name === "string" && name.length > 0 ? name : fallback;
  } catch {
    return fallback;
  }
}

/** One live service as a hub, so existing tests can keep passing a stub `wa`. */
export function singletonSource(wa: WhatsAppApi): AccountSource {
  const id = readSingletonId(wa);
  const binding = bind(id, wa);
  const self = (): AccountRecord => ({
    id,
    name: readSingletonName(wa, id),
    enabled: true,
    owner: null,
  });
  return {
    binding: (requested) => (requested === id ? binding : undefined),
    defaultBinding: () => binding,
    bindings: () => [binding],
    findByChat: (jid) => (typeof wa.hasChat === "function" && wa.hasChat(jid) ? [binding] : []),
    findByMessage: (mid) => (typeof wa.hasMessage === "function" && wa.hasMessage(mid) ? [binding] : []),
    findByDraft: (did) => (typeof wa.hasDraft === "function" && wa.hasDraft(did) ? [binding] : []),
    record: (requested) => (requested === id ? self() : undefined),
    records: () => [self()],
  };
}

export class AccountHub implements AccountSource {
  private readonly services = new Map<string, WhatsAppService>();
  private readonly known = new Map<string, AccountRecord>();
  private readonly givenUp = new Set<string>();
  private readonly primary: WhatsAppService;
  private readonly primaryId: string;
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
    const firstId = enabled[0]!.id;
    this.primaryId = this.services.has(registry.defaultId()) ? registry.defaultId() : firstId;
    this.primary = this.services.get(this.primaryId)!;
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

  binding(id: string): AccountBinding | undefined {
    const wa = this.services.get(id);
    return wa === undefined ? undefined : bind(id, wa);
  }

  defaultBinding(): AccountBinding {
    return bind(this.primaryId, this.primary);
  }

  bindings(): AccountBinding[] {
    return [...this.services].map(([id, wa]) => bind(id, wa));
  }

  findByChat(jid: string): AccountBinding[] {
    return this.bindings().filter((row) => row.wa.hasChat(jid));
  }

  findByMessage(id: string): AccountBinding[] {
    return this.bindings().filter((row) => row.wa.hasMessage(id));
  }

  findByDraft(id: string): AccountBinding[] {
    return this.bindings().filter((row) => row.wa.hasDraft(id));
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
