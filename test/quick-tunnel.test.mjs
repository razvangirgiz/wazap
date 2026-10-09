/**
 * `wazap expose quick`: a trycloudflare.com URL with no account. cloudflared
 * here is a stand-in script; downloads go to a loopback server. Nothing in
 * this file reaches the network.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { paths } from "../dist/config.js";
import { QUICK_NOTE, runExpose } from "../dist/expose.js";
import {
  CLOUDFLARED_PIN,
  adoptQuickUrl,
  edgeEventIn,
  ensureCloudflared,
  markTunnelConnected,
  parseTunnelTarget,
  pinnedCloudflared,
  quickUrlIn,
  readTunnelState,
  registeredIn,
} from "../dist/quick-tunnel.js";
import { installService, readService, tunnelsTo } from "../dist/service.js";
import { builtinSupervisor } from "../dist/supervisor.js";
import { BINARY, childEnv, waitFor } from "./helpers.mjs";

const run = promisify(execFile);
const URL_A = "https://quiet-river-blue-moon.trycloudflare.com";
const URL_B = "https://loud-ocean-red-sun.trycloudflare.com";

function dataDir() {
  return mkdtempSync(join(tmpdir(), "wazap-quick-"));
}

async function captured(work) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    await work();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

function env(dir) {
  return Object.fromEntries(
    readFileSync(paths(dir).envFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
  );
}

test("the hostname is read off cloudflared's banner, and nothing else passes for one", () => {
  assert.equal(quickUrlIn(`2026-10-09T12:00:00Z INF |  ${URL_A}                     |`), URL_A);
  assert.equal(quickUrlIn("INF Requesting new quick Tunnel on trycloudflare.com..."), null);
  assert.equal(quickUrlIn("https://evil.example/?x=.trycloudflare.com"), null);
  assert.equal(quickUrlIn("https://a.trycloudflare.com.evil.example"), "https://a.trycloudflare.com", "only the trycloudflare host is taken");
});

test("the tunnel unit only ever points at loopback", () => {
  assert.equal(parseTunnelTarget("http://127.0.0.1:8766"), "http://127.0.0.1:8766");
  for (const bad of [undefined, "http://0.0.0.0:8766", "http://example.com:80", "http://127.0.0.1:8766/../x", "file:///etc"]) {
    assert.throws(() => parseTunnelTarget(bad), /http:\/\/127\.0\.0\.1:<port>/);
  }
});

test("every pinned cloudflared is a release asset of the pinned version, by exact size and sha256", () => {
  const keys = Object.keys(CLOUDFLARED_PIN.assets).sort();
  assert.deepEqual(keys, ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
  for (const asset of Object.values(CLOUDFLARED_PIN.assets)) {
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(asset.bytes) && asset.bytes > 1_000_000);
    assert.ok(asset.url.startsWith(`https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_PIN.version}/`));
    assert.equal(asset.kind, asset.url.endsWith(".tgz") ? "tgz" : "bin");
    if (asset.kind === "tgz") {
      // The release notes publish the binary's digest; the archive's own is a different file's.
      assert.match(asset.binarySha256, /^[0-9a-f]{64}$/);
      assert.notEqual(asset.binarySha256, asset.sha256);
    }
  }
});

async function serving(t, body) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-length": body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/cloudflared`;
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("a download becomes the binary only when its size and sha256 match, and never partly", async (t) => {
  const body = Buffer.from("#!/bin/sh\necho cloudflared\n");
  const url = await serving(t, body);
  const dir = dataDir();
  const dest = pinnedCloudflared(dir);
  const asset = { url, sha256: sha(body), bytes: body.length, kind: "bin" };
  await assert.rejects(ensureCloudflared(dir, { onPath: () => null, asset: { ...asset, sha256: "0".repeat(64) } }), (err) => {
    assert.equal(err.code, "SERVICE_ERROR");
    assert.match(err.message, /nothing was installed: .*did not verify/);
    assert.match(err.fix, /wazap expose quick/);
    return true;
  });
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(`${dest}.part`), false);
  await assert.rejects(ensureCloudflared(dir, { onPath: () => null, asset: { ...asset, bytes: 10 } }), /exceeds the expected size/);
  assert.equal(existsSync(dest), false);
  assert.equal(await ensureCloudflared(dir, { onPath: () => null, asset }), dest);
  assert.deepEqual(readFileSync(dest), body);
});

test("a .tgz is checked as downloaded, and the cloudflared inside it against its own pin", { skip: process.platform === "win32" }, async (t) => {
  const work = dataDir();
  const binary = Buffer.from("#!/bin/sh\nexit 0\n");
  writeFileSync(join(work, "cloudflared"), binary);
  const tgz = join(work, "cf.tgz");
  await run("tar", ["-czf", tgz, "-C", work, "cloudflared"]);
  const archive = readFileSync(tgz);
  const url = await serving(t, archive);
  const asset = { url, sha256: sha(archive), bytes: archive.length, kind: "tgz", binarySha256: sha(binary) };

  const wrong = dataDir();
  await assert.rejects(
    ensureCloudflared(wrong, { onPath: () => null, asset: { ...asset, binarySha256: "0".repeat(64) } }),
    /cloudflared inside the download does not match/
  );
  assert.equal(existsSync(pinnedCloudflared(wrong)), false);
  assert.equal(existsSync(`${pinnedCloudflared(wrong)}.tgz`), false, "the archive does not linger");
  assert.equal(existsSync(`${pinnedCloudflared(wrong)}.d`), false);

  const dir = dataDir();
  const got = await ensureCloudflared(dir, { onPath: () => null, asset });
  assert.equal(got, pinnedCloudflared(dir));
  assert.deepEqual(readFileSync(got), binary);
});

test("ensureCloudflared takes the person's own cloudflared first, then the pinned one, fetching it once", async (t) => {
  const body = Buffer.from("#!/bin/sh\nexit 0\n");
  const url = await serving(t, body);
  const dir = dataDir();
  assert.equal(await ensureCloudflared(dir, { onPath: () => "/opt/homebrew/bin/cloudflared" }), "/opt/homebrew/bin/cloudflared");
  const asset = { url, sha256: sha(body), bytes: body.length, kind: "bin" };
  const got = await ensureCloudflared(dir, { onPath: () => null, asset });
  assert.equal(got, pinnedCloudflared(dir));
  assert.equal(readFileSync(got, "utf8"), body.toString());
  // Present now: a broken URL must not matter.
  assert.equal(await ensureCloudflared(dir, { onPath: () => null, asset: { ...asset, url: "http://127.0.0.1:9/" } }), got);
  await assert.rejects(ensureCloudflared(dataDir(), { onPath: () => null, asset: null }), /no cloudflared build/);
});

test("a new hostname becomes the public URL and restarts the server; the same one again changes nothing", () => {
  const dir = dataDir();
  writeFileSync(paths(dir).serviceFile, JSON.stringify({ supervisor: "builtin", label: "wazap-server", unitFile: "/x", port: 8766, logDir: "/l", installedVersion: "1" }));
  const restarts = [];
  const hooks = { restartServer: (where) => restarts.push(where) };
  assert.equal(adoptQuickUrl(dir, URL_A, hooks), true);
  assert.equal(env(dir).WAZAP_PUBLIC_URL, URL_A);
  assert.deepEqual(readService(dir).tunnel, { provider: "quick", url: URL_A });
  assert.equal(readTunnelState(dir).url, URL_A);
  assert.equal(adoptQuickUrl(dir, URL_A, hooks), false);
  assert.equal(adoptQuickUrl(dir, URL_B, hooks), true, "a restarted tunnel's new hostname");
  assert.equal(env(dir).WAZAP_PUBLIC_URL, URL_B);
  assert.deepEqual(restarts, [dir, dir]);
});

test("`wazap tunnel` runs cloudflared, passes its log through and adopts the hostname it announces", async (t) => {
  const dir = dataDir();
  const bin = join(dir, "fake-bin");
  mkdirSync(bin);
  // What a unit killed outright leaves: the last URL, still marked connected.
  adoptQuickUrl(dir, URL_B, { restartServer: () => {} });
  markTunnelConnected(dir, URL_B, 1);
  writeFileSync(
    join(bin, "cloudflared"),
    [
      "#!/bin/sh",
      "sleep 1",
      'echo "args: $*" >&2',
      `echo "INF |  ${URL_A}  |" >&2`,
      "sleep 0.3",
      'echo "2026-10-09T13:56:28Z INF Registered tunnel connection connIndex=0 connection=8f0c ip=198.41.200.13 location=fra08 protocol=http2" >&2',
      "sleep 1",
      'echo "2026-10-09T13:56:40Z ERR Serve tunnel error error=\\"timeout: no recent network activity\\" connIndex=0 event=0 ip=198.41.200.13" >&2',
      'echo "2026-10-09T13:56:40Z INF Retrying connection in up to 2s connIndex=0 event=0 ip=198.41.200.13" >&2',
      "sleep 1",
      'echo "2026-10-09T13:56:42Z INF Registered tunnel connection connIndex=0 connection=91aa ip=198.41.192.7 location=fra12 protocol=quic" >&2',
      "trap 'exit 0' TERM",
      "while :; do sleep 1; done",
      "",
    ].join("\n")
  );
  chmodSync(join(bin, "cloudflared"), 0o755);
  const child = spawn(process.execPath, [BINARY, "tunnel", "http://127.0.0.1:8766", "--data-dir", dir], {
    env: childEnv({ PATH: `${bin}:${process.env.PATH}` }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr.on("data", (chunk) => (log += chunk));
  t.after(() => child.kill("SIGKILL"));
  await waitFor(() => {
    const state = readTunnelState(dir);
    return state?.url === URL_B && state.connected_at === undefined;
  }, 15_000, "the stale connection cleared");
  await waitFor(() => readTunnelState(dir)?.url === URL_A, 15_000, "the hostname");
  // tunnel.json is written first, then .env.
  await waitFor(() => env(dir).WAZAP_PUBLIC_URL === URL_A, 15_000, "the hostname in .env");
  await waitFor(() => readTunnelState(dir)?.connected_at !== undefined, 15_000, "the edge connection");
  await waitFor(() => readTunnelState(dir)?.connected_at === undefined, 15_000, "the lost connection");
  await waitFor(() => readTunnelState(dir)?.connected_at !== undefined, 15_000, "the connection back");
  assert.match(log, /args: tunnel --no-autoupdate --url http:\/\/127\.0\.0\.1:8766/);
  child.kill("SIGTERM");
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0, log);
  assert.equal(readTunnelState(dir).connected_at, undefined, "without cloudflared the URL reaches nothing");
});

/** A supervisor stand-in whose tunnel unit "announces" URL_A as soon as it is (re)started. */
function announcingSupervisor(dir, calls = []) {
  return {
    calls,
    name: "builtin",
    available: () => true,
    logDir: () => join(dir, "logs"),
    unitFile: (label) => join(dir, `${label}.json`),
    render: (unit) => `${JSON.stringify(unit)}\n`,
    start: (ref) => calls.push(`start ${ref.label}`),
    stop: (ref) => calls.push(`stop ${ref.label}`),
    restart: (ref) => {
      calls.push(`restart ${ref.label}`);
      if (ref.label === "wazap-tunnel") setTimeout(() => adoptQuickUrl(dir, URL_A, { restartServer: () => calls.push("server restarted by the unit") }), 50);
    },
    remove: (ref) => {
      calls.push(`remove ${ref.label}`);
      rmSync(ref.unitFile, { force: true });
    },
    pid: () => 4242,
    logs: (ref) => [`tail ${ref.label}`],
  };
}

test("expose quick: password first, then the tunnel; the URL and the password are shown once, and the trade-off is said", async () => {
  const dir = dataDir();
  const supervisor = announcingSupervisor(dir);
  const config = { dataDir: dir, httpPort: 47_001, dryRun: false, args: ["quick"], oauthPassword: null, readOnly: false };
  await captured(() => installService(config, supervisor, 0, { kind: "global", script: BINARY }));
  supervisor.calls.length = 0;
  const ensured = [];
  const output = await captured(() =>
    runExpose(config, [], [supervisor], { waitMs: 5_000, ensure: async (where) => ensured.push(where), health: async () => 200 })
  );
  assert.deepEqual(ensured, [dir], "cloudflared is fetched before the unit starts");
  const settings = env(dir);
  assert.equal(settings.WAZAP_PUBLIC_URL, URL_A);
  assert.ok(settings.WAZAP_OAUTH_PASSWORD.length >= 20);
  assert.ok(output.includes(`MCP URL   ${URL_A}/mcp`));
  assert.ok(output.includes(settings.WAZAP_OAUTH_PASSWORD));
  assert.ok(output.includes(QUICK_NOTE));
  assert.deepEqual(readService(dir).tunnel, { provider: "quick", url: URL_A });
  const unit = JSON.parse(readFileSync(join(dir, "wazap-tunnel.json"), "utf8"));
  assert.deepEqual(unit.argv.slice(2), ["tunnel", "http://127.0.0.1:47001"]);
  assert.equal(unit.env.WAZAP_DATA_DIR, dir);
  // The unit's own command is what serve's tunnel check recognises: no sign-in, no serving.
  const found = tunnelsTo({ ...builtinSupervisor(() => dir), unitFile: (label) => join(dir, `${label}.json`) }, 47_001);
  assert.deepEqual(found.map((entry) => entry.label), ["wazap-tunnel"]);
});

test("expose quick says so when no URL comes, and points at the tunnel's log", async () => {
  const dir = dataDir();
  const supervisor = { ...announcingSupervisor(dir), restart: () => {} };
  const config = { dataDir: dir, httpPort: 47_002, dryRun: false, args: ["quick"], oauthPassword: null, readOnly: false };
  await captured(() => installService(config, supervisor, 0, { kind: "global", script: BINARY }));
  await assert.rejects(
    captured(() => runExpose(config, [], [supervisor], { waitMs: 300, ensure: async () => {}, health: async () => 200 })),
    (err) => {
      assert.match(err.message, /did not announce a URL in time/);
      assert.match(err.fix, /tail wazap-tunnel/);
      return true;
    }
  );
});

test("expose with no provider ready takes the quick tunnel, saying why", async () => {
  const dir = dataDir();
  const supervisor = announcingSupervisor(dir);
  const config = { dataDir: dir, httpPort: 47_003, dryRun: false, args: [], oauthPassword: "x".repeat(24), readOnly: false };
  await captured(() => installService(config, supervisor, 0, { kind: "global", script: BINARY }));
  const notReady = {
    name: "tailscale",
    describe: "Tailscale Funnel",
    available: () => true,
    ready: () => ({ ok: false, fix: "run `tailscale up`" }),
  };
  const output = await captured(() =>
    runExpose(config, [notReady], [supervisor], { waitMs: 5_000, ensure: async () => {}, health: async () => 200 })
  );
  assert.match(output, /Tailscale Funnel is installed but not ready \(run `tailscale up`\); using a quick tunnel instead/);
  assert.equal(readService(dir).tunnel.provider, "quick");
  assert.doesNotMatch(output, /x{24}/, "a password set earlier is never printed again");
});

test("expose off after a quick tunnel forgets its URL", async () => {
  const dir = dataDir();
  const supervisor = announcingSupervisor(dir);
  const config = { dataDir: dir, httpPort: 47_004, dryRun: false, args: ["quick"], oauthPassword: null, readOnly: false };
  await captured(() => installService(config, supervisor, 0, { kind: "global", script: BINARY }));
  await captured(() => runExpose(config, [], [supervisor], { waitMs: 5_000, ensure: async () => {}, health: async () => 200 }));
  await captured(() => runExpose({ ...config, args: ["off"] }, [], [supervisor]));
  assert.equal(env(dir).WAZAP_PUBLIC_URL, "");
  assert.equal(readTunnelState(dir), null);
  assert.equal(readService(dir).tunnel, undefined);
});

test("`wazap expose` names quick among the providers", async () => {
  const { stderr } = await run(process.execPath, [BINARY, "--help"], { env: childEnv() });
  assert.match(stderr, /wazap expose \[quick\|tailscale\|cloudflare\|off\]/);
  assert.match(stderr, /quick, tailscale, cloudflare|tailscale, cloudflare, quick/);
});

test("a registered edge connection is told apart from a URL that never connected", () => {
  assert.equal(registeredIn("2026-10-09T13:56:28Z INF Registered tunnel connection connIndex=0 protocol=quic"), true);
  assert.equal(registeredIn("2026-10-09T13:56:28Z INF Registered tunnel connection connIndex=0 protocol=http2"), true);
  assert.equal(registeredIn("2026-10-09T13:56:28Z ERR Failed to dial a quic connection"), false);
  assert.equal(registeredIn("2026-10-09T13:56:28Z INF Unregistered tunnel connection connIndex=0 event=0"), false);
  assert.deepEqual(edgeEventIn("INF Registered tunnel connection connIndex=2 protocol=http2"), { up: true, conn: "2" });
  assert.deepEqual(edgeEventIn("INF Unregistered tunnel connection connIndex=2 event=0"), { up: false, conn: "2" });
  assert.deepEqual(edgeEventIn("ERR Serve tunnel error error=\"EOF\" connIndex=0 event=0"), { up: false, conn: "0" });
  assert.deepEqual(edgeEventIn("INF Retrying connection in up to 4s connIndex=0 event=0"), { up: false, conn: "0" });
  assert.equal(edgeEventIn("INF precheck complete hard_fail=true suggested_protocol=http2"), null);
  const dir = dataDir();
  markTunnelConnected(dir, URL_A, 1);
  assert.equal(readTunnelState(dir), null, "no state, nothing to mark");
  adoptQuickUrl(dir, URL_A, { restartServer: () => {} });
  assert.equal(readTunnelState(dir).connected_at, undefined);
  markTunnelConnected(dir, URL_B, 99);
  assert.equal(readTunnelState(dir).connected_at, undefined, "another URL's connection is not this one's");
  markTunnelConnected(dir, URL_A, 1234);
  assert.equal(readTunnelState(dir).connected_at, 1234);
  adoptQuickUrl(dir, URL_A, { restartServer: () => {} });
  assert.equal(readTunnelState(dir).connected_at, 1234, "the same hostname again is the same connection");
  markTunnelConnected(dir, URL_A, null);
  assert.equal(readTunnelState(dir).connected_at, undefined, "a lost connection is no connection");
  markTunnelConnected(dir, URL_A, 5678);
  adoptQuickUrl(dir, URL_B, { restartServer: () => {} });
  assert.equal(readTunnelState(dir).connected_at, undefined, "a new hostname is a new connection");
});

test("expose quick says plainly when the tunnel never reached Cloudflare, instead of 'still coming up'", async () => {
  const dir = dataDir();
  const supervisor = announcingSupervisor(dir);
  const config = { dataDir: dir, httpPort: 47_003, dryRun: false, args: ["quick"], oauthPassword: null, readOnly: false };
  await captured(() => installService(config, supervisor, 0, { kind: "global", script: BINARY }));
  const output = await captured(() => runExpose(config, [], [supervisor], { waitMs: 5_000, ensure: async () => {}, health: async () => 530 }));
  assert.match(output, /could not connect to Cloudflare from this network/);
  assert.match(output, /tail wazap-tunnel/);
  assert.doesNotMatch(output, /may still be coming up/);
  const status = await run(process.execPath, [BINARY, "status", "--json", "--data-dir", dir], { env: childEnv() });
  assert.equal(JSON.parse(status.stdout).public.connected, false);
});

test("`wazap status` always shows the current public URL, and says a quick tunnel's moves", async () => {
  const dir = dataDir();
  writeFileSync(paths(dir).envFile, `WAZAP_PUBLIC_URL=${URL_B}\nWAZAP_OAUTH_PASSWORD=${"p".repeat(24)}\n`);
  writeFileSync(
    paths(dir).serviceFile,
    JSON.stringify({ supervisor: "builtin", label: "wazap-server", unitFile: "/x", port: 8766, logDir: "/l", installedVersion: "1", tunnel: { provider: "quick", url: URL_B } })
  );
  const human = await run(process.execPath, [BINARY, "status", "--data-dir", dir], { env: childEnv() });
  assert.ok(human.stderr.includes(`public: ${URL_B}/mcp (quick tunnel: a new URL each time it restarts; this is the current one)`));
  const json = await run(process.execPath, [BINARY, "status", "--json", "--data-dir", dir], { env: childEnv() });
  assert.deepEqual(JSON.parse(json.stdout).public, { mcp_url: `${URL_B}/mcp`, tunnel: "quick", url_changes_on_restart: true });
  assert.doesNotMatch(json.stdout + human.stderr, /p{24}/, "the password is never in status");
});

test("a cloudflared left by a killed unit is stopped; a pid that runs anything else is left alone", async (t) => {
  const { stopStaleCloudflared } = await import("../dist/quick-tunnel.js");
  const dir = dataDir();
  const bin = join(dir, "cloudflared");
  writeFileSync(bin, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n");
  chmodSync(bin, 0o755);
  const target = "http://127.0.0.1:8766";
  const stale = spawn(bin, ["tunnel", "--no-autoupdate", "--url", target], { stdio: "ignore" });
  const other = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => {
    stale.kill("SIGKILL");
    other.kill("SIGKILL");
  });
  const pidFile = join(dir, "cloudflared.pid");
  await new Promise((resolve) => setTimeout(resolve, 200));
  writeFileSync(pidFile, `${other.pid}\n`);
  stopStaleCloudflared(pidFile, target);
  assert.equal(other.exitCode, null, "not a cloudflared: untouched");
  writeFileSync(pidFile, `${stale.pid}\n`);
  stopStaleCloudflared(pidFile, "http://127.0.0.1:876");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(stale.exitCode, null, "another port's tunnel: untouched");
  writeFileSync(pidFile, `${stale.pid}\n`);
  stopStaleCloudflared(pidFile, target);
  const code = await new Promise((resolve) => stale.once("exit", (exitCode, signal) => resolve(exitCode ?? signal)));
  assert.ok(code === 0 || code === "SIGTERM");
  assert.equal(existsSync(pidFile), false);
});
