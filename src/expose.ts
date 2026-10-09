import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ask } from "./cli.js";
import { paths, writesHints, type Config } from "./config.js";
import { commandOnPath } from "./connect.js";
import { WazapError } from "./errors.js";
import { say } from "./logger.js";
import {
  SUPERVISORS,
  TUNNEL_LABELS,
  installedService,
  secureLogs,
  serviceScript,
  servicePath,
  stableNode,
  stateHome,
  tunnelsTo,
  writeService,
  type Installed,
  type Supervisor,
  type UnitSpec,
  writeUnit,
} from "./service.js";
import { setEnvSetting } from "./settings.js";
import { ensureCloudflared, readTunnelState, tunnelStateFile } from "./quick-tunnel.js";
import { maskKey, which } from "./transcribe/index.js";
import { box, brand, dim, fail, info, ok, shortPath, warn } from "./ui.js";

export type Readiness = { ok: true } | { ok: false; fix: string };

export interface TunnelProvider {
  name: "tailscale" | "cloudflare";
  describe: string;
  /** The binary is on PATH. */
  available(): boolean;
  /** Signed in, with somewhere to publish. */
  ready(): Readiness;
  /** Where agents will reach the server. Asked of the user once when the provider cannot know it. */
  publicUrl(port: number, stored: string | null): Promise<string>;
  /** Bring the tunnel up. Providers that need a process of their own return its argv from `command`. */
  open(port: number, url: string): void;
  close(port: number): void;
  /** argv a supervisor unit runs to hold the tunnel open, or null when the provider holds it itself. */
  command(port: number): string[] | null;
}

interface Ran {
  status: number;
  stdout: string;
}

function run(argv: readonly string[]): Ran {
  const [command, ...args] = argv;
  const result = spawnSync(command!, args, { encoding: "utf8" });
  if (result.error) return { status: -1, stdout: "" };
  return { status: result.status ?? -1, stdout: result.stdout ?? "" };
}

function runOrThrow(argv: readonly string[], repair: string): void {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
  if (result.status === 0) return;
  const detail = ((result.stderr ?? "").trim() || (result.stdout ?? "").trim() || String(result.error?.message)).split(
    "\n"
  )[0]!;
  throw new WazapError("SERVICE_ERROR", `\`${argv.join(" ")}\` failed: ${detail}`, repair);
}

const TAILSCALE_UP_FIX = "run `tailscale up`, then `wazap expose tailscale` again";

/** `Self.DNSName` from `tailscale status --json`, without its trailing dot. */
function tailscaleName(): string | null {
  const result = run(["tailscale", "status", "--json"]);
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { BackendState?: unknown; Self?: { DNSName?: unknown } };
    if (parsed.BackendState !== "Running") return null;
    const dns = parsed.Self?.DNSName;
    return typeof dns === "string" && dns !== "" ? dns.replace(/\.$/, "") : null;
  } catch {
    return null;
  }
}

const tailscale: TunnelProvider = {
  name: "tailscale",
  describe: "Tailscale Funnel",
  available: () => commandOnPath("tailscale"),
  ready: () =>
    tailscaleName() === null
      ? {
          ok: false,
          fix: `${TAILSCALE_UP_FIX}; Funnel also needs MagicDNS and HTTPS on in the Tailscale admin console`,
        }
      : { ok: true },
  publicUrl: async (_port, _stored) => {
    const name = tailscaleName();
    if (name === null)
      throw new WazapError("SERVICE_ERROR", "Tailscale has no name for this machine.", TAILSCALE_UP_FIX);
    return `https://${name}`;
  },
  open: (port) => {
    runOrThrow(["tailscale", "funnel", "--bg", String(port)], "run `tailscale funnel status` to see what it refused");
  },
  close: () => {
    run(["tailscale", "funnel", "--https=443", "off"]);
  },
  // tailscaled holds the funnel itself, so there is nothing for a supervisor to keep alive.
  command: () => null,
};

function cloudflaredCert(): string {
  return join(homedir(), ".cloudflared", "cert.pem");
}

const CLOUDFLARE_TUNNEL = "wazap";

const cloudflare: TunnelProvider = {
  name: "cloudflare",
  describe: "Cloudflare Tunnel",
  available: () => commandOnPath("cloudflared"),
  ready: () =>
    existsSync(cloudflaredCert())
      ? { ok: true }
      : { ok: false, fix: "run `cloudflared tunnel login`, then `wazap expose cloudflare` again" },
  publicUrl: async (_port, stored) => {
    if (stored !== null) return stored;
    const answer = (await ask(`${brand("?")} Hostname on your Cloudflare domain (e.g. wazap.example.com): `)).trim();
    const host = answer.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
      throw new WazapError("SERVICE_ERROR", `"${answer}" is not a hostname.`, "run `wazap expose cloudflare` again");
    }
    return `https://${host}`;
  },
  open: (_port, url) => {
    // Both are idempotent in effect but not in exit code: a tunnel that exists
    // and a name already routed to it are the state we want, not a failure.
    run(["cloudflared", "tunnel", "create", CLOUDFLARE_TUNNEL]);
    runOrThrow(
      ["cloudflared", "tunnel", "route", "dns", "--overwrite-dns", CLOUDFLARE_TUNNEL, new URL(url).hostname],
      "check that the domain is on this Cloudflare account"
    );
  },
  close: () => {},
  command: (port) => [
    which("cloudflared") ?? "cloudflared",
    "tunnel",
    "run",
    "--url",
    `http://127.0.0.1:${port}`,
    CLOUDFLARE_TUNNEL,
  ],
};

export const PROVIDERS: readonly TunnelProvider[] = [tailscale, cloudflare];

/** The account-free one (quick-tunnel.ts), handled on its own: its URL is only known once it runs. */
export const QUICK = "quick";

export const PROVIDER_NAMES: string = [...PROVIDERS.map((provider) => provider.name), QUICK].join(", ");

/** How long `expose quick` waits for cloudflared to announce its hostname. */
export const QUICK_WAIT_MS = 60_000;

/**
 * `wazap expose quick`: a trycloudflare.com URL, with no account and no admin
 * console. The tunnel's own unit learns the hostname and restarts the server
 * onto it (quick-tunnel.ts); this sets the password first, so the server is
 * never reachable through the tunnel without sign-in, and waits to print the URL.
 */
async function exposeQuick(config: Config, { supervisor, record }: Installed, deps: QuickDeps): Promise<void> {
  const { waitMs, ensure, health = publicHealth } = deps;
  // Fetched (and verified) here, where a person sees the download, not inside the unit.
  await ensure(config.dataDir);
  const p = paths(config.dataDir);
  const fresh = config.oauthPassword === null;
  const password = config.oauthPassword ?? newPassword();
  if (fresh) setEnvSetting(p.envFile, "WAZAP_OAUTH_PASSWORD", password);
  // Another provider's tunnel goes first: one tunnel to the port at a time.
  if (record.tunnel && record.tunnel.provider !== QUICK) {
    PROVIDERS.find((provider) => provider.name === record.tunnel?.provider)?.close(record.port);
  }

  const label = TUNNEL_LABELS[supervisor.name];
  const ref = { label, unitFile: supervisor.unitFile(label) };
  const argv = [stableNode(), serviceScript(), "tunnel", `http://127.0.0.1:${record.port}`];
  const unit: UnitSpec = {
    ...tunnelUnit(label, argv, record.logDir),
    env: { HOME: homedir(), PATH: servicePath(argv[0]!), WAZAP_DATA_DIR: config.dataDir, ...stateHome() },
  };
  const started = Date.now();
  rmSync(tunnelStateFile(config.dataDir), { force: true });
  secureLogs(record.logDir, label);
  writeUnit(ref.unitFile, supervisor.render(unit));
  writeService(config.dataDir, { ...record, tunnel: { provider: QUICK, url: record.tunnel?.provider === QUICK ? record.tunnel.url : "pending" } });
  supervisor.restart(ref);

  say(info("Starting a Cloudflare quick tunnel (no account needed)…"));
  let state = readTunnelState(config.dataDir);
  const deadline = Date.now() + waitMs;
  while ((state === null || state.at < started) && Date.now() < deadline) {
    await sleep(500);
    state = readTunnelState(config.dataDir);
  }
  if (state === null || state.at < started) {
    throw new WazapError(
      "SERVICE_ERROR",
      "The quick tunnel did not announce a URL in time.",
      `check its log with \`${supervisor.logs(ref)[0]}\`; it keeps trying, and \`wazap status\` shows the URL once it has one`
    );
  }
  const url = state.url;
  say(ok(`Cloudflare quick tunnel · ${url}`));
  // The unit restarted the server onto the URL; give it a moment to answer there.
  let status: number | null = null;
  for (let attempt = 0; attempt < 10 && status !== 200; attempt++) {
    status = await health(url);
    if (status !== 200) await sleep(1_500);
  }
  const latest = readTunnelState(config.dataDir);
  if (status === 200) say(ok("The public URL reaches this machine."));
  else if (latest !== null && latest.url !== url) {
    say(warn(`cloudflared restarted meanwhile, and the URL moved to ${latest.url}; \`wazap status\` always shows the current one.`));
  } else if (latest?.connected_at === undefined) {
    say(
      fail(
        "cloudflared got a URL but could not connect to Cloudflare from this network, so the URL does not reach this machine yet."
      )
    );
    say(
      info(
        `Its log (\`${supervisor.logs(ref)[0]}\`) names the cause; a network that blocks outbound QUIC (UDP 7844) and HTTP/2 to *.argotunnel.com never connects. It keeps retrying; on such a network use a machine with open egress, or \`wazap expose tailscale\`.`
      )
    );
  } else say(warn(`${url}/healthz answered ${status ?? "nothing"}; the tunnel may still be coming up.`));
  say("");
  say(box(`MCP URL   ${url}/mcp`, `Password  ${fresh ? password : maskKey(password)}`));
  say("");
  say(HANDOVER);
  say(info(QUICK_NOTE));
  for (const line of writesHints(config)) say(info(line));
}

/** What a quick tunnel costs, said wherever its URL is. */
export const QUICK_NOTE =
  "A quick tunnel's URL changes whenever it restarts (the tunnel, the service, or this machine). `wazap status` always shows the current one; give the agent the new URL when it changes. For a URL that stays: `wazap expose tailscale` or `wazap expose cloudflare`.";

function findProvider(name: string, providers: readonly TunnelProvider[]): TunnelProvider {
  const found = providers.find((provider) => provider.name === name);
  if (found === undefined) {
    throw new WazapError("INVALID_ID", `Unknown tunnel provider "${name}".`, `Pick one of: ${PROVIDER_NAMES}`);
  }
  return found;
}

function requireService(config: Config, registry: readonly Supervisor[]): Installed {
  const found = installedService(config.dataDir, registry);
  if (found === null) {
    throw new WazapError(
      "SERVICE_ERROR",
      "A public URL needs the background service: something has to stay up for the tunnel to reach.",
      "run `wazap service install`"
    );
  }
  return found;
}

/** 24 characters out of 18 random bytes. The whole identity layer of the consent page. */
function newPassword(): string {
  return randomBytes(18).toString("base64url");
}

function tunnelUnit(label: string, argv: readonly string[], logDir: string): UnitSpec {
  return {
    label,
    describe: "wazap public tunnel",
    argv,
    env: { HOME: homedir(), PATH: servicePath(argv[0]!) },
    logDir,
  };
}

const PUBLIC_HEALTH_MS = 10_000;

async function publicHealth(url: string): Promise<number | null> {
  try {
    const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(PUBLIC_HEALTH_MS) });
    return response.status;
  } catch {
    return null;
  }
}

const HANDOVER =
  "Give an agent the URL only. It signs in on your consent page with this password; wazap status shows who holds a grant.";

async function exposeOn(config: Config, provider: TunnelProvider, { supervisor, record }: Installed): Promise<void> {
  if (!provider.available()) {
    throw new WazapError(
      "SERVICE_ERROR",
      `${provider.describe} is not installed on this machine.`,
      `install ${provider.name}, or run \`wazap expose ${PROVIDERS.filter((p) => p !== provider)
        .map((p) => p.name)
        .join("|")}\``
    );
  }
  const readiness = provider.ready();
  if (!readiness.ok) throw new WazapError("SERVICE_ERROR", `${provider.describe} is not ready.`, readiness.fix);

  const stored = record.tunnel?.provider === provider.name ? record.tunnel.url : null;
  const url = await provider.publicUrl(record.port, stored);
  provider.open(record.port, url);

  const argv = provider.command(record.port);
  const label = TUNNEL_LABELS[supervisor.name];
  const ref = { label, unitFile: supervisor.unitFile(label) };
  if (argv !== null) {
    secureLogs(record.logDir, label);
    writeUnit(ref.unitFile, supervisor.render(tunnelUnit(label, argv, record.logDir)));
    supervisor.restart(ref);
  }

  const p = paths(config.dataDir);
  setEnvSetting(p.envFile, "WAZAP_PUBLIC_URL", url);
  const fresh = config.oauthPassword === null;
  const password = config.oauthPassword ?? newPassword();
  if (fresh) setEnvSetting(p.envFile, "WAZAP_OAUTH_PASSWORD", password);

  writeService(config.dataDir, { ...record, tunnel: { provider: provider.name, url } });
  supervisor.restart(record);

  say(ok(`${provider.describe} · ${url}`));
  say(dim(`Stored in ${shortPath(p.envFile)}.`));
  const status = await publicHealth(url);
  say(
    status === 200
      ? ok("The public URL reaches this machine.")
      : warn(`${url}/healthz answered ${status ?? "nothing"}; the tunnel may still be coming up.`)
  );
  say("");
  say(box(`MCP URL   ${url}/mcp`, `Password  ${fresh ? password : maskKey(password)}`));
  say("");
  say(HANDOVER);
  for (const line of writesHints(config)) {
    say(info(line));
  }
}

async function exposeOff(
  config: Config,
  providers: readonly TunnelProvider[],
  { supervisor, record }: Installed
): Promise<void> {
  const label = TUNNEL_LABELS[supervisor.name];
  supervisor.remove({ label, unitFile: supervisor.unitFile(label) });
  if (record.tunnel) {
    providers.find((provider) => provider.name === record.tunnel?.provider)?.close(record.port);
  }
  const { tunnel: _dropped, ...kept } = record;

  // A tunnel wazap did not open still reaches the port, and sign-in is all that
  // stands in front of it, so sign-in stays on until that tunnel is gone too.
  const others = tunnelsTo(supervisor, record.port);
  if (others.length > 0) {
    writeService(config.dataDir, kept);
    throw new WazapError(
      "SERVICE_ERROR",
      `wazap's tunnel is off, but ${others.map((unit) => unit.label).join(", ")} ${others.length === 1 ? "still tunnels" : "still tunnel"} to port ${record.port}, so sign-in stays on.`,
      `stop it and remove its unit with \`${others.map((unit) => unit.stop).join("; ")}\`, then run \`wazap expose off\` again`
    );
  }

  setEnvSetting(paths(config.dataDir).envFile, "WAZAP_PUBLIC_URL", "");
  rmSync(tunnelStateFile(config.dataDir), { force: true });
  writeService(config.dataDir, kept);
  supervisor.restart(kept);

  say(ok("Tunnel off. Only this machine reaches wazap again."));
  say(info("The consent password is kept, so the next `wazap expose` hands agents the same one."));
}

/** The quick tunnel's two outside dependencies, replaced in the tests. */
export interface QuickDeps {
  waitMs: number;
  ensure: (dataDir: string) => Promise<string>;
  /** What /healthz answers on the public URL; the network, outside the tests. */
  health?: (url: string) => Promise<number | null>;
}

export async function runExpose(
  config: Config,
  providers: readonly TunnelProvider[] = PROVIDERS,
  registry: readonly Supervisor[] = SUPERVISORS,
  quick: QuickDeps = { waitMs: QUICK_WAIT_MS, ensure: ensureCloudflared }
): Promise<void> {
  const installed = requireService(config, registry);
  const named = config.args[0];
  if (named === "off") return exposeOff(config, providers, installed);
  if (named === QUICK) return exposeQuick(config, installed, quick);

  if (named !== undefined) return exposeOn(config, findProvider(named, providers), installed);
  // A provider already signed in gives a URL that stays; with none, the quick
  // tunnel needs no account at all.
  const first = providers.find((provider) => provider.available() && provider.ready().ok);
  if (first === undefined) {
    for (const provider of providers.filter((entry) => entry.available())) {
      const readiness = provider.ready();
      if (!readiness.ok) say(info(`${provider.describe} is installed but not ready (${readiness.fix}); using a quick tunnel instead.`));
    }
    return exposeQuick(config, installed, quick);
  }
  return exposeOn(config, first, installed);
}
