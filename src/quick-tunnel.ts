/**
 * `wazap expose quick`: a public https URL with no account anywhere. It runs
 * Cloudflare's quick tunnel (`cloudflared tunnel --url`, the trycloudflare.com
 * service) from a cloudflared release wazap pins by sha256, as the background
 * service's second unit, next to the server.
 *
 * The trade-off, said wherever the URL is shown: a quick tunnel gets a new
 * random hostname every time it starts, so the URL changes when the tunnel,
 * the service or the machine restarts. Nothing is lost when it does — the
 * tunnel's own unit (`wazap tunnel`, below) sees the new hostname, writes it
 * where `wazap status` and the server read it, and restarts the server onto
 * it — but an agent holding the old URL has to be given the new one, and
 * signs in again. Cloudflare runs quick tunnels with no uptime promise, for
 * trying things out. For a URL that stays, `wazap expose tailscale` or
 * `wazap expose cloudflare`.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { paths, type Config } from "./config.js";
import { commandOnPath } from "./connect.js";
import { WazapError } from "./errors.js";
import { log, logError } from "./logger.js";
import { installedService, writeService, readService } from "./service.js";
import { commandOf } from "./supervisor.js";
import { setEnvSetting } from "./settings.js";
import { which } from "./transcribe/index.js";

export interface CloudflaredAsset {
  url: string;
  sha256: string;
  /** A bare binary, or a .tgz holding one named `cloudflared`. */
  kind: "bin" | "tgz";
  /** At most this many bytes are taken: a larger answer is not the release. */
  maxBytes: number;
}

const RELEASES = "https://github.com/cloudflare/cloudflared/releases/download";

/**
 * One cloudflared release. The Linux digests were checked against the binary
 * inside Cloudflare's own signed .deb for the same version (pkg.cloudflare.com),
 * the macOS ones are those the release notes publish. Keyed
 * `${process.platform}-${process.arch}`.
 */
export const CLOUDFLARED_PIN = {
  version: "2026.10.0",
  assets: {
    "linux-x64": {
      url: `${RELEASES}/2026.10.0/cloudflared-linux-amd64`,
      sha256: "d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db",
      kind: "bin",
      maxBytes: 80_000_000,
    },
    "linux-arm64": {
      url: `${RELEASES}/2026.10.0/cloudflared-linux-arm64`,
      sha256: "e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08",
      kind: "bin",
      maxBytes: 80_000_000,
    },
    "darwin-x64": {
      url: `${RELEASES}/2026.10.0/cloudflared-darwin-amd64.tgz`,
      sha256: "0560c9ab7281ac3f746055323623ed23bc0405b6dab9400474020cba33a978da",
      kind: "tgz",
      maxBytes: 80_000_000,
    },
    "darwin-arm64": {
      url: `${RELEASES}/2026.10.0/cloudflared-darwin-arm64.tgz`,
      sha256: "72edfd3eea463aef4d5cb89e2e209cecb048cc756c2b01915de2e0ad7cb39830",
      kind: "tgz",
      maxBytes: 80_000_000,
    },
  } as Partial<Record<string, CloudflaredAsset>>,
};

export function cloudflaredAssetFor(key = `${process.platform}-${process.arch}`): CloudflaredAsset | null {
  return CLOUDFLARED_PIN.assets[key] ?? null;
}

/** Where the pinned build lives inside a data dir. */
export function pinnedCloudflared(dataDir: string): string {
  return join(dataDir, "bin", `cloudflared-${CLOUDFLARED_PIN.version}`);
}

/** The hostnames a quick tunnel gets; nothing else is taken for a URL. */
const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export function quickUrlIn(line: string): string | null {
  return QUICK_URL.exec(line)?.[0] ?? null;
}

/**
 * Fetch `url` to `dest` only if its sha256 is `sha256`: streamed to a file
 * beside it, hashed on the way, capped at `maxBytes`, and renamed into place
 * only once it matches. A partial or wrong download never becomes `dest`.
 */
export async function fetchVerified(url: string, dest: string, sha256: string, maxBytes: number): Promise<void> {
  const part = `${dest}.part`;
  const fail = (message: string): WazapError =>
    new WazapError("SERVICE_ERROR", message, "Check the network, then run `wazap expose quick` again");
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  } catch (err) {
    throw fail(`Could not download cloudflared: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok || response.body === null) throw fail(`Could not download cloudflared (HTTP ${response.status}).`);
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > maxBytes) throw fail("The cloudflared download is larger than the release; nothing was installed.");
    hash.update(chunk);
    chunks.push(Buffer.from(chunk));
  }
  const got = hash.digest("hex");
  if (got !== sha256) {
    throw new WazapError(
      "SERVICE_ERROR",
      `The cloudflared download does not match its pinned sha256 (${got}); nothing was installed.`,
      "Run `wazap expose quick` again; if it keeps failing, install cloudflared yourself (e.g. `brew install cloudflared`) and run it again"
    );
  }
  mkdirSync(join(dest, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(part, Buffer.concat(chunks), { mode: 0o700 });
  renameSync(part, dest);
}

/**
 * The cloudflared to run: one the person installed themselves (PATH), else
 * the pinned release in the data dir, downloaded and verified on first use.
 */
export async function ensureCloudflared(
  dataDir: string,
  opts: { asset?: CloudflaredAsset | null; onPath?: () => string | null } = {}
): Promise<string> {
  const own = (opts.onPath ?? (() => (commandOnPath("cloudflared") ? which("cloudflared") : null)))();
  if (own !== null) return own;
  const pinned = pinnedCloudflared(dataDir);
  if (existsSync(pinned)) return pinned;
  const asset = opts.asset === undefined ? cloudflaredAssetFor() : opts.asset;
  if (asset === null) {
    throw new WazapError(
      "SERVICE_ERROR",
      `wazap has no cloudflared build for ${process.platform} ${process.arch}.`,
      "Install cloudflared yourself, then run `wazap expose quick` again"
    );
  }
  mkdirSync(join(dataDir, "bin"), { recursive: true, mode: 0o700 });
  if (asset.kind === "bin") {
    await fetchVerified(asset.url, pinned, asset.sha256, asset.maxBytes);
    chmodSync(pinned, 0o700);
    return pinned;
  }
  const archive = `${pinned}.tgz`;
  await fetchVerified(asset.url, archive, asset.sha256, asset.maxBytes);
  const dir = `${pinned}.d`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const unpacked = spawnSync("tar", ["-xzf", archive, "-C", dir], { encoding: "utf8" });
  rmSync(archive, { force: true });
  if (unpacked.status !== 0 || !existsSync(join(dir, "cloudflared"))) {
    rmSync(dir, { recursive: true, force: true });
    throw new WazapError("SERVICE_ERROR", "Could not unpack the cloudflared download.", "Run `wazap expose quick` again");
  }
  renameSync(join(dir, "cloudflared"), pinned);
  rmSync(dir, { recursive: true, force: true });
  chmodSync(pinned, 0o700);
  return pinned;
}

/** `<data-dir>/tunnel.json`: the quick tunnel's current URL, written by its unit. */
export interface TunnelState {
  url: string;
  at: number;
  pid: number;
  /** When cloudflared registered its connection to Cloudflare's edge; absent while it has none. */
  connected_at?: number;
}

export function tunnelStateFile(dataDir: string): string {
  return join(dataDir, "tunnel.json");
}

export function readTunnelState(dataDir: string): TunnelState | null {
  try {
    const parsed = JSON.parse(readFileSync(tunnelStateFile(dataDir), "utf8")) as Partial<TunnelState>;
    if (typeof parsed.url !== "string" || quickUrlIn(parsed.url) !== parsed.url) return null;
    const state: TunnelState = { url: parsed.url, at: Number(parsed.at) || 0, pid: Number(parsed.pid) || 0 };
    const connectedAt = Number(parsed.connected_at);
    if (Number.isFinite(connectedAt) && connectedAt > 0) state.connected_at = connectedAt;
    return state;
  } catch {
    return null;
  }
}

function writeTunnelState(dataDir: string, state: TunnelState): void {
  const file = tunnelStateFile(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * cloudflared's lines (2026.10.0, QUIC and HTTP/2 alike) for one connection to
 * the edge coming up and going away; the URL answers only while one is up. A
 * quick tunnel holds one (`ha-connections:1`), but they are counted by
 * `connIndex` all the same. Case matters: "Unregistered" is not "Registered".
 */
const REGISTERED = /\bRegistered tunnel connection\b/;
const LOST = /\b(?:Unregistered tunnel connection|Serve tunnel error|Retrying connection in up to)\b/;
const CONN_INDEX = /\bconnIndex=(\d+)/;

export function registeredIn(line: string): boolean {
  return REGISTERED.test(line);
}

/** An edge connection that came up or went away in this line, by its `connIndex`; null when neither. */
export function edgeEventIn(line: string): { up: boolean; conn: string } | null {
  const up = REGISTERED.test(line);
  if (!up && !LOST.test(line)) return null;
  return { up, conn: CONN_INDEX.exec(line)?.[1] ?? "0" };
}

/**
 * Records whether the tunnel for `url` is connected to Cloudflare (`at`, or
 * null once it is not), so `wazap expose` and `wazap status` can tell a dead
 * URL from a live one. A state for another URL is left alone.
 */
export function markTunnelConnected(dataDir: string, url: string, at: number | null = Date.now()): void {
  const state = readTunnelState(dataDir);
  if (state === null || state.url !== url) return;
  const { connected_at: _previous, ...rest } = state;
  writeTunnelState(dataDir, at === null ? rest : { ...rest, connected_at: at });
}

/** What the quick tunnel's unit does once its hostname is known; injectable for the tests. */
export interface TunnelHooks {
  /** Restart the server so sign-in answers on the new URL. */
  restartServer(dataDir: string): void;
}

const REAL_HOOKS: TunnelHooks = {
  restartServer: (dataDir) => {
    const found = installedService(dataDir);
    if (found === null) return;
    found.supervisor.restart(found.record);
  },
};

/**
 * A quick tunnel announced `url`: make it the server's public URL. The data
 * dir's .env (what the server reads at start), service.json (what `wazap
 * status` shows), tunnel.json (when and by whom), then a server restart. A URL
 * already in place changes nothing.
 */
export function adoptQuickUrl(dataDir: string, url: string, hooks: TunnelHooks = REAL_HOOKS): boolean {
  const p = paths(dataDir);
  const previous = readTunnelState(dataDir);
  // The same hostname again is the same tunnel: it keeps its edge connection.
  const kept = previous?.url === url && previous.connected_at !== undefined ? { connected_at: previous.connected_at } : {};
  writeTunnelState(dataDir, { url, at: Date.now(), pid: process.pid, ...kept });
  if (previous?.url === url) return false;
  setEnvSetting(p.envFile, "WAZAP_PUBLIC_URL", url);
  const record = readService(dataDir);
  if (record !== null) writeService(dataDir, { ...record, tunnel: { provider: "quick", url } });
  log(`quick tunnel: ${url} (restarting the server onto it)`);
  try {
    hooks.restartServer(dataDir);
  } catch (err) {
    logError("quick tunnel: server restart", err);
  }
  return true;
}

/** The cloudflared an earlier unit left, when its pid still runs a tunnel to `target`; never another process. */
export function stopStaleCloudflared(pidFile: string, target: string): void {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  } catch {
    return;
  }
  rmSync(pidFile, { force: true });
  if (!Number.isInteger(pid) || pid <= 0) return;
  const command = commandOf(pid);
  if (command === null || !command.includes("cloudflared") || !command.split(" ").includes(target)) return;
  try {
    process.kill(pid, "SIGTERM");
    log(`quick tunnel: stopped a cloudflared an earlier run left (pid ${pid})`);
  } catch {
    /* already gone */
  }
}

/** `http://127.0.0.1:<port>`, the only target the tunnel unit takes. */
export function parseTunnelTarget(value: string | undefined): string {
  if (value === undefined || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value)) {
    throw new WazapError("INVALID_ID", "wazap tunnel takes http://127.0.0.1:<port>.", "Run `wazap expose quick` instead");
  }
  return value;
}

/**
 * `wazap tunnel http://127.0.0.1:<port>`: the quick tunnel's unit, run by the
 * service's supervisor, not by people. It runs cloudflared, passes its output
 * through to the unit's log, and adopts each hostname cloudflared announces.
 * When cloudflared exits so does this, and the supervisor starts both again.
 */
export async function runTunnel(config: Config, hooks: TunnelHooks = REAL_HOOKS): Promise<void> {
  const target = parseTunnelTarget(config.args[0]);
  const bin = await ensureCloudflared(config.dataDir);
  const pidFile = join(config.dataDir, "cloudflared.pid");
  // A unit killed outright leaves its cloudflared running, still tunnelling to
  // the port under a URL nobody knows: one tunnel at a time.
  stopStaleCloudflared(pidFile, target);
  // Nor its connection: a unit killed outright never cleared it.
  const stale = readTunnelState(config.dataDir);
  if (stale !== null) markTunnelConnected(config.dataDir, stale.url, null);
  const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", target], { stdio: ["ignore", "pipe", "pipe"] });
  if (child.pid !== undefined) writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 });
  const stop = (why: string): void => {
    log(`quick tunnel: ${why}, stopping cloudflared`);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  if (typeof process.send === "function") process.once("disconnect", () => stop("supervisor gone"));
  // This cloudflared's hostname, and its edge connections that are up now.
  let adopted: string | null = null;
  const live = new Set<string>();
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      process.stderr.write(`${line}\n`);
      const url = quickUrlIn(line);
      if (url !== null) {
        if (url !== adopted) live.clear();
        adoptQuickUrl(config.dataDir, url, hooks);
        adopted = url;
        return;
      }
      const edge = edgeEventIn(line);
      if (edge === null || adopted === null) return;
      if (edge.up) {
        live.add(edge.conn);
        markTunnelConnected(config.dataDir, adopted);
      } else if (live.delete(edge.conn) && live.size === 0) markTunnelConnected(config.dataDir, adopted, null);
    });
  }
  const code = await new Promise<number>((resolve) => {
    child.once("error", (err) => {
      logError("quick tunnel: cloudflared", err);
      resolve(1);
    });
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  // Without its cloudflared the URL reaches nothing, whatever it last registered.
  if (adopted !== null) markTunnelConnected(config.dataDir, adopted, null);
  rmSync(pidFile, { force: true });
  process.exit(code);
}
