/**
 * One process, N WhatsApp sockets. The registry names the accounts; this holds
 * a live service for each enabled one, with its own reconnect loop and write
 * bucket. MCP tools still close over `default()`.
 */

import { AccountRegistry } from "./accounts.js";
import { accountPaths, type Config } from "./config.js";
import { WazapError } from "./errors.js";
import { logError } from "./logger.js";
import type { WhatsAppApi } from "./wa-types.js";
import { WhatsAppService } from "./whatsapp.js";

const FIX_ENABLE = "Run `wazap account enable <id>` or `wazap account add <id>`";

/** What HTTP and stdio need until Phase 3 retargets tools at the hub. */
export interface AccountSource {
  default(): WhatsAppApi;
  all(): WhatsAppApi[];
}

export class AccountHub implements AccountSource {
  private readonly services = new Map<string, WhatsAppService>();
  private readonly givenUp = new Set<string>();
  private readonly primary: WhatsAppService;
  /** Process exit hook. Fires only after every enabled account has given up. */
  onGiveUp: (() => void) | null = null;

  constructor(config: Config, registry: AccountRegistry) {
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

  private noteGiveUp(id: string): void {
    if (this.givenUp.has(id)) return;
    this.givenUp.add(id);
    logError("whatsapp", `account ${id}: reconnects exhausted`);
    if (this.givenUp.size < this.services.size) return;
    this.onGiveUp?.();
  }
}
