import { Accounts } from "./accounts.js";
import { paths, type Config } from "./config.js";
import { readLinkedAccount } from "./auth-state.js";
import { lockHolder } from "./lock.js";
import { WazapError } from "./errors.js";
import { say } from "./logger.js";
import { runChecks } from "./doctor.js";

export function accountConfig(config: Config): Config {
  const registry = new Accounts(config.dataDir);
  const accounts = registry.list();
  if (!accounts.length && !config.accountId) return config;
  const account = registry.get(config.accountId);
  return registry.config(config, account);
}

export async function runAccounts(config: Config): Promise<void> {
  const registry = new Accounts(config.dataDir);
  const [action, id] = config.args;
  if (action === "list") {
    if (id) throw new WazapError("INVALID_ID", "Run wazap accounts list.");
    await accountsStatus(config);
    return;
  }
  if (action === "add") {
    if (id || !config.accountName)
      throw new WazapError(
        "INVALID_ID",
        "Run wazap accounts add --name Personal.",
      );
    const a = registry.add(config.accountName);
    say(`Added ${a.name} (${a.id}).`);
    say(
      `Next: wazap login --account ${a.id} --data-dir ${JSON.stringify(config.dataDir)}`,
    );
    return;
  }
  if (!id)
    throw new WazapError(
      "ACCOUNT_REQUIRED",
      "Choose an account_id from wazap accounts list.",
    );
  if (action === "rename") {
    if (!config.accountName)
      throw new WazapError(
        "INVALID_ID",
        "Use --name with the new account name.",
      );
    registry.rename(id, config.accountName);
    say(`Renamed ${id} to ${config.accountName}.`);
  } else if (action === "enable" || action === "disable") {
    registry.enable(id, action === "enable");
    say(
      `${id}: ${action === "enable" ? "enabled" : "disabled; local archive retained"}.`,
    );
  } else
    throw new WazapError(
      "INVALID_ID",
      "Use accounts list, add, rename, enable or disable.",
    );
}

/** Read-only inspection: never creates an archive or starts a WhatsApp socket. */
export async function accountsStatus(config: Config): Promise<void> {
  const registry = new Accounts(config.dataDir);
  const profiles = registry.list();
  const accounts = [];
  for (const a of profiles) {
    const c = registry.config(config, a);
    let linked = null,
      error: string | null = null;
    try {
      linked = readLinkedAccount(paths(c.dataDir).authDir);
    } catch (err) {
      error = String(err);
    }
    const checks = await runChecks(c);
    accounts.push({
      account_id: a.id,
      account_name: a.name,
      enabled: a.enabled,
      linked: !!linked,
      number: linked?.number ? `…${linked.number.slice(-4)}` : null,
      read_only: c.readOnly || !a.enabled,
      data_dir: c.dataDir,
      checks,
      error,
    });
  }
  const p = paths(config.dataDir),
    pid = lockHolder(p.lockFile);
  const result = {
    accounts,
    server_pid: pid,
    hint: "Use get_status(account_id) through the agent for the live connection state.",
  };
  if (config.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    if (!accounts.length)
      say("No accounts. Run wazap accounts add --name Personal.");
    for (const a of accounts) {
      say(
        `${a.account_name} — ${a.account_id}: ${a.enabled ? "enabled" : "disabled"}, ${a.linked ? "linked" : "not linked"}${a.read_only ? ", read-only" : ""}`,
      );
      for (const c of a.checks.filter((c) => c.state === "fail"))
        say(`  ${c.name}: ${c.detail}${c.fix ? ` — ${c.fix}` : ""}`);
    }
    if (pid) say(`Wazap running (pid ${pid}). ${result.hint}`);
  }
}

/** Pair through the existing private daemon so a second socket never steals a session. */
export async function loginThroughDaemon(
  config: Config,
  getPhone: () => Promise<string>,
): Promise<boolean> {
  if (!config.rootDataDir || !config.accountId) return false;
  const { readDaemon } = await import("./daemon.js");
  const rootPaths = paths(config.rootDataDir),
    daemon = readDaemon(rootPaths.daemonFile);
  if (!daemon || lockHolder(rootPaths.lockFile) !== daemon.pid) return false;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const client = new Client({ name: "wazap-login", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${daemon.port}/mcp`),
        {
          requestInit: {
            headers: {
              Authorization: `Bearer ${daemon.token}`,
              "x-wazap-read-only": "1",
              "x-wazap-accounts": config.accountId,
            },
          },
        },
      ),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({
        name,
        arguments: { ...args, account_id: config.accountId },
      });
      if (result.isError)
        throw new WazapError(
          "WHATSAPP_ERROR",
          String(
            (result.structuredContent as Record<string, unknown>)?.message ??
              "Account operation failed.",
          ),
        );
      return result.structuredContent as Record<string, unknown>;
    };
    let status = await call("get_status", {});
    if (status.status === "connected") {
      say(`Already connected: ${status.account_name} (${config.accountId}).`);
      return true;
    }
    const phone = await getPhone();
    new Accounts(config.rootDataDir).checkPhone(config.accountId, phone);
    const pairing = await call("link_account", { phone });
    say(`Account: ${pairing.account_name} (${config.accountId})`);
    say(`Pairing code: ${pairing.code}`);
    say(
      "WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead.",
    );
    const deadline = Math.min(
      Date.parse(String(pairing.expires_at)),
      Date.now() + 180_000,
    );
    // Some clients expose expires_at. Keep a bounded deadline for either shape.
    const until = Number.isFinite(deadline) ? deadline : Date.now() + 180_000;
    const { setTimeout: sleep } = await import("node:timers/promises");
    while (Date.now() < until) {
      await sleep(1_000);
      status = await call("get_status", {});
      if (status.status === "connected") {
        say(`Connected: ${status.account_name}. Sync: ${status.sync}.`);
        return true;
      }
      if (
        ["not_linked", "auth_failure", "session_corrupt"].includes(
          String(status.status),
        )
      )
        throw new WazapError(
          "NOT_CONNECTED",
          String(
            status.last_error ?? "Pairing did not complete. Run login again.",
          ),
        );
    }
    throw new WazapError(
      "TIMEOUT",
      "Pairing was not confirmed in time. Check get_status before requesting another code.",
    );
  } finally {
    await client.close();
  }
}
